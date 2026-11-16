import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NormalizeObservationInput } from "../../packages/market-core/src/index";
import { openDatabase, SqliteCredentialStore } from "../../packages/database/src/index";
import {
  UPSTOX_TOKEN_CREDENTIAL,
  UPSTOX_V3_LIMITS,
  UpstoxMarketDataStream,
  type SdkStreamer
} from "../../packages/broker-upstox/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

// Resolve the SDK's bundled proto + its own protobufjs for real protobuf-to-JSON
// serialization tests (version-pinned seam, no second runtime decoder in the app).
const brokerRequire = createRequire(resolve(import.meta.dir, "../../packages/broker-upstox/src/index.ts"));
const sdkPath = brokerRequire.resolve("upstox-js-sdk");
const sdkRequire = createRequire(sdkPath);
const protobuf = sdkRequire("protobufjs") as typeof import("protobufjs");
const SDK_PROTO = sdkPath.replace(/dist[\\/]index\.js$/, "dist/feeder/proto/MarketDataFeedV3.proto");
const root = protobuf.loadSync(SDK_PROTO);
const FeedResponse = root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");

function encodeFeed(payload: Record<string, unknown>): Uint8Array {
  const err = FeedResponse.verify(payload);
  if (err) throw new Error(err);
  return FeedResponse.encode(FeedResponse.create(payload)).finish();
}
/** Real SDK serialization path: decode binary with SDK schema, then JSON.stringify. */
function sdkSerialize(payload: Record<string, unknown>): string {
  return JSON.stringify(FeedResponse.decode(encodeFeed(payload)));
}

const NOW = 1_700_000_000_000;
const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const NIFTY_CANONICAL = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const BANK_KEY = "NSE_INDEX|Nifty Bank";
const BANK_CANONICAL = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

type Listener = (payload?: unknown) => void;

class FakeStreamer implements SdkStreamer {
  streamer = { protobufRoot: {} as unknown }; // ready by default
  autoReconnectCalls: boolean[] = [];
  subscribeCalls: Array<{ keys: string[]; mode: string }> = [];
  unsubscribeCalls: string[][] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  connectMode: "resolve" | "reject" | "deferred" = "resolve";
  subscribeThrows = false;
  private listeners = new Map<string, Listener[]>();
  private connectResolvers: Array<() => void> = [];
  private connectRejecters: Array<(e: Error) => void> = [];
  autoReconnect(enable: boolean): void { this.autoReconnectCalls.push(enable); }
  on(event: string, listener: Listener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.connectMode === "reject") throw new Error("SDK connect failed");
    if (this.connectMode === "deferred") {
      return new Promise<void>((resolve, reject) => {
        this.connectResolvers.push(resolve);
        this.connectRejecters.push(reject);
      });
    }
  }
  resolveConnect(): void { this.connectResolvers.shift()?.(); }
  rejectConnect(e: Error): void { this.connectRejecters.shift()?.(e); }
  disconnect(): void { this.disconnectCalls++; }
  subscribe(keys: string[], mode: string): void {
    if (this.subscribeThrows) throw new Error("SDK subscribe failed");
    this.subscribeCalls.push({ keys, mode });
  }
  unsubscribe(keys: string[]): void { this.unsubscribeCalls.push(keys); }
  emit(event: string, payload?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }
  async open(): Promise<void> { this.emit("open"); }
}

