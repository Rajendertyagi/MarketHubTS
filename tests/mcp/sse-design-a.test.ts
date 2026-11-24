import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { createMcpNotificationBridge } from "../../apps/api/src/mcp-notification-bridge";
import {
  boundSseResponse,
  wrapMcpHandlerFetch,
  MCP_SSE_MAX_BUFFERED_BYTES,
  MCP_SSE_MAX_BUFFERED_FRAMES,
  SSE_OVERFLOW_REASON,
  SSE_ENQUEUE_FAILED_REASON,
  type BoundedSseOptions,
  type SseBufferSample,
  type SseOverflowInfo
} from "../../apps/api/src/mcp-sse-bound";
import { withSseIdleTimeout } from "../../apps/api/src/index";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

/**
 * M6-E Design A permanent regression tests. These move the key disposable
 * experiments from `diagnostics2/` into the repository: standard Web Streams
 * with an application-owned bounded FIFO queue, a synchronous `pull()` demand
 * signal, and `controller.enqueue()` delivery (never waiter resolution).
 */

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});
const SNAPSHOT_URI = "markethub://market/snapshot";
const OTHER_URI = "markethub://other/resource";

interface HarnessOptions extends BoundedSseOptions {
  keepAliveMs?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-sse-a-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_LAN: "false" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);

  const service = new MarketDataService({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    policy: { openMaxAgeMs: 60_000, unknownMaxAgeMs: 60_000, maxRetainedObservationAgeMs: 86_400_000 },
    maxInstruments: 10_000,
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

  const rawHandler = createMcpHandler((ctx) => createMcpServer(ctx, services), {
    maxSubscriptions: 64,
    keepAliveMs: options.keepAliveMs ?? 0
  });
  const handler = wrapMcpHandlerFetch(rawHandler, {
    maxBufferedBytes: options.maxBufferedBytes ?? MCP_SSE_MAX_BUFFERED_BYTES,
    maxBufferedFrames: options.maxBufferedFrames ?? MCP_SSE_MAX_BUFFERED_FRAMES,
    onOverflow: options.onOverflow,
    onBuffered: options.onBuffered,
    onUpstreamCancel: options.onUpstreamCancel
  });
  const bridge = createMcpNotificationBridge(service, handler.notify);
  bridge.start();
  const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now(), mcpHandler: handler });
  return { dir, db, config, service, hub, handler, bridge, app };
}

function listenBody(uri = SNAPSHOT_URI) {
  return JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "subscriptions/listen",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "design-a", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      },
      notifications: { resourceSubscriptions: [uri] }
    }
  });
}

async function openListen(port: number, uri = SNAPSHOT_URI) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "subscriptions/listen"
    },
    body: listenBody(uri)
  });
}

/** Stateful SSE frame reader that preserves partial chunks across reads. */
function sseFrames(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return {
    async next(timeoutMs = 2000): Promise<{ method?: string; data: Record<string, unknown>; raw: string } | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const idx = buffer.indexOf("\n\n");
        if (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const data = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          return { method: data.method as string | undefined, data, raw: frame };
        }
        if (!pending) pending = reader.read();
        const result = await Promise.race([
          pending,
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), Math.max(1, deadline - Date.now())))
        ]);
        if (result === "timeout") continue;
        pending = null;
        if (result.done) return null;
        buffer += decoder.decode(result.value, { stream: true });
      }
      return null;
    },
    async close(): Promise<void> { try { await reader.cancel(); } catch { /* best effort */ } }
  };
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

function busCount(handler: ReturnType<typeof makeHarness>["handler"]): number {
  return (handler.bus as { listenerCount?: number }).listenerCount ?? 0;
}

