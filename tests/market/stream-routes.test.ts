import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import {
  defaultMigrationsFolder, openDatabase, runMigrations, SqliteCatalogRepository, SqliteSubscriptionRepository
} from "../../packages/database/src/index";
import {
  canonicalInstrumentSchema, liveSnapshotSchema, providerInstrumentMappingSchema, subscriptionStateViewSchema,
  type CatalogRepository, type SubscriptionRepository
} from "../../packages/contracts/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { LockedUpstoxDriver, StreamSupervisor } from "../../apps/api/src/stream-supervisor";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const BASE = 1_700_000_000_000;

function makeDeps(opts: {
  wrapCatalog?: (real: CatalogRepository) => CatalogRepository;
  wrapSubscriptions?: (real: SubscriptionRepository) => SubscriptionRepository;
} = {}) {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-routes-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const logger = createLogger("error");
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
  const realCatalog = new SqliteCatalogRepository(db.db, db.sqlite);
  const realSubscriptions = new SqliteSubscriptionRepository(db.db, db.sqlite);
  const catalog = opts.wrapCatalog ? opts.wrapCatalog(realCatalog) : realCatalog;
  const subscriptions = opts.wrapSubscriptions ? opts.wrapSubscriptions(realSubscriptions) : realSubscriptions;
  const supervisor = new StreamSupervisor({ service, subscriptions, catalog, driver: new LockedUpstoxDriver() });
  const deps = { config, db, logger, startedAt: Date.now(), service, hub, supervisor };
  const app = createApp(deps);
  const localEnv = { requestIP: () => ({ address: "127.0.0.1" }) };
  const cleanup = () => {
    supervisor.stop();
    hub.stop();
    closeDatabaseHandle(db);
    removeTempDir(dir);
  };
  return { app, deps, catalog: realCatalog, subscriptions: realSubscriptions, service, hub, supervisor, localEnv, cleanup };
}

async function seedInstrument(catalog: SqliteCatalogRepository, canonicalId: string) {
  await catalog.transaction(async (tx) => {
    await tx.upsertInstrument(canonicalInstrumentSchema.parse({
      canonicalId, identityKey: `key:${canonicalId}`, exchange: "NSE", segment: "INDEX",
      marketType: "INDEX", instrumentCategory: "INDEX", canonicalSymbol: canonicalId, displayName: canonicalId
    }));
  });
}

interface SseFrame { event?: string; id?: string; data: string }

async function readSse(res: Response, maxEvents: number): Promise<SseFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: SseFrame[] = [];
  while (frames.length < maxEvents) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1 && frames.length < maxEvents) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame: SseFrame = { data: "" };
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("data:")) frame.data += line.slice(5).trim();
      }
      frames.push(frame);
    }
  }
  try { await reader.cancel(); } catch {}
  return frames;
}

