import { describe, expect, test } from "bun:test";
import type {
  ComponentUpdate,
  CredentialStore,
  FreshnessPolicy,
  MarketSessionState,
  ProviderConnectionState
} from "../../packages/contracts/src/index";
import { MarketDataService, type NormalizeObservationInput } from "../../packages/market-core/src/index";
import {
  FyersMarketDataStream,
  type FyersDriverCallbacks,
  type FyersDriverSubscription,
  type FyersStreamer,
  type FyersStreamerFactory
} from "../../packages/broker-fyers/src/index";

const NOW = 1_700_000_000_000;
const SBIN = "NSE:SBIN-EQ";
const SBIN_CANONICAL = "v1|NSE|EQ|EQ|CODE:SBIN";
const INFY = "NSE:INFY-EQ";
const INFY_CANONICAL = "v1|NSE|EQ|EQ|CODE:INFY";
const NIFTY = "NSE:NIFTY50-INDEX";
const NIFTY_CANONICAL = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";

type Listener = (payload?: unknown) => void;

/** SDK-faithful fake: single-slot on(), close() does not detach, no reconnect in seam. */
class FakeStreamer implements FyersStreamer {
  connectCalls = 0;
  closeCalls = 0;
  subscribeCalls: Array<{ symbols: string[]; depth?: boolean }> = [];
  unsubscribeCalls: string[][] = [];
  autoreconnectCalls: number[] = [];
  registeredEvents: string[] = [];
  subscribeThrows = false;
  subscribeError: Error | null = null;
  private listeners = new Map<string, Listener>();

  on(event: string, listener: Listener): void {
    this.registeredEvents.push(event);
    this.listeners.set(event, listener); // single slot: overwrite, never accumulate
  }
  connect(): void { this.connectCalls++; }
  close(): void { this.closeCalls++; }
  subscribe(symbols: string[], depth?: boolean): void {
    if (this.subscribeError) throw this.subscribeError;
    if (this.subscribeThrows) throw new Error("FYERS subscription limit exceeded");
    this.subscribeCalls.push(depth === undefined ? { symbols } : { symbols, depth });
  }
  unsubscribe(symbols: string[]): void { this.unsubscribeCalls.push(symbols); }
  emit(event: string, payload?: unknown): void { this.listeners.get(event)?.(payload); }
  listenerCount(): number { return this.listeners.size; }
  /** Extra spy: proves the adapter never reaches SDK-side reconnect. */
  autoreconnect(count: number): void { this.autoreconnectCalls.push(count); }
}