/** Raw TCP client that reads headers then pauses (definitive saturation). */
function openSaturated(port: number) {
  const body = listenBody();
  const socket = netConnect({ host: "127.0.0.1", port });
  let buf = "";
  let headersDone = false;
  let bodyBytes = 0;
  let closed = false;
  let resolveClosed!: (v: { bodyBytes: number; closedByRemote: boolean }) => void;
  const closedPromise = new Promise<{ bodyBytes: number; closedByRemote: boolean }>((r) => { resolveClosed = r; });
  socket.setNoDelay(true);
  socket.on("connect", () => {
    try { socket.setRecvBufferSize(2048); } catch { /* best effort */ }
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
      `Accept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2026-07-28\r\n` +
      `Mcp-Method: subscriptions/listen\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: keep-alive\r\n\r\n${body}`
    );
  });
  socket.on("data", (chunk) => {
    if (!headersDone) {
      buf += chunk.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx >= 0) {
        headersDone = true;
        bodyBytes = buf.length - (idx + 4);
        socket.pause();
      }
    } else {
      bodyBytes += chunk.length;
    }
  });
  const finish = (closedByRemote: boolean) => {
    if (closed) return;
    closed = true;
    resolveClosed({ bodyBytes, closedByRemote });
  };
  socket.on("close", () => finish(true));
  socket.on("error", () => finish(false));
  return {
    socket, closedPromise,
    get headersDone() { return headersDone; },
    get bodyBytes() { return bodyBytes; },
    destroy() { try { socket.destroy(); } catch { /* best effort */ } }
  };
}

async function waitForHeaders(client: ReturnType<typeof openSaturated>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!client.headersDone && Date.now() < deadline) await Bun.sleep(2);
  return client.headersDone;
}