describe("market REST routes", () => {
  test("GET /api/market/snapshot returns a Zod-valid snapshot with connections", async () => {
    const h = makeDeps();
    try {
      h.service.track(A);
      h.service.setProviderConnection("UPSTOX", "STREAMING");
      const res = await h.app.request("/api/market/snapshot");
      expect(res.status).toBe(200);
      const parsed = liveSnapshotSchema.safeParse(await res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.items.length).toBe(1);
      expect(parsed.success && parsed.data.connections[0]!.state).toBe("STREAMING");
    } finally { h.cleanup(); }
  });

  test("GET /api/market/subscriptions returns a validated view", async () => {
    const h = makeDeps();
    try {
      const res = await h.app.request("/api/market/subscriptions");
      expect(res.status).toBe(200);
      const parsed = subscriptionStateViewSchema.safeParse(await res.json());
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.generation).toBe(0);
    } finally { h.cleanup(); }
  });

  test("PUT /api/market/subscriptions is local-owner only", async () => {
    const h = makeDeps();
    try {
      const body = JSON.stringify({ selections: [] });
      const remote = await h.app.request("/api/market/subscriptions", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body
      }, { requestIP: () => ({ address: "192.168.1.50" }) });
      expect(remote.status).toBe(403);

      const local = await h.app.request("/api/market/subscriptions", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body
      }, h.localEnv);
      expect(local.status).toBe(200);
      expect((await local.json()).generation).toBe(1);
    } finally { h.cleanup(); }
  });

  test("PUT rejects unknown canonical ids atomically", async () => {
    const h = makeDeps();
    try {
      const res = await h.app.request("/api/market/subscriptions", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: [{ canonicalId: "unknown", enabled: true }] })
      }, h.localEnv);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
      expect((await h.supervisor.getView()).generation).toBe(0);
    } finally { h.cleanup(); }
  });

  test("PUT with a valid selection persists and advances generation", async () => {
    const h = makeDeps();
    try {
      await seedInstrument(h.catalog, A);
      const res = await h.app.request("/api/market/subscriptions", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: [{ canonicalId: A, enabled: true }] })
      }, h.localEnv);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.generation).toBe(1);
      expect(json.selections).toEqual([{ canonicalId: A, enabled: true }]);
    } finally { h.cleanup(); }
  });

  test("public subscription views never expose provider-native identifiers", async () => {
    const h = makeDeps();
    try {
      const NATIVE = "NSE_EQ_11536";
      await h.catalog.transaction(async (tx) => {
        await tx.upsertInstrument(canonicalInstrumentSchema.parse({
          canonicalId: A, identityKey: `key:${A}`, exchange: "NSE", segment: "INDEX",
          marketType: "INDEX", instrumentCategory: "INDEX", canonicalSymbol: A, displayName: A
        }));
        await tx.upsertMapping(providerInstrumentMappingSchema.parse({
          provider: "UPSTOX", nativeIdentifier: NATIVE, canonicalId: A, status: "ACTIVE"
        }));
      });
      const put = await h.app.request("/api/market/subscriptions", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: [{ canonicalId: A, enabled: true }] })
      }, h.localEnv);
      expect(put.status).toBe(200);
      const putText = await put.text();
      expect(putText).not.toContain(NATIVE);
      expect(JSON.parse(putText).runtime.resolutions[0]).toEqual({
        canonicalId: A, enabled: true, available: true, reason: null
      });
      const get = await h.app.request("/api/market/subscriptions");
      expect(await get.text()).not.toContain(NATIVE);
    } finally { h.cleanup(); }
  });

  test("post-commit mapping failure is reported as committed state with runtime error, not invalid_request", async () => {
    const h = makeDeps({
      wrapCatalog: (real) => ({
        async getInstrumentByCanonicalId(canonicalId: string) {
          return real.getInstrumentByCanonicalId(canonicalId);
        },
        async listMappingsByCanonicalId(): Promise<any[]> {
          throw new Error("mapping resolution failed");
        }
      } as unknown as CatalogRepository)
    });
    try {
      await seedInstrument(h.catalog, A);
      const res = await h.app.request("/api/market/subscriptions", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: [{ canonicalId: A, enabled: true }] })
      }, h.localEnv);
      expect(res.status).toBe(200); // not 400 — desired state was committed
      const json = await res.json();
      expect(json.generation).toBe(1);
      expect(json.selections).toEqual([{ canonicalId: A, enabled: true }]);
      expect(json.runtime.lastError).toContain("mapping resolution failed");
      expect((await h.subscriptions.load()).generation).toBe(1);
    } finally { h.cleanup(); }
  });

  test("persistence failure is reported as persistence_failed, not invalid_request", async () => {
    const h = makeDeps({
      wrapSubscriptions: (real) => ({
        load: () => real.load(),
        replace: async () => { throw new Error("disk write failed"); }
      })
    });
    try {
      const res = await h.app.request("/api/market/subscriptions", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections: [] })
      }, h.localEnv);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("persistence_failed");
      expect(json.message).toContain("disk write failed");
    } finally { h.cleanup(); }
  });
});

describe("market SSE route", () => {
  test("no cursor delivers an initial snapshot then live data events", async () => {
    const h = makeDeps();
    try {
      const res = await h.app.request("/api/market/stream");
      expect(res.status).toBe(200);
      h.service.track(A); // queued after the initial snapshot
      const frames = await readSse(res, 2);
      expect(frames[0]!.event).toBe("snapshot");
      expect(frames[0]!.id).toBe("0");
      expect(liveSnapshotSchema.safeParse(JSON.parse(frames[0]!.data)).success).toBe(true);
      expect(frames[1]!.event).toBe("item-updated");
      expect(frames[1]!.id).toBe("1");
    } finally { h.cleanup(); }
  });

  test("invalid Last-Event-ID emits one snapshot-required and terminates", async () => {
    const h = makeDeps();
    try {
      const res = await h.app.request("/api/market/stream", { headers: { "Last-Event-ID": "" } });
      const frames = await readSse(res, 5);
      expect(frames.length).toBe(1);
      expect(frames[0]!.event).toBe("snapshot-required");
      expect(frames[0]!.id).toBeUndefined();
    } finally { h.cleanup(); }
  });

  test("valid cursor replays only later revisions", async () => {
    const h = makeDeps();
    try {
      h.service.track(A); // rev 1
      const res = await h.app.request("/api/market/stream?since=1");
      h.service.setProviderConnection("UPSTOX", "STREAMING"); // rev 2
      const frames = await readSse(res, 1);
      expect(frames[0]!.event).toBe("provider-connection-changed");
      expect(frames[0]!.id).toBe("2");
    } finally { h.cleanup(); }
  });
});
