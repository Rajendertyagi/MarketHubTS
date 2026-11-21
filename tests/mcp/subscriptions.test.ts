import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

const SNAPSHOT_URI = "markethub://market/snapshot";

function makeServices(): McpServices {
  return {
    getHealth: async () => ({ ok: true, value: HEALTH }),
    searchCatalog: async () => ({ ok: true, value: { instruments: [], nextCursor: null } }),
    readEventFeed: async () => ({ ok: true, value: { events: [], nextCursor: null, resumeCursor: "r:0" } }),
    getProviderStatus: async () => ({ ok: true, value: {} as never }),
    getLiveSnapshot: async () => ({ ok: true, value: { revision: 0, capturedAtMs: 0, items: [], connections: [] } as never }),
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
}

function makeHandler(opts?: { maxSubscriptions?: number }) {
  return createMcpHandler((ctx) => createMcpServer(ctx, makeServices()), opts);
}

async function connect(handler: ReturnType<typeof createMcpHandler>, name = "sub-test") {
  const client = new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  return client;
}

describe("M6-D subscriptions (modern HTTP, in-process)", () => {
  test("server/discover advertises explicit capabilities: listChanged false, resources.subscribe true", async () => {
    const handler = makeHandler();
    const client = await connect(handler);
    try {
      const discover = await client.getDiscoverResult();
      const caps = discover.capabilities as Record<string, Record<string, unknown>>;
      expect(caps.tools?.listChanged).toBe(false);
      expect(caps.prompts?.listChanged).toBe(false);
      expect(caps.resources?.listChanged).toBe(false);
      expect(caps.resources?.subscribe).toBe(true);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("listen ack is first, honors only the requested URI, and notifications carry subscriptionId", async () => {
    const handler = makeHandler();
    const client = await connect(handler);
    try {
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      client.setNotificationHandler("notifications/resources/updated", (n) => {
        notifications.push({ method: "notifications/resources/updated", params: n.params as Record<string, unknown> });
      });

      const sub = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      expect(sub.honoredFilter.resourceSubscriptions).toEqual([SNAPSHOT_URI]);
      expect(sub.honoredFilter.toolsListChanged).toBeUndefined();

      handler.notify.resourceUpdated(SNAPSHOT_URI);
      await Bun.sleep(20);
      expect(notifications.length).toBe(1);
      const meta = notifications[0]!.params._meta as Record<string, unknown>;
      expect(meta["io.modelcontextprotocol/subscriptionId"]).toBeDefined();

      await sub.close();
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("unsubscribed clients receive no notification; two subscriptions are isolated", async () => {
    const handler = makeHandler();
    const c1 = await connect(handler, "sub-1");
    const c2 = await connect(handler, "sub-2");
    try {
      let c1Count = 0;
      let c2Count = 0;
      c1.setNotificationHandler("notifications/resources/updated", () => { c1Count++; });
      c2.setNotificationHandler("notifications/resources/updated", () => { c2Count++; });

      const sub1 = await c1.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      // c2 opens a listen with an empty honored filter (no resourceSubscriptions).
      const sub2 = await c2.listen({});
      expect(sub2.honoredFilter.resourceSubscriptions).toBeUndefined();

      handler.notify.resourceUpdated(SNAPSHOT_URI);
      await Bun.sleep(20);
      expect(c1Count).toBe(1);
      expect(c2Count).toBe(0);

      await sub1.close();
      await sub2.close();
    } finally {
      await c1.close();
      await c2.close();
      await handler.close();
    }
  });

  test("exact URI filtering: a different URI does not reach the subscriber", async () => {
    const handler = makeHandler();
    const client = await connect(handler);
    try {
      let count = 0;
      client.setNotificationHandler("notifications/resources/updated", () => { count++; });
      const sub = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      handler.notify.resourceUpdated("markethub://other/resource");
      await Bun.sleep(20);
      expect(count).toBe(0);
      await sub.close();
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("maxSubscriptions bound rejects an extra listen in-band", async () => {
    const handler = makeHandler({ maxSubscriptions: 1 });
    const client = await connect(handler);
    try {
      const sub1 = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      expect(sub1.honoredFilter.resourceSubscriptions).toEqual([SNAPSHOT_URI]);
      // A second listen on the same handler should be refused before ack.
      let refused = false;
      try {
        const sub2 = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
        await sub2.close();
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      await sub1.close();
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("handler.close() completes an active listen stream gracefully", async () => {
    const handler = makeHandler();
    const client = await connect(handler);
    try {
      const sub = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      const closePromise = handler.close();
      const reason = await sub.closed;
      expect(reason).toBe("graceful");
      await closePromise;
    } finally {
      await client.close();
    }
  });
});
