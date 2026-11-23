import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import {
  AppSettings, CandleRepository, SnapshotRepository, defaultMigrationsFolder, openDatabase, runMigrations,
  RETENTION_SETTINGS_KEY
} from "../../packages/database/src/index";
import type { McpActivityRepository } from "../../packages/database/src/index";
import { appMeta } from "../../packages/database/src/schema";
import {
  retentionCleanupResultSchema, retentionSettingsViewSchema,
  type HistoricalCandle, type HistoricalSyncConfig, type OptionChainCaptureConfig,
  type OptionChainSnapshot, type RetentionSettings
} from "../../packages/contracts/src/index";
import { createApp } from "../../apps/api/src/app";
import { applyRetentionCleanup } from "../../apps/api/src/historical-routes";
import { createLogger } from "../../apps/api/src/lib/logger";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const CANON = "v1|NSE|EQ|EQ|CODE:SBIN";
const FROM = Date.parse("2026-01-01T00:00:00Z");
const TO = Date.parse("2026-01-31T00:00:00Z");

function harness() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "mh-hist-routes-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now() });
  const localEnv = { requestIP: () => ({ address: "127.0.0.1" }) };
  const remoteEnv = { requestIP: () => ({ address: "8.8.8.8" }) };
  const candles = new CandleRepository(db.db, db.sqlite);
  const snapshots = new SnapshotRepository(db.db, db.sqlite);
  const settings = new AppSettings(db.db);
  const cleanup = () => { closeDatabaseHandle(db); removeTempDir(dir); };
  return { app, localEnv, remoteEnv, db, candles, snapshots, settings, cleanup };
}

type Harness = ReturnType<typeof harness>;

