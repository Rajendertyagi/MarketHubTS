import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import type {
  CapabilityResult,
  ComponentUpdate,
  CredentialStore,
  DepthLevel,
  FieldUpdate,
  ProviderConnectionState,
  QuoteField,
  SourceTimestamp
} from "@markethub/contracts";
import type { NormalizeObservationInput } from "@markethub/market-core";
import { sanitizeError } from "@markethub/market-core";

// createRequire selects the CommonJS build of the SDK under Bun 1.4.4. The
// module is loaded lazily inside the default factory so injected fakes never
// touch the process-wide SDK singleton.
const require = createRequire(import.meta.url);

/** Same credential name used by the FYERS auth adapter (local to avoid a cycle). */
const FYERS_ACCESS_TOKEN_CREDENTIAL = "access_token";

/**
 * Minimal structural interface for the FYERS Data Socket SDK. Deliberately
 * omits `autoreconnect()`: SDK-side retry is opt-in and its argument is a retry
 * count, so this wrapper can never enable it. The supervisor owns retry with a
 * fresh adapter instance.
 */
export interface FyersStreamer {
  on(event: string, listener: (payload?: unknown) => void): void;
  connect(): void;
  close(): void;
  subscribe(symbols: string[], depth?: boolean): void;
  unsubscribe(symbols: string[]): void;
}

/**
 * Factory seam. `logging` is always false from the adapter; the default
 * factory forwards it to DataSocket.getInstance(token, logPath, logging).
 */
export type FyersStreamerFactory = (token: string, logPath: string, logging: boolean) => FyersStreamer;

function defaultStreamerFactory(token: string, logPath: string, logging: boolean): FyersStreamer {
  const sdk = require("fyers-api-v3") as {
    fyersDataSocket: {
      getInstance(token: string, logPath: string, logging: boolean): FyersStreamer;
    };
  };
  return sdk.fyersDataSocket.getInstance(token, logPath, logging);
}

/** Structurally compatible with the supervisor's DriverSubscription. */
export interface FyersDriverSubscription {
  canonicalId: string;
  nativeIdentifier: string;
  /** Request five-level depth (`dp`) for this symbol in addition to quotes. */
  depth?: boolean;
}

/** Structurally compatible with the supervisor's DriverCallbacks. */
export interface FyersDriverCallbacks {
  onObservation?: (input: NormalizeObservationInput) => void;
  onConnectionState: (state: ProviderConnectionState, error?: string | null) => void;
  onComponentUpdate?: (update: ComponentUpdate) => void;
}

/** Structurally compatible with the supervisor's StreamingDriver. */
export interface FyersDriver {
  readonly locked?: boolean;
  start(subscriptions: FyersDriverSubscription[], callbacks: FyersDriverCallbacks, signal: AbortSignal): Promise<void>;
  updateSubscriptions(subscriptions: FyersDriverSubscription[], signal: AbortSignal): Promise<void>;
  stop(): void;
  getConnectionState(): ProviderConnectionState;
}

export interface FyersStreamOptions {
  credentials: CredentialStore;
  logPath?: string;
  now?: () => Date;
  streamerFactory?: FyersStreamerFactory;
  /** Bounded wait for the SDK connect event. Default 10000ms. */
  connectTimeoutMs?: number;
}

// --- Decoded SDK message (HSM/mapper.js field names) ---

interface DecodedMessage {
  type?: string;
  symbol?: string;
  [key: string]: unknown;
}

const CONTROL_TYPES = new Set(["cn", "sub", "unsub"]);

function decodeMessage(payload: unknown): DecodedMessage | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as DecodedMessage;
  }
  if (typeof payload === "string") {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as DecodedMessage;
    } catch {
      return null;
    }
  }
  return null;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Integer fields reject unsafe integers rather than silently losing precision. */
function safeInteger(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && Number.isSafeInteger(n) ? n : undefined;
}

/**
 * FYERS `last_traded_time` / `exch_feed_time` units and precision are NOT
 * documented. Keep the raw value verbatim, mark the unit UNKNOWN and untrusted,
 * and let receipt ordering drive freshness until live verification (Stage G).
 */
function unverifiedTimestamp(value: unknown, meaning: string): SourceTimestamp | null {
  const raw = finiteNumber(value);
  if (raw === undefined) return null;
  return { raw, unit: "UNKNOWN", meaning, normalizedMs: null, trusted: false };
}

