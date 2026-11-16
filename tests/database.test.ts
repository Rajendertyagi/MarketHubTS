import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkDatabase, defaultMigrationsFolder, openDatabase, repoRoot, resolveDatabasePath, runMigrations } from "../packages/database/src/index";

function tempDbPath(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "markethub-db-"));
  return { dir, path: join(dir, name) };
}
function safeRm(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

describe("database", () => {
  test("creates fresh database and applies migrations", () => {
    const { dir, path } = tempDbPath("fresh.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      runMigrations(handle.db, defaultMigrationsFolder);
      expect(existsSync(path)).toBe(true);
      expect(checkDatabase(handle.sqlite)).toBe("ok");
      const tables = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").all();
      expect(tables.length).toBe(1);
      handle.close();
    } finally {
      safeRm(dir);
    }
  });

  test("repeated startup and migration preserves existing data", () => {
    const { dir, path } = tempDbPath("repeat.sqlite");
    try {
      const h1 = openDatabase({ dbPath: path });
      runMigrations(h1.db, defaultMigrationsFolder);
      h1.sqlite.exec("INSERT INTO app_meta(key,value,updated_at) VALUES ('k','v',1)");
      h1.close();

      const h2 = openDatabase({ dbPath: path });
      runMigrations(h2.db, defaultMigrationsFolder);
      const row = h2.sqlite.query("SELECT value FROM app_meta WHERE key='k'").get() as { value: string } | null;
      expect(row?.value).toBe("v");
      expect(checkDatabase(h2.sqlite)).toBe("ok");
      h2.close();
    } finally {
      safeRm(dir);
    }
  });

  test("migration failure handling for missing folder", () => {
    const { dir, path } = tempDbPath("fail.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      expect(() => runMigrations(handle.db, join(dir, "nope"))).toThrow();
      handle.close();
    } finally {
      safeRm(dir);
    }
  });

  test("checkDatabase reports error for closed db", () => {
    const { dir, path } = tempDbPath("closed.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      handle.close();
      expect(checkDatabase(handle.sqlite)).toBe("error");
    } finally {
      safeRm(dir);
    }
  });

  test("resolves relative database paths against repository root regardless of cwd", () => {
    const prev = process.cwd();
    try {
      process.chdir(join(repoRoot, "packages", "database"));
      const resolved = resolveDatabasePath("./data/markethub.sqlite");
      expect(resolved).toBe(resolve(repoRoot, "data", "markethub.sqlite"));
    } finally {
      process.chdir(prev);
    }
  });

  test("keeps explicit absolute database paths", () => {
    const abs = resolve(repoRoot, "tmp-abs", "custom.sqlite");
    expect(resolveDatabasePath(abs)).toBe(abs);
  });
});
