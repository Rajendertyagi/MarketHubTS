import { createRequire } from "node:module";
import type { CredentialStore, ProviderConnectionState } from "@markethub/contracts";
import type { NormalizeObservationInput } from "@markethub/market-core";
import { sanitizeError } from "@markethub/market-core";
import { UPSTOX_TOKEN_CREDENTIAL } from "./constants";

// createRequire selects the full CommonJS build of the SDK under Bun 1.4.4.
const require = createRequire(import.meta.url);
const sdk = require("upstox-js-sdk") as {
  ApiClient: { instance: { authentications: Record<string, { accessToken?: string }> } };
  MarketDataStreamerV3: new (instrumentKeys: string[], mode: string) => SdkStreamer;
};

/** Minimal structural interface for the SDK streamer — SDK types stay behind this seam. */
export interface SdkStreamer {
  autoReconnect(enable: boolean): void;
  on(event: string, listener: (payload?: unknown) => void): void;
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(instrumentKeys: string[], mode: string): void;
  unsubscribe(instrumentKeys: string[]): void;
  /** SDK-internal: inner feeder and its protobuf root (version-specific readiness signal). */
  streamer?: { protobufRoot?: unknown };
}

export type StreamerFactory = () => SdkStreamer;

/** Published V3 limits (verified 2026-11-16). Individual / combined. */
export const UPSTOX_V3_LIMITS = {
  connectionsPerUser: 2,
  ltpc: { individual: 5000, combined: 2000 },
  option_greeks: { individual: 3000, combined: 2000 },
  full: { individual: 2000, combined: 1500 },
  full_d30: { individual: 50, combined: 1500 }
} as const;

export type UpstoxFeedMode = "ltpc" | "full" | "option_greeks" | "full_d30";

export interface UpstoxSubscription {
  instrumentKey: string;
  canonicalId: string;
  mode?: UpstoxFeedMode;
}

export interface UpstoxStreamCallbacks {
  onObservation: (input: NormalizeObservationInput) => void;
  onConnectionState: (state: ProviderConnectionState, error?: string | null) => void;
}

export interface UpstoxStreamOptions {
  credentials: CredentialStore;
  now?: () => Date;
  streamerFactory?: StreamerFactory;
  /** Bounded wait for SDK protobuf readiness. Default 2000ms. */
  protobufReadyTimeoutMs?: number;
  /** Test seam: override the readiness check. */
  isProtobufReady?: (streamer: SdkStreamer) => boolean;
}

export function modeLimit(mode: UpstoxFeedMode, combined: boolean): number {
  const limits = UPSTOX_V3_LIMITS[mode];
  return combined ? limits.combined : limits.individual;
}

export function groupByMode(subscriptions: UpstoxSubscription[]): Map<UpstoxFeedMode, UpstoxSubscription[]> {
  const groups = new Map<UpstoxFeedMode, UpstoxSubscription[]>();
  for (const sub of subscriptions) {
    const mode = sub.mode ?? "ltpc";
    const group = groups.get(mode) ?? [];
    group.push(sub);
    groups.set(mode, group);
  }
  return groups;
}

function defaultStreamerFactory(): SdkStreamer {
  // Empty initial key list: MarketHubTS owns subscription state.
  return new sdk.MarketDataStreamerV3([], "ltpc");
}

function defaultIsProtobufReady(streamer: SdkStreamer): boolean {
  // Version-specific workaround for SDK 2.31.0: the inner feeder exposes
  // protobufRoot, which is null until the async schema load completes.
  return streamer.streamer?.protobufRoot != null;
}