function provenanceOf(receivedAtMs: number) {
  return {
    source: "provider-feed",
    provider: "FYERS" as const,
    receivedAt: new Date(receivedAtMs).toISOString(),
    sourceVersion: "v3"
  };
}

function field(value: unknown, receivedAtMs: number, sourceTimestamp?: SourceTimestamp): FieldUpdate {
  return sourceTimestamp
    ? { value, sourceTimestamp, receivedAtMs }
    : { value, receivedAtMs };
}

// --- Component mapping (provider protocol translation only) ---

function sfQuoteUpdate(msg: DecodedMessage, canonicalId: string, receivedAtMs: number): ComponentUpdate | null {
  const set: Partial<Record<QuoteField, FieldUpdate>> = {};
  const ltp = finiteNumber(msg.ltp);
  if (ltp !== undefined) set.ltp = field(ltp, receivedAtMs);
  const prevClose = finiteNumber(msg.prev_close_price);
  if (prevClose !== undefined) {
    set.previousClose = field(prevClose, receivedAtMs);
    // Deprecated alias carried from the same source value during migration.
    set.close = field(prevClose, receivedAtMs);
  }
  const ltt = unverifiedTimestamp(msg.last_traded_time, "FYERS last_traded_time (unit unverified)");
  if (ltt) set.lastTradedTime = field(ltt, receivedAtMs, ltt);
  const ltq = safeInteger(msg.last_traded_qty);
  if (ltq !== undefined) set.lastTradedQuantity = field(ltq, receivedAtMs);
  const open = finiteNumber(msg.open_price);
  if (open !== undefined) set.open = field(open, receivedAtMs);
  const high = finiteNumber(msg.high_price);
  if (high !== undefined) set.high = field(high, receivedAtMs);
  const low = finiteNumber(msg.low_price);
  if (low !== undefined) set.low = field(low, receivedAtMs);
  const volume = safeInteger(msg.vol_traded_today);
  if (volume !== undefined) set.volume = field(volume, receivedAtMs);
  const atp = finiteNumber(msg.avg_trade_price);
  if (atp !== undefined) set.averageTradePrice = field(atp, receivedAtMs);
  const change = finiteNumber(msg.ch);
  if (change !== undefined) set.change = field(change, receivedAtMs);
  const changePercent = finiteNumber(msg.chp);
  if (changePercent !== undefined) set.changePercent = field(changePercent, receivedAtMs);
  if (Object.keys(set).length === 0) return null;
  return {
    provider: "FYERS", canonicalId, component: "quote", set,
    receivedAtMs, provenance: provenanceOf(receivedAtMs)
  };
}

/** Index (`if`) quote: LTP/OHLC/change only — no volume, no bid/ask. */
function ifQuoteUpdate(msg: DecodedMessage, canonicalId: string, receivedAtMs: number): ComponentUpdate | null {
  const set: Partial<Record<QuoteField, FieldUpdate>> = {};
  const ltp = finiteNumber(msg.ltp); // mapper: iv -> ltp
  if (ltp !== undefined) set.ltp = field(ltp, receivedAtMs);
  const prevClose = finiteNumber(msg.prev_close_price); // mapper: ic -> prev_close_price
  if (prevClose !== undefined) {
    set.previousClose = field(prevClose, receivedAtMs);
    set.close = field(prevClose, receivedAtMs);
  }
  const open = finiteNumber(msg.open_price);
  if (open !== undefined) set.open = field(open, receivedAtMs);
  const high = finiteNumber(msg.high_price);
  if (high !== undefined) set.high = field(high, receivedAtMs);
  const low = finiteNumber(msg.low_price);
  if (low !== undefined) set.low = field(low, receivedAtMs);
  const change = finiteNumber(msg.ch);
  if (change !== undefined) set.change = field(change, receivedAtMs);
  const changePercent = finiteNumber(msg.chp);
  if (changePercent !== undefined) set.changePercent = field(changePercent, receivedAtMs);
  const feedTime = unverifiedTimestamp(msg.exch_feed_time, "FYERS exch_feed_time (unit unverified)");
  if (feedTime) set.lastTradedTime = field(feedTime, receivedAtMs, feedTime);
  if (Object.keys(set).length === 0) return null;
  return {
    provider: "FYERS", canonicalId, component: "quote", set,
    receivedAtMs, provenance: provenanceOf(receivedAtMs)
  };
}

