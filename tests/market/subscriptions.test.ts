import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync as mkdtemp, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultMigrationsFolder, openDatabase, runMigrations, SqliteSubscriptionRepository, STREAMING_GENERATION_KEY
} from "../../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

function tempDb(name: string) {
  const dir = mkdtemp(join(tmpdir(), "markethub-subs-"));
  return { dir, path: join(dir, name) };
}

describe("streaming_subscriptions migration", () => {
  test("fresh install creates the table and generation key is absent until first write", async () => {
    const { dir, path } = tempDb("fresh.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      runMigrations(handle.db, defaultMigrationsFolder);
      const tables = handle.sqlite.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='streaming_subscriptions'"
      ).all();
      expect(tables.length).toBe(1);

      const repo = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
      const state = await repo.load();
      expect(state.selections).toEqual([]);
      expect(state.generation).toBe(0);
      closeDatabaseHandle(handle);
    } finally {
      removeTempDir(dir);
    }
  });

  test("upgrade from M3 migrations preserves existing data and adds the new table", () => {
    const { dir, path } = tempDb("upgrade.sqlite");
    const legacyMigrations = join(dir, "m3-migrations");
    try {
      mkdirSync(join(legacyMigrations, "meta"), { recursive: true });
      const legacyTags = [
        "0000_tan_la_nuit", "0001_lively_mauler", "0002_round_baron_strucker", "0003_sad_edwin_jarvis"
      ];
      for (const tag of legacyTags) {
        copyFileSync(join(defaultMigrationsFolder, `${tag}.sql`), join(legacyMigrations, `${tag}.sql`));
      }
      const fullJournal = JSON.parse(readFileSync(join(defaultMigrationsFolder, "meta", "_journal.json"), "utf8"));
      writeFileSync(
        join(legacyMigrations, "meta", "_journal.json"),
        JSON.stringify({ ...fullJournal, entries: fullJournal.entries.slice(0, 4) })
      );

      const h1 = openDatabase({ dbPath: path });
      runMigrations(h1.db, legacyMigrations);
      h1.sqlite.exec("INSERT INTO app_meta(key,value,updated_at) VALUES ('legacy_key','legacy_value',1)");
      closeDatabaseHandle(h1);

      const h2 = openDatabase({ dbPath: path });
      runMigrations(h2.db, defaultMigrationsFolder);
      const legacy = h2.sqlite.query("SELECT value FROM app_meta WHERE key='legacy_key'").get() as { value: string } | null;
      expect(legacy?.value).toBe("legacy_value");
      const tables = h2.sqlite.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='streaming_subscriptions'"
      ).all();
      expect(tables.length).toBe(1);
      closeDatabaseHandle(h2);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("SqliteSubscriptionRepository", () => {
  test("round-trip, empty replacement and durable generation", async () => {
    const { dir, path } = tempDb("repo.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      runMigrations(handle.db, defaultMigrationsFolder);
      const repo = new SqliteSubscriptionRepository(handle.db, handle.sqlite);

      const g1 = await repo.replace([
        { canonicalId: "a", enabled: true },
        { canonicalId: "b", enabled: false }
      ]);
      expect(g1).toBe(1);
      expect(await repo.load()).toEqual({
        selections: [{ canonicalId: "a", enabled: true }, { canonicalId: "b", enabled: false }],
        generation: 1
      });

      const g2 = await repo.replace([{ canonicalId: "c", enabled: true }]);
      expect(g2).toBe(2);
      expect(await repo.load()).toEqual({
        selections: [{ canonicalId: "c", enabled: true }], generation: 2
      });

      // Empty replacement is valid and still advances the generation.
      const g3 = await repo.replace([]);
      expect(g3).toBe(3);
      expect(await repo.load()).toEqual({ selections: [], generation: 3 });

      const meta = handle.sqlite.query("SELECT value FROM app_meta WHERE key=?").get(STREAMING_GENERATION_KEY) as { value: string } | null;
      expect(meta?.value).toBe("3");
      closeDatabaseHandle(handle);
    } finally {
      removeTempDir(dir);
    }
  });

  test("duplicate canonical ids are rejected atomically without advancing generation", async () => {
    const { dir, path } = tempDb("dup.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      runMigrations(handle.db, defaultMigrationsFolder);
      const repo = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
      await repo.replace([{ canonicalId: "a", enabled: true }]);

      let rejected = false;
      try {
        await repo.replace([{ canonicalId: "x", enabled: true }, { canonicalId: "x", enabled: false }]);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      // State and generation are unchanged after the rejected replacement.
      expect(await repo.load()).toEqual({
        selections: [{ canonicalId: "a", enabled: true }], generation: 1
      });
      closeDatabaseHandle(handle);
    } finally {
      removeTempDir(dir);
    }
  });

  test("concurrent replacements are serialized with monotonic generations", async () => {
    const { dir, path } = tempDb("concurrent.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      runMigrations(handle.db, defaultMigrationsFolder);
      const repo = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
      const results = await Promise.all([
        repo.replace([{ canonicalId: "a", enabled: true }]),
        repo.replace([{ canonicalId: "b", enabled: true }]),
        repo.replace([{ canonicalId: "c", enabled: true }])
      ]);
      expect(results.sort()).toEqual([1, 2, 3]);
      expect((await repo.load()).generation).toBe(3);
      closeDatabaseHandle(handle);
    } finally {
      removeTempDir(dir);
    }
  });
});
