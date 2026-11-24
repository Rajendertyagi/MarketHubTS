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
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import {
  wrapMcpHandlerFetch,
  MCP_SSE_MAX_BUFFERED_BYTES,
  MCP_SSE_MAX_BUFFERED_FRAMES,
  SSE_OVERFLOW_REASON,
  type BoundedSseOptions,
  type SseBufferSample,
  type SseOverflowInfo
} from "../../apps/api/src/mcp-sse-bound";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});
const SNAPSHOT_URI = "markethub://market/snapshot";

interface HarnessOptions {
  /** Override individual services (e.g. a blocking getHealth for shutdown tests). */
  servicesOverride?: Partial<McpServices>;
  /** Diagnostic hooks forwarded to the production SSE wrapper (test-only). */
  onOverflow?: BoundedSseOptions["onOverflow"];
  onBuffered?: BoundedSseOptions["onBuffered"];
  onUpstreamCancel?: BoundedSseOptions["onUpstreamCancel"];
  /** Best-effort bridge publisher error hook (test-only). */
  bridgeOnError?: (error: unknown) => void;
}

function makeHarness(options: HarnessOptions = {}) {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-m6e-http-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_LAN: "false" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);

  const service = new MarketDataService({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    policy: { openMaxAgeMs: 60_000, unknownMaxAgeMs: 60_000, maxRetainedObservationAgeMs: 86_400_000 },
    maxInstruments: 10_000, // E2 publishes >2000 unique canonical ids to saturate Bun's sink
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
    completeActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured" } }),
    ...options.servicesOverride
  };

  // Production composition: the raw handler is wrapped with the SAME bounded
  // SSE fetch wrapper and measurement-derived caps used by apps/api/src/index.ts.
  // The wrapper preserves close/notify/bus, so the bridge, app and shutdown all
  // use the same handler identity. Diagnostic hooks are test-only.
  const rawHandler = createMcpHandler((ctx) => createMcpServer(ctx, services), { maxSubscriptions: 64 });
  const handler = wrapMcpHandlerFetch(rawHandler, {
    maxBufferedBytes: MCP_SSE_MAX_BUFFERED_BYTES,
    maxBufferedFrames: MCP_SSE_MAX_BUFFERED_FRAMES,
    onOverflow: options.onOverflow,
    onBuffered: options.onBuffered,
    onUpstreamCancel: options.onUpstreamCancel
  });
  const bridge = createMcpNotificationBridge(service, handler.notify, options.bridgeOnError);
  bridge.start();
  const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now(), mcpHandler: handler });
  return { dir, db, config, service, hub, handler, bridge, app, services };
}

async function connect(url: string, name: string) {
  const client = new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/** Open a raw modern subscriptions/listen SSE stream on the real listener. */
async function openListenStream(url: string, lastEventId?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "subscriptions/listen"
  };
  if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
  const res = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "subscriptions/listen",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "raw-listen", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {}
        },
        notifications: { resourceSubscriptions: ["markethub://market/snapshot"] }
      }
    })
  });
  return res;
}

/**
 * Raw TCP client that reads only the HTTP response headers, then pauses with a
 * small OS receive buffer so the server's transport backpressure becomes real
 * (Windows-relevant). This is the definitive saturated-consumer client: unlike
 * a `fetch` response left unread, it cannot silently buffer the whole body.
 */
function openSaturatedListen(port: number) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "subscriptions/listen",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "raw-saturated", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {}
      },
      notifications: { resourceSubscriptions: [SNAPSHOT_URI] }
    }
  });
  const socket = netConnect({ host: "127.0.0.1", port });
  let buf = "";
  let headersDone = false;
  let bodyBytes = 0;
  let closed = false;
  let resolveClosed!: (value: { bodyBytes: number; closedByRemote: boolean }) => void;
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
        socket.pause(); // stop reading the body -> saturate the connection
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
    socket,
    closedPromise,
    get headersDone() { return headersDone; },
    get bodyBytes() { return bodyBytes; },
    destroy() { try { socket.destroy(); } catch { /* best effort */ } }
  };
}

/** Stateful SSE frame reader — holds the stream open across multiple frames. */
function sseFrames(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return {
    async next(timeoutMs = 1500): Promise<Record<string, unknown> | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const idx = buffer.indexOf("\n\n");
        if (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          return dataLine ? JSON.parse(dataLine.slice(6)) as Record<string, unknown> : null;
        }
        if (!pending) pending = reader.read();
        const result = await Promise.race([
          pending,
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), Math.max(1, deadline - Date.now())))
        ]);
        if (result === "timeout") continue; // pending read stays for the next loop
        pending = null;
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
      }
      return null; // no frame within the deadline (not an error)
    },
    async close(): Promise<void> { try { await reader.cancel(); } catch { /* best effort */ } }
  };
}