/** L1 depth from `sf` best bid/ask. Emitted only until five-level `dp` arrives. */
function sfDepthUpdate(msg: DecodedMessage, canonicalId: string, receivedAtMs: number): ComponentUpdate | null {
  const bidPrice = finiteNumber(msg.bid_price);
  const askPrice = finiteNumber(msg.ask_price);
  const bidSize = safeInteger(msg.bid_size);
  const askSize = safeInteger(msg.ask_size);
  if (bidPrice === undefined && askPrice === undefined && bidSize === undefined && askSize === undefined) return null;
  const level: DepthLevel = { index: 1 };
  if (bidPrice !== undefined) level.bidPrice = bidPrice;
  if (bidSize !== undefined) level.bidSize = bidSize;
  if (askPrice !== undefined) level.askPrice = askPrice;
  if (askSize !== undefined) level.askSize = askSize;
  return {
    provider: "FYERS", canonicalId, component: "depth",
    set: {
      levels: field([level], receivedAtMs),
      levelCount: field(1, receivedAtMs)
    },
    receivedAtMs, provenance: provenanceOf(receivedAtMs)
  };
}

/** Five-level depth from `dp`. No price fields are present in a dp message. */
function dpDepthUpdate(msg: DecodedMessage, canonicalId: string, receivedAtMs: number): ComponentUpdate | null {
  const levels: DepthLevel[] = [];
  for (let i = 1; i <= 5; i++) {
    const bidPrice = finiteNumber(msg[`bid_price${i}`]);
    const askPrice = finiteNumber(msg[`ask_price${i}`]);
    const bidSize = safeInteger(msg[`bid_size${i}`]);
    const askSize = safeInteger(msg[`ask_size${i}`]);
    const bidOrders = safeInteger(msg[`bid_order${i}`]);
    const askOrders = safeInteger(msg[`ask_order${i}`]);
    if (bidPrice === undefined && askPrice === undefined && bidSize === undefined &&
        askSize === undefined && bidOrders === undefined && askOrders === undefined) continue;
    const level: DepthLevel = { index: i };
    if (bidPrice !== undefined) level.bidPrice = bidPrice;
    if (bidSize !== undefined) level.bidSize = bidSize;
    if (bidOrders !== undefined) level.bidOrders = bidOrders;
    if (askPrice !== undefined) level.askPrice = askPrice;
    if (askSize !== undefined) level.askSize = askSize;
    if (askOrders !== undefined) level.askOrders = askOrders;
    levels.push(level);
  }
  if (levels.length === 0) return null;
  return {
    provider: "FYERS", canonicalId, component: "depth",
    set: {
      levels: field(levels, receivedAtMs),
      levelCount: field(levels.length, receivedAtMs)
    },
    // A dp frame is a complete snapshot only when all five levels are present.
    ...(levels.length === 5 ? { complete: true } : {}),
    receivedAtMs, provenance: provenanceOf(receivedAtMs)
  };
}

function observationFrom(msg: DecodedMessage, canonicalId: string, receivedAtMs: number): NormalizeObservationInput {
  const value: Record<string, unknown> = { native: { ...msg } };
  const ltp = finiteNumber(msg.ltp);
  if (ltp !== undefined) value.ltp = ltp;
  const prevClose = finiteNumber(msg.prev_close_price);
  if (prevClose !== undefined) { value.previousClose = prevClose; value.close = prevClose; }
  const open = finiteNumber(msg.open_price);
  if (open !== undefined) value.open = open;
  const high = finiteNumber(msg.high_price);
  if (high !== undefined) value.high = high;
  const low = finiteNumber(msg.low_price);
  if (low !== undefined) value.low = low;
  const volume = safeInteger(msg.vol_traded_today);
  if (volume !== undefined) value.volume = volume;
  const ltq = safeInteger(msg.last_traded_qty);
  if (ltq !== undefined) value.lastTradedQuantity = ltq;
  const raw = finiteNumber(msg.last_traded_time ?? msg.exch_feed_time);
  return {
    provider: "FYERS",
    canonicalId,
    value,
    rawProviderTimestamp: raw ?? null,
    providerTimestampUnit: "UNKNOWN",
    providerTimestampMeaning: "FYERS last_traded_time / exch_feed_time (unit unverified)",
    receivedAtMs,
    providerSequence: null,
    sourceVersion: "v3"
  };
}

/** Connection-preventing over-limit failures are classified as LIMITED, not generic ERROR. */
function isLimitFailure(message: string): boolean {
  return /\b(limit|limits|exceed(?:ed|s|ing)?|maximum|too many|subscription count|symbol count)\b/i.test(message);
}

interface PendingStart {
  generation: number;
  resolve(): void;
  reject(error: Error): void;
}

