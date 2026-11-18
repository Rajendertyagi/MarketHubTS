import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import {
  AppSettings, CandleRepository, SnapshotRepository, defaultMigrationsFolder, openDatabase, runMigrations
} from "../../packages/database/src/index";
import type { HistoricalCandle, HistoricalSyncConfig, OptionChainCaptureConfig, OptionChainSnapshot } from "../../packages/contracts/src/index";
import { createApp } from "../../apps/api/src/app";
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
  return { app, localEnv, remoteEnv, candles, snapshots, settings, cleanup };
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
