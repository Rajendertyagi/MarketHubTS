import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { createMcpNotificationBridge } from "../../apps/api/src/mcp-notification-bridge";
import { buildMcpAllowlists, validateMcpRequest } from "../../apps/api/src/mcp-routes";

const PROTOCOL = "2026-07-28";
const SNAPSHOT_URI = "markethub://market/snapshot";
const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

async function readJson(client: Client, uri: string): Promise<Record<string, unknown>> {
  const result = await client.readResource({ uri });
  const first = result.contents?.[0];
  if (!first || !("text" in first)) throw new Error(`no text content for ${uri}`);
  return JSON.parse(first.text) as Record<string, unknown>;
}

/**
 * M6-E LAN simulation — ONE standalone, fully in-process test.
 *
 * No second device, no listener, no socket, no Bun.serve, no temp DB, no CLI and
 * no external dependency. It drives the official MCP client through a mocked
 * `fetch` against the real handler, with an in-memory canonical source and the
 * real notification bridge. It also exercises the production Host/Origin helper.
 *
 * This is a mocked simulation. It does NOT verify physical LAN reachability,
 * which is outside the revised M6 scope (user-approved scope change). It does
 * NOT replace `http-integration.test.ts`, which remains the real-listener gate.
 */
describe("M6-E LAN simulation (in-process, no listener)", () => {
  test("composed discovery, capabilities, subscription, notification, read-after-notify and Host/Origin", async () => {
    // In-memory canonical source + feed + bridge — no database, no network.
    const service = new MarketDataService({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      policy: { openMaxAgeMs: 60_000, unknownMaxAgeMs: 60_000, maxRetainedObservationAgeMs: 86_400_000 },
      maxInstruments: 100,
      session: () => "UNKNOWN" as const
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
        if (r.outcome === "snapshot-required") {
          return { ok: true, value: { events: [], nextCursor: null, snapshotRequired: { reason: r.reason } } };
        }
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

    const client = new Client(
      { name: "m6e-lan-simulation", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: PROTOCOL } } }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL("http://simulation.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init))
    }));

    let subscription: Awaited<ReturnType<Client["listen"]>> | null = null;
    try {
      // 1. Modern protocol discovery and version.
      const discovery = await client.discover();
      expect(client.getNegotiatedProtocolVersion()).toBe(PROTOCOL);
      expect(discovery.supportedVersions).toContain(PROTOCOL);

      // 2. resources.subscribe capability.
      expect(discovery.capabilities.resources?.subscribe).toBe(true);

      // 3. Tool, resource and resource-template access.
      const [tools, resources, templates] = await Promise.all([
        client.listTools(), client.listResources(), client.listResourceTemplates()
      ]);
      expect(tools.tools.some((t) => t.name === "markethub_health")).toBe(true);
      expect(resources.resources.length).toBeGreaterThan(0);
      expect(templates.resourceTemplates.length).toBeGreaterThan(0);
      const health = await client.callTool({ name: "markethub_health", arguments: {} });
      expect(health.isError).not.toBe(true);

      // 4. Snapshot reading (initial revision).
      const before = await readJson(client, SNAPSHOT_URI);
      expect(typeof before.revision).toBe("number");

      // 5. subscriptions/listen: handler registered BEFORE listen; ack first; filter honored.
      let notifications = 0;
      let ackDone = false;
      let notifiedBeforeAck = false;
      client.setNotificationHandler("notifications/resources/updated", () => {
        notifications++;
        if (!ackDone) notifiedBeforeAck = true;
      });
      subscription = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      ackDone = true;
      expect(subscription.honoredFilter.resourceSubscriptions).toEqual([SNAPSHOT_URI]);
      expect(notifiedBeforeAck).toBe(false);

      // 6. Simulated canonical update through the real notification bridge.
      service.track("LAN-SIM-1");

      // 7. Notification delivery (bounded wait).
      await waitFor(() => notifications >= 1, 2_000, "resource-updated notification");
      expect(notifications).toBe(1);

      // 8. Snapshot revision advanced after the notification.
      const after = await readJson(client, SNAPSHOT_URI);
      expect(typeof after.revision).toBe("number");
      expect(after.revision as number).toBeGreaterThan(before.revision as number);

      // 9. Live-feed read and incremental cursor behavior.
      const feed = await readJson(client, "markethub://events/live?after=first&limit=100");
      const events = Array.isArray(feed.events) ? feed.events as Array<Record<string, unknown>> : [];
      const synthetic = events.find((e) => {
        const data = (e.data && typeof e.data === "object") ? e.data as Record<string, unknown> : {};
        return e.event === "item-updated" && data.canonicalId === "LAN-SIM-1";
      });
      expect(synthetic).toBeDefined();
      expect(typeof feed.resumeCursor).toBe("string");
      const next = await readJson(client, `markethub://events/live?after=${encodeURIComponent(feed.resumeCursor as string)}&limit=100`);
      expect(Array.isArray(next.events)).toBe(true);
      expect((next.events as unknown[]).length).toBe(0); // no replay after the checkpoint

      // 10. Valid and invalid Host/Origin through the existing production helper.
      resetConfigCache();
      const config = loadConfig({ env: { MARKETHUB_LAN: "true", MARKETHUB_HOST: "127.0.0.1" } });
      const allowlists = buildMcpAllowlists(config);
      const request = (headers: Record<string, string>) =>
        new Request("http://simulation.local/mcp", { headers });
      expect(validateMcpRequest(request({ Host: "127.0.0.1:31337", Origin: "http://127.0.0.1" }), allowlists)).toBeUndefined();
      expect(validateMcpRequest(request({ Host: "evil.example:31337" }), allowlists)?.status).toBe(403);
      expect(validateMcpRequest(request({ Host: "127.0.0.1:31337", Origin: "http://evil.example" }), allowlists)?.status).toBe(403);
    } finally {
      if (subscription) await subscription.close();
      await client.close();
      await handler.close();
      bridge.stop();
      hub.stop();
    }
  });
});