class FakeCredentials {
  token: string | null;
  constructor(token: string | null = "appid:test-token") { this.token = token; }
  async get(): Promise<string | null> { return this.token; }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function setup(opts: { streamer?: FakeStreamer; token?: string | null; connectTimeoutMs?: number } = {}) {
  const credentials = new FakeCredentials(opts.token === undefined ? "appid:test-token" : opts.token);
  const streamer = opts.streamer ?? new FakeStreamer();
  const factoryCalls: Array<{ token: string; logPath: string; logging: boolean }> = [];
  const factory: FyersStreamerFactory = (token, logPath, logging) => {
    factoryCalls.push({ token, logPath, logging });
    return streamer;
  };
  const updates: ComponentUpdate[] = [];
  const observations: NormalizeObservationInput[] = [];
  const states: Array<{ state: ProviderConnectionState; error?: string | null }> = [];
  /** Ordered callback log: proves onTerminalFailure precedes onConnectionState. */
  const callOrder: string[] = [];
  const terminalFailures: Array<import("../../packages/contracts/src/index").DriverTerminalFailure> = [];
  const stream = new FyersMarketDataStream({
    credentials: credentials as unknown as CredentialStore,
    now: () => new Date(NOW),
    connectTimeoutMs: opts.connectTimeoutMs ?? 1000,
    streamerFactory: factory
  });
  const callbacks: FyersDriverCallbacks = {
    onObservation: (o) => observations.push(o),
    onConnectionState: (s, e) => { callOrder.push(`connection:${s}`); states.push({ state: s, error: e ?? null }); },
    onComponentUpdate: (u) => updates.push(u),
    onTerminalFailure: (f) => { callOrder.push("terminal"); terminalFailures.push(f); }
  };
  return { stream, streamer, credentials, factoryCalls, updates, observations, states, callbacks, callOrder, terminalFailures };
}

const quoteSub = (canonicalId = SBIN_CANONICAL, nativeIdentifier = SBIN): FyersDriverSubscription => ({ canonicalId, nativeIdentifier });

async function connected(
  subs: FyersDriverSubscription[] = [quoteSub()],
  opts: { streamer?: FakeStreamer; connectTimeoutMs?: number } = {}
) {
  const h = setup(opts);
  const startPromise = h.stream.start(subs, h.callbacks, new AbortController().signal);
  await flush();
  h.streamer.emit("connect");
  await startPromise;
  return h;
}

const POLICY: FreshnessPolicy = {
  openMaxAgeMs: 15_000,
  unknownMaxAgeMs: 5_000,
  maxRetainedObservationAgeMs: 60_000
};

/** Wire the adapter callbacks to the REAL canonical store, not just spies. */
async function connectedToStore(subs: FyersDriverSubscription[] = [quoteSub()]) {
  const h = setup();
  const service = new MarketDataService({
    now: () => new Date(NOW),
    policy: POLICY,
    maxInstruments: 10,
    session: (): MarketSessionState => "OPEN"
  });
  for (const sub of subs) service.track(sub.canonicalId);
  service.setProviderConnection("FYERS", "STREAMING");
  const storeCallbacks: FyersDriverCallbacks = {
    ...h.callbacks,
    onObservation: (o) => { h.observations.push(o); service.applyProviderUpdate(o); },
    onComponentUpdate: (u) => { h.updates.push(u); service.applyComponentUpdate(u); }
  };
  const startPromise = h.stream.start(subs, storeCallbacks, new AbortController().signal);
  await flush();
  h.streamer.emit("connect");
  await startPromise;
  return { ...h, service };
}

function sf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "sf", symbol: SBIN, ltp: 100.5, last_traded_time: 1700000000,
    last_traded_qty: 10, exch_feed_time: 1700000000, open_price: 99,
    high_price: 102, low_price: 98, prev_close_price: 97, ch: 3.5, chp: 3.6,
    vol_traded_today: 1000, avg_trade_price: 100.2, bid_price: 100.4,
    ask_price: 100.6, bid_size: 5, ask_size: 7, ...overrides
  };
}

function dp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const msg: Record<string, unknown> = { type: "dp", symbol: SBIN };
  for (let i = 1; i <= 5; i++) {
    msg[`bid_price${i}`] = 100 - i;
    msg[`ask_price${i}`] = 100 + i;
    msg[`bid_size${i}`] = i * 10;
    msg[`ask_size${i}`] = i * 20;
    msg[`bid_order${i}`] = i;
    msg[`ask_order${i}`] = i + 1;
  }
  return { ...msg, ...overrides };
}

function depthUpdates(updates: ComponentUpdate[]): ComponentUpdate[] {
  return updates.filter((u) => u.component === "depth");
}
function quoteUpdates(updates: ComponentUpdate[]): ComponentUpdate[] {
  return updates.filter((u) => u.component === "quote");
}
function levelCount(update: ComponentUpdate): number {
  return (update.set.levelCount?.value as number) ?? -1;
}

