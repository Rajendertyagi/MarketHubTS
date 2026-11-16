import { createRequire } from "node:module";
import { resolve } from "node:path";

// protobufjs v8's default ESM entry resolves to the light build (no loadSync).
// createRequire selects the full CommonJS build, which resolves well-known types.
const require = createRequire(import.meta.url);
const protobuf = require("protobufjs") as typeof import("protobufjs");

const PROTO_PATH = resolve(import.meta.dir, "proto", "MarketDataFeed.proto");
const FEED_RESPONSE_TYPE = "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse";

let cachedType: ReturnType<typeof protobuf.Root.prototype.lookupType> | null = null;

function feedResponseType(): ReturnType<typeof protobuf.Root.prototype.lookupType> {
  if (!cachedType) {
    const root = protobuf.loadSync(PROTO_PATH);
    cachedType = root.lookupType(FEED_RESPONSE_TYPE);
  }
  return cachedType;
}

/** Convert protobuf int64 (Long), number or numeric string to a finite number. */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof (value as { toNumber?: unknown }).toNumber === "function") {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Encode a FeedResponse for deterministic tests. Not part of the runtime feed path. */
export function encodeFeedResponse(payload: Record<string, unknown>): Uint8Array {
  const type = feedResponseType();
  const error = type.verify(payload);
  if (error) throw new Error(error);
  return type.encode(type.create(payload)).finish();
}

export type UpstoxFeedMessageType = "initial_feed" | "live_feed" | "market_info";

export interface DecodedDepthLevel {
  bidQ: number | null;
  bidP: number | null;
  askQ: number | null;
  askP: number | null;
}

export interface DecodedOhlc {
  interval: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  vol: number | null;
  ts: number | null;
}

export interface DecodedGreeks {
  delta: number | null;
  theta: number | null;
  gamma: number | null;
  vega: number | null;
  rho: number | null;
}

/** Provider-native fields preserved verbatim; never fabricated. */
export interface UpstoxNativeFields {
  optionGreeks?: DecodedGreeks;
  oi?: number;
  iv?: number;
  vtt?: number;
  atp?: number;
  tbq?: number;
  tsq?: number;
  depth?: DecodedDepthLevel[];
  firstDepth?: DecodedDepthLevel;
  ohlc?: DecodedOhlc[];
}

export interface DecodedFeedEntry {
  instrumentKey: string;
  ltp: number;
  lastTradedTimeMs: number | null;
  lastTradedQty: number | null;
  close: number | null;
  native: UpstoxNativeFields;
}

export interface DecodedFeed {
  type: UpstoxFeedMessageType;
  currentTs: number | null;
  entries: DecodedFeedEntry[];
}

function extractLtpc(feed: any): any | null {
  if (feed?.ltpc) return feed.ltpc;
  const full = feed?.fullFeed;
  if (full?.marketFF?.ltpc) return full.marketFF.ltpc;
  if (full?.indexFF?.ltpc) return full.indexFF.ltpc;
  if (feed?.firstLevelWithGreeks?.ltpc) return feed.firstLevelWithGreeks.ltpc;
  return null;
}

function depthLevel(quote: any): DecodedDepthLevel {
  return {
    bidQ: toNumber(quote?.bidQ),
    bidP: toNumber(quote?.bidP),
    askQ: toNumber(quote?.askQ),
    askP: toNumber(quote?.askP)
  };
}

function ohlcBar(bar: any): DecodedOhlc {
  return {
    interval: typeof bar?.interval === "string" ? bar.interval : null,
    open: toNumber(bar?.open),
    high: toNumber(bar?.high),
    low: toNumber(bar?.low),
    close: toNumber(bar?.close),
    vol: toNumber(bar?.vol),
    ts: toNumber(bar?.ts)
  };
}

function nativeFields(feed: any): UpstoxNativeFields {
  const native: UpstoxNativeFields = {};
  const marketFF = feed?.fullFeed?.marketFF;
  const indexFF = feed?.fullFeed?.indexFF;
  const greeksFeed = feed?.firstLevelWithGreeks;
  const full = marketFF ?? indexFF ?? greeksFeed;
  if (!full) return native;

  const greeks = full.optionGreeks;
  if (greeks) {
    native.optionGreeks = {
      delta: toNumber(greeks.delta),
      theta: toNumber(greeks.theta),
      gamma: toNumber(greeks.gamma),
      vega: toNumber(greeks.vega),
      rho: toNumber(greeks.rho)
    };
  }
  for (const key of ["oi", "iv", "vtt", "atp", "tbq", "tsq"] as const) {
    const value = toNumber(full[key]);
    if (value !== null) native[key] = value;
  }

  // Market depth: 5-level (marketFF) or first level (greeksFeed).
  if (Array.isArray(marketFF?.marketLevel?.bidAskQuote) && marketFF.marketLevel.bidAskQuote.length > 0) {
    native.depth = marketFF.marketLevel.bidAskQuote.map(depthLevel);
  }
  if (greeksFeed?.firstDepth) native.firstDepth = depthLevel(greeksFeed.firstDepth);

  // OHLC bars: present on marketFF and indexFF full feeds.
  const ohlcSource = marketFF?.marketOHLC?.ohlc ?? indexFF?.marketOHLC?.ohlc;
  if (Array.isArray(ohlcSource) && ohlcSource.length > 0) {
    native.ohlc = ohlcSource.map(ohlcBar);
  }
  return native;
}

/**
 * Decode and validate a protobuf FeedResponse. Malformed or unexpected payloads
 * throw; callers must convert that into an explicit error state, never a value.
 */
export function decodeFeedResponse(bytes: Uint8Array): DecodedFeed {
  const message: any = feedResponseType().decode(bytes);

  const typeMap: Record<number, UpstoxFeedMessageType> = {
    0: "initial_feed",
    1: "live_feed",
    2: "market_info"
  };
  const type = typeMap[message?.type];
  if (!type) throw new Error("Upstox feed returned an unknown message type");
  if (!message.feeds || typeof message.feeds !== "object") {
    throw new Error("Upstox feed response is missing the feeds map");
  }

  const entries: DecodedFeedEntry[] = [];
  for (const [instrumentKey, feed] of Object.entries(message.feeds as Record<string, unknown>)) {
    const ltpc = extractLtpc(feed);
    if (!ltpc) continue; // no LTP data supplied — never fabricate
    const ltp = toNumber(ltpc.ltp);
    if (ltp === null) continue; // invalid price — skip this instrument
    entries.push({
      instrumentKey,
      ltp,
      lastTradedTimeMs: toNumber(ltpc.ltt),
      lastTradedQty: toNumber(ltpc.ltq),
      close: toNumber(ltpc.cp),
      native: nativeFields(feed)
    });
  }

  return { type, currentTs: toNumber(message.currentTs), entries };
}
