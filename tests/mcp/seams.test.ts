import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { LockedUpstoxDriver, StreamSupervisor } from "../../apps/api/src/stream-supervisor";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import {
  defaultMigrationsFolder, openDatabase, runMigrations, SqliteCatalogRepository, SqliteSubscriptionRepository
} from "../../packages/database/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const BASE = 1_700_000_000_000;

function makeApp() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-b1-seams-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_LAN: "false" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const service = new MarketDataService({
    now: () => new Date(BASE),
    policy: { openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000 },
    maxInstruments: 20,
    session: () => "OPEN"
  });
  const hub = new LiveEventHub(service, {
    replayMaxEvents: 100, replayMaxBytes: 1_000_000,
    clientMaxEvents: 100, clientMaxBytes: 1_000_000, refreshIntervalMs: 0
  });
  hub.start();
  const catalog = new SqliteCatalogRepository(db.db, db.sqlite);
  const subscriptions = new SqliteSubscriptionRepository(db.db, db.sqlite);
  const supervisor = new StreamSupervisor({ service, subscriptions, catalog, driver: new LockedUpstoxDriver() });
  const app = createApp({
    config, db, logger: createLogger("error"), startedAt: Date.now(), service, hub, supervisor, catalogRepo: catalog
  });
  const cleanup = () => {
    supervisor.stop();
    hub.stop();
    closeDatabaseHandle(db);
    removeTempDir(dir);
  };
  return { app, service, hub, catalog, cleanup };
}

describe("M6-B1 HTTP seams", () => {
  test("GET /api/catalog/search validates input and returns the bounded contract", async () => {
    const { app, cleanup } = makeApp();
    try {
      expect((await app.request("/api/catalog/search?text=")).status).toBe(400);
      expect((await app.request("/api/catalog/search?text=abc&limit=101")).status).toBe(400);
      expect((await app.request("/api/catalog/search?text=abc&limit=0")).status).toBe(400);

      const ok = await app.request("/api/catalog/search?text=abc&limit=25");
      expect(ok.status).toBe(200);
      const json = await ok.json();
      expect(Array.isArray(json.instruments)).toBe(true);
      expect(json.nextCursor === null || typeof json.nextCursor === "string").toBe(true);
    } finally {
      cleanup();
    }
  });

  test("GET /api/market/events validates limit and returns the bounded contract", async () => {
    const { app, service, hub, cleanup } = makeApp();
    try {
      expect((await app.request("/api/market/events?limit=0")).status).toBe(400);
      expect((await app.request("/api/market/events?limit=101")).status).toBe(400);
      expect((await app.request("/api/market/events?limit=abc")).status).toBe(400);

      service.track(A);
      const ok = await app.request("/api/market/events?limit=25");
      expect(ok.status).toBe(200);
      const json = await ok.json();
      expect(Array.isArray(json.events)).toBe(true);
      expect(json.nextCursor === null || typeof json.nextCursor === "string").toBe(true);
      expect(typeof json.resumeCursor).toBe("string"); // checkpoint present even on final/empty pages
      expect(json.snapshotRequired).toBeUndefined();

      const badCursor = await app.request("/api/market/events?after=not-a-number&limit=25");
      expect(badCursor.status).toBe(200);
      const badJson = await badCursor.json();
      expect(badJson.snapshotRequired?.reason).toBe("invalid-cursor");
      void hub;
    } finally {
      cleanup();
    }
  });
});