describe("Stage C — SDK seam, auth and lifecycle", () => {
  test("getInstance receives token and logging=false; token never exposed in state", async () => {
    const h = await connected();
    expect(h.factoryCalls.length).toBe(1);
    expect(h.factoryCalls[0]!.token).toBe("appid:test-token");
    expect(h.factoryCalls[0]!.logging).toBe(false);
    expect(h.factoryCalls[0]!.logPath).toBeTruthy();
    for (const s of h.states) expect(JSON.stringify(s)).not.toContain("test-token");
  });

  test("autoreconnect is never called", async () => {
    const h = await connected();
    expect(h.streamer.autoreconnectCalls).toEqual([]);
  });

  test("fails when no token is configured", async () => {
    const h = setup({ token: null });
    await expect(h.stream.start([quoteSub()], h.callbacks, new AbortController().signal))
      .rejects.toThrow("not configured");
    expect(h.streamer.connectCalls).toBe(0);
  });

  test("start resolves on connect + subscription submission without cn/sub ack", async () => {
    const h = await connected();
    expect(h.stream.getConnectionState()).toBe("STREAMING");
    expect(h.streamer.subscribeCalls.length).toBe(1);
    expect(h.streamer.subscribeCalls[0]!.symbols).toEqual([SBIN]);
    // No acknowledgement was emitted; start already resolved.
    h.streamer.emit("message", { type: "cn", s: "ok" });
    expect(h.updates.length).toBe(0);
  });

  test("control messages cn/sub/unsub are ignored", async () => {
    const h = await connected();
    const before = h.updates.length;
    h.streamer.emit("message", { type: "cn", s: "ok" });
    h.streamer.emit("message", { type: "sub", s: "ok" });
    h.streamer.emit("message", { type: "unsub", s: "ok" });
    expect(h.updates.length).toBe(before);
  });

  test("bounded start times out when connect never fires", async () => {
    const h = setup({ connectTimeoutMs: 20 });
    await expect(h.stream.start([quoteSub()], h.callbacks, new AbortController().signal))
      .rejects.toThrow("timed out");
    expect(h.stream.getConnectionState()).toBe("ERROR");
  });

  test("abort before connect rejects with AbortError", async () => {
    const h = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(h.stream.start([quoteSub()], h.callbacks, controller.signal))
      .rejects.toThrow(/aborted/i);
  });

  test("stop during connect rejects start and closes the socket", async () => {
    const h = setup();
    const startPromise = h.stream.start([quoteSub()], h.callbacks, new AbortController().signal);
    await flush();
    h.stream.stop();
    await expect(startPromise).rejects.toThrow("stopped");
    expect(h.streamer.closeCalls).toBe(1);
  });

  test("stop is idempotent", async () => {
    const h = await connected();
    h.stream.stop();
    h.stream.stop();
    expect(h.streamer.closeCalls).toBe(1);
    expect(h.stream.getConnectionState()).toBe("DISCONNECTED");
  });

  test("fresh adapter instance re-registers all four events on the shared singleton", async () => {
    const streamer = new FakeStreamer();
    const first = await connected([quoteSub()], { streamer });
    first.stream.stop();
    const second = await connected([quoteSub()], { streamer });
    expect(streamer.registeredEvents).toEqual([
      "connect", "message", "error", "close",
      "connect", "message", "error", "close"
    ]);
    expect(streamer.listenerCount()).toBe(4); // single slot per event, no accumulation
    expect(second.streamer).toBe(streamer);
  });

  test("stale singleton callbacks are inert after retirement", async () => {
    const streamer = new FakeStreamer();
    const first = await connected([quoteSub()], { streamer });
    first.stream.stop();
    const second = await connected([quoteSub()], { streamer });
    const firstCount = first.updates.length;
    streamer.emit("message", sf());
    expect(first.updates.length).toBe(firstCount); // retired adapter received nothing
    expect(second.updates.length).toBeGreaterThan(0);
  });

  test("close() is called on retirement", async () => {
    const h = await connected();
    expect(h.streamer.closeCalls).toBe(0);
    h.stream.stop();
    expect(h.streamer.closeCalls).toBe(1);
  });

  test("subscribe throwing on connect rejects start and sets ERROR", async () => {
    const h = setup();
    h.streamer.subscribeThrows = true;
    const startPromise = h.stream.start([quoteSub()], h.callbacks, new AbortController().signal);
    await flush();
    h.streamer.emit("connect");
    await expect(startPromise).rejects.toThrow("limit exceeded");
    expect(h.stream.getConnectionState()).toBe("ERROR");
    expect(h.streamer.closeCalls).toBe(1); // closed exactly once, not twice
  });

  test("close before connect rejects start promptly instead of waiting for timeout", async () => {
    const h = setup({ connectTimeoutMs: 5000 });
    const startPromise = h.stream.start([quoteSub()], h.callbacks, new AbortController().signal);
    await flush();
    h.streamer.emit("close");
    await expect(startPromise).rejects.toThrow("closed before connect");
  });
});

