import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { createMcpNotificationBridge } from "../../apps/api/src/mcp-notification-bridge";
import {
  wrapMcpHandlerFetch,
  MCP_SSE_MAX_BUFFERED_BYTES,
  MCP_SSE_MAX_BUFFERED_FRAMES,
  SSE_OVERFLOW_REASON,
  type BoundedSseOptions,
  type SseBufferSample,
  type SseOverflowInfo
} from "../../apps/api/src/mcp-sse-bound";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});
const SNAPSHOT_URI = "markethub://market/snapshot";
const FANOUT_LATENCY_BUDGET_MS = 50; // unchanged (docs/M6_D_FANOUT_EVIDENCE.md §3)

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

/** Real canonical source + wrapped handler + bridge — the complete M6-D path. */
function makeHarness(options: BoundedSseOptions) {
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
  const rawHandler = createMcpHandler((ctx) => createMcpServer(ctx, makeServices()), {
    maxSubscriptions: 64,
    keepAliveMs: 0 // deterministic frame counts; keepalives are not part of the bound derivation
  });
  const handler = wrapMcpHandlerFetch(rawHandler, options);
  const bridge = createMcpNotificationBridge(service, handler.notify);
  bridge.start();
  return { service, hub, handler, bridge };
}

/** Raw modern `subscriptions/listen` POST, pinned to 2026-07-28. */
function rawListenRequest(): Request {
  return new Request("http://test.local/mcp", {
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
  });
}

async function connectHealthy(handler: ReturnType<typeof makeHarness>["handler"], name: string) {
  const client = new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  let count = 0;
  client.setNotificationHandler("notifications/resources/updated", () => { count++; });
  await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
  return { client, count: () => count };
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 2000) {
  const decoder = new TextDecoder();
  let bytes = 0;
  let frames = 0;
  let keepalives = 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))
    ]);
    if (result.done) break;
    const text = decoder.decode(result.value);
    bytes += result.value.byteLength;
    frames += (text.match(/event: message/g) ?? []).length;
    keepalives += (text.match(/: keepalive/g) ?? []).length;
  }
  return { bytes, frames, keepalives };
}

function overflowTracker() {
  const infos: SseOverflowInfo[] = [];
  let resolve!: (info: SseOverflowInfo) => void;
  const first = new Promise<SseOverflowInfo>((r) => { resolve = r; });
  const onOverflow = (info: SseOverflowInfo): void => { infos.push(info); resolve(info); };
  return { infos, first, onOverflow };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), ms))
  ]);
}

function highWater(samples: SseBufferSample[]) {
  return {
    frames: samples.reduce((m, s) => Math.max(m, s.bufferedFrames), 0),
    bytes: samples.reduce((m, s) => Math.max(m, s.bufferedBytes), 0)
  };
}

