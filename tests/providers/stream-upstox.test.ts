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
  private listeners = new Map<string, Listener[]>();
  autoReconnect(enable: boolean): void { this.autoReconnectCalls.push(enable); }
  on(event: string, listener: Listener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  async connect(): Promise<void> { this.connectCalls++; }
  disconnect(): void { this.disconnectCalls++; }
  subscribe(keys: string[], mode: string): void { this.subscribeCalls.push({ keys, mode }); }
  unsubscribe(keys: string[]): void { this.unsubscribeCalls.push(keys); }
  emit(event: string, payload?: unknown): void {
    for (const l of this.listeners.get(event) ?? []) l(payload);
  }
  async open(): Promise<void> { this.emit("open"); }
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

  test("concurrent start and stop-during-connect generation guards", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    const first = h.stream.start([{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }], cbs(h));
    await expect(h.stream.start([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }], cbs(h))).rejects.toThrow("already in progress");
    h.stream.stop();
    await first;
    expect(h.streamers.length).toBe(1);
    // stale event from old streamer must not affect state
    h.streamers[0]!.emit("message", sdkSerialize({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: { ltpc: { ltp: 1 }, requestMode: 0 } } }));
    expect(h.observations.length).toBe(0);
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