describe("Stage C — component mapping", () => {
  test("sf maps to a full quote update", async () => {
    const h = await connected();
    h.streamer.emit("message", sf());
    const quote = quoteUpdates(h.updates)[0]!;
    expect(quote.provider).toBe("FYERS");
    expect(quote.canonicalId).toBe(SBIN_CANONICAL);
    expect(quote.set.ltp?.value).toBe(100.5);
    expect(quote.set.previousClose?.value).toBe(97);
    expect(quote.set.close?.value).toBe(97);
    expect(quote.set.open?.value).toBe(99);
    expect(quote.set.high?.value).toBe(102);
    expect(quote.set.low?.value).toBe(98);
    expect(quote.set.volume?.value).toBe(1000);
    expect(quote.set.averageTradePrice?.value).toBe(100.2);
    expect(quote.set.change?.value).toBe(3.5);
    expect(quote.set.changePercent?.value).toBe(3.6);
    expect(quote.set.lastTradedQuantity?.value).toBe(10);
  });

  test("sf maps to L1 depth (levelCount 1)", async () => {
    const h = await connected();
    h.streamer.emit("message", sf());
    const depth = depthUpdates(h.updates)[0]!;
    expect(levelCount(depth)).toBe(1);
    const levels = depth.set.levels?.value as Array<Record<string, number>>;
    expect(levels.length).toBe(1);
    expect(levels[0]!.bidPrice).toBe(100.4);
    expect(levels[0]!.askPrice).toBe(100.6);
  });

  test("if maps to a reduced quote with no volume, no depth and no last-traded time", async () => {
    const h = await connected([quoteSub(NIFTY_CANONICAL, NIFTY)]);
    h.streamer.emit("message", {
      type: "if", symbol: NIFTY, ltp: 25000, prev_close_price: 24900,
      open_price: 24950, high_price: 25100, low_price: 24900, ch: 100, chp: 0.4,
      exch_feed_time: 1700000000, vol_traded_today: 999, bid_price: 1, ask_price: 2
    });
    const quote = quoteUpdates(h.updates)[0]!;
    expect(quote.set.ltp?.value).toBe(25000);
    expect(quote.set.previousClose?.value).toBe(24900);
    expect(quote.set.open?.value).toBe(24950);
    expect(quote.set.high?.value).toBe(25100);
    expect(quote.set.low?.value).toBe(24900);
    expect(quote.set.change?.value).toBe(100);
    expect(quote.set.changePercent?.value).toBe(0.4);
    // exch_feed_time is not a documented last-traded timestamp for `if`.
    expect(quote.set.lastTradedTime).toBeUndefined();
    expect(quote.set.volume).toBeUndefined();
    expect(quote.set.bidPrice).toBeUndefined();
    expect(depthUpdates(h.updates).length).toBe(0);
    // Observation-level timestamp metadata remains verbatim, untrusted and UNKNOWN.
    expect(h.observations.length).toBe(1);
    expect(h.observations[0]!.rawProviderTimestamp).toBe(1700000000);
    expect(h.observations[0]!.providerTimestampUnit).toBe("UNKNOWN"); // untrusted downstream
    expect(h.observations[0]!.providerTimestampMeaning).toContain("unverified");
  });

  test("dp maps to five-level depth with levelCount 5 and complete snapshot", async () => {
    const h = await connected();
    h.streamer.emit("message", dp());
    const depth = depthUpdates(h.updates)[0]!;
    expect(levelCount(depth)).toBe(5);
    expect(depth.complete).toBe(true);
    const levels = depth.set.levels?.value as Array<Record<string, number>>;
    expect(levels.length).toBe(5);
    expect(levels[0]!.bidPrice).toBe(99);
    expect(levels[4]!.askPrice).toBe(105);
    expect(levels[0]!.bidOrders).toBe(1);
  });

  test("partial dp reports actual level count and is not marked complete", async () => {
    const h = await connected();
    h.streamer.emit("message", dp({ bid_price2: undefined, ask_price2: undefined, bid_size2: undefined, ask_size2: undefined, bid_order2: undefined, ask_order2: undefined }));
    const depth = depthUpdates(h.updates)[0]!;
    expect(levelCount(depth)).toBe(4);
    expect(depth.complete).toBeUndefined();
  });

  test("dp does not emit an observation that would clobber the quote observation", async () => {
    const h = await connected();
    h.streamer.emit("message", sf());
    h.streamer.emit("message", dp());
    // Only the price-bearing sf frame produced an observation; dp must not
    // replace it with an empty one in the shared store.
    expect(h.observations.length).toBe(1);
    expect(h.observations[0]!.value.ltp).toBe(100.5);
    expect(quoteUpdates(h.updates).length).toBe(1);
    // sf L1 depth then dp five-level depth — both are legitimate depth updates.
    expect(depthUpdates(h.updates).length).toBe(2);
  });

  test("valid sf then empty sf keeps the previous observation in the real store", async () => {
    const h = await connectedToStore();
    h.streamer.emit("message", sf());
    expect(h.service.getSelected(SBIN_CANONICAL)?.value?.ltp).toBe(100.5);
    expect(h.service.getSelected(SBIN_CANONICAL)?.value?.open).toBe(99);
    h.streamer.emit("message", { type: "sf", symbol: SBIN }); // no canonical fields
    expect(h.observations.length).toBe(1);
    expect(h.service.getSelected(SBIN_CANONICAL)?.value?.ltp).toBe(100.5);
    expect(h.service.getSelected(SBIN_CANONICAL)?.value?.open).toBe(99);
  });

  test("valid quote then empty if keeps the previous observation in the real store", async () => {
    const h = await connectedToStore([quoteSub(NIFTY_CANONICAL, NIFTY)]);
    h.streamer.emit("message", { type: "if", symbol: NIFTY, ltp: 25000, open_price: 24950 });
    expect(h.service.getSelected(NIFTY_CANONICAL)?.value?.ltp).toBe(25000);
    h.streamer.emit("message", { type: "if", symbol: NIFTY }); // no canonical fields
    expect(h.observations.length).toBe(1);
    expect(h.service.getSelected(NIFTY_CANONICAL)?.value?.ltp).toBe(25000);
    expect(h.service.getSelected(NIFTY_CANONICAL)?.value?.open).toBe(24950);
  });

  test("native-only payload produces no observation and no quote update", async () => {
    const h = await connectedToStore();
    h.streamer.emit("message", { type: "sf", symbol: SBIN, someNativeField: "x" });
    expect(h.observations.length).toBe(0);
    expect(quoteUpdates(h.updates).length).toBe(0);
  });

  test("timestamp-only payload does not qualify as a quote observation", async () => {
    const h = await connectedToStore();
    h.streamer.emit("message", { type: "sf", symbol: SBIN, last_traded_time: 1700000000 });
    expect(h.observations.length).toBe(0);
  });

  test("valid zero-valued quote field is retained in the real store", async () => {
    const h = await connectedToStore();
    h.streamer.emit("message", sf({
      ltp: 0, open_price: 0, high: 0, low: 0, prev_close_price: 0,
      vol_traded_today: 0, last_traded_qty: 0
    }));
    expect(h.observations.length).toBe(1);
    expect(h.observations[0]!.value.ltp).toBe(0);
    expect(h.service.getSelected(SBIN_CANONICAL)?.value?.ltp).toBe(0);
  });

  test("derivatives are never fabricated from any message", async () => {
    const h = await connected();
    h.streamer.emit("message", sf({ oi: 123, iv: 45, delta: 0.5 }));
    h.streamer.emit("message", dp());
    expect(h.updates.filter((u) => u.component === "derivatives").length).toBe(0);
    const caps = h.stream.getCapabilities();
    expect(caps.find((c) => c.component === "derivatives")?.status).toBe("UNSUPPORTED");
  });

  test("unverified timestamp is stored verbatim with UNKNOWN unit and untrusted", async () => {
    const h = await connected();
    h.streamer.emit("message", sf({ last_traded_time: 1700000000 }));
    const quote = quoteUpdates(h.updates)[0]!;
    expect(quote.set.lastTradedTime).toBeDefined(); // sf still maps last_traded_time
    const ts = quote.set.lastTradedTime?.sourceTimestamp;
    expect(ts?.raw).toBe(1700000000);
    expect(ts?.unit).toBe("UNKNOWN");
    expect(ts?.trusted).toBe(false);
    expect(ts?.normalizedMs).toBeNull();
    expect(h.observations[0]!.providerTimestampUnit).toBe("UNKNOWN");
  });

  test("unsafe integers are rejected rather than silently truncated", async () => {
    const h = await connected();
    h.streamer.emit("message", sf({ last_traded_qty: Number.MAX_SAFE_INTEGER + 10 }));
    expect(quoteUpdates(h.updates)[0]!.set.lastTradedQuantity).toBeUndefined();
  });

  test("malformed message produces a controlled ERROR", async () => {
    const h = await connected();
    h.streamer.emit("message", "not-an-object");
    expect(h.states.at(-1)?.state).toBe("ERROR");
    expect(h.states.at(-1)?.error).toContain("malformed");
  });

  test("unknown message type is ignored", async () => {
    const h = await connected();
    h.streamer.emit("message", { type: "xyz", symbol: SBIN, ltp: 1 });
    expect(h.updates.length).toBe(0);
  });

  test("messages for unsubscribed symbols are ignored", async () => {
    const h = await connected();
    h.streamer.emit("message", sf({ symbol: "NSE:UNKNOWN-EQ" }));
    expect(h.updates.length).toBe(0);
  });
});