/**
 * FYERS Data Socket adapter. Owns only provider protocol and emits canonical
 * component updates; it never owns a live store, never imports apps/api, and
 * never enables SDK-side reconnect. The SDK object is a process-wide singleton
 * with single-slot listeners, so every instance re-registers all four events
 * and relies on a generation guard to make stale callbacks inert.
 */
export class FyersMarketDataStream implements FyersDriver {
  private readonly now: () => Date;
  private readonly credentials: CredentialStore;
  private readonly logPath: string;
  private readonly streamerFactory: FyersStreamerFactory;
  private readonly connectTimeoutMs: number;
  private streamer: FyersStreamer | null = null;
  private subscriptions = new Map<string, FyersDriverSubscription>(); // key: nativeIdentifier
  private callbacks: FyersDriverCallbacks | null = null;
  private state: ProviderConnectionState = "NOT_STARTED";
  private startGeneration = 0;
  private startInFlight = false;
  private ready = false;
  /** nativeIdentifier -> five-level depth established for that symbol. */
  private depthEstablished = new Set<string>();
  private limitReason: string | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStart: PendingStart | null = null;

  constructor(private readonly options: FyersStreamOptions) {
    this.now = options.now ?? (() => new Date());
    this.credentials = options.credentials;
    this.logPath = options.logPath ?? tmpdir();
    this.streamerFactory = options.streamerFactory ?? defaultStreamerFactory;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10000;
  }

  getConnectionState(): ProviderConnectionState {
    return this.state;
  }

  /** Provider-neutral capability report; entitlements stay UNKNOWN until verified. */
  getCapabilities(): CapabilityResult[] {
    const limited = this.limitReason !== null;
    const reason = this.limitReason;
    const limitExtras = (): Partial<CapabilityResult> =>
      limited && reason !== null ? { status: "LIMITED", reason } : {};
    return [
      {
        component: "quote", provider: "FYERS", status: "SUPPORTED",
        fields: ["ltp", "previousClose", "lastTradedTime", "lastTradedQuantity", "open", "high", "low", "volume", "averageTradePrice", "change", "changePercent"],
        entitlementUnverified: true,
        ...limitExtras()
      },
      {
        component: "depth", provider: "FYERS", status: "SUPPORTED", levels: 5,
        entitlementUnverified: true,
        ...limitExtras()
      },
      {
        component: "derivatives", provider: "FYERS", status: "UNSUPPORTED",
        reason: "OI/IV/Greeks are not available from the FYERS Data Socket (REST-only, M5)"
      }
    ];
  }

  private setState(state: ProviderConnectionState, error?: string | null): void {
    this.state = state;
    this.callbacks?.onConnectionState(state, error ?? null);
  }

  private validateSubscriptions(subscriptions: FyersDriverSubscription[]): void {
    const canonical = new Set<string>();
    const native = new Set<string>();
    for (const sub of subscriptions) {
      if (!sub || typeof sub.canonicalId !== "string" || sub.canonicalId.trim() === "") {
        throw new Error("FYERS subscription requires a canonicalId");
      }
      if (typeof sub.nativeIdentifier !== "string" || sub.nativeIdentifier.trim() === "") {
        throw new Error("FYERS subscription requires a nativeIdentifier");
      }
      if (canonical.has(sub.canonicalId)) throw new Error(`Duplicate FYERS canonicalId: ${sub.canonicalId}`);
      if (native.has(sub.nativeIdentifier)) throw new Error(`Duplicate FYERS nativeIdentifier: ${sub.nativeIdentifier}`);
      canonical.add(sub.canonicalId);
      native.add(sub.nativeIdentifier);
    }
  }

  private reportFailure(error: unknown, generation: number): void {
    if (generation !== this.startGeneration) return;
    const message = sanitizeError(error);
    if (isLimitFailure(message)) {
      this.limitReason = message;
      this.setState("ERROR", `FYERS Data Socket limit: ${message}`);
    } else {
      this.setState("ERROR", message);
    }
  }

  private cleanupStreamer(streamer: FyersStreamer): void {
    // Only the active instance owns the socket. A stale instance was already
    // closed by stop()/retirement; closing it again produces spurious SDK logs.
    if (this.streamer === streamer) {
      this.streamer = null;
      this.ready = false;
      try { streamer.close(); } catch { /* retirement is best-effort */ }
    }
  }