describe("M6-D slow-consumer mitigation (bounded SSE wrapper, black-box)", () => {
  test("T1: sustained unread stream is bounded; upstream cancel invoked; downstream EOF", async () => {
    const tracker = overflowTracker();
    const cancels: unknown[] = [];
    const samples: SseBufferSample[] = [];
    const h = makeHarness({
      maxBufferedBytes: MCP_SSE_MAX_BUFFERED_BYTES,
      maxBufferedFrames: MCP_SSE_MAX_BUFFERED_FRAMES,
      onOverflow: tracker.onOverflow,
      onBuffered: (s) => samples.push(s),
      onUpstreamCancel: (reason) => cancels.push(reason)
    });
    try {
      const raw = await h.handler.fetch(rawListenRequest());
      expect(raw.status).toBe(200);
      expect(raw.headers.get("content-type")).toContain("text/event-stream");
      const reader = raw.body!.getReader();

      // Sustained sequence through the canonical bridge path — far more than the cap.
      const published = MCP_SSE_MAX_BUFFERED_FRAMES + 40;
      for (let i = 0; i < published; i++) h.service.track(`T1-${i}`);

      const info = await withTimeout(tracker.first, 3000, "T1: overflow did not occur");
      expect(info.reason).toBe(SSE_OVERFLOW_REASON);
      expect(info.bufferedFrames).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_FRAMES);
      expect(info.bufferedBytes).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_BYTES);

      // Application-owned buffer never exceeded the measured cap.
      const hw = highWater(samples);
      expect(hw.frames).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_FRAMES);
      expect(hw.bytes).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_BYTES);

      // Normative upstream cancellation happened with the overflow reason.
      expect(cancels).toContain(SSE_OVERFLOW_REASON);

      // Downstream ends with a plain EOF; queued frames were dropped on overflow.
      const drained = await drain(reader);
      expect(drained.frames).toBe(0);
    } finally {
      await h.handler.close();
      h.bridge.stop();
      h.hub.stop();
    }
  });

  test("T2: after overflow the bounded stream gets no further frames; healthy sibling still does; clean close", async () => {
    const tracker = overflowTracker();
    const h = makeHarness({
      maxBufferedBytes: MCP_SSE_MAX_BUFFERED_BYTES,
      maxBufferedFrames: MCP_SSE_MAX_BUFFERED_FRAMES,
      onOverflow: tracker.onOverflow
    });
    const healthy = await connectHealthy(h.handler, "t2-healthy");
    try {
      const raw = await h.handler.fetch(rawListenRequest());
      const reader = raw.body!.getReader();

      const firstBatch = MCP_SSE_MAX_BUFFERED_FRAMES + 40;
      for (let i = 0; i < firstBatch; i++) {
        h.service.track(`T2a-${i}`);
        // Realistic pacing: canonical changes arrive as streamed ticks, not a
        // tight synchronous loop. The unread stream still accumulates every
        // frame and overflows; the healthy sibling keeps up (T5 envelope ~6 frames).
        if (i % 5 === 0) await Bun.sleep(1);
      }
      await withTimeout(tracker.first, 3000, "T2: overflow did not occur");

      // Drain the bounded stream fully: plain EOF, no queued frames survive overflow.
      const before = await drain(reader);
      expect(before.frames).toBe(0);

      // Publish N more canonical changes after overflow.
      const N = 10;
      for (let i = 0; i < N; i++) h.service.track(`T2b-${i}`);
      const target = firstBatch + N;
      const deadline = Date.now() + 2000;
      while (healthy.count() < target && Date.now() < deadline) await Bun.sleep(2);

      // Healthy sibling still receives every change; bounded stream receives none.
      expect(healthy.count()).toBe(target);
      const after = await drain(reader);
      expect(after.frames).toBe(0);

      // handler.close() completes cleanly after a cancelled stream.
      await withTimeout(h.handler.close(), 3000, "T2: handler.close() did not complete");
    } finally {
      await healthy.client.close();
      await h.handler.close();
      h.bridge.stop();
      h.hub.stop();
    }
  });

  test("T3: healthy draining subscriber receives every notification within 50 ms with a slow stream present", async () => {
    const h = makeHarness({
      maxBufferedBytes: MCP_SSE_MAX_BUFFERED_BYTES,
      maxBufferedFrames: MCP_SSE_MAX_BUFFERED_FRAMES
    });
    const healthy = await connectHealthy(h.handler, "t3-healthy");
    try {
      // A deliberately unread stream is present (below the cap in this test).
      const raw = await h.handler.fetch(rawListenRequest());
      expect(raw.status).toBe(200);

      const M = 20;
      const latencies: number[] = [];
      for (let j = 0; j < M; j++) {
        const t0 = performance.now();
        h.service.track(`T3-${j}`);
        const target = j + 1;
        const deadline = performance.now() + 2000;
        while (healthy.count() < target && performance.now() < deadline) await Bun.sleep(2);
        latencies.push(performance.now() - t0);
      }
      expect(healthy.count()).toBe(M); // no drops and no duplicates

      const sorted = [...latencies].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
      expect(p95).toBeLessThan(FANOUT_LATENCY_BUDGET_MS);
    } finally {
      await healthy.client.close();
      await h.handler.close();
      h.bridge.stop();
      h.hub.stop();
    }
  });

  test("T5: sustained-load evidence — healthy burst envelope and unread growth", async () => {
    // Large cap so neither stream overflows: measure natural behaviour, then
    // derive the production cap from the healthy burst envelope (recorded in
    // docs/M6_D_FANOUT_EVIDENCE.md §7).
    const samples: SseBufferSample[] = [];
    const h = makeHarness({
      maxBufferedBytes: 4 * 1024 * 1024,
      maxBufferedFrames: 100_000,
      onBuffered: (s) => samples.push(s)
    });
    const healthy = await connectHealthy(h.handler, "t5-healthy");
    try {
      await Bun.sleep(10);
      const idsBefore = new Set(samples.map((s) => s.streamId));
      const healthyId = [...idsBefore][0];

      const raw = await h.handler.fetch(rawListenRequest());
      await Bun.sleep(10);
      const unreadId = [...new Set(samples.map((s) => s.streamId))].find((id) => !idsBefore.has(id));
      expect(healthyId).toBeDefined();
      expect(unreadId).toBeDefined();

      const M = 300;
      const heapBefore = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      for (let j = 0; j < M; j++) {
        h.service.track(`T5-${j}`);
        if (j % 10 === 0) await Bun.sleep(1); // realistic inter-update pacing
      }
      const publishMs = performance.now() - t0;
      const deadline = Date.now() + 3000;
      while (healthy.count() < M && Date.now() < deadline) await Bun.sleep(2);
      const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

      const evidence = {
        M, publishMs, healthyDelivered: healthy.count(), heapDeltaMb,
        healthyHighWater: highWater(samples.filter((s) => s.streamId === healthyId)),
        unreadHighWater: highWater(samples.filter((s) => s.streamId === unreadId))
      };
      console.log(`[M6-D slow-consumer sustained evidence] ${JSON.stringify(evidence)}`);

      expect(healthy.count()).toBe(M);
      expect(publishMs).toBeLessThan(2000);
      // The healthy burst envelope must sit comfortably below the production cap.
      expect(evidence.healthyHighWater.frames).toBeLessThan(MCP_SSE_MAX_BUFFERED_FRAMES);
      expect(evidence.healthyHighWater.bytes).toBeLessThan(MCP_SSE_MAX_BUFFERED_BYTES);
    } finally {
      await healthy.client.close();
      await h.handler.close();
      h.bridge.stop();
      h.hub.stop();
    }
  });
});