describe("Stage C — adapter-side depth protection", () => {
  test("dp then sf: levelCount stays 5, sf L1 suppressed, quote still emitted", async () => {
    const h = await connected();
    h.streamer.emit("message", dp());
    h.streamer.emit("message", sf());
    const depths = depthUpdates(h.updates);
    expect(depths.length).toBe(1); // only the dp depth; sf L1 suppressed
    expect(levelCount(depths[0]!)).toBe(5);
    expect(quoteUpdates(h.updates).length).toBe(1); // quote still emitted
  });

  test("sf then dp: final depth retains levelCount 5", async () => {
    const h = await connected();
    h.streamer.emit("message", sf());
    h.streamer.emit("message", dp());
    const depths = depthUpdates(h.updates);
    expect(depths.length).toBe(2);
    expect(levelCount(depths[0]!)).toBe(1);
    expect(levelCount(depths[1]!)).toBe(5);
  });

  test("per-symbol isolation: dp for A does not suppress sf L1 for B", async () => {
    const h = await connected([quoteSub(SBIN_CANONICAL, SBIN), quoteSub(INFY_CANONICAL, "NSE:INFY-EQ")]);
    h.streamer.emit("message", dp());
    h.streamer.emit("message", sf({ symbol: "NSE:INFY-EQ" }));
    const depths = depthUpdates(h.updates);
    expect(depths.length).toBe(2);
    expect(levelCount(depths[0]!)).toBe(5);
    expect(levelCount(depths[1]!)).toBe(1);
  });

  test("retained symbol keeps dp protection across a subscription update", async () => {
    const h = await connected([quoteSub(SBIN_CANONICAL, SBIN), quoteSub(INFY_CANONICAL, "NSE:INFY-EQ")]);
    h.streamer.emit("message", dp());
    await h.stream.updateSubscriptions([
      quoteSub(SBIN_CANONICAL, SBIN), quoteSub(INFY_CANONICAL, "NSE:INFY-EQ")
    ], new AbortController().signal);
    h.streamer.emit("message", sf());
    expect(depthUpdates(h.updates).length).toBe(1); // still suppressed
  });

  test("removing then re-adding a symbol clears its dp protection", async () => {
    const h = await connected([quoteSub(SBIN_CANONICAL, SBIN), quoteSub(INFY_CANONICAL, "NSE:INFY-EQ")]);
    h.streamer.emit("message", dp());
    await h.stream.updateSubscriptions([quoteSub(INFY_CANONICAL, "NSE:INFY-EQ")], new AbortController().signal);
    await h.stream.updateSubscriptions([
      quoteSub(SBIN_CANONICAL, SBIN), quoteSub(INFY_CANONICAL, "NSE:INFY-EQ")
    ], new AbortController().signal);
    h.streamer.emit("message", sf());
    expect(depthUpdates(h.updates).length).toBe(2); // L1 emitted again
  });

  test("retirement clears all depth protection", async () => {
    const streamer = new FakeStreamer();
    const first = await connected([quoteSub()], { streamer });
    first.streamer.emit("message", dp());
    first.stream.stop();
    const second = await connected([quoteSub()], { streamer });
    second.streamer.emit("message", sf());
    expect(depthUpdates(second.updates).length).toBe(1); // L1 emitted for fresh adapter
  });

  test("turning a symbol's depth flag off clears its dp protection", async () => {
    const h = await connected([{ ...quoteSub(), depth: true }]);
    h.streamer.emit("message", dp());
    await h.stream.updateSubscriptions([quoteSub()], new AbortController().signal); // depth: false
    h.streamer.emit("message", sf());
    expect(depthUpdates(h.updates).length).toBe(2); // L1 emitted again
  });

  test("empty dp does not establish protection: following sf emits L1 depth", async () => {
    const h = await connected();
    h.streamer.emit("message", { type: "dp", symbol: SBIN }); // no levels at all
    expect(depthUpdates(h.updates).length).toBe(0); // nothing emitted
    h.streamer.emit("message", sf());
    const depths = depthUpdates(h.updates);
    expect(depths.length).toBe(1);
    expect(levelCount(depths[0]!)).toBe(1); // L1 not suppressed
  });

  test("partial dp does not establish protection: following sf emits L1 depth", async () => {
    const h = await connected();
    h.streamer.emit("message", { type: "dp", symbol: SBIN, bid_price1: 99, ask_price1: 101 });
    expect(depthUpdates(h.updates).length).toBe(1);
    expect(levelCount(depthUpdates(h.updates)[0]!)).toBe(1);
    h.streamer.emit("message", sf());
    const depths = depthUpdates(h.updates);
    expect(depths.length).toBe(2);
    expect(levelCount(depths[1]!)).toBe(1); // L1 not suppressed by partial dp
  });

  test("complete five-level dp establishes protection: following sf L1 suppressed", async () => {
    const h = await connected();
    h.streamer.emit("message", dp());
    expect(levelCount(depthUpdates(h.updates)[0]!)).toBe(5);
    h.streamer.emit("message", sf());
    expect(depthUpdates(h.updates).length).toBe(1); // L1 suppressed
    expect(quoteUpdates(h.updates).length).toBe(1); // quote still emitted
  });

  test("partial dp then complete dp establishes protection only after the complete frame", async () => {
    const h = await connected();
    h.streamer.emit("message", { type: "dp", symbol: SBIN, bid_price1: 99, ask_price1: 101 });
    h.streamer.emit("message", dp());
    h.streamer.emit("message", sf());
    const depths = depthUpdates(h.updates);
    expect(depths.length).toBe(2); // partial dp + complete dp; sf L1 suppressed
    expect(levelCount(depths[0]!)).toBe(1);
    expect(levelCount(depths[1]!)).toBe(5);
  });

  test("partial dp for symbol A does not suppress sf L1 for symbol B", async () => {
    const h = await connected([quoteSub(SBIN_CANONICAL, SBIN), quoteSub(INFY_CANONICAL, INFY)]);
    h.streamer.emit("message", { type: "dp", symbol: SBIN, bid_price1: 99, ask_price1: 101 });
    h.streamer.emit("message", sf({ symbol: INFY }));
    const depths = depthUpdates(h.updates);
    expect(depths.length).toBe(2);
    expect(levelCount(depths[0]!)).toBe(1);
    expect(levelCount(depths[1]!)).toBe(1);
  });
});