/** Credential store whose get() can be deliberately blocked and resolved. */
class DeferredCredentials {
  calls = 0;
  private resolvers: Array<(v: string | null) => void> = [];
  status(): { state: "AVAILABLE" } { return { state: "AVAILABLE" }; }
  async get(): Promise<string | null> {
    this.calls++;
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async reset(): Promise<void> {}
  resolve(value: string | null): void { this.resolvers.shift()?.(value); }
}

function setup(opts: { ready?: boolean; streamer?: FakeStreamer } = {}) {
  const dir = join(tmpdir(), `mh-stream-upstox-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const observations: NormalizeObservationInput[] = [];
  const states: Array<{ state: string; error?: string | null }> = [];
  const streamers: FakeStreamer[] = [];
  const stream = new UpstoxMarketDataStream({
    credentials,
    now: () => new Date(NOW),
    protobufReadyTimeoutMs: 100,
    streamerFactory: () => {
      const s = opts.streamer ?? new FakeStreamer();
      if (opts.ready === false) s.streamer = { protobufRoot: undefined };
      streamers.push(s);
      return s;
    }
  });
  return { stream, credentials, observations, states, streamers, handle };
}

async function configure(stream: UpstoxMarketDataStream, credentials: SqliteCredentialStore) {
  await credentials.set("UPSTOX", UPSTOX_TOKEN_CREDENTIAL, "test-token");
  return stream;
}
const cbs = (h: ReturnType<typeof setup>) => ({
  onObservation: (o: NormalizeObservationInput) => h.observations.push(o),
  onConnectionState: (s: any, e?: string | null) => h.states.push({ state: s, error: e })
});

/** Build a stream with injected credentials and/or streamer factory for race tests. */
function makeStream(opts: {
  credentials?: DeferredCredentials;
  streamerFactory?: () => SdkStreamer;
  protobufReadyTimeoutMs?: number;
} = {}) {
  const observations: NormalizeObservationInput[] = [];
  const states: Array<{ state: string; error?: string | null }> = [];
  const streamers: FakeStreamer[] = [];
  const stream = new UpstoxMarketDataStream({
    credentials: (opts.credentials ?? new DeferredCredentials()) as any,
    now: () => new Date(NOW),
    protobufReadyTimeoutMs: opts.protobufReadyTimeoutMs ?? 100,
    streamerFactory: opts.streamerFactory ?? (() => {
      const s = new FakeStreamer();
      streamers.push(s);
      return s;
    })
  });
  return { stream, observations, states, streamers,
    callbacks: {
      onObservation: (o: NormalizeObservationInput) => observations.push(o),
      onConnectionState: (s: any, e?: string | null) => states.push({ state: s, error: e })
    } };
}

afterEach(() => {
  while (handles.length) { try { handles.pop()?.close(); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

describe("SDK integration — auth, factory, lifecycle", () => {
  test("configures SDK token without exposing credentials; empty initial list; autoReconnect(false) before connect", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    expect(s.autoReconnectCalls).toEqual([false]);
    expect(s.connectCalls).toBe(1);
    expect(s.subscribeCalls.length).toBe(0); // no subscribe before open
    expect(h.stream.getConnectionState()).toBe("CONNECTING");
  });

  test("fails when no token is configured", async () => {
    const h = setup();
    await expect(h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h)))
      .rejects.toThrow("not configured");
    expect(h.streamers.length).toBe(0);
  });

  test("fresh SDK instance per connection attempt", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    h.stream.stop();
    await h.stream.start([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }], cbs(h));
    expect(h.streamers.length).toBe(2);
    expect(h.streamers[0]).not.toBe(h.streamers[1]);
  });
});

describe("protobuf readiness gate", () => {
  test("initial subscriptions sent once after open AND readiness", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    expect(s.subscribeCalls).toEqual([{ keys: [NIFTY_KEY], mode: "ltpc" }]);
    expect(h.stream.getConnectionState()).toBe("STREAMING");
  });

  test("delayed readiness does not lose the first subscribed snapshot", async () => {
    const h = setup({ ready: false });
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    // Not ready yet — no subscribe, no STREAMING.
    expect(s.subscribeCalls.length).toBe(0);
    // Simulate SDK finishing schema load.
    s.streamer = { protobufRoot: {} as unknown };
    await Bun.sleep(20);
    expect(s.subscribeCalls).toEqual([{ keys: [NIFTY_KEY], mode: "ltpc" }]);
    // First feed snapshot after readiness is processed.
    s.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 100, ltt: NOW, ltq: 5, cp: 99 }, requestMode: 0 } } }));
    expect(h.observations.length).toBe(1);
    expect(h.observations[0]!.value.ltp).toBe(100);
  });

  test("readiness timeout enters ERROR and cleans up", async () => {
    const h = setup({ ready: false });
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(150);
    expect(h.states.some((x) => x.state === "ERROR")).toBe(true);
    expect(s.disconnectCalls).toBe(1);
  });
});

describe("message handling — payload types and market_info", () => {
  test("accepts Buffer, Uint8Array and string payloads", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    const json = sdkSerialize({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 100, ltt: NOW, ltq: 5, cp: 99 }, requestMode: 0 } } });
    s.emit("message", Buffer.from(json, "utf8"));
    s.emit("message", new TextEncoder().encode(json));
    s.emit("message", json);
    expect(h.observations.length).toBe(3);
  });

  test("market_info without feeds is ignored, not an error", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", sdkSerialize({ type: 2, currentTs: NOW, feeds: {}, marketInfo: { segmentStatus: { NSE_FO: 2 } } }));
    expect(h.observations.length).toBe(0);
    expect(h.states.some((x) => x.state === "ERROR")).toBe(false);
  });

  test("SDK pre-readiness null payload is ignored without crashing", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", null);
    expect(h.observations.length).toBe(0);
    expect(h.states.some((x) => x.state === "ERROR")).toBe(false);
  });

  test("malformed SDK message produces controlled error, no fabricated observation", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", "not-json");
    expect(h.observations.length).toBe(0);
    expect(h.states.some((x) => x.state === "ERROR")).toBe(true);
  });
});

describe("subscription lifecycle", () => {
  test("added, removed and mode-changed subscriptions (unsubscribe+subscribe, never changeMode)", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "ltpc" }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    await h.stream.updateSubscriptions([
      { instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL, mode: "full" },
      { instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "option_greeks" }
    ]);
    expect(s.unsubscribeCalls).toContainEqual([NIFTY_KEY]); // mode change uses unsubscribe
    expect(s.subscribeCalls.some((c) => c.keys.includes(BANK_KEY) && c.mode === "full")).toBe(true);
    expect(s.subscribeCalls.some((c) => c.keys.includes(NIFTY_KEY) && c.mode === "option_greeks")).toBe(true);
    expect((s as any).changeMode).toBeUndefined(); // SDK changeMode never used
  });

  test("updates while connecting are deferred and applied on open", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await h.stream.updateSubscriptions([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }]);
    expect(s.subscribeCalls.length).toBe(0); // deferred
    await s.open();
    await Bun.sleep(20);
    expect(s.subscribeCalls).toEqual([{ keys: [BANK_KEY], mode: "ltpc" }]);
  });

  test("per-mode individual and combined limits enforced", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    const single = Array.from({ length: UPSTOX_V3_LIMITS.ltpc.individual + 1 }, (_, i) => ({ instrumentKey: `K${i}`, canonicalId: `C${i}`, mode: "ltpc" as const }));
    await expect(h.stream.start(single, cbs(h))).rejects.toThrow("exceeds limit 5000");
    const mixed = Array.from({ length: UPSTOX_V3_LIMITS.ltpc.combined + 2 }, (_, i) => ({ instrumentKey: `K${i}`, canonicalId: `C${i}`, mode: (i === 0 ? "full" : "ltpc") as "full" | "ltpc" }));
    await expect(h.stream.start(mixed, cbs(h))).rejects.toThrow("exceeds limit 2000");
  });

  test("unexpected close preserves desired subscriptions; stop clears them", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("close");
    expect(h.stream.getSubscriptions().length).toBe(1);
    h.stream.stop();
    expect(h.stream.getSubscriptions().length).toBe(0);
    expect(h.states.some((x) => x.state === "DISCONNECTED")).toBe(true);
  });

  test("concurrent start is rejected while a start is in progress", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    const first = h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    await expect(h.stream.start([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }], cbs(h)))
      .rejects.toThrow("already in progress");
    await first;
    expect(h.streamers.length).toBe(1);
  });

  test("stop during credential retrieval prevents streamer creation and stale state changes", async () => {
    const creds = new DeferredCredentials();
    const h = makeStream({ credentials: creds });
    const first = h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], h.callbacks);
    expect(creds.calls).toBe(1);
    h.stream.stop(); // invalidate generation while credentials are pending
    creds.resolve("test-token");
    await first;
    expect(h.streamers.length).toBe(0); // no SDK streamer created
    expect(h.states.some((s) => s.state === "CONNECTING")).toBe(true); // stale start did not change final state
    expect(h.stream.getConnectionState()).toBe("DISCONNECTED");
    // A new generation works normally.
    const creds2 = new DeferredCredentials();
    const h2 = makeStream({ credentials: creds2 });
    const second = h2.stream.start([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }], h2.callbacks);
    creds2.resolve("test-token");
    await second;
    expect(h2.streamers.length).toBe(1);
    expect(h2.streamers[0]!.connectCalls).toBe(1);
  });

  test("old credential resolution does not interfere with a newer pending start", async () => {
    const creds = new DeferredCredentials();
    const h = makeStream({ credentials: creds });
    const first = h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], h.callbacks);
    h.stream.stop();
    const second = h.stream.start([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }], h.callbacks);
    expect(creds.calls).toBe(2);
    creds.resolve("old-token"); // resolves the FIRST pending request
    await first;
    expect(h.streamers.length).toBe(0); // old start created nothing
    expect(h.stream.getConnectionState()).toBe("CONNECTING"); // newer start still owns state
    creds.resolve("new-token"); // resolves the SECOND request
    await second;
    expect(h.streamers.length).toBe(1);
    expect(h.streamers[0]!.connectCalls).toBe(1);
    expect(h.stream.getConnectionState()).toBe("CONNECTING");
  });
});

describe("field mapping via real SDK serialization", () => {
  async function emitAndGet(payload: Record<string, unknown>): Promise<NormalizeObservationInput> {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "full" }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", sdkSerialize(payload));
    expect(h.observations.length).toBe(1);
    return h.observations[0]!;
  }

  test("LTPC fields and int64 string conversion", async () => {
    const o = await emitAndGet({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 26188.1, ltt: NOW, ltq: 75, cp: 26216.05 }, requestMode: 0 } } });
    expect(o.provider).toBe("UPSTOX");
    expect(o.canonicalId).toBe(NIFTY_CANONICAL);
    expect(o.value).toMatchObject({ ltp: 26188.1, lastTradedQuantity: 75, close: 26216.05 });
    expect(o.rawProviderTimestamp).toBe(NOW);
    expect(o.providerTimestampUnit).toBe("MS");
    expect(o.sourceVersion).toBe("v3");
  });

  test("depth, OHLC, Greeks and CAS fields preserved", async () => {
    const o = await emitAndGet({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { fullFeed: { marketFF: {
      ltpc: { ltp: 26188.1, ltt: NOW, ltq: 10, cp: 26216 },
      marketLevel: { bidAskQuote: [{ bidQ: 100, bidP: 26188, askQ: 200, askP: 26188.5 }] },
      marketOHLC: { ohlc: [{ interval: "1m", open: 26180, high: 26200, low: 26170, close: 26188.1, vol: 5000, ts: NOW }] },
      optionGreeks: { delta: 0.5, theta: -0.1, gamma: 0.02, vega: 0.3, rho: 0.05 },
      oi: 12345, iv: 18.5, vtt: 9999, atp: 26190, tbq: 1000, tsq: 900,
      iep: 26100.5, rp: 26000, ieq: 100, iiqTotal: 250, iiqM: -75, casEligible: true
    } }, requestMode: 1 } } });
    const n = o.value.native as any;
    expect(n.depth[0]).toMatchObject({ bidQ: 100, bidP: 26188, askQ: 200, askP: 26188.5 });
    expect(n.ohlc[0]).toMatchObject({ interval: "1m", open: 26180, high: 26200, low: 26170, close: 26188.1, vol: 5000, ts: NOW });
    expect(n.optionGreeks).toMatchObject({ delta: 0.5, gamma: 0.02 });
    expect(n).toMatchObject({ oi: 12345, iv: 18.5, vtt: 9999, atp: 26190, tbq: 1000, tsq: 900, iep: 26100.5, rp: 26000, ieq: 100, iiqTotal: 250, iiqM: -75, casEligible: true });
  });

  test("explicit zeros and omitted proto3 scalar defaults preserved", async () => {
    const o = await emitAndGet({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { fullFeed: { marketFF: {
      ltpc: { ltp: 1, ltt: NOW, ltq: 0, cp: 0, iep: { value: 0 } },
      iep: 0, rp: 0, ieq: 0, iiqTotal: 0, iiqM: 0, casEligible: false
    } }, requestMode: 1 } } });
    const n = o.value.native as any;
    expect(n.ltpcIep).toBe(0);
    expect(n.iep).toBe(0);
    expect(n.rp).toBe(0);
    expect(n.ieq).toBe(0);
    expect(n.iiqTotal).toBe(0);
    expect(n.iiqM).toBe(0);
    expect(n.casEligible).toBe(false);
    expect(o.value.lastTradedQuantity).toBe(0);
    expect(o.value.close).toBe(0);
  });

  test("absent vs present-zero DoubleValue wrapper", async () => {
    const present = await emitAndGet({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 1, ltt: NOW, ltq: 1, cp: 1, iep: { value: 0 } }, requestMode: 0 } } });
    expect((present.value.native as any).ltpcIep).toBe(0);
    const absent = await emitAndGet({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 1, ltt: NOW, ltq: 1, cp: 1 }, requestMode: 0 } } });
    expect((absent.value.native as any)?.ltpcIep).toBeUndefined();
  });

  test("unsafe int64 does not silently round", async () => {
    const Long = (protobuf as any).util.Long;
    const unsafe = Long.fromString("9007199254740993"); // 2^53 + 1, not safely representable
    const o = await emitAndGet({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 1, ltt: unsafe, ltq: 1, cp: 1 }, requestMode: 0 } } });
    expect(o.rawProviderTimestamp).toBeNull(); // unsafe -> unset, no silent rounding
  });

  test("unsubscribed instrument keys never produce observations", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: { [BANK_KEY]: { ltpc: { ltp: 1 }, requestMode: 0 } } }));
    expect(h.observations.length).toBe(0);
  });
});

describe("Finding 2 — failed SDK connect cleanup", () => {
  test("connect rejection cleans up failed instance and allows a fresh start", async () => {
    const creds = new DeferredCredentials();
    const h = makeStream({ credentials: creds });
    const first = h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], h.callbacks);
    creds.resolve("token");
    await first;
    const failed = h.streamers[0]!;
    failed.connectMode = "reject";
    // Force a fresh start after stop; the next streamer will reject connect.
    h.stream.stop();
    const creds2 = new DeferredCredentials();
    const h2 = makeStream({ credentials: creds2, streamerFactory: () => {
      const s = new FakeStreamer();
      s.connectMode = "reject";
      h2streamers.push(s);
      return s;
    } });
    const h2streamers: FakeStreamer[] = [];
    const second = h2.stream.start([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }], h2.callbacks);
    creds2.resolve("token");
    await expect(second).rejects.toThrow("SDK connect failed");
    expect(h2streamers[0]!.disconnectCalls).toBe(1); // failed instance cleaned up
    expect(h2.states.some((s) => s.state === "ERROR")).toBe(true);
    // A subsequent start creates a fresh instance and can succeed.
    const creds3 = new DeferredCredentials();
    const h3 = makeStream({ credentials: creds3 });
    const third = h3.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], h3.callbacks);
    creds3.resolve("token");
    await third;
    expect(h3.streamers.length).toBe(1);
    expect(h3.streamers[0]!.connectCalls).toBe(1);
  });

  test("old connect rejection after stop does not disturb a newer start", async () => {
    const creds = new DeferredCredentials();
    const h = makeStream({ credentials: creds, streamerFactory: () => {
      const s = new FakeStreamer();
      s.connectMode = "deferred";
      h.streamers.push(s);
      return s;
    } });
    const first = h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], h.callbacks);
    creds.resolve("token");
    await Bun.sleep(5); // let first reach deferred connect
    const old = h.streamers[0]!;
    h.stream.stop(); // invalidate old generation
    const creds2 = new DeferredCredentials();
    const h2 = makeStream({ credentials: creds2 });
    const second = h2.stream.start([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }], h2.callbacks);
    creds2.resolve("token");
    await second;
    old.rejectConnect(new Error("old connect failed"));
    await first.catch(() => {});
    expect(h2.streamers.length).toBe(1);
    expect(h2.streamers[0]!.connectCalls).toBe(1);
    expect(h2.states.some((s) => s.state === "ERROR")).toBe(false); // old failure did not touch newer state
  });
});

describe("Finding 3 — safe int64 across all fields", () => {
  const Long = (protobuf as any).util.Long;
  const unsafe = () => Long.fromString("9007199254740993");

  test("unsafe ltpc.ltt and ltpc.ltq are not rounded or zeroed", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 1, ltt: unsafe(), ltq: unsafe(), cp: 1 }, requestMode: 0 } } }));
    expect(h.observations.length).toBe(1);
    const o = h.observations[0]!;
    expect(o.rawProviderTimestamp).toBeNull();
    expect(o.value.lastTradedQuantity).toBeUndefined();
    const n = o.value.native as any;
    expect(n.ltpcLttRaw).toBe("9007199254740993");
    expect(n.ltpcLttUnsafe).toBe(true);
    expect(n.ltpcLtqRaw).toBe("9007199254740993");
    expect(n.ltpcLtqUnsafe).toBe(true);
  });

  test("unsafe vtt, CAS int64, depth, first-depth and OHLC int64 fields preserved exactly", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "full" }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { fullFeed: { marketFF: {
      ltpc: { ltp: 1, ltt: NOW, ltq: 1, cp: 1 },
      vtt: unsafe(), ieq: unsafe(), iiqTotal: unsafe(), iiqM: unsafe(),
      marketLevel: { bidAskQuote: [{ bidQ: unsafe(), bidP: 1, askQ: unsafe(), askP: 1 }] },
      marketOHLC: { ohlc: [{ interval: "1m", open: 1, high: 1, low: 1, close: 1, vol: unsafe(), ts: unsafe() }] }
    } }, requestMode: 1 } } }));
    expect(h.observations.length).toBe(1);
    const n = h.observations[0]!.value.native as any;
    for (const key of ["vtt", "ieq", "iiqTotal", "iiqM"]) {
      expect(n[`${key}Raw`]).toBe("9007199254740993");
      expect(n[`${key}Unsafe`]).toBe(true);
      expect(n[key]).toBeUndefined(); // never fabricated zero
    }
    expect(n.depth[0].bidQRaw).toBe("9007199254740993");
    expect(n.depth[0].askQRaw).toBe("9007199254740993");
    expect(n.depth[0].bidQ).toBeUndefined();
    expect(n.ohlc[0].volRaw).toBe("9007199254740993");
    expect(n.ohlc[0].tsRaw).toBe("9007199254740993");
    expect(n.ohlc[0].vol).toBeUndefined();
  });

  test("unsafe first-level depth quantities preserved exactly", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "option_greeks" }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { firstLevelWithGreeks: {
      ltpc: { ltp: 1, ltt: NOW, ltq: 1, cp: 1 },
      firstDepth: { bidQ: unsafe(), bidP: 1, askQ: unsafe(), askP: 1 }
    }, requestMode: 2 } } }));
    const n = h.observations[0]!.value.native as any;
    expect(n.firstDepth.bidQRaw).toBe("9007199254740993");
    expect(n.firstDepth.askQRaw).toBe("9007199254740993");
    expect(n.firstDepth.bidQ).toBeUndefined();
  });

  test("safe int64 values still convert and omitted scalars keep zero defaults", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "full" }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { fullFeed: { marketFF: {
      ltpc: { ltp: 1, ltt: NOW, ltq: 7, cp: 1 }, vtt: 42, ieq: 9
      // iiqTotal, iiqM, depth, OHLC omitted -> proto3 zero defaults
    } }, requestMode: 1 } } }));
    const o = h.observations[0]!;
    const n = o.value.native as any;
    expect(o.value.lastTradedQuantity).toBe(7);
    expect(n.vtt).toBe(42);
    expect(n.ieq).toBe(9);
    expect(n.iiqTotal).toBe(0);
    expect(n.iiqM).toBe(0);
    expect(n.vttUnsafe).toBeUndefined();
  });
});

describe("Finding 4 — close during readiness and async handler safety", () => {
  test("close before readiness completes prevents STREAMING and subscriptions", async () => {
    const h = setup({ ready: false });
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    s.emit("close"); // close while readiness pending
    s.streamer = { protobufRoot: {} as unknown }; // readiness becomes ready
    await Bun.sleep(30);
    expect(s.subscribeCalls.length).toBe(0);
    expect(h.states.some((x) => x.state === "STREAMING")).toBe(false);
    expect(h.stream.getConnectionState()).toBe("DISCONNECTED");
    // stale message after close produces no observation
    s.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 1 }, requestMode: 0 } } }));
    expect(h.observations.length).toBe(0);
  });

  test("subscribe throwing during initial subscription yields controlled ERROR and cleanup", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    s.subscribeThrows = true;
    await s.open();
    await Bun.sleep(30);
    expect(h.states.some((x) => x.state === "ERROR")).toBe(true);
    expect(s.disconnectCalls).toBe(1);
    expect(h.stream.getConnectionState()).toBe("ERROR");
  });
});

describe("Additional A/B/C — partial failure, mode normalization, feed types", () => {
  test("partial subscription update failure keeps last committed map and invalidates connection", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    s.subscribeThrows = true; // unsubscribe succeeds, subscribe fails
    await expect(h.stream.updateSubscriptions([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }]))
      .rejects.toThrow("SDK subscribe failed");
    expect(h.stream.getSubscriptions().map((x) => x.instrumentKey)).toEqual([NIFTY_KEY]); // last committed
    expect(s.disconnectCalls).toBe(1); // inconsistent connection invalidated
    expect(h.states.some((x) => x.state === "ERROR")).toBe(true);
  });

  test("omitted mode and explicit ltpc are equivalent — no unnecessary operations", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h)); // omitted mode
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    await h.stream.updateSubscriptions([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "ltpc" }]);
    expect(s.unsubscribeCalls.length).toBe(0);
    expect(s.subscribeCalls.length).toBe(1); // only the initial subscription
  });

  test("supported feed types produce observations; unknown type with feeds does not", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    const s = h.streamers[0]!;
    await s.open();
    await Bun.sleep(20);
    const feed = { [NIFTY_KEY]: { ltpc: { ltp: 1, ltt: NOW, ltq: 1, cp: 1 }, requestMode: 0 } };
    s.emit("message", sdkSerialize({ type: 0, currentTs: NOW, feeds: feed })); // initial_feed
    s.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: feed })); // live_feed
    expect(h.observations.length).toBe(2);
    s.emit("message", JSON.stringify({ type: "mystery_type", feeds: feed }));
    expect(h.observations.length).toBe(2); // no observation for unknown type
    expect(h.states.some((x) => x.state === "ERROR")).toBe(true);
  });
});
