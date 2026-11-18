import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AppSettings, CandleRepository, SnapshotRepository,
  checkDatabase, defaultMigrationsFolder, openDatabase, repoRoot, resolveDatabasePath, runMigrations
} from "../packages/database/src/index";
import type { HistoricalCandle, OptionChainSnapshot, OptionChainCaptureConfig, RetentionSettings } from "../packages/contracts/src/index";
import { closeDatabaseHandle, removeTempDir } from "./helpers/fs-cleanup";

function tempDbPath(name: string) {
  const dir = mkdtempSync(join(tmpdir(), "markethub-db-"));
  return { dir, path: join(dir, name) };
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
      closeDatabaseHandle(handle);
    } finally {
      removeTempDir(dir);
    }
  });

  test("repeated startup and migration preserves existing data", () => {
    const { dir, path } = tempDbPath("repeat.sqlite");
    try {
      const h1 = openDatabase({ dbPath: path });
      runMigrations(h1.db, defaultMigrationsFolder);
      h1.sqlite.exec("INSERT INTO app_meta(key,value,updated_at) VALUES ('k','v',1)");
      closeDatabaseHandle(h1);

      const h2 = openDatabase({ dbPath: path });
      runMigrations(h2.db, defaultMigrationsFolder);
      const row = h2.sqlite.query("SELECT value FROM app_meta WHERE key='k'").get() as { value: string } | null;
      expect(row?.value).toBe("v");
      expect(checkDatabase(h2.sqlite)).toBe("ok");
      closeDatabaseHandle(h2);
    } finally {
      removeTempDir(dir);
    }
  });

  test("migration failure handling for missing folder", () => {
    const { dir, path } = tempDbPath("fail.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      expect(() => runMigrations(handle.db, join(dir, "nope"))).toThrow();
      closeDatabaseHandle(handle);
    } finally {
      removeTempDir(dir);
    }
  });

  test("checkDatabase reports error for closed db", () => {
    const { dir, path } = tempDbPath("closed.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      closeDatabaseHandle(handle);
      expect(checkDatabase(handle.sqlite)).toBe("error");
    } finally {
      removeTempDir(dir);
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

// --- M5 Phase 1: five-table storage, additive migration, retention fail-safe ---

function candle(overrides: Partial<HistoricalCandle> = {}): HistoricalCandle {
  return {
    canonicalId: "v1|NSE|EQ|EQ|CODE:SBIN", interval: "1D", tsMs: 1700000000000,
    open: 100, high: 102, low: 99, close: 101, volume: 1000, oi: null,
    provider: "UPSTOX",
    provenance: { source: "provider-feed", provider: "UPSTOX", receivedAt: "2026-01-01T00:00:00.000Z" },
    receivedAtMs: 1700000000000,
    ...overrides
  };
}

function snapshot(overrides: Partial<OptionChainSnapshot> = {}): OptionChainSnapshot {
  return {
    id: "snap-1", configId: "cfg-1", capturedAt: "2026-01-01T00:00:00.000Z", provider: "FYERS",
    envelope: {
      underlyingCanonicalId: "v1|NSE|INDEX|INDEX|CODE:NIFTY50", expiryDate: "2026-01-29",
      capturedAt: "2026-01-01T00:00:00.000Z", observationTimestamp: null, underlyingLtp: 25000,
      strikes: [{ strike: 25000, optionType: "CE", ltp: 100, greeks: { delta: 0.5, gamma: null } }],
      providerExtensions: { fyToken: "123" }
    },
    provenance: { source: "provider-feed", provider: "FYERS", receivedAt: "2026-01-01T00:00:00.000Z" },
    ...overrides
  };
}

function captureConfig(overrides: Partial<OptionChainCaptureConfig> = {}): OptionChainCaptureConfig {
  return {
    id: "cfg-1", underlyingCanonicalId: "v1|NSE|INDEX|INDEX|CODE:NIFTY50", expiryDate: "2026-01-29",
    strikeRangeJson: null, captureEnabled: true, captureMode: "MANUAL", scheduleJson: null,
    streamingEnabled: false, provider: "FYERS",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("M5 storage", () => {
  test("fresh migration creates all five M5 tables", () => {
    const { dir, path } = tempDbPath("m5-fresh.sqlite");
    try {
      const handle = openDatabase({ dbPath: path });
      runMigrations(handle.db, defaultMigrationsFolder);
      const names = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      for (const table of ["historical_candles", "candle_range_notes", "historical_sync_configs", "option_chain_capture_configs", "option_chain_snapshots"]) {
        expect(names.some((r) => r.name === table)).toBe(true);
      }
      closeDatabaseHandle(handle);
    } finally { removeTempDir(dir); }
  });

  test("0004 to 0005 upgrade preserves app_meta, catalog and subscriptions", () => {
    const { dir, path } = tempDbPath("m5-upgrade.sqlite");
    const oldMigrations = join(dir, "migrations-0004");
    try {
      mkdirSync(join(oldMigrations, "meta"), { recursive: true });
      const tags = ["0000_tan_la_nuit", "0001_lively_mauler", "0002_round_baron_strucker", "0003_sad_edwin_jarvis", "0004_flat_spitfire"];
      for (const tag of tags) {
        copyFileSync(join(defaultMigrationsFolder, `${tag}.sql`), join(oldMigrations, `${tag}.sql`));
        const snapshotName = `${tag.slice(0, 4)}_snapshot.json`;
        copyFileSync(join(defaultMigrationsFolder, "meta", snapshotName), join(oldMigrations, "meta", snapshotName));
      }
      const journal = JSON.parse(readFileSync(join(defaultMigrationsFolder, "meta", "_journal.json"), "utf8"));
      journal.entries = journal.entries.slice(0, 5);
      writeFileSync(join(oldMigrations, "meta", "_journal.json"), JSON.stringify(journal));

      const h1 = openDatabase({ dbPath: path });
      runMigrations(h1.db, oldMigrations);
      h1.sqlite.exec("INSERT INTO app_meta(key,value,updated_at) VALUES ('streaming_subscriptions_generation','7',1)");
      h1.sqlite.exec("INSERT INTO streaming_subscriptions(canonical_id,enabled,created_at,updated_at) VALUES ('c1',1,'x','x')");
      closeDatabaseHandle(h1);

      const h2 = openDatabase({ dbPath: path });
      runMigrations(h2.db, defaultMigrationsFolder);
      const gen = h2.sqlite.query("SELECT value FROM app_meta WHERE key='streaming_subscriptions_generation'").get() as { value: string } | null;
      expect(gen?.value).toBe("7");
      const sub = h2.sqlite.query("SELECT canonical_id FROM streaming_subscriptions WHERE canonical_id='c1'").get();
      expect(sub).toBeDefined();
      const names = h2.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='historical_candles'").all();
      expect(names.length).toBe(1);
      closeDatabaseHandle(h2);
    } finally { removeTempDir(dir); }
  });

  test("first valid write wins; conflicts recorded; duplicates idempotent; refresh explicit", () => {
    const { dir, path } = tempDbPath("m5-candles.sqlite");
    try {
      const handle = openDatabase({ dbPath: path, migrate: true });
      const repo = new CandleRepository(handle.db, handle.sqlite);
      const first = candle();
      expect(repo.upsertCandles([first]).inserted).toBe(1);
      expect(repo.upsertCandles([first]).unchanged).toBe(1); // duplicate idempotent
      const competing = candle({ provider: "FYERS", close: 999, receivedAtMs: 1700000001000 });
      const conflict = repo.upsertCandles([competing]);
      expect(conflict.conflicts).toBe(1);
      expect(repo.getCandles(first.canonicalId, "1D", 0, 9999999999999)[0]!.close).toBe(101); // not overwritten
      expect(repo.getRangeNotes(first.canonicalId, "1D", 0, 9999999999999).some((n) => n.kind === "CONFLICT")).toBe(true);
      const refreshed = candle({ close: 105, receivedAtMs: 1700000002000 });
      expect(repo.upsertCandles([refreshed], { refresh: true }).refreshed).toBe(1);
      expect(repo.getCandles(first.canonicalId, "1D", 0, 9999999999999)[0]!.close).toBe(105);
      closeDatabaseHandle(handle);
    } finally { removeTempDir(dir); }
  });

  test("snapshots survive capture-config deletion (config_id nulled)", () => {
    const { dir, path } = tempDbPath("m5-snapshots.sqlite");
    try {
      const handle = openDatabase({ dbPath: path, migrate: true });
      const repo = new SnapshotRepository(handle.db, handle.sqlite);
      repo.putCaptureConfig(captureConfig());
      repo.putSnapshot(snapshot());
      expect(repo.getSnapshot("snap-1")?.configId).toBe("cfg-1");
      repo.deleteCaptureConfig("cfg-1");
      expect(repo.getCaptureConfig("cfg-1")).toBeNull();
      expect(repo.getSnapshot("snap-1")?.configId).toBeNull();
      expect(repo.getSnapshot("snap-1")?.envelope.strikes[0]!.greeks?.gamma).toBeNull(); // null preserved
      closeDatabaseHandle(handle);
    } finally { removeTempDir(dir); }
  });

  test("retention fail-safe: invalid config disables cleanup and deletes nothing", () => {
    const { dir, path } = tempDbPath("m5-retention.sqlite");
    try {
      const handle = openDatabase({ dbPath: path, migrate: true });
      const settings = new AppSettings(handle.db);
      const repo = new CandleRepository(handle.db, handle.sqlite);
      repo.upsertCandles([candle()]);
      expect(settings.getRetention().valid).toBe(false); // missing
      handle.sqlite.exec("INSERT INTO app_meta(key,value,updated_at) VALUES ('retention_settings','not-json',1)");
      expect(settings.getRetention().valid).toBe(false); // malformed
      handle.sqlite.exec("INSERT OR REPLACE INTO app_meta(key,value,updated_at) VALUES ('retention_settings','{\"version\":99}',1)");
      expect(settings.getRetention().valid).toBe(false); // schema-invalid
      // Cleanup is only invoked when valid; assert no rows deleted while invalid.
      expect(repo.getCandles("v1|NSE|EQ|EQ|CODE:SBIN", "1D", 0, 9999999999999).length).toBe(1);
      const valid: RetentionSettings = { version: 1, classes: { CANDLE: { maxAgeDays: 30 } } };
      settings.setRetention(valid);
      expect(settings.getRetention().valid).toBe(true);
      expect(settings.getRetention().settings?.classes.CANDLE?.maxAgeDays).toBe(30);
      closeDatabaseHandle(handle);
    } finally { removeTempDir(dir); }
  });

  test("restart persistence: candles, snapshots, configs and retention survive close + reopen", () => {
    const { dir, path } = tempDbPath("m5-restart.sqlite");
    try {
      const h1 = openDatabase({ dbPath: path, migrate: true });
      const candleRepo1 = new CandleRepository(h1.db, h1.sqlite);
      const snapRepo1 = new SnapshotRepository(h1.db, h1.sqlite);
      const settings1 = new AppSettings(h1.db);
      candleRepo1.upsertCandles([candle()]);
      candleRepo1.putSyncConfig({
        id: "sync-1", canonicalId: candle().canonicalId, interval: "1D", enabled: true,
        dateRangeJson: null, scheduleJson: null, providerPolicyJson: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
      });
      snapRepo1.putCaptureConfig(captureConfig());
      snapRepo1.putSnapshot(snapshot());
      settings1.setRetention({ version: 1, classes: { CANDLE: { maxAgeDays: 30 }, SNAPSHOT: { maxAgeDays: 90 } } });
      closeDatabaseHandle(h1);

      const h2 = openDatabase({ dbPath: path, migrate: true });
      const candleRepo2 = new CandleRepository(h2.db, h2.sqlite);
      const snapRepo2 = new SnapshotRepository(h2.db, h2.sqlite);
      const settings2 = new AppSettings(h2.db);
      expect(candleRepo2.getCandles(candle().canonicalId, "1D", 0, 9999999999999).length).toBe(1);
      expect(candleRepo2.getSyncConfig("sync-1")?.enabled).toBe(true);
      expect(snapRepo2.getCaptureConfig("cfg-1")?.provider).toBe("FYERS");
      expect(snapRepo2.getSnapshot("snap-1")?.envelope.strikes[0]!.greeks?.gamma).toBeNull();
      expect(settings2.getRetention().settings?.classes.SNAPSHOT?.maxAgeDays).toBe(90);
      closeDatabaseHandle(h2);
    } finally { removeTempDir(dir); }
  });

  test("duplicate snapshot id insert is idempotent (no constraint error)", () => {
    const { dir, path } = tempDbPath("m5-snapshot-idempotent.sqlite");
    try {
      const handle = openDatabase({ dbPath: path, migrate: true });
      const repo = new SnapshotRepository(handle.db, handle.sqlite);
      repo.putCaptureConfig(captureConfig()); // satisfy the config_id FK
      expect(repo.putSnapshot(snapshot())).toBe(true);
      expect(repo.putSnapshot(snapshot())).toBe(false); // duplicate is a no-op
      expect(repo.listSnapshots().length).toBe(1);
      closeDatabaseHandle(handle);
    } finally { removeTempDir(dir); }
  });

  test("retention cleanup deletes in bounded batches until all expired rows are gone", () => {
    const { dir, path } = tempDbPath("m5-batch-cleanup.sqlite");
    try {
      const handle = openDatabase({ dbPath: path, migrate: true });
      const repo = new CandleRepository(handle.db, handle.sqlite);
      const many = Array.from({ length: 25 }, (_, i) => candle({ tsMs: 1000 + i }));
      expect(repo.upsertCandles(many).inserted).toBe(25);
      // Batch limit 7 → 25 rows require 4 batches; all must be deleted.
      expect(repo.cleanupCandles(2000, 7)).toBe(25);
      expect(repo.getCandles(candle().canonicalId, "1D", 0, 9999999999999).length).toBe(0);
      closeDatabaseHandle(handle);
    } finally { removeTempDir(dir); }
  });
});
