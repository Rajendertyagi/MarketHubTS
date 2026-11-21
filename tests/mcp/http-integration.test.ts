import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { createMcpNotificationBridge } from "../../apps/api/src/mcp-notification-bridge";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});
const SNAPSHOT_URI = "markethub://market/snapshot";

function makeHarness() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-m6e-http-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_LAN: "false" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);

  const service = new MarketDataService({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    policy: { openMaxAgeMs: 60_000, unknownMaxAgeMs: 60_000, maxRetainedObservationAgeMs: 86_400_000 },
    maxInstruments: 500,
    session: () => "OPEN" as const
  });
  const hub = new LiveEventHub(service, {
    replayMaxEvents: 1000, replayMaxBytes: 10_000_000,
    clientMaxEvents: 1000, clientMaxBytes: 10_000_000, refreshIntervalMs: 0
  });
  hub.start();

  const services: McpServices = {
    getHealth: async () => ({ ok: true, value: HEALTH }),
    searchCatalog: async () => ({ ok: true, value: { instruments: [], nextCursor: null } }),
    readEventFeed: async (req) => {
      const r = hub.readAfter(req.after, req.limit);
      if (r.outcome === "snapshot-required") return { ok: true, value: { events: [], nextCursor: null, snapshotRequired: { reason: r.reason } } };
      return { ok: true, value: { events: r.events, nextCursor: r.nextCursor, resumeCursor: r.resumeCursor } };
    },
    getProviderStatus: async () => ({ ok: true, value: {} as never }),
    getLiveSnapshot: async () => ({ ok: true, value: service.getSnapshot() as never }),
    getCachedCandles: async () => ({ ok: true, value: { candles: [] } }),
    getCoverage: async () => ({ ok: true, value: { gaps: [], unavailableNotes: [] } }),
    fetchHistorical: async () => ({ ok: true, value: { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] } }),
    listSnapshots: async () => ({ ok: true, value: { snapshots: [] } }),
    listSnapshotsPage: async () => ({ ok: true, value: { snapshots: [], nextCursor: null } }),
    getSnapshot: async (id) => ({ ok: true, value: { id } as never }),
    captureSnapshot: async () => ({ ok: true, value: { snapshot: null, error: "no provider available" } }),
    startActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured" } }),
    completeActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured" } })
  };

  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services), { maxSubscriptions: 64 });
  const bridge = createMcpNotificationBridge(service, handler.notify);
  bridge.start();
  const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now(), mcpHandler: handler });
  return { dir, db, config, service, hub, handler, bridge, app };
}