  private submitSubscriptions(streamer: FyersStreamer): void {
    const all = [...this.subscriptions.keys()];
    if (all.length === 0) return;
    // Submit the desired set as-is: no hardcoded cap, no silent truncation.
    streamer.subscribe(all);
    const depth = [...this.subscriptions.values()]
      .filter((s) => s.depth === true)
      .map((s) => s.nativeIdentifier);
    if (depth.length > 0) streamer.subscribe(depth, true);
  }

  private registerEvents(streamer: FyersStreamer, generation: number, signal: AbortSignal): void {
    // The SDK singleton has single-slot listeners and close() does not detach.
    // Re-register ALL FOUR events on every instance so stale slots are replaced.
    streamer.on("connect", () => {
      if (generation !== this.startGeneration) return;
      if (this.streamer !== streamer) return;
      try {
        this.submitSubscriptions(streamer);
        this.ready = true;
        this.setState("STREAMING");
        this.pendingStart?.resolve();
      } catch (error) {
        this.reportFailure(error, generation);
        this.pendingStart?.reject(error instanceof Error ? error : new Error(sanitizeError(error)));
        this.cleanupStreamer(streamer);
      }
    });
    streamer.on("message", (payload) => {
      if (generation !== this.startGeneration) return;
      if (this.streamer !== streamer) return;
      this.handleMessage(payload);
    });
    streamer.on("error", (err) => {
      if (generation !== this.startGeneration) return;
      if (this.streamer !== streamer) return;
      const message = sanitizeError(err);
      this.reportFailure(err, generation);
      this.pendingStart?.reject(new Error(message));
    });
    streamer.on("close", () => {
      if (generation !== this.startGeneration) return;
      if (this.streamer !== streamer) return;
      this.streamer = null;
      this.ready = false;
      this.setState("DISCONNECTED");
      // A close before connect is a failed startup: release the pending start
      // instead of letting it wait for the full connect timeout.
      if (this.pendingStart) {
        this.pendingStart.reject(new Error("FYERS Data Socket closed before connect"));
      }
    });
    void signal; // retained for signature parity; abort is handled in awaitConnect
  }