function writeRawRetention(h: Harness, value: string): void {
  const now = new Date();
  h.db.db.insert(appMeta).values({ key: RETENTION_SETTINGS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
    .run();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.parse("2026-06-01T00:00:00Z");

function fakeRepositories() {
  const calls: string[] = [];
  const candles = {
    cleanupCandles(cutoffMs: number) { calls.push(`candles:${cutoffMs}`); return 1; }
  } as unknown as CandleRepository;
  const snapshots = {
    cleanupSnapshots(cutoffMs: number) { calls.push(`snapshots:${cutoffMs}`); return 2; }
  } as unknown as SnapshotRepository;
  const activities = {
    cleanupActivities(cutoffMs: number) { calls.push(`activities:${cutoffMs}`); return 3; }
  } as unknown as McpActivityRepository;
  return { candles, snapshots, activities, calls };
}

function seedCandle(tsMs: number): HistoricalCandle {
  return {
    canonicalId: CANON, interval: "1D", tsMs, open: 10, high: 12, low: 9, close: 11,
    volume: 100, oi: null, provider: "UPSTOX",
    provenance: { source: "provider-feed", provider: "UPSTOX", receivedAt: "2026-01-01T00:00:00.000Z" },
    receivedAtMs: tsMs
  };
}

function syncConfig(): HistoricalSyncConfig {
  return {
    id: "sync-1", canonicalId: CANON, interval: "1D", enabled: true,
    dateRangeJson: null, scheduleJson: null, providerPolicyJson: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function captureConfig(): OptionChainCaptureConfig {
  return {
    id: "cap-1", underlyingCanonicalId: CANON, expiryDate: "2026-01-29", strikeRangeJson: null,
    captureEnabled: true, captureMode: "MANUAL", scheduleJson: null, streamingEnabled: false,
    provider: "FYERS", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function snapshot(): OptionChainSnapshot {
  return {
    id: "snap-1", configId: "cap-1", capturedAt: "2026-01-01T00:00:00.000Z", provider: "FYERS",
    envelope: {
      underlyingCanonicalId: CANON, expiryDate: "2026-01-29", capturedAt: "2026-01-01T00:00:00.000Z",
      observationTimestamp: null, underlyingLtp: 25000,
      strikes: [{ strike: 25000, optionType: "CE", ltp: 100, greeks: { delta: 0.5, gamma: null } }],
      providerExtensions: {}
    },
    provenance: { source: "provider-feed", provider: "FYERS", receivedAt: "2026-01-01T00:00:00.000Z" }
  };
}

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("M5 historical/snapshot API routes", () => {
  test("cached candles and coverage are read from stored data", async () => {
    const h = harness();
    try {
      h.candles.upsertCandles([seedCandle(Date.parse("2026-01-05T00:00:00Z"))]);
      const candlesRes = await h.app.request(
        `/api/historical/candles?canonicalId=${encodeURIComponent(CANON)}&interval=1D&from=${FROM}&to=${TO}`, {}, h.localEnv
      );
      expect(candlesRes.status).toBe(200);
      expect((await json(candlesRes)).candles.length).toBe(1);

      const coverageRes = await h.app.request(
        `/api/historical/coverage?canonicalId=${encodeURIComponent(CANON)}&interval=1D&from=${FROM}&to=${TO}`, {}, h.localEnv
      );
      expect(coverageRes.status).toBe(200);
      const coverage = await json(coverageRes);
      expect(coverage.confirmed).toBe(false);
      expect(coverage.gaps.every((g: any) => g.confirmed === false)).toBe(true);
    } finally { h.cleanup(); }
  });

  test("coverage reports authoritative unavailable periods alongside gaps", async () => {
    const h = harness();
    try {
      h.candles.addRangeNote({
        canonicalId: CANON, interval: "1D", provider: "FYERS",
        rangeStartMs: Date.parse("2026-01-10T00:00:00Z"), kind: "UNAVAILABLE",
        rangeEndMs: Date.parse("2026-01-12T00:00:00Z"), reasonCode: "NO_DATA",
        reasonJson: "{}", requestedAtMs: 1, updatedAtMs: 1
      });
      const res = await h.app.request(
        `/api/historical/coverage?canonicalId=${encodeURIComponent(CANON)}&interval=1D&from=${FROM}&to=${TO}`, {}, h.localEnv
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.unavailableNotes.length).toBe(1);
      expect(body.unavailableNotes[0].reasonCode).toBe("NO_DATA");
      expect(body.unavailableNotes[0].provider).toBe("FYERS");
    } finally { h.cleanup(); }
  });

  test("invalid range returns 400", async () => {
    const h = harness();
    try {
      const res = await h.app.request("/api/historical/candles?canonicalId=x", {}, h.localEnv);
      expect(res.status).toBe(400);
    } finally { h.cleanup(); }
  });

  test("sync config CRUD is local-owner only", async () => {
    const h = harness();
    try {
      const remote = await h.app.request("/api/historical/sync-configs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(syncConfig())
      }, h.remoteEnv);
      expect(remote.status).toBe(403);

      const created = await h.app.request("/api/historical/sync-configs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(syncConfig())
      }, h.localEnv);
      expect(created.status).toBe(200);
      expect((await json(created)).config.id).toBe("sync-1");

      const listed = await json(await h.app.request("/api/historical/sync-configs", {}, h.localEnv));
      expect(listed.configs.length).toBe(1);

      const deleted = await h.app.request("/api/historical/sync-configs/sync-1", { method: "DELETE" }, h.localEnv);
      expect(deleted.status).toBe(200);
      expect((await json(await h.app.request("/api/historical/sync-configs", {}, h.localEnv))).configs.length).toBe(0);
    } finally { h.cleanup(); }
  });

  test("saving a second config for the same instrument/interval merges instead of 500", async () => {
    const h = harness();
    try {
      const first = await h.app.request("/api/historical/sync-configs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(syncConfig())
      }, h.localEnv);
      expect(first.status).toBe(200);

      const duplicate = { ...syncConfig(), id: "sync-2", enabled: false };
      const second = await h.app.request("/api/historical/sync-configs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(duplicate)
      }, h.localEnv);
      expect(second.status).toBe(200);
      const body = await json(second);
      expect(body.config.id).toBe("sync-1"); // existing identity preserved
      expect(body.config.enabled).toBe(false); // values merged
      expect((await json(await h.app.request("/api/historical/sync-configs", {}, h.localEnv))).configs.length).toBe(1);
    } finally { h.cleanup(); }
  });

  test("retention is validated and local-owner only; cleanup fails closed", async () => {
    const h = harness();
    try {
      const remote = await h.app.request("/api/retention", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, classes: { CANDLE: { maxAgeDays: 30 } } })
      }, h.remoteEnv);
      expect(remote.status).toBe(403);

      const invalid = await h.app.request("/api/retention", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 99 })
      }, h.localEnv);
      expect(invalid.status).toBe(400);

      const before = await json(await h.app.request("/api/retention", {}, h.localEnv));
      expect(before.valid).toBe(false);

      h.candles.upsertCandles([seedCandle(Date.parse("2026-01-05T00:00:00Z"))]);
      const blocked = await json(await h.app.request("/api/retention/cleanup", { method: "POST" }, h.localEnv));
      expect(blocked.ran).toBe(false);
      expect(blocked.candlesDeleted).toBe(0);
      expect(h.candles.getCandles(CANON, "1D", 0, 9999999999999).length).toBe(1); // nothing deleted

      const saved = await h.app.request("/api/retention", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, classes: { CANDLE: { maxAgeDays: 30 } } })
      }, h.localEnv);
      expect(saved.status).toBe(200);
      const after = await json(await h.app.request("/api/retention", {}, h.localEnv));
      expect(after.valid).toBe(true);
      expect(after.settings.classes.CANDLE.maxAgeDays).toBe(30);
    } finally { h.cleanup(); }
  });

  test("GET /api/snapshots/configs is not shadowed by the :id route", async () => {
    const h = harness();
    try {
      await h.app.request("/api/snapshots/configs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(captureConfig())
      }, h.localEnv);
      const res = await h.app.request("/api/snapshots/configs", {}, h.localEnv);
      expect(res.status).toBe(200);
      expect((await json(res)).configs.length).toBe(1);
    } finally { h.cleanup(); }
  });

  test("capture config CRUD is local-owner only; snapshots survive config deletion", async () => {
    const h = harness();
    try {
      const remote = await h.app.request("/api/snapshots/configs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(captureConfig())
      }, h.remoteEnv);
      expect(remote.status).toBe(403);

      const created = await h.app.request("/api/snapshots/configs", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(captureConfig())
      }, h.localEnv);
      expect(created.status).toBe(200);

      h.snapshots.putSnapshot(snapshot());
      const listed = await json(await h.app.request("/api/snapshots", {}, h.localEnv));
      expect(listed.snapshots.length).toBe(1);
      expect(listed.snapshots[0].envelope.observationTimestamp).toBeNull();
      expect(listed.snapshots[0].envelope.strikes[0].greeks.gamma).toBeNull();

      await h.app.request("/api/snapshots/configs/cap-1", { method: "DELETE" }, h.localEnv);
      const after = await json(await h.app.request("/api/snapshots", {}, h.localEnv));
      expect(after.snapshots.length).toBe(1);
      expect(after.snapshots[0].configId).toBeNull();
    } finally { h.cleanup(); }
  });

  test("manual capture rejects an invalid provider enum with 400", async () => {
    const h = harness();
    try {
      const res = await h.app.request("/api/snapshots/capture", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ underlyingCanonicalId: CANON, expiryDate: "2026-01-29", provider: "NOPE" })
      }, h.localEnv);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe("invalid_request");
    } finally { h.cleanup(); }
  });

  test("manual capture with no wired provider reports unavailable, never fabricates", async () => {
    const h = harness();
    try {
      const res = await h.app.request("/api/snapshots/capture", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ underlyingCanonicalId: CANON, expiryDate: "2026-01-29" })
      }, h.localEnv);
      expect(res.status).toBe(422);
      expect((await json(res)).error).toBe("capture_unavailable");
      expect((await json(await h.app.request("/api/snapshots", {}, h.localEnv))).snapshots.length).toBe(0);
    } finally { h.cleanup(); }
  });

  test("on-demand fetch with no wired provider returns no candles", async () => {
    const h = harness();
    try {
      const res = await h.app.request("/api/historical/fetch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalId: CANON, interval: "1D", fromMs: FROM, toMs: TO })
      }, h.localEnv);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.candles.length).toBe(0);
      expect(body.providersTried.length).toBe(0);
    } finally { h.cleanup(); }
  });
});