describe("Stage C — limits and failure classification", () => {
  test("no hardcoded 100 cap: all desired symbols are submitted as-is", async () => {
    const subs = Array.from({ length: 150 }, (_, i) => quoteSub(`canon-${i}`, `NSE:SYM${i}-EQ`));
    const h = await connected(subs);
    expect(h.streamer.subscribeCalls[0]!.symbols.length).toBe(150);
  });

  test("no silent truncation on subscription update", async () => {
    const h = await connected();
    const subs = Array.from({ length: 150 }, (_, i) => quoteSub(`canon-${i}`, `NSE:SYM${i}-EQ`));
    await h.stream.updateSubscriptions(subs, new AbortController().signal);
    expect(h.streamer.subscribeCalls.at(-1)!.symbols.length).toBe(150);
  });

  test("connection-preventing over-limit failure is LIMITED with a reason", async () => {
    const h = await connected();
    h.streamer.emit("error", "maximum symbol limit exceeded for data socket");
    expect(h.stream.getConnectionState()).toBe("ERROR");
    expect(h.states.at(-1)?.error).toContain("limit");
    const caps = h.stream.getCapabilities();
    expect(caps.find((c) => c.component === "depth")?.status).toBe("LIMITED");
    expect(caps.find((c) => c.component === "depth")?.reason).toContain("limit");
  });

  test("entitlements remain UNKNOWN until verified", async () => {
    const h = await connected();
    for (const cap of h.stream.getCapabilities()) {
      if (cap.status !== "UNSUPPORTED") expect(cap.entitlementUnverified).toBe(true);
    }
  });

  test("subscription update failure reports ERROR and invalidates the connection", async () => {
    const h = await connected();
    h.streamer.subscribeThrows = true;
    await expect(h.stream.updateSubscriptions([quoteSub(INFY_CANONICAL, "NSE:INFY-EQ")], new AbortController().signal))
      .rejects.toThrow("limit exceeded");
    // The failed update is not committed; the connection is invalidated so the
    // supervisor retries with the last committed desired state.
    expect(h.stream.getConnectionState()).toBe("ERROR");
    const before = h.updates.length;
    h.streamer.emit("message", sf());
    expect(h.updates.length).toBe(before); // stale socket is inert
  });

  test("depth subscription uses subscribe(symbols, true)", async () => {
    const h = await connected([{ ...quoteSub(), depth: true }]);
    expect(h.streamer.subscribeCalls.length).toBe(2);
    expect(h.streamer.subscribeCalls[0]!.depth).toBeUndefined();
    expect(h.streamer.subscribeCalls[1]!.depth).toBe(true);
    expect(h.streamer.subscribeCalls[1]!.symbols).toEqual([SBIN]);
  });
});

