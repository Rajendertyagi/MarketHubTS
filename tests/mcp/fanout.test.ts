import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { createMcpNotificationBridge } from "../../apps/api/src/mcp-notification-bridge";
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

/** Real canonical source + bridge + handler — the complete M6-D publish path. */
function makeHarness(onError?: (error: unknown) => void) {
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
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, makeServices()), { maxSubscriptions: 64 });
  const bridge = createMcpNotificationBridge(service, handler.notify, onError);
  bridge.start();
  return { service, hub, handler, bridge };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

// Latency budget selected from the measured p95 at the 64-subscriber bound
// (~3.6 ms across repeated runs): 50 ms gives >12x headroom over the worst
// observed p95 and >2x over the worst observed max (20 ms). See
// docs/M6_D_FANOUT_EVIDENCE.md for the recorded measurements and rationale.
const FANOUT_LATENCY_BUDGET_MS = 50;

describe("M6-D bounded fan-out (synthetic load through the real bridge)", () => {
  test("sweep subscribers toward the bound: no drops, measured latency and memory", async () => {
    const M = 20;
    const evidence: Array<{
      n: number; m: number; minMs: number; meanMs: number; p95Ms: number; maxMs: number;
      heapDeltaMb: number; errors: number; path: string;
    }> = [];
    for (const N of [8, 32, 64]) {
      let publisherErrors = 0; // real: bridge onError callbacks (notifier failures)
      const h = makeHarness(() => { publisherErrors++; });
      const clients: Client[] = [];
      const counts = new Array<number>(N).fill(0);
      try {
        const heapBefore = process.memoryUsage().heapUsed;
        for (let i = 0; i < N; i++) {
          const client = new Client({ name: `fanout-${N}-${i}`, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
          await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
            fetch: (url, init) => h.handler.fetch(new Request(url, init))
          }));
          client.setNotificationHandler("notifications/resources/updated", () => { counts[i]!++; });
          await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
          clients.push(client);
        }

        const latencies: number[] = [];
        for (let j = 0; j < M; j++) {
          const t0 = performance.now();
          // Canonical change through MarketDataService -> bridge -> handler.notify.
          h.service.track(`FANOUT-${N}-${j}`);
          const target = j + 1;
          const deadline = performance.now() + 2000;
          while (counts.some((c) => c < target) && performance.now() < deadline) await Bun.sleep(2);
          latencies.push(performance.now() - t0);
        }
        const sorted = [...latencies].sort((a, b) => a - b);
        const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
        // Real delivery errors: total missing + total duplicate notifications
        // across all subscribers (not just the count of mismatched subscribers).
        const missing = counts.reduce((sum, c) => sum + Math.max(0, M - c), 0);
        const duplicates = counts.reduce((sum, c) => sum + Math.max(0, c - M), 0);
        const deliveryErrors = missing + duplicates;
        const errors = publisherErrors + deliveryErrors;
        const record = {
          n: N, m: M, minMs: sorted[0]!,
          meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
          p95Ms: percentile(sorted, 95), maxMs: sorted[sorted.length - 1]!,
          heapDeltaMb, publisherErrors, missing, duplicates, errors,
          path: "MarketDataService->bridge->handler.notify->subscribers"
        };
        evidence.push(record);
        console.log(`[M6-D fanout evidence] ${JSON.stringify(record)}`);
        // Every subscribed client must receive exactly M notifications.
        expect(counts.every((c) => c === M)).toBe(true);
        expect(errors).toBe(0);
      } finally {
        for (const c of clients) await c.close();
        await h.handler.close(); h.bridge.stop(); h.hub.stop();
      }
    }
    // Evidence is preserved in docs/M6_D_FANOUT_EVIDENCE.md (measured values,
    // selected bound and latency budget). The assertion uses the documented
    // budget, not the per-update observation deadline.
    const atBound = evidence.find((e) => e.n === 64)!;
    expect(atBound.errors).toBe(0);
    expect(atBound.p95Ms).toBeLessThan(FANOUT_LATENCY_BUDGET_MS);
    expect(evidence.length).toBe(3);
  });

  test("an unread SSE stream does not block the publisher; drain counts queued frames", async () => {
    const h = makeHarness();
    const fast = new Client({ name: "fast", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await fast.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => h.handler.fetch(new Request(url, init))
      }));
      let fastCount = 0;
      fast.setNotificationHandler("notifications/resources/updated", () => { fastCount++; });
      await fast.listen({ resourceSubscriptions: [SNAPSHOT_URI] });

      // Open a raw modern listen stream and deliberately do NOT read its body.
      const raw = await h.handler.fetch(new Request("http://test.local/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "subscriptions/listen"
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 99, method: "subscriptions/listen",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "slow-raw", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {}
            },
            notifications: { resourceSubscriptions: [SNAPSHOT_URI] }
          }
        })
      }));
      expect(raw.status).toBe(200);
      const heapBefore = process.memoryUsage().heapUsed;

      const t0 = performance.now();
      for (let i = 0; i < 20; i++) h.service.track(`SLOW-${i}`); // through the bridge
      const publishMs = performance.now() - t0;
      const deadline = performance.now() + 2000;
      while (fastCount < 20 && performance.now() < deadline) await Bun.sleep(2);
      const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

      // Close the handler first so the listen stream ends gracefully, then
      // drain it to count queued frames and their encoded bytes.
      await h.handler.close();
      const reader = raw.body!.getReader();
      const decoder = new TextDecoder();
      let queuedBytes = 0;
      let queuedFrames = 0;
      const drainDeadline = Date.now() + 2000;
      for (;;) {
        const result = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(1, drainDeadline - Date.now())))
        ]);
        if (result.done) break;
        queuedBytes += result.value.byteLength;
        queuedFrames += (decoder.decode(result.value).match(/event: message/g) ?? []).length;
      }
      try { await reader.cancel(); } catch { /* best effort */ }

      const slowEvidence = {
        events: 20, publishMs, fastDelivered: fastCount, heapDeltaMb,
        queuedFrames, queuedBytes, unreadStreamStatus: raw.status,
        contentType: raw.headers.get("content-type")
      };
      console.log(`[M6-D slow-consumer evidence] ${JSON.stringify(slowEvidence)}`);
      expect(fastCount).toBe(20); // other subscriber unaffected
      expect(publishMs).toBeLessThan(500); // publisher not blocked by unread stream
      expect(slowEvidence.unreadStreamStatus).toBe(200);
      expect(slowEvidence.contentType).toContain("text/event-stream");
      // The SDK has no per-stream frame/byte bound; we record the observed
      // queue size, not assert a bound the SDK does not provide.
      expect(queuedFrames).toBeGreaterThanOrEqual(20);
    } finally {
      await fast.close();
      await h.handler.close(); h.bridge.stop(); h.hub.stop();
    }
  });

  test("slow notification handler does not block the publisher or other subscribers", async () => {
    const h = makeHarness();
    const fast = new Client({ name: "fast", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const slow = new Client({ name: "slow", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      const transport = (name: string) => new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => h.handler.fetch(new Request(url, init))
      });
      await fast.connect(transport("fast"));
      await slow.connect(transport("slow"));
      let fastCount = 0;
      fast.setNotificationHandler("notifications/resources/updated", () => { fastCount++; });
      slow.setNotificationHandler("notifications/resources/updated", async () => { await Bun.sleep(50); });
      await fast.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      await slow.listen({ resourceSubscriptions: [SNAPSHOT_URI] });

      const t0 = performance.now();
      for (let i = 0; i < 10; i++) h.service.track(`SLOWH-${i}`); // through the bridge
      const publishMs = performance.now() - t0;
      const deadline = performance.now() + 2000;
      while (fastCount < 10 && performance.now() < deadline) await Bun.sleep(2);
      expect(fastCount).toBe(10);
      expect(publishMs).toBeLessThan(500);
    } finally {
      await fast.close();
      await slow.close();
      await h.handler.close(); h.bridge.stop(); h.hub.stop();
    }
  });
});