async function connect(url: string, name: string) {
  const client = new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe("M6-E real HTTP integration (actual listener + pinned client)", () => {
  test("discovery, tools, resources, prompts, subscriptions and read-after-notify over a real listener", async () => {
    const h = makeHarness();
    let server: ReturnType<typeof Bun.serve> | null = null;
    const clients: Client[] = [];
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;

      const c1 = await connect(url, "m6e-1");
      const c2 = await connect(url, "m6e-2");
      clients.push(c1, c2);

      // Modern discovery + capabilities.
      expect(c1.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const discover = await c1.getDiscoverResult();
      const caps = discover.capabilities as Record<string, Record<string, unknown>>;
      expect(caps.resources?.subscribe).toBe(true);
      expect(caps.tools?.listChanged).toBe(false);

      // Tools, resources, prompts over the real listener.
      const tools = await c1.listTools();
      expect(tools.tools.some((t) => t.name === "markethub_health")).toBe(true);
      const health = await c1.callTool({ name: "markethub_health", arguments: {} });
      expect(health.isError).not.toBe(true);
      const snap = await c1.readResource({ uri: SNAPSHOT_URI });
      expect(snap.contents[0]!.mimeType).toBe("application/json");
      const prompt = await c1.getPrompt({ name: "explain_market_snapshot", arguments: {} });
      expect(prompt.messages.length).toBeGreaterThan(0);

      // Subscriptions: c1 subscribes, c2 does not.
      let c1Notifications = 0;
      let c2Notifications = 0;
      c1.setNotificationHandler("notifications/resources/updated", () => { c1Notifications++; });
      c2.setNotificationHandler("notifications/resources/updated", () => { c2Notifications++; });
      const sub = await c1.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      expect(sub.honoredFilter.resourceSubscriptions).toEqual([SNAPSHOT_URI]);

      // Synthetic canonical change through the real bridge.
      h.service.track("NIFTY");
      const deadline = Date.now() + 2000;
      while (c1Notifications < 1 && Date.now() < deadline) await Bun.sleep(5);
      expect(c1Notifications).toBeGreaterThanOrEqual(1);
      expect(c2Notifications).toBe(0);

      // Read-after-notify: snapshot reflects the change; feed returns the event.
      const snap2 = await c1.readResource({ uri: SNAPSHOT_URI });
      const snapBody = JSON.parse(snap2.contents[0]!.text) as { revision: number };
      expect(snapBody.revision).toBeGreaterThanOrEqual(1);
      const feed = await c1.readResource({ uri: "markethub://events/live?after=first&limit=100" });
      const feedBody = JSON.parse(feed.contents[0]!.text) as { events: unknown[]; resumeCursor: string };
      expect(feedBody.events.length).toBeGreaterThanOrEqual(1);
      expect(typeof feedBody.resumeCursor).toBe("string");
      // Incremental read using the saved cursor (not a fresh bootstrap).
      const incremental = await c1.readResource({ uri: `markethub://events/live?after=${feedBody.resumeCursor}&limit=100` });
      const incrementalBody = JSON.parse(incremental.contents[0]!.text) as { events: unknown[]; resumeCursor: string };
      expect(Array.isArray(incrementalBody.events)).toBe(true);
      expect(typeof incrementalBody.resumeCursor).toBe("string");

      await sub.close();
    } finally {
      for (const c of clients) await c.close();
      await h.handler.close();
      h.bridge.stop();
      h.hub.stop();
      if (server) await server.stop(true);
      closeDatabaseHandle(h.db);
      removeTempDir(h.dir);
    }
  });

  test("missed-event catch-up: >100 events while disconnected, reconnect, page through nextCursor", async () => {
    const h = makeHarness(); // replayMaxEvents=1000 retains the whole workload
    let server: ReturnType<typeof Bun.serve> | null = null;
    let client: Client | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;
      client = await connect(url, "catchup");

      const sub1 = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      await sub1.close(); // disconnect

      // Create 150 events while disconnected (feed per-read bound is 100).
      for (let i = 1; i <= 150; i++) h.service.track(`CATCHUP-${i}`);
      // Confirm the hub retained the whole workload (otherwise this becomes an expiry test).
      const probe = h.hub.readAfter(undefined, 100);
      expect(probe.outcome).toBe("page");
      if (probe.outcome === "page") expect(probe.events.length).toBe(100);

      // Reconnect: new listen stream, ack, then immediate catch-up with NO later mutation.
      const sub2 = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      expect(sub2.honoredFilter.resourceSubscriptions).toEqual([SNAPSHOT_URI]);

      const seen: number[] = [];
      let after = "first";
      for (;;) {
        const res = await client.readResource({ uri: `markethub://events/live?after=${after}&limit=100` });
        const body = JSON.parse(res.contents[0]!.text) as { events: Array<{ data: { revision: number } }>; nextCursor: string | null; resumeCursor: string };
        for (const ev of body.events) seen.push(ev.data.revision);
        if (body.nextCursor === null) break;
        after = body.nextCursor;
      }
      expect(seen.length).toBe(150);
      expect(seen[0]).toBe(1);
      expect(seen[149]).toBe(150);
      await sub2.close();
    } finally {
      if (client) await client.close();
      await h.handler.close(); h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true);
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  });

  test("reconnect reuses the saved feed cursor and recovers a missed event", async () => {
    const h = makeHarness();
    let server: ReturnType<typeof Bun.serve> | null = null;
    let client: Client | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;
      client = await connect(url, "reconnect");
      const sub1 = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      const first = await client.readResource({ uri: "markethub://events/live?after=first&limit=100" });
      const firstBody = JSON.parse(first.contents[0]!.text) as { resumeCursor: string };
      await sub1.close();

      h.service.track("MISSED-1"); // mutate while disconnected
      const sub2 = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      const res = await client.readResource({ uri: `markethub://events/live?after=${firstBody.resumeCursor}&limit=100` });
      const body = JSON.parse(res.contents[0]!.text) as { events: unknown[] };
      expect(body.events.length).toBeGreaterThanOrEqual(1);
      await sub2.close();
    } finally {
      if (client) await client.close();
      await h.handler.close(); h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true);
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  });

  test("two concurrent subscriptions with distinct filters are isolated", async () => {
    const h = makeHarness();
    let server: ReturnType<typeof Bun.serve> | null = null;
    let client: Client | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;
      client = await connect(url, "multi-sub");
      let snapCount = 0;
      client.setNotificationHandler("notifications/resources/updated", () => { snapCount++; });
      const subA = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      const subB = await client.listen({ resourceSubscriptions: ["markethub://other/resource"] });
      expect(subA.honoredFilter.resourceSubscriptions).toEqual([SNAPSHOT_URI]);
      expect(subB.honoredFilter.resourceSubscriptions).toEqual(["markethub://other/resource"]);
      h.service.track("MULTI-1");
      const deadline = Date.now() + 2000;
      while (snapCount < 1 && Date.now() < deadline) await Bun.sleep(5);
      expect(snapCount).toBe(1); // only subA's URI matched
      await subA.close();
      await subB.close();
    } finally {
      if (client) await client.close();
      await h.handler.close(); h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true);
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  });

  test("malformed modern headers and unsupported methods are rejected", async () => {
    const h = makeHarness();
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;
      // Missing required modern headers on a modern-enveloped request.
      const bad = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/list",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } }
        })
      });
      expect(bad.status).toBe(400);
      // Unsupported method on a valid modern request.
      const unknown = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "no/such/method"
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "no/such/method",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } }
        })
      });
      expect([400, 404]).toContain(unknown.status);
    } finally {
      await h.handler.close(); h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true);
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  });

  test("Host/Origin validation and CORS preflight on the real listener", async () => {
    const h = makeHarness();
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;
      const badHost = await fetch(url, {
        method: "POST",
        headers: { Host: "evil.example", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} })
      });
      expect(badHost.status).toBe(403);
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type, mcp-protocol-version, mcp-method, mcp-name"
        }
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    } finally {
      await h.handler.close();
      h.bridge.stop();
      h.hub.stop();
      if (server) await server.stop(true);
      closeDatabaseHandle(h.db);
      removeTempDir(h.dir);
    }
  });
});
