import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import {
  AppSettings, SnapshotRepository, defaultMigrationsFolder, openDatabase, runMigrations
} from "../../packages/database/src/index";
import type { OptionChainCaptureConfig, OptionChainSnapshot } from "../../packages/contracts/src/index";
import { OptionChainSnapshotService } from "../../packages/market-core/src/index";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const UNDERLYING = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";

function harness() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "mh-b3-page-route-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const snapshots = new SnapshotRepository(db.db, db.sqlite);
  const settings = new AppSettings(db.db);
  const service = new OptionChainSnapshotService({ snapshots, settings, providers: [] });
  const app = createApp({
    config, db, logger: createLogger("error"), startedAt: Date.now(),
    snapshotRepo: snapshots, snapshotService: service
  });
  return { app, snapshots, service, cleanup: () => { closeDatabaseHandle(db); removeTempDir(dir); } };
}

function config(id: string): OptionChainCaptureConfig {
  return {
    id, underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29", strikeRangeJson: null,
    captureEnabled: true, captureMode: "MANUAL", scheduleJson: null, streamingEnabled: false,
    provider: "UPSTOX", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function snap(id: string, configId: string | null, capturedAt: string): OptionChainSnapshot {
  return {
    id, configId, capturedAt, provider: "UPSTOX",
    envelope: {
      underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29", capturedAt,
      observationTimestamp: null, underlyingLtp: 25000,
      strikes: [{ strike: 25000, optionType: "CE", ltp: 100, oi: 0 }],
      providerExtensions: {}
    } as OptionChainSnapshot["envelope"],
    provenance: { source: "provider-feed", provider: "UPSTOX", receivedAt: capturedAt }
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

describe("M6-B3 snapshot page endpoint", () => {
  test("scope=config with a real id 'none' works; unknown config is 404", async () => {
    const h = harness();
    try {
      h.service.putCaptureConfig(config("none"));
      h.snapshots.putSnapshot(snap("s1", "none", "2026-01-02T00:00:00.000Z"));
      const ok = await h.app.request("/api/snapshots/page?scope=config&configId=none&limit=25&cursor=first");
      expect(ok.status).toBe(200);
      const body = await json(ok);
      expect((body.snapshots as Array<{ id: string }>).map((s) => s.id)).toEqual(["s1"]);

      const missing = await h.app.request("/api/snapshots/page?scope=config&configId=missing&limit=25&cursor=first");
      expect(missing.status).toBe(404);
    } finally { h.cleanup(); }
  });

  test("scope=null-config returns the null-config partition and rejects configId", async () => {
    const h = harness();
    try {
      h.snapshots.putSnapshot(snap("od", null, "2026-01-01T00:00:00.000Z"));
      h.service.putCaptureConfig(config("cfg"));
      h.snapshots.putSnapshot(snap("cfg1", "cfg", "2026-01-02T00:00:00.000Z"));
      h.service.deleteCaptureConfig("cfg");
      const ok = await h.app.request("/api/snapshots/page?scope=null-config&limit=25&cursor=first");
      expect(ok.status).toBe(200);
      const body = await json(ok);
      expect((body.snapshots as Array<{ id: string }>).map((s) => s.id).sort()).toEqual(["cfg1", "od"]);

      const conflict = await h.app.request("/api/snapshots/page?scope=null-config&configId=x&limit=25&cursor=first");
      expect(conflict.status).toBe(400);
    } finally { h.cleanup(); }
  });

  test("unknown scope, missing configId and invalid limit are 400", async () => {
    const h = harness();
    try {
      expect((await h.app.request("/api/snapshots/page?scope=bogus&limit=25&cursor=first")).status).toBe(400);
      expect((await h.app.request("/api/snapshots/page?scope=config&limit=25&cursor=first")).status).toBe(400);
      expect((await h.app.request("/api/snapshots/page?scope=null-config&limit=0&cursor=first")).status).toBe(400);
      expect((await h.app.request("/api/snapshots/page?scope=null-config&limit=101&cursor=first")).status).toBe(400);
    } finally { h.cleanup(); }
  });

  test("malformed cursor is 400, never an empty 200", async () => {
    const h = harness();
    try {
      const res = await h.app.request("/api/snapshots/page?scope=null-config&limit=25&cursor=garbage");
      expect(res.status).toBe(400);
    } finally { h.cleanup(); }
  });

  test("static /page route is not shadowed by dynamic /:id", async () => {
    const h = harness();
    try {
      const res = await h.app.request("/api/snapshots/page?scope=null-config&limit=25&cursor=first");
      expect(res.status).toBe(200);
    } finally { h.cleanup(); }
  });
});