function decodeMessage(data: unknown): string | null {
  if (data === null || data === undefined) return null; // SDK pre-readiness "null"
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isSafeInteger(n) || Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Convert an int64 decimal string to a safe number, or null with a diagnostic. */
function int64ToNumber(value: unknown): { value: number | null; unsafe: boolean } {
  if (value === null || value === undefined) return { value: null, unsafe: false };
  const n = toNumber(value);
  if (n === null) return { value: null, unsafe: true };
  if (!Number.isSafeInteger(n)) return { value: null, unsafe: true };
  return { value: n, unsafe: false };
}

interface NativeFields {
  [key: string]: unknown;
}

function mapNative(feed: any): NativeFields {
  const native: NativeFields = {};
  const full = feed?.fullFeed?.marketFF ?? feed?.fullFeed?.indexFF ?? feed?.firstLevelWithGreeks;
  if (!full) return native;

  const greeks = full.optionGreeks;
  if (greeks) {
    native.optionGreeks = {
      delta: toNumber(greeks.delta), theta: toNumber(greeks.theta),
      gamma: toNumber(greeks.gamma), vega: toNumber(greeks.vega), rho: toNumber(greeks.rho)
    };
  }
  for (const key of ["oi", "iv", "vtt", "atp", "tbq", "tsq"] as const) {
    const v = toNumber(full[key]);
    if (v !== null) native[key] = v;
  }
  const marketFF = feed?.fullFeed?.marketFF;
  if (marketFF) {
    // Proto3 scalar defaults: when the parent message exists, omitted scalars
    // decode to 0/false. Preserve that behavior for CAS fields.
    for (const key of ["iep", "rp"] as const) native[key] = toNumber(marketFF[key]) ?? 0;
    for (const key of ["ieq", "iiqTotal", "iiqM"] as const) {
      const c = int64ToNumber(marketFF[key]);
      native[key] = c.value ?? 0;
    }
    native.casEligible = marketFF.casEligible === true;
    const quotes = marketFF.marketLevel?.bidAskQuote;
    if (Array.isArray(quotes) && quotes.length) {
      native.depth = quotes.map((q: any) => ({
        bidQ: int64ToNumber(q.bidQ).value ?? 0, bidP: toNumber(q.bidP) ?? 0,
        askQ: int64ToNumber(q.askQ).value ?? 0, askP: toNumber(q.askP) ?? 0
      }));
    }
  }
  const greeksFeed = feed?.firstLevelWithGreeks;
  if (greeksFeed?.firstDepth) {
    const q = greeksFeed.firstDepth;
    native.firstDepth = {
      bidQ: int64ToNumber(q.bidQ).value ?? 0, bidP: toNumber(q.bidP) ?? 0,
      askQ: int64ToNumber(q.askQ).value ?? 0, askP: toNumber(q.askP) ?? 0
    };
  }
  const ohlcSource = marketFF?.marketOHLC?.ohlc ?? feed?.fullFeed?.indexFF?.marketOHLC?.ohlc;
  if (Array.isArray(ohlcSource) && ohlcSource.length) {
    native.ohlc = ohlcSource.map((b: any) => ({
      interval: typeof b.interval === "string" ? b.interval : null,
      open: toNumber(b.open) ?? 0, high: toNumber(b.high) ?? 0, low: toNumber(b.low) ?? 0,
      close: toNumber(b.close) ?? 0, vol: int64ToNumber(b.vol).value ?? 0,
      ts: int64ToNumber(b.ts).value ?? 0
    }));
  }
  return native;
}

function extractLtpc(feed: any): any | null {
  if (feed?.ltpc) return feed.ltpc;
  const full = feed?.fullFeed;
  if (full?.marketFF?.ltpc) return full.marketFF.ltpc;
  if (full?.indexFF?.ltpc) return full.indexFF.ltpc;
  if (feed?.firstLevelWithGreeks?.ltpc) return feed.firstLevelWithGreeks.ltpc;
  return null;
}

/**
 * Upstox V3 stream using the official SDK. Owns only provider protocol and
 * emits shared NormalizeObservationInput values; never owns a live store.
 */
export class UpstoxMarketDataStream {
  private readonly now: () => Date;
  private readonly streamerFactory: StreamerFactory;
  private readonly protobufReadyTimeoutMs: number;
  private readonly isProtobufReady: (streamer: SdkStreamer) => boolean;
  private streamer: SdkStreamer | null = null;
  private subscriptions = new Map<string, UpstoxSubscription>();
  private callbacks: UpstoxStreamCallbacks | null = null;
  private state: ProviderConnectionState = "NOT_STARTED";
  private startGeneration = 0;
  private startInFlight = false;
  private ready = false;

  constructor(private readonly options: UpstoxStreamOptions) {
    this.now = options.now ?? (() => new Date());
    this.streamerFactory = options.streamerFactory ?? defaultStreamerFactory;
    this.protobufReadyTimeoutMs = options.protobufReadyTimeoutMs ?? 2000;
    this.isProtobufReady = options.isProtobufReady ?? defaultIsProtobufReady;
  }

  getConnectionState(): ProviderConnectionState { return this.state; }
  getSubscriptions(): UpstoxSubscription[] {
    return [...this.subscriptions.values()].map((s) => ({ ...s }));
  }

  private setState(state: ProviderConnectionState, error: string | null = null): void {
    this.state = state;
    this.callbacks?.onConnectionState(state, error);
  }

  private validateSubscriptions(subscriptions: UpstoxSubscription[]): void {
    if (subscriptions.length === 0) throw new Error("At least one subscription is required");
    const seen = new Set<string>();
    for (const sub of subscriptions) {
      if (!sub.instrumentKey || !sub.canonicalId) throw new Error("Each subscription requires an instrumentKey and canonicalId");
      if (seen.has(sub.instrumentKey)) throw new Error(`Duplicate instrument key: ${sub.instrumentKey}`);
      seen.add(sub.instrumentKey);
    }
    const groups = groupByMode(subscriptions);
    const combined = groups.size > 1;
    for (const [mode, subs] of groups) {
      const limit = modeLimit(mode, combined);
      if (subs.length > limit) throw new Error(`${mode} subscription count ${subs.length} exceeds limit ${limit}`);
    }
  }

  private async waitForProtobufReady(streamer: SdkStreamer, generation: number): Promise<boolean> {
    // Wall-clock deadline: the injected now() is for observation timestamps and
    // may be fixed in tests, so it must not drive a real timeout.
    const deadline = Date.now() + this.protobufReadyTimeoutMs;
    while (Date.now() < deadline) {
      if (generation !== this.startGeneration) return false;
      if (this.isProtobufReady(streamer)) return true;
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    return this.isProtobufReady(streamer);
  }

  private sendSubscriptions(streamer: SdkStreamer): void {
    for (const [mode, subs] of groupByMode([...this.subscriptions.values()])) {
      streamer.subscribe(subs.map((s) => s.instrumentKey), mode);
    }
  }

  async start(subscriptions: UpstoxSubscription[], callbacks: UpstoxStreamCallbacks): Promise<void> {
    this.validateSubscriptions(subscriptions);
    if (this.streamer) throw new Error("Upstox stream is already connected");
    if (this.startInFlight) throw new Error("Upstox stream start is already in progress");

    const generation = ++this.startGeneration;
    this.startInFlight = true;
    this.callbacks = callbacks;
    this.subscriptions = new Map(subscriptions.map((s) => [s.instrumentKey, { ...s }]));
    this.setState("CONNECTING");

    try {
      const token = await this.options.credentials.get("UPSTOX", UPSTOX_TOKEN_CREDENTIAL);
      if (!token) throw new Error("Upstox Analytics Token is not configured");
      const oauth2 = sdk.ApiClient.instance.authentications.OAUTH2;
      if (!oauth2) throw new Error("Upstox SDK OAUTH2 authentication slot is unavailable");
      oauth2.accessToken = token;

      const streamer = this.streamerFactory();
      // SDK defaults autoReconnect to TRUE — explicitly disable so MarketHubTS
      // is the sole owner of reconnection.
      streamer.autoReconnect(false);

      streamer.on("open", () => {
        if (generation !== this.startGeneration) return;
        void this.waitForProtobufReady(streamer, generation).then((ready) => {
          if (generation !== this.startGeneration) return;
          if (!ready) {
            this.setState("ERROR", "Upstox SDK protobuf schema did not become ready");
            try { streamer.disconnect(); } catch {}
            if (this.streamer === streamer) this.streamer = null;
            return;
          }
          this.ready = true;
          this.setState("STREAMING");
          this.sendSubscriptions(streamer);
        });
      });
      streamer.on("message", (payload) => {
        if (generation !== this.startGeneration) return;
        this.handleMessage(payload);
      });
      streamer.on("close", () => {
        if (generation !== this.startGeneration) return;
        this.streamer = null;
        this.ready = false;
        this.setState("DISCONNECTED");
      });
      streamer.on("error", (err) => {
        if (generation !== this.startGeneration) return;
        this.setState("ERROR", sanitizeError(err));
      });

      this.streamer = streamer;
      await streamer.connect();
      this.startInFlight = false;
    } catch (error) {
      if (generation === this.startGeneration) {
        this.startInFlight = false;
        this.setState("ERROR", sanitizeError(error));
      }
      throw error;
    }
  }

  async updateSubscriptions(subscriptions: UpstoxSubscription[]): Promise<void> {
    this.validateSubscriptions(subscriptions);
    const next = new Map(subscriptions.map((s) => [s.instrumentKey, { ...s }]));
    const removed = [...this.subscriptions.keys()].filter((k) => !next.has(k));
    const added = [...next.values()].filter((s) => !this.subscriptions.has(s.instrumentKey));
    const modeChanged = [...next.values()].filter((s) => {
      const cur = this.subscriptions.get(s.instrumentKey);
      return cur && cur.mode !== s.mode;
    });
    if (!this.streamer || !this.ready) {
      // Defer: desired state changes only; no SDK calls while disconnected/connecting.
      this.subscriptions = next;
      return;
    }
    const streamer = this.streamer;
    try {
      if (removed.length) streamer.unsubscribe(removed);
      if (added.length) {
        for (const [mode, subs] of groupByMode(added)) streamer.subscribe(subs.map((s) => s.instrumentKey), mode);
      }
      if (modeChanged.length) {
        // SDK changeMode() is defective (sends sub instead of change_mode).
        for (const s of modeChanged) {
          streamer.unsubscribe([s.instrumentKey]);
          streamer.subscribe([s.instrumentKey], s.mode ?? "ltpc");
        }
      }
      this.subscriptions = next; // commit only after SDK operations succeed
    } catch (error) {
      this.setState("ERROR", sanitizeError(error));
      throw error;
    }
  }

  private handleMessage(payload: unknown): void {
    const text = decodeMessage(payload);
    if (text === null) return; // SDK pre-readiness "null" — ignore, never fabricate
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      this.setState("ERROR", "Upstox SDK delivered a malformed message");
      return;
    }
    // market_info is the first V3 message and has no feeds map — handle before feeds validation.
    if (message?.type === "market_info") return;
    if (!message?.feeds || typeof message.feeds !== "object") {
      this.setState("ERROR", "Upstox SDK message is missing the feeds map");
      return;
    }
    const receivedAtMs = this.now().getTime();
    for (const [instrumentKey, feed] of Object.entries(message.feeds as Record<string, unknown>)) {
      const sub = this.subscriptions.get(instrumentKey);
      if (!sub) continue;
      const ltpc = extractLtpc(feed);
      if (!ltpc) continue;
      const ltp = toNumber(ltpc.ltp);
      if (ltp === null) continue;
      const value: Record<string, unknown> = { ltp };
      const qty = int64ToNumber(ltpc.ltq);
      if (qty.value !== null) value.lastTradedQuantity = qty.value;
      const cp = toNumber(ltpc.cp);
      if (cp !== null) value.close = cp;
      const native = mapNative(feed);
      // LTPC IEP wrapper: absent -> undefined; present (incl. {} for zero) -> 0.
      if (ltpc.iep !== null && ltpc.iep !== undefined) {
        native.ltpcIep = toNumber(ltpc.iep.value) ?? 0;
      }
      if (Object.keys(native).length) value.native = native;
      this.callbacks?.onObservation({
        provider: "UPSTOX",
        canonicalId: sub.canonicalId,
        value,
        rawProviderTimestamp: int64ToNumber(ltpc.ltt).value,
        providerTimestampUnit: "MS",
        providerTimestampMeaning: "last traded time",
        receivedAtMs,
        providerSequence: null,
        sourceVersion: "v3"
      });
    }
  }

  stop(): void {
    this.startGeneration++;
    this.startInFlight = false;
    const streamer = this.streamer;
    this.streamer = null;
    this.subscriptions = new Map();
    this.callbacks = null;
    this.ready = false;
    if (streamer) { try { streamer.disconnect(); } catch {} }
    this.setState("DISCONNECTED");
  }
}