  private awaitConnect(streamer: FyersStreamer, generation: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.pendingStart = null;
        reject(new DOMException("FYERS stream start aborted", "AbortError"));
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      this.connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this.pendingStart = null;
        reject(new Error("FYERS Data Socket connect timed out"));
      }, this.connectTimeoutMs);
      this.pendingStart = {
        generation,
        resolve: () => {
          if (settled) return;
          settled = true;
          cleanup();
          this.pendingStart = null;
          resolve();
        },
        reject: (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.pendingStart = null;
          reject(error);
        }
      };
      try {
        streamer.connect();
      } catch (error) {
        this.pendingStart?.reject(error instanceof Error ? error : new Error(sanitizeError(error)));
      }
    });
  }

  async start(
    subscriptions: FyersDriverSubscription[],
    callbacks: FyersDriverCallbacks,
    signal: AbortSignal
  ): Promise<void> {
    this.validateSubscriptions(subscriptions);
    if (this.streamer) throw new Error("FYERS stream is already connected");
    if (this.startInFlight) throw new Error("FYERS stream start is already in progress");

    const generation = ++this.startGeneration;
    this.startInFlight = true;
    this.callbacks = callbacks;
    this.subscriptions = new Map(subscriptions.map((s) => [s.nativeIdentifier, { ...s }]));
    this.limitReason = null;
    this.setState("CONNECTING");

    let streamer: FyersStreamer | null = null;
    try {
      const token = await this.credentials.get("FYERS", FYERS_ACCESS_TOKEN_CREDENTIAL);
      if (generation !== this.startGeneration) return;
      if (!token) throw new Error("FYERS access token is not configured");

      streamer = this.streamerFactory(token, this.logPath, false);
      this.registerEvents(streamer, generation, signal);
      this.streamer = streamer;

      // Resolve on connect + successful subscription submission, never on an
      // undocumented cn/sub acknowledgement and never for the socket lifetime.
      await this.awaitConnect(streamer, generation, signal);
      if (generation !== this.startGeneration) return;
      this.startInFlight = false;
    } catch (error) {
      // A newer generation means stop()/retirement already closed this socket;
      // never close it twice. Only clean up the still-active generation.
      if (generation === this.startGeneration) {
        if (streamer) this.cleanupStreamer(streamer);
        this.startInFlight = false;
        this.reportFailure(error, generation);
      }
      throw error;
    }
  }

  async updateSubscriptions(subscriptions: FyersDriverSubscription[], signal: AbortSignal): Promise<void> {
    this.validateSubscriptions(subscriptions);
    if (signal.aborted) throw new DOMException("FYERS subscription update aborted", "AbortError");

    const next = new Map(subscriptions.map((s) => [s.nativeIdentifier, { ...s }]));
    const removed = [...this.subscriptions.keys()].filter((k) => !next.has(k));
    const added = [...next.values()].filter((s) => !this.subscriptions.has(s.nativeIdentifier));
    const changed = [...next.values()].filter((s) => {
      const current = this.subscriptions.get(s.nativeIdentifier);
      return current !== undefined && Boolean(current.depth) !== Boolean(s.depth);
    });

    // Surgical reset: clear depth protection only for removed symbols and for
    // symbols whose depth subscription was turned off. Symbols that remain
    // subscribed with depth keep their five-level-depth protection.
    for (const key of removed) this.depthEstablished.delete(key);
    for (const sub of changed) {
      if (sub.depth !== true) this.depthEstablished.delete(sub.nativeIdentifier);
    }

    if (!this.streamer || !this.ready) {
      this.subscriptions = next;
      return;
    }

    const streamer = this.streamer;
    try {
      const reconfigure = [...changed.map((s) => s.nativeIdentifier)];
      const detach = [...new Set([...removed, ...reconfigure])];
      if (detach.length) streamer.unsubscribe(detach);

      const attach = [...added, ...changed];
      if (attach.length) {
        streamer.subscribe(attach.map((s) => s.nativeIdentifier));
        const withDepth = attach.filter((s) => s.depth === true).map((s) => s.nativeIdentifier);
        if (withDepth.length) streamer.subscribe(withDepth, true);
      }
      // Commit only after all SDK operations succeed. On failure the connection
      // is invalidated so the supervisor retries with the last committed map.
      this.subscriptions = next;
    } catch (error) {
      this.cleanupStreamer(streamer);
      this.reportFailure(error, this.startGeneration);
      throw error;
    }
  }

  private handleMessage(payload: unknown): void {
    const msg = decodeMessage(payload);
    if (msg === null) {
      this.setState("ERROR", "FYERS SDK delivered a malformed message");
      return;
    }
    const type = typeof msg.type === "string" ? msg.type : "";
    if (CONTROL_TYPES.has(type)) return; // cn/sub/unsub are control, not observations
    if (type !== "sf" && type !== "if" && type !== "dp") return;

    const symbol = typeof msg.symbol === "string" ? msg.symbol : "";
    if (symbol === "") return;
    const sub = this.subscriptions.get(symbol);
    if (!sub) return; // symbol->canonical mapping comes from the caller only

    const receivedAtMs = this.now().getTime();
    const canonicalId = sub.canonicalId;

    if (type === "dp") {
      // dp carries no price fields. Emitting an observation here would replace
      // the provider's quote observation in the shared store with an empty one.
      this.depthEstablished.add(symbol);
      const update = dpDepthUpdate(msg, canonicalId, receivedAtMs);
      if (update) this.callbacks?.onComponentUpdate?.(update);
      return;
    }
    // Only price-bearing frames produce observations (mirrors the Upstox seam).
    this.callbacks?.onObservation?.(observationFrom(msg, canonicalId, receivedAtMs));
    if (type === "sf") {
      const quote = sfQuoteUpdate(msg, canonicalId, receivedAtMs);
      if (quote) this.callbacks?.onComponentUpdate?.(quote);
      // Suppress L1 depth once five-level depth is established for this symbol.
      if (!this.depthEstablished.has(symbol)) {
        const depth = sfDepthUpdate(msg, canonicalId, receivedAtMs);
        if (depth) this.callbacks?.onComponentUpdate?.(depth);
      }
      return;
    }
    const quote = ifQuoteUpdate(msg, canonicalId, receivedAtMs);
    if (quote) this.callbacks?.onComponentUpdate?.(quote);
  }

  stop(): void {
    this.startGeneration++;
    this.startInFlight = false;
    const streamer = this.streamer;
    this.streamer = null;
    this.subscriptions = new Map();
    this.callbacks = null;
    this.ready = false;
    this.depthEstablished.clear(); // full clear only on retirement/replacement
    this.limitReason = null;
    if (this.connectTimer !== null) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (this.pendingStart) {
      this.pendingStart.reject(new Error("FYERS stream stopped"));
      this.pendingStart = null;
    }
    if (streamer) { try { streamer.close(); } catch { /* idempotent */ } }
    this.setState("DISCONNECTED");
  }
}