describe("WP6A — shared retention contracts and persistence", () => {
  const allClasses = {
    version: 1,
    classes: { CANDLE: { maxAgeDays: 30 }, SNAPSHOT: { maxAgeDays: 7 }, ACTIVITY: { maxAgeDays: 9 } }
  };

  test("retentionSettingsViewSchema parses a valid all-classes view", () => {
    const parsed = retentionSettingsViewSchema.safeParse({ settings: allClasses, valid: true, error: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.valid).toBe(true);
      expect(parsed.data.settings?.classes.ACTIVITY?.maxAgeDays).toBe(9);
    }
  });

  test("retentionSettingsViewSchema treats valid empty settings as valid", () => {
    const parsed = retentionSettingsViewSchema.safeParse({ settings: { version: 1, classes: {} }, valid: true, error: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.settings?.classes).toEqual({});
  });

  test("retentionSettingsViewSchema parses an invalid view with a non-empty error", () => {
    const parsed = retentionSettingsViewSchema.safeParse({ settings: null, valid: false, error: "retention settings not configured" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.error).toBe("retention settings not configured");
  });

  test("retentionSettingsViewSchema rejects invalid branches and combinations", () => {
    expect(retentionSettingsViewSchema.safeParse({ settings: null, valid: false, error: "" }).success).toBe(false);
    expect(retentionSettingsViewSchema.safeParse({ settings: allClasses, valid: true, error: "oops" }).success).toBe(false);
    expect(retentionSettingsViewSchema.safeParse({ settings: null, valid: true, error: null }).success).toBe(false);
    expect(retentionSettingsViewSchema.safeParse({ settings: allClasses, valid: false, error: "bad" }).success).toBe(false);
    expect(retentionSettingsViewSchema.safeParse({ settings: null, valid: false, error: null }).success).toBe(false);
    expect(retentionSettingsViewSchema.safeParse({ valid: true, error: null }).success).toBe(false);
  });

  test("retentionCleanupResultSchema requires all fields and validates every count", () => {
    const ok = { ran: true, reason: null, candlesDeleted: 1, snapshotsDeleted: 2, activitiesDeleted: 3 };
    expect(retentionCleanupResultSchema.safeParse(ok).success).toBe(true);
    expect(retentionCleanupResultSchema.safeParse({ ...ok, candlesDeleted: undefined }).success).toBe(false);
    expect(retentionCleanupResultSchema.safeParse({ ...ok, candlesDeleted: 1.5 }).success).toBe(false);
    expect(retentionCleanupResultSchema.safeParse({ ...ok, candlesDeleted: -1 }).success).toBe(false);
    expect(retentionCleanupResultSchema.safeParse({ ...ok, candlesDeleted: "1" }).success).toBe(false);
    expect(retentionCleanupResultSchema.safeParse({ ...ok, reason: 5 }).success).toBe(false);
    expect(retentionCleanupResultSchema.safeParse({ ...ok, ran: "true" }).success).toBe(false);
    expect(retentionCleanupResultSchema.safeParse({ ran: false, reason: "invalid", candlesDeleted: 0, snapshotsDeleted: 0, activitiesDeleted: 0 }).success).toBe(true);
  });

  test("AppSettings.getRetention distinguishes missing, malformed, invalid, valid-empty and valid-configured", () => {
    const h = harness();
    try {
      expect(h.settings.getRetention()).toEqual({ settings: null, valid: false, error: "retention settings not configured" });

      writeRawRetention(h, "{not json");
      expect(h.settings.getRetention()).toEqual({ settings: null, valid: false, error: "retention settings malformed" });

      writeRawRetention(h, JSON.stringify({ version: 99 }));
      expect(h.settings.getRetention()).toEqual({ settings: null, valid: false, error: "retention settings invalid" });

      h.settings.setRetention({ version: 1, classes: {} });
      expect(h.settings.getRetention()).toEqual({ settings: { version: 1, classes: {} }, valid: true, error: null });

      h.settings.setRetention({ version: 1, classes: { CANDLE: { maxAgeDays: 30 } } });
      const configured = h.settings.getRetention();
      expect(configured.valid).toBe(true);
      expect(configured.settings?.classes.CANDLE?.maxAgeDays).toBe(30);
      expect(configured.error).toBeNull();
    } finally { h.cleanup(); }
  });
});

describe("WP6A — retention cleanup behavior", () => {
  test("missing settings fail closed without calling any repository", () => {
    const h = harness();
    try {
      const repos = fakeRepositories();
      const result = applyRetentionCleanup(h.settings, repos.candles, repos.snapshots, repos.activities, () => FIXED_NOW);
      expect(result).toEqual({ ran: false, reason: "retention settings not configured", candlesDeleted: 0, snapshotsDeleted: 0, activitiesDeleted: 0 });
      expect(repos.calls).toEqual([]);
    } finally { h.cleanup(); }
  });

  test("malformed and schema-invalid persisted settings fail closed", () => {
    for (const raw of ["{not json", JSON.stringify({ version: 99 })]) {
      const h = harness();
      try {
        writeRawRetention(h, raw);
        const repos = fakeRepositories();
        const result = applyRetentionCleanup(h.settings, repos.candles, repos.snapshots, repos.activities, () => FIXED_NOW);
        expect(result.ran).toBe(false);
        expect(result.candlesDeleted).toBe(0);
        expect(result.snapshotsDeleted).toBe(0);
        expect(result.activitiesDeleted).toBe(0);
        expect(repos.calls).toEqual([]);
      } finally { h.cleanup(); }
    }
  });

  test("valid empty settings run with zero deletes and no repository calls", () => {
    const h = harness();
    try {
      h.settings.setRetention({ version: 1, classes: {} });
      const repos = fakeRepositories();
      const result = applyRetentionCleanup(h.settings, repos.candles, repos.snapshots, repos.activities, () => FIXED_NOW);
      expect(result).toEqual({ ran: true, reason: null, candlesDeleted: 0, snapshotsDeleted: 0, activitiesDeleted: 0 });
      expect(repos.calls).toEqual([]);
    } finally { h.cleanup(); }
  });

  test("each configured class is cleaned independently", () => {
    const cases: Array<{
      settings: RetentionSettings;
      expectedCall: string;
      expected: { candlesDeleted: number; snapshotsDeleted: number; activitiesDeleted: number };
    }> = [
      {
        settings: { version: 1, classes: { CANDLE: { maxAgeDays: 30 } } },
        expectedCall: `candles:${FIXED_NOW - 30 * DAY_MS}`,
        expected: { candlesDeleted: 1, snapshotsDeleted: 0, activitiesDeleted: 0 }
      },
      {
        settings: { version: 1, classes: { SNAPSHOT: { maxAgeDays: 7 } } },
        expectedCall: `snapshots:${FIXED_NOW - 7 * DAY_MS}`,
        expected: { candlesDeleted: 0, snapshotsDeleted: 2, activitiesDeleted: 0 }
      },
      {
        settings: { version: 1, classes: { ACTIVITY: { maxAgeDays: 9 } } },
        expectedCall: `activities:${FIXED_NOW - 9 * DAY_MS}`,
        expected: { candlesDeleted: 0, snapshotsDeleted: 0, activitiesDeleted: 3 }
      }
    ];
    for (const c of cases) {
      const h = harness();
      try {
        h.settings.setRetention(c.settings);
        const repos = fakeRepositories();
        const result = applyRetentionCleanup(h.settings, repos.candles, repos.snapshots, repos.activities, () => FIXED_NOW);
        expect(result.ran).toBe(true);
        expect(result.candlesDeleted).toBe(c.expected.candlesDeleted);
        expect(result.snapshotsDeleted).toBe(c.expected.snapshotsDeleted);
        expect(result.activitiesDeleted).toBe(c.expected.activitiesDeleted);
        expect(repos.calls).toEqual([c.expectedCall]);
      } finally { h.cleanup(); }
    }
  });

  test("mixed configuration applies each class independently", () => {
    const h = harness();
    try {
      h.settings.setRetention({
        version: 1,
        classes: { CANDLE: { maxAgeDays: 30 }, SNAPSHOT: { maxAgeDays: 7 }, ACTIVITY: { maxAgeDays: 9 } }
      });
      const repos = fakeRepositories();
      const result = applyRetentionCleanup(h.settings, repos.candles, repos.snapshots, repos.activities, () => FIXED_NOW);
      expect(result).toEqual({ ran: true, reason: null, candlesDeleted: 1, snapshotsDeleted: 2, activitiesDeleted: 3 });
      expect(repos.calls).toEqual([
        `candles:${FIXED_NOW - 30 * DAY_MS}`,
        `snapshots:${FIXED_NOW - 7 * DAY_MS}`,
        `activities:${FIXED_NOW - 9 * DAY_MS}`
      ]);
    } finally { h.cleanup(); }
  });

  test("an omitted class does not trigger cleanup for that class", () => {
    const h = harness();
    try {
      h.settings.setRetention({ version: 1, classes: { CANDLE: { maxAgeDays: 30 }, ACTIVITY: { maxAgeDays: 9 } } });
      const repos = fakeRepositories();
      const result = applyRetentionCleanup(h.settings, repos.candles, repos.snapshots, repos.activities, () => FIXED_NOW);
      expect(result.snapshotsDeleted).toBe(0);
      expect(repos.calls).toEqual([
        `candles:${FIXED_NOW - 30 * DAY_MS}`,
        `activities:${FIXED_NOW - 9 * DAY_MS}`
      ]);
    } finally { h.cleanup(); }
  });

  test("ACTIVITY limit with no activity repository deletes nothing for that class", () => {
    const h = harness();
    try {
      h.settings.setRetention({ version: 1, classes: { ACTIVITY: { maxAgeDays: 9 } } });
      const repos = fakeRepositories();
      const result = applyRetentionCleanup(h.settings, repos.candles, repos.snapshots, undefined, () => FIXED_NOW);
      expect(result).toEqual({ ran: true, reason: null, candlesDeleted: 0, snapshotsDeleted: 0, activitiesDeleted: 0 });
      expect(repos.calls).toEqual([]);
    } finally { h.cleanup(); }
  });

  test("remote cleanup is rejected (local-owner only)", async () => {
    const h = harness();
    try {
      const res = await h.app.request("/api/retention/cleanup", { method: "POST" }, h.remoteEnv);
      expect(res.status).toBe(403);
      expect((await json(res)).error).toBe("forbidden");
    } finally { h.cleanup(); }
  });

  test("API retention and cleanup responses parse with the shared schemas", async () => {
    const h = harness();
    try {
      const before = await json(await h.app.request("/api/retention", {}, h.localEnv));
      expect(retentionSettingsViewSchema.safeParse(before).success).toBe(true);
      expect(before.valid).toBe(false);

      const saved = await json(await h.app.request("/api/retention", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, classes: {} })
      }, h.localEnv));
      expect(retentionSettingsViewSchema.safeParse(saved).success).toBe(true);
      expect(saved.valid).toBe(true);
      expect(saved.settings.classes).toEqual({});

      const cleanup = await json(await h.app.request("/api/retention/cleanup", { method: "POST" }, h.localEnv));
      expect(retentionCleanupResultSchema.safeParse(cleanup).success).toBe(true);
      expect(cleanup).toEqual({ ran: true, reason: null, candlesDeleted: 0, snapshotsDeleted: 0, activitiesDeleted: 0 });
    } finally { h.cleanup(); }
  });
});