/** First-overflow tracker using the wrapper's public test-only diagnostic seam. */
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

/**
 * Healthy subscriber on the SAME wrapped handler, driven IN-PROCESS ONLY (the
 * proven slow-consumer.test.ts pattern). This is NOT real-listener healthy-path
 * evidence: a wrapped SSE stream read through the real Bun listener stalls after
 * its first couple of frames (also reproduced with a Node http client; the
 * unwrapped handler delivers all frames). The deliberately unread stream below
 * is the one that must traverse the real listener. See the tracked follow-up in
 * docs/M6_E_EVIDENCE.md ("Bun wrapped-SSE stall").
 */
async function connectHealthyInProcess(handler: ReturnType<typeof makeHarness>["handler"], name: string) {
  const client = new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  let count = 0;
  client.setNotificationHandler("notifications/resources/updated", () => { count++; });
  await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
  return { client, count: () => count };
}

/** Drain an SSE reader to EOF, counting message frames; `done` distinguishes EOF from timeout. */
async function drainSseReader(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 2000) {
  const decoder = new TextDecoder();
  let frames = 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await Promise.race([
      reader.read().then((r) => ({ ...r, timedOut: false })),
      new Promise<{ done: boolean; value?: Uint8Array; timedOut: boolean }>((r) =>
        setTimeout(() => r({ done: false, timedOut: true }), Math.max(1, deadline - Date.now())))
    ]);
    if (result.timedOut) return { frames, done: false };
    if (result.done) return { frames, done: true };
    frames += (decoder.decode(result.value).match(/event: message/g) ?? []).length;
  }
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

  /**
   * M6-E combined-gap 2 (§8.3): ONE scenario, ONE handler/bridge/listener/client,
   * proving the entire D+E sequence end to end. This is deliberately a single
   * test — not a composition of separate tests — so a gap in any step (notify,
   * read-after-notify by cursor, or graceful close on handler.close()) fails the
   * combined gate. E1 and E2 below remain unchanged and cover shutdown/overflow
   * in isolation.
   */
  test("combined D+E gate: listen, notify, read snapshot + feed by cursor, graceful close on one handler", async () => {
    const h = makeHarness();
    let server: ReturnType<typeof Bun.serve> | null = null;
    let client: Client | null = null;
    try {
      // Actual Hono/Bun listener; the SAME wrapped handler the bridge publishes to.
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;

      // 1) Connect a pinned modern MCP client to the real listener.
      client = await connect(url, "combined-de-gate");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const discover = await client.getDiscoverResult();
      const caps = discover.capabilities as Record<string, Record<string, unknown>>;
      expect(caps.resources?.subscribe).toBe(true); // modern HTTP owns the bridge

      // 2) Open subscriptions/listen on the SAME handler/bridge/listener.
      let notifications = 0;
      const uris = new Set<string>();
      client.setNotificationHandler("notifications/resources/updated", (note) => {
        notifications++;
        const params = note.params as { uri?: string } | undefined;
        if (params?.uri) uris.add(params.uri);
      });
      const sub = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      expect(sub.honoredFilter.resourceSubscriptions).toEqual([SNAPSHOT_URI]);

      // 3) Trigger a synthetic canonical market-state change through the bridge
      // (no live provider — same canonical service pattern as E1/E2).
      h.service.track("COMBINED-DE-1");

      // 4) Receive the correct notification: URI-scoped, payload-free signal.
      const deadline = Date.now() + 2000;
      while (notifications < 1 && Date.now() < deadline) await Bun.sleep(5);
      expect(notifications).toBeGreaterThanOrEqual(1);
      expect([...uris]).toEqual([SNAPSHOT_URI]);

      // 5) Read the updated market snapshot via the SAME client.
      const snap = await client.readResource({ uri: SNAPSHOT_URI });
      expect(snap.contents[0]!.mimeType).toBe("application/json");
      const snapBody = JSON.parse(snap.contents[0]!.text) as { revision: number };
      expect(snapBody.revision).toBeGreaterThanOrEqual(1);

      // 6) Read the live event feed using its cursor (bootstrap to obtain the
      // opaque resumeCursor, then an incremental read with that cursor).
      const feed = await client.readResource({ uri: "markethub://events/live?after=first&limit=100" });
      expect(feed.contents[0]!.mimeType).toBe("application/json");
      const feedBody = JSON.parse(feed.contents[0]!.text) as {
        events: unknown[]; nextCursor: string | null; resumeCursor: string;
      };
      expect(feedBody.events.length).toBeGreaterThanOrEqual(1);
      expect(typeof feedBody.resumeCursor).toBe("string");
      const incremental = await client.readResource({
        uri: `markethub://events/live?after=${feedBody.resumeCursor}&limit=100`
      });
      expect(incremental.contents[0]!.mimeType).toBe("application/json");
      const incrementalBody = JSON.parse(incremental.contents[0]!.text) as {
        events: unknown[]; resumeCursor: string;
      };
      expect(Array.isArray(incrementalBody.events)).toBe(true);
      expect(typeof incrementalBody.resumeCursor).toBe("string");

      // 7) Call handler.close() while the client is still open — do NOT close
      // the client first. The wrapped handler delegates close() to the raw
      // handler, whose listenRouter.closeAll() completes active listen streams.
      const closePromise = h.handler.close();

      // 8) Verify the subscription closes gracefully on the SAME handler.
      const reason = await withTimeout(
        sub.closed, 3000, "combined D+E gate: listen stream did not close gracefully"
      );
      expect(reason).toBe("graceful");
      await withTimeout(closePromise, 3000, "combined D+E gate: handler.close() did not complete");

      // Deterministic listener shutdown after the handler is closed.
      await withTimeout(server.stop(true), 3000, "combined D+E gate: listener stop did not complete");
      server = null;
    } finally {
      if (client) await client.close().catch(() => {});
      await h.handler.close().catch(() => {});
      h.bridge.stop();
      h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
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
      // C10: the real listener must return exactly 404 with -32601 for an
      // unknown method — 400 is not an acceptable alternative.
      expect(unknown.status).toBe(404);
      const unknownBody = await unknown.json() as { error: { code: number } };
      expect(unknownBody.error.code).toBe(-32601);
    } finally {
      await h.handler.close(); h.bridge.stop(); h.hub.stop();
      if (server) await server.stop(true);
      closeDatabaseHandle(h.db); removeTempDir(h.dir);
    }
  });

  test("C11: a stale Last-Event-ID does not replay an earlier notification on the real listener", async () => {
    const h = makeHarness();
    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;

      // Stream A: open, observe ack, trigger a canonical change, observe it.
      const a = sseFrames(await openListenStream(url));
      const ackA = await a.next();
      expect(ackA?.method).toBe("notifications/subscriptions/acknowledged");
      h.service.track("C11-FIRST");
      const noteA = await a.next();
      expect(noteA?.method).toBe("notifications/resources/updated");

      // Stream B: fresh stream carrying a stale Last-Event-ID. The prior
      // notification must NOT be replayed after the ack.
      const b = sseFrames(await openListenStream(url, "0"));
      const ackB = await b.next();
      expect(ackB?.method).toBe("notifications/subscriptions/acknowledged");
      const replay = await b.next(400); // short window: no replay expected
      expect(replay).toBeNull();

      // A subsequent NEW notification is still delivered normally on stream B.
      h.service.track("C11-SECOND");
      const fresh = await b.next();
      expect(fresh?.method).toBe("notifications/resources/updated");

      await a.close();
      await b.close();
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

  test("E1: server-side handler.close() gracefully completes an active listen stream on the real listener (client left open)", async () => {
    let release: (() => void) | null = null;
    let reached!: () => void;
    const reachedService = new Promise<void>((resolve) => { reached = resolve; });
    const blocking = new Promise<void>((resolve) => { release = resolve; });
    const h = makeHarness({
      servicesOverride: {
        getHealth: async () => { reached(); await blocking; return { ok: true, value: HEALTH }; }
      }
    });
    let server: ReturnType<typeof Bun.serve> | null = null;
    let client: Client | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;
      client = await connect(url, "e1-shutdown");

      // Active subscription + in-flight request, both left open.
      const sub = await client.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
      const inFlight = client.callTool({ name: "markethub_health", arguments: {} });
      // Deterministic in-flight signal: the blocking service resolves this as
      // soon as the request actually reaches it (no fixed sleep / timing guess).
      await withTimeout(reachedService, 3000, "E1: request did not reach the blocking service");

      // Server-side shutdown FIRST — do not close the client first.
      const closePromise = h.handler.close();
      const reason = await withTimeout(sub.closed, 3000, "E1: listen stream did not close gracefully");
      expect(reason).toBe("graceful");

      // The in-flight request is aborted, never reported as a successful result.
      let rejected = false;
      try { await inFlight; } catch { rejected = true; }
      expect(rejected).toBe(true);
      await withTimeout(closePromise, 3000, "E1: handler.close() did not complete");

      // Deterministic listener shutdown after the handler is closed.
      await withTimeout(server.stop(true), 3000, "E1: listener stop did not complete");
      server = null;
    } finally {
      release?.();
      if (client) await client.close().catch(() => {});
      await h.handler.close().catch(() => {});
      h.bridge.stop();
      h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
      closeDatabaseHandle(h.db);
      removeTempDir(h.dir);
    }
  });

  test("E2: bounded SSE through the real listener — slow stream capped/cancelled; healthy subscriber continues", async () => {
    const tracker = overflowTracker();
    const cancels: unknown[] = [];
    const samples: SseBufferSample[] = [];
    const bridgeErrors: unknown[] = [];
    const h = makeHarness({
      onOverflow: tracker.onOverflow,
      onBuffered: (s) => samples.push(s),
      onUpstreamCancel: (reason) => cancels.push(reason),
      bridgeOnError: (error) => bridgeErrors.push(error)
    });
    let server: ReturnType<typeof Bun.serve> | null = null;
    let healthy: Awaited<ReturnType<typeof connectHealthyInProcess>> | null = null;
    let slow: ReturnType<typeof openSaturatedListen> | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;

      // Healthy subscriber on the same wrapped handler (in-process control).
      // The real-listener healthy path is covered by the dedicated healthy test.
      healthy = await connectHealthyInProcess(h.handler, "e2-healthy");
      const bus = h.handler.bus as { listenerCount?: number };
      const listenersBefore = bus.listenerCount ?? 0;

      // Deliberately saturated SSE subscription through the REAL Bun listener:
      // a raw TCP client reads only the headers then pauses, so Bun's transport
      // applies genuine backpressure and the application queue accumulates.
      slow = openSaturatedListen(server.port);
      const headerDeadline = Date.now() + 2000;
      while (!slow.headersDone && Date.now() < headerDeadline) await Bun.sleep(2);
      expect(slow.headersDone).toBe(true);

      // Publish enough canonical changes (with realistic pacing so the healthy
      // sibling keeps up) to saturate the transport and reach the app bound.
      const firstBatch = 2000;
      for (let i = 0; i < firstBatch; i++) {
        h.service.track(`E2a-${i}`);
        if (i % 5 === 0) await Bun.sleep(1);
      }
      const info = await withTimeout(tracker.first, 5000, "E2: slow stream did not overflow");
      expect(info.reason).toBe(SSE_OVERFLOW_REASON);
      expect(info.bufferedFrames).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_FRAMES);
      expect(info.bufferedBytes).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_BYTES);
      const hw = highWater(samples);
      expect(hw.frames).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_FRAMES);
      expect(hw.bytes).toBeLessThanOrEqual(MCP_SSE_MAX_BUFFERED_BYTES);
      expect(cancels).toContain(SSE_OVERFLOW_REASON);
      // Overflow is idempotent per stream: exactly one overflow for the slow
      // stream (the healthy sibling never overflows under pacing).
      expect(tracker.infos).toHaveLength(1);

      // SDK subscription resources cleaned up (black-box proxy): the bus
      // listener count returns to the pre-slow-stream baseline after teardown.
      expect(typeof bus.listenerCount).toBe("number");
      expect(bus.listenerCount).toBe(listenersBefore);

      // Publish more after overflow: the healthy control keeps up, while the
      // overflowed stream receives nothing further (no post-overflow delivery).
      const N = 10;
      for (let i = 0; i < N; i++) h.service.track(`E2b-${i}`);
      const target = firstBatch + N;
      const deadline = Date.now() + 5000;
      while (healthy.count() < target && Date.now() < deadline) await Bun.sleep(2);
      expect(healthy.count()).toBe(target);
      expect(tracker.infos).toHaveLength(1); // still exactly one overflow

      // Canonical publishing unaffected: no bridge publisher error was raised.
      expect(bridgeErrors).toHaveLength(0);

      await withTimeout(h.handler.close(), 3000, "E2: handler.close() did not complete after overflow");
    } finally {
      slow?.destroy();
      if (healthy) await healthy.client.close().catch(() => {});
      await h.handler.close().catch(() => {});
      h.bridge.stop();
      h.hub.stop();
      if (server) await server.stop(true).catch(() => {});
      closeDatabaseHandle(h.db);
      removeTempDir(h.dir);
    }
  }, 30_000);
});