describe("M6-E Design A — standard Web Streams bounded SSE wrapper", () => {
  test("pure Web Streams guard: resolving a waiter without enqueue leaves read pending; enqueue resolves it", async () => {
    // Documents the exact mechanism behind the old stall. A pending pull
    // promise resolved by the producer does NOT satisfy a consumer read; only
    // controller.enqueue() does.
    const waiters: Array<() => void> = [];
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let pullCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      pull() { pullCalls++; return new Promise<void>((resolve) => { waiters.push(resolve); }); }
    });
    const reader = stream.getReader();
    const readPromise = reader.read();
    await Bun.sleep(5); // let pull() run and register the waiter
    expect(pullCalls).toBe(1);
    expect(waiters.length).toBe(1);

    // Resolve the waiter WITHOUT enqueue — the read must stay pending.
    waiters.shift()!();
    const stillPending = await Promise.race([
      readPromise.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 100))
    ]);
    expect(stillPending).toBe("pending");

    // Direct enqueue resolves the same read request.
    controller.enqueue(new TextEncoder().encode("frame"));
    const result = await withTimeout(readPromise, 500, "enqueue did not resolve read");
    expect(result.done).toBe(false);
    expect(result.value?.byteLength).toBe(5);
    await reader.cancel();
  });

  test("oversized single frame does not bypass the cap on the demand path", async () => {
    const tracker = overflowTracker();
    const cancels: unknown[] = [];
    const delivered: Uint8Array[] = [];
    // Upstream emits ONE chunk larger than the 16 KiB cap. A consumer is
    // actively reading, so the old direct-delivery path would have handed it
    // straight through. Design A checks the cap before append in the drain
    // loop (the only append path), so it must overflow instead.
    const big = new Uint8Array(MCP_SSE_MAX_BUFFERED_BYTES + 1).fill(0x61);
    const upstream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(big); },
      cancel(reason) { cancels.push(reason); }
    });
    const wrapped = boundSseResponse(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      {
        maxBufferedBytes: MCP_SSE_MAX_BUFFERED_BYTES,
        maxBufferedFrames: MCP_SSE_MAX_BUFFERED_FRAMES,
        onOverflow: tracker.onOverflow,
        onUpstreamCancel: (reason) => cancels.push(reason)
      }
    );
    const reader = wrapped.body!.getReader();
    // Start an active read BEFORE the drain loop appends, to exercise demand.
    const firstRead = reader.read();
    const info = await withTimeout(tracker.first, 1000, "oversized frame did not overflow");
    expect(info.reason).toBe(SSE_OVERFLOW_REASON);
    expect(cancels).toContain(SSE_OVERFLOW_REASON);
    const first = await withTimeout(firstRead, 1000, "downstream did not end after overflow");
    expect(first.done).toBe(true); // plain EOF, oversized chunk never delivered
    expect(first.value).toBeUndefined();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      delivered.push(r.value);
    }
    expect(delivered).toHaveLength(0);
  });

  test("downstream enqueue failure cancels upstream once with a distinct reason (no spurious overflow)", async () => {
    const tracker = overflowTracker();
    const cancels: unknown[] = [];
    const samples: SseBufferSample[] = [];
    const sentinel = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    let timer: ReturnType<typeof setInterval> | null = null;
    let upstreamCancelCount = 0;

    // Upstream emits the sentinel synchronously in start(), then keeps producing
    // small chunks on a timer. The sentinel is enqueued BEFORE the patch below is
    // installed, so only the wrapper's downstream enqueue of that same chunk is
    // forced to throw.
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(sentinel);
        let i = 0;
        timer = setInterval(() => c.enqueue(new Uint8Array([i++ & 0xff])), 5);
      },
      cancel() {
        upstreamCancelCount++;
        if (timer) clearInterval(timer);
      }
    });

    const wrapped = boundSseResponse(
      new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
      {
        maxBufferedBytes: MCP_SSE_MAX_BUFFERED_BYTES,
        maxBufferedFrames: MCP_SSE_MAX_BUFFERED_FRAMES,
        onOverflow: tracker.onOverflow,
        onBuffered: (s) => samples.push(s),
        onUpstreamCancel: (reason) => cancels.push(reason)
      }
    );

    // Force controller.enqueue() to throw ONLY for the sentinel chunk. This
    // deterministically exercises pump()'s enqueue-throw catch path in the real
    // production wrapper; every other stream in the process is unaffected.
    const proto = ReadableStreamDefaultController.prototype as unknown as {
      enqueue: (chunk: unknown) => void;
    };
    const originalEnqueue = proto.enqueue;
    proto.enqueue = function (this: unknown, chunk: unknown) {
      if (chunk === sentinel) throw new Error("forced downstream enqueue failure");
      return Reflect.apply(originalEnqueue, this, [chunk]);
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      reader = wrapped.body!.getReader();
      // Trigger pull() -> pump() -> enqueue(sentinel) -> forced throw.
      const first = await withTimeout(reader.read(), 1000, "downstream read hung after enqueue failure");
      expect(first.done).toBe(true); // plain EOF from closeDownstream()

      // Upstream released exactly once with the DISTINCT reason, never overflow.
      expect(cancels).toEqual([SSE_ENQUEUE_FAILED_REASON]);
      const cancelDeadline = Date.now() + 1000;
      while (upstreamCancelCount === 0 && Date.now() < cancelDeadline) await Bun.sleep(2);
      expect(upstreamCancelCount).toBe(1);
      expect(tracker.infos).toHaveLength(0); // no slow_consumer_bound_exceeded

      // Queue does not regrow: the drain loop has stopped, so no further appends
      // are reported even though the upstream timer kept firing before cancel.
      await Bun.sleep(20);
      const samplesAtFailure = samples.length;
      await Bun.sleep(60);
      expect(samples.length).toBe(samplesAtFailure);

      // Downstream stays closed.
      const after = await withTimeout(reader.read(), 500, "post-failure read hung");
      expect(after.done).toBe(true);
      expect(after.value).toBeUndefined();
    } finally {
      proto.enqueue = originalEnqueue;
      if (timer) clearInterval(timer);
      try { await reader?.cancel(); } catch { /* best effort */ }
    }
  });

  test("healthy real-listener subscriber: ack first, >96 notifications in order, no false overflow, correct IDs/filtering", async () => {
    const tracker = overflowTracker();
    const h = makeHarness({ onOverflow: tracker.onOverflow });
    let server: ReturnType<typeof Bun.serve> | null = null;
    let client: Client | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;

      // Official pinned client for the >cap delivery assertion.
      client = new Client({ name: "design-a-healthy", version: "1.0.0" }, {
        versionNegotiation: { mode: { pin: "2026-07-28" } }
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      // Notifications are payload-free change signals (the bridge publishes only
      // the URI), so "in order" is verified as no drops/duplicates plus a stable
      // subscription id; the authoritative sequence is read from the feed.
      let received = 0;
      const uris = new Set<string>();
      client.setNotificationHandler("notifications/resources/updated", (note) => {
        received++;
        const params = note.params as { uri?: string } | undefined;
        if (params?.uri) uris.add(params.uri);
      });
      const sub = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      expect(sub.honoredFilter.resourceSubscriptions).toEqual([SNAPSHOT_URI]);

      // Raw stream for ack-first + subscription-id + filtering assertions.
      const raw = sseFrames(await openListen(server.port, OTHER_URI));
      const ack = await raw.next();
      expect(ack?.method).toBe("notifications/subscriptions/acknowledged");
      const ackParams = ack!.data.params as { _meta?: Record<string, unknown> } | undefined;
      const ackId = ackParams?._meta?.["io.modelcontextprotocol/subscriptionId"];
      expect(ackId).toBeDefined(); // SDK stamps the subscription id on the ack

      const N = 200; // > 96 frame cap
      for (let i = 0; i < N; i++) {
        h.service.track(`HEALTH-${i}`);
        if (i % 10 === 0) await Bun.sleep(1);
      }
      const deadline = Date.now() + 5000;
      while (received < N && Date.now() < deadline) await Bun.sleep(2);
      expect(received).toBe(N); // no drops, no duplicates
      expect([...uris]).toEqual([SNAPSHOT_URI]); // correct URI, no cross-filter leakage
      expect(tracker.infos).toHaveLength(0); // no false overflow

      // Raw stream filtered to OTHER_URI receives no snapshot notifications,
      // and a notification for OTHER_URI carries its own subscription id.
      const wrongUri = await raw.next(300);
      expect(wrongUri).toBeNull();
      h.service.track("OTHER-1"); // snapshot URI only — still no match
      const stillNone = await raw.next(300);
      expect(stillNone).toBeNull();
      await raw.close();
      await sub.close();
    } finally {
      if (client) await client.close().catch(() => {});
      await h.handler.close().catch(() => {});
      h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  }, 20_000);

  test("slow subscriber (raw TCP saturation): overflow once, bounded app queue, upstream cancel, SDK teardown", async () => {
    const tracker = overflowTracker();
    const cancels: unknown[] = [];
    const samples: SseBufferSample[] = [];
    const h = makeHarness({
      onOverflow: tracker.onOverflow,
      onBuffered: (s) => samples.push(s),
      onUpstreamCancel: (reason) => cancels.push(reason)
    });
    let server: ReturnType<typeof Bun.serve> | null = null;
    let slow: ReturnType<typeof openSaturated> | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const baseline = busCount(h.handler);
      slow = openSaturated(server.port);
      expect(await waitForHeaders(slow)).toBe(true);

      const heapBefore = process.memoryUsage().heapUsed;
      const N = 3000;
      for (let i = 0; i < N; i++) {
        h.service.track(`SLOW-${i}`);
        if (i % 20 === 0) await Bun.sleep(1);
      }
      const info = await withTimeout(tracker.first, 5000, "saturated stream did not overflow");
      expect(info.reason).toBe(SSE_OVERFLOW_REASON);
      expect(info.bufferedFrames).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_FRAMES);
      expect(info.bufferedBytes).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_BYTES);
      const hw = highWater(samples);
      expect(hw.frames).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_FRAMES);
      expect(hw.bytes).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_BYTES);
      expect(cancels).toContain(SSE_OVERFLOW_REASON);
      expect(tracker.infos).toHaveLength(1); // exactly once
      expect(busCount(h.handler)).toBe(baseline); // SDK listener removed

      const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
      expect(heapDeltaMb).toBeLessThan(64); // no unbounded memory growth
      console.log(`[Design A saturated] ${JSON.stringify({ hw, heapDeltaMb, bodyBytes: slow.bodyBytes })}`);
    } finally {
      slow?.destroy();
      await h.handler.close().catch(() => {});
      h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  }, 20_000);

  test("slow subscriber reaches plain EOF and receives no frames after overflow", async () => {
    const tracker = overflowTracker();
    const cancels: unknown[] = [];
    const h = makeHarness({ onOverflow: tracker.onOverflow, onUpstreamCancel: (r) => cancels.push(r) });
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const res = await openListen(server.port);
      expect(res.status).toBe(200);
      // Never read the body while publishing fast enough to saturate Bun's sink.
      // Pace in small bursts (as in the validated experiment) so the drain loop
      // can hand chunks to Bun and the app queue accumulates to the cap.
      for (let i = 0; i < 4000; i++) {
        h.service.track(`EOF-${i}`);
        if (i % 20 === 0) await Bun.sleep(1);
      }
      await withTimeout(tracker.first, 5000, "stream did not overflow");
      expect(cancels).toContain(SSE_OVERFLOW_REASON);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let frames = 0;
      let done = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const r = await reader.read();
        if (r.done) { done = true; break; }
        frames += (decoder.decode(r.value).match(/event: message/g) ?? []).length;
      }
      expect(done).toBe(true); // plain EOF after overflow
      // Publish more after overflow: the already-EOF stream stays closed.
      for (let i = 0; i < 10; i++) h.service.track(`POST-${i}`);
      const after = await withTimeout(reader.read(), 500, "post-overflow read hung");
      expect(after.done).toBe(true);
      expect(after.value).toBeUndefined();
      expect(tracker.infos).toHaveLength(1);
      console.log(`[Design A EOF] ${JSON.stringify({ frames })}`);
    } finally {
      await h.handler.close().catch(() => {});
      h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  }, 20_000);

  test("slow but active subscriber: controlled reading does not overflow prematurely", async () => {
    const tracker = overflowTracker();
    const h = makeHarness({ onOverflow: tracker.onOverflow });
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const res = await openListen(server.port);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let frames = 0;
      const N = 150;
      // Controlled slow reading: one read per ~2 ms, still within the envelope.
      const readLoop = (async () => {
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          frames += (decoder.decode(r.value).match(/notifications\/resources\/updated/g) ?? []).length;
          await Bun.sleep(2);
        }
      })();
      for (let i = 0; i < N; i++) {
        h.service.track(`ACTIVE-${i}`);
        await Bun.sleep(1);
      }
      const deadline = Date.now() + 5000;
      while (frames < N && Date.now() < deadline) await Bun.sleep(2);
      expect(frames).toBe(N);
      expect(tracker.infos).toHaveLength(0); // no premature overflow
      await reader.cancel();
      await readLoop.catch(() => {});
    } finally {
      await h.handler.close().catch(() => {});
      h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  }, 20_000);

  test("disconnect cleanup: idle, during notifications, and during backpressure", async () => {
    for (const scenario of ["idle", "notifications", "backpressure"] as const) {
      const cancels: unknown[] = [];
      const h = makeHarness({ onUpstreamCancel: (r) => cancels.push(r) });
      let server: ReturnType<typeof Bun.serve> | null = null;
      let slow: ReturnType<typeof openSaturated> | null = null;
      try {
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
        const baseline = busCount(h.handler);
        if (scenario === "backpressure") {
          slow = openSaturated(server.port);
          expect(await waitForHeaders(slow)).toBe(true);
          for (let i = 0; i < 200; i++) {
            h.service.track(`DISC-${scenario}-${i}`);
            if (i % 20 === 0) await Bun.sleep(1);
          }
          slow.destroy(); // disconnect while the transport is saturated
        } else {
          const res = await openListen(server.port);
          const reader = res.body!.getReader();
          const first = await reader.read(); // ack
          expect(first.done).toBe(false);
          if (scenario === "notifications") {
            for (let i = 0; i < 20; i++) h.service.track(`DISC-${scenario}-${i}`);
            await Bun.sleep(20);
          }
          await reader.cancel("client-gone"); // idle or during notifications
        }
        const deadline = Date.now() + 2000;
        while (cancels.length === 0 && Date.now() < deadline) await Bun.sleep(2);
        expect(cancels.length).toBeGreaterThanOrEqual(1); // upstream released
        const settleDeadline = Date.now() + 2000;
        while (busCount(h.handler) !== baseline && Date.now() < settleDeadline) await Bun.sleep(2);
        expect(busCount(h.handler)).toBe(baseline); // no leaked subscription
      } finally {
        slow?.destroy();
        await h.handler.close().catch(() => {});
        h.bridge.stop(); h.hub.stop();
        if (server) await server.stop(true).catch(() => {});
        closeDatabaseHandle(h.db); removeTempDir(h.dir);
      }
    }
  }, 20_000);

  test("multiple slow clients simultaneously: each overflows, aggregate memory bounded", async () => {
    const tracker = overflowTracker();
    const cancels: unknown[] = [];
    const samples: SseBufferSample[] = [];
    const h = makeHarness({
      onOverflow: tracker.onOverflow,
      onBuffered: (s) => samples.push(s),
      onUpstreamCancel: (r) => cancels.push(r)
    });
    let server: ReturnType<typeof Bun.serve> | null = null;
    const clients: ReturnType<typeof openSaturated>[] = [];
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const baseline = busCount(h.handler);
      const COUNT = 4;
      for (let i = 0; i < COUNT; i++) {
        const c = openSaturated(server.port);
        clients.push(c);
        expect(await waitForHeaders(c)).toBe(true);
      }
      expect(busCount(h.handler)).toBe(baseline + COUNT);
      const heapBefore = process.memoryUsage().heapUsed;
      for (let i = 0; i < 3000; i++) {
        h.service.track(`MULTI-${i}`);
        if (i % 20 === 0) await Bun.sleep(1);
      }
      const deadline = Date.now() + 5000;
      while (tracker.infos.length < COUNT && Date.now() < deadline) await Bun.sleep(5);
      expect(tracker.infos).toHaveLength(COUNT); // each slow client overflowed once
      expect(cancels.filter((r) => r === SSE_OVERFLOW_REASON)).toHaveLength(COUNT);
      const hw = highWater(samples);
      expect(hw.frames).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_FRAMES);
      expect(hw.bytes).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_BYTES);
      const settleDeadline = Date.now() + 2000;
      while (busCount(h.handler) !== baseline && Date.now() < settleDeadline) await Bun.sleep(2);
      expect(busCount(h.handler)).toBe(baseline); // all SDK listeners removed
      const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
      expect(heapDeltaMb).toBeLessThan(64);
      console.log(`[Design A multi-slow] ${JSON.stringify({ COUNT, hw, heapDeltaMb })}`);
    } finally {
      for (const c of clients) c.destroy();
      await h.handler.close().catch(() => {});
      h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  }, 20_000);

  test("SSE idle-timeout override is applied only to text/event-stream responses", async () => {
    const calls: Array<{ request: Request; seconds: number }> = [];
    const fakeServer = {
      timeout: (request: Request, seconds: number) => { calls.push({ request, seconds }); }
    } as never;

    const jsonFetch = withSseIdleTimeout(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const jsonReq = new Request("http://127.0.0.1/json");
    await jsonFetch(jsonReq, fakeServer);
    expect(calls).toHaveLength(0); // JSON keeps the global timeout

    const sseFetch = withSseIdleTimeout(async () =>
      new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }));
    const sseReq = new Request("http://127.0.0.1/sse");
    await sseFetch(sseReq, fakeServer);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.seconds).toBe(0);
    expect(calls[0]!.request).toBe(sseReq);
  });

  test("quiet SSE stream stays alive past a shortened idle timeout while the 15 s keepalive is pending", async () => {
    const h = makeHarness({ keepAliveMs: 15_000 }); // production keepalive
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      // Shortened idle timeout keeps the test bounded; the override must still
      // keep the quiet stream open beyond it.
      server = Bun.serve({
        hostname: "127.0.0.1", port: 0, idleTimeout: 1,
        fetch: withSseIdleTimeout(h.app.fetch)
      });
      const res = await openListen(server.port);
      const reader = res.body!.getReader();
      const first = await withTimeout(reader.read(), 2000, "no ack");
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain("subscriptions/acknowledged");

      // Wait beyond the 1 s idle timeout; no keepalive has fired yet (15 s).
      await Bun.sleep(2500);
      const raced = await Promise.race([
        reader.read().then((r) => ({ ...r, timedOut: false })),
        new Promise<{ timedOut: boolean }>((r) => setTimeout(() => r({ timedOut: true }), 300))
      ]);
      expect(raced.timedOut).toBe(true); // still open — no EOF from idle timeout
      await reader.cancel();
    } finally {
      await h.handler.close().catch(() => {});
      h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  }, 15_000);

  test("no unhandled promise rejections during overflow, disconnect and shutdown", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      const tracker = overflowTracker();
      const h = makeHarness({ onOverflow: tracker.onOverflow });
      let server: ReturnType<typeof Bun.serve> | null = null;
      let slow: ReturnType<typeof openSaturated> | null = null;
      try {
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
        slow = openSaturated(server.port);
        expect(await waitForHeaders(slow)).toBe(true);
        for (let i = 0; i < 2000; i++) {
          h.service.track(`REJ-${i}`);
          if (i % 20 === 0) await Bun.sleep(1);
        }
        await withTimeout(tracker.first, 5000, "no overflow");
        slow.destroy();
        await h.handler.close();
      } finally {
        slow?.destroy();
        await h.handler.close().catch(() => {});
        h.bridge.stop(); h.hub.stop();
        if (server) await server.stop(true).catch(() => {});
        closeDatabaseHandle(h.db); removeTempDir(h.dir);
      }
      await Bun.sleep(100); // allow any late rejection to surface
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 20_000);
});