describe("Stage C Finding 3 — FYERS typed terminal failure", () => {
  test("startup limit rejection emits typed LIMITED failure before the connection error", async () => {
    const h = setup();
    h.streamer.subscribeThrows = true;
    const startPromise = h.stream.start([quoteSub()], h.callbacks, new AbortController().signal);
    await flush();
    h.streamer.emit("connect");
    await expect(startPromise).rejects.toThrow("limit exceeded");

    expect(h.terminalFailures).toHaveLength(1);
    const failure = h.terminalFailures[0]!;
    expect(failure.kind).toBe("LIMITED");
    expect(failure.reason).toContain("limit exceeded");
    expect(failure.capabilities.find((c) => c.component === "quote")?.status).toBe("LIMITED");
    expect(failure.capabilities.find((c) => c.component === "depth")?.status).toBe("LIMITED");
    expect(failure.capabilities.find((c) => c.component === "derivatives")?.status).toBe("UNSUPPORTED");
    // Typed notification must precede the paired ERROR connection state.
    expect(h.callOrder.indexOf("terminal")).toBeGreaterThanOrEqual(0);
    expect(h.callOrder.indexOf("connection:ERROR")).toBeGreaterThan(h.callOrder.indexOf("terminal"));
  });

  test("typed failure reason and capabilities never expose credentials", async () => {
    const h = setup();
    h.streamer.subscribeError = new Error("limit exceeded for access_token=appid:test-token secret=abc");
    const startPromise = h.stream.start([quoteSub()], h.callbacks, new AbortController().signal);
    await flush();
    h.streamer.emit("connect");
    await expect(startPromise).rejects.toThrow();

    expect(h.terminalFailures).toHaveLength(1);
    const failure = h.terminalFailures[0]!;
    expect(failure.reason).not.toContain("test-token");
    expect(failure.reason).not.toContain("abc");
    for (const cap of failure.capabilities) {
      if (cap.reason) {
        expect(cap.reason).not.toContain("test-token");
        expect(cap.reason).not.toContain("abc");
      }
    }
  });

  test("async error callback and promise rejection emit exactly one terminal failure", async () => {
    const h = setup();
    h.streamer.subscribeThrows = true;
    const startPromise = h.stream.start([quoteSub()], h.callbacks, new AbortController().signal);
    await flush();
    h.streamer.emit("connect"); // connect handler reports failure + rejects
    h.streamer.emit("error", "maximum symbol limit exceeded"); // async path also reports
    await expect(startPromise).rejects.toThrow("limit exceeded");

    // Both paths call reportFailure, but the guard emits one typed notification.
    expect(h.terminalFailures).toHaveLength(1);
    expect(h.callOrder.filter((x) => x === "terminal")).toHaveLength(1);
  });

  test("subscription update limit failure emits typed terminal failure and rejects", async () => {
    const h = await connected();
    h.streamer.subscribeThrows = true;
    await expect(
      h.stream.updateSubscriptions([quoteSub(INFY_CANONICAL, "NSE:INFY-EQ")], new AbortController().signal)
    ).rejects.toThrow("limit exceeded");

    expect(h.terminalFailures).toHaveLength(1);
    expect(h.terminalFailures[0]!.kind).toBe("LIMITED");
    expect(h.terminalFailures[0]!.reason).toContain("limit exceeded");
    expect(h.callOrder.indexOf("connection:ERROR")).toBeGreaterThan(h.callOrder.indexOf("terminal"));
    expect(h.stream.getConnectionState()).toBe("ERROR");
  });

  test("a fresh start resets the terminal-failure guard", async () => {
    const h = setup();
    h.streamer.subscribeThrows = true;
    const first = h.stream.start([quoteSub()], h.callbacks, new AbortController().signal);
    await flush();
    h.streamer.emit("connect");
    await expect(first).rejects.toThrow("limit exceeded");
    expect(h.terminalFailures).toHaveLength(1);

    // stop() then a new start with the limit cleared must allow a new notification.
    h.stream.stop();
    h.streamer.subscribeThrows = false;
    const second = h.stream.start([quoteSub()], h.callbacks, new AbortController().signal);
    await flush();
    h.streamer.emit("connect");
    await second;
    h.streamer.subscribeThrows = true;
    h.streamer.emit("error", "maximum symbol limit exceeded");
    expect(h.terminalFailures).toHaveLength(2);
  });
});
