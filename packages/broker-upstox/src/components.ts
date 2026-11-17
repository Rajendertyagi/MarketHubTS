import type {
  CapabilityResult,
  ComponentUpdate,
  OhlcIntervalRecord,
  QuoteField,
  SourceTimestamp
} from "@markethub/contracts";
import type { NormalizeObservationInput } from "@markethub/market-core";

type NativeRecord = Record<string, unknown>;

function sourceTimestamp(input: NormalizeObservationInput): SourceTimestamp {
  return {
    raw: input.rawProviderTimestamp,
    unit: input.providerTimestampUnit,
    meaning: input.providerTimestampMeaning,
    normalizedMs: input.rawProviderTimestamp !== null && input.providerTimestampUnit !== "UNKNOWN"
      ? (input.providerTimestampUnit === "MS" ? input.rawProviderTimestamp : input.rawProviderTimestamp * 1000)
      : null,
    trusted: input.providerTimestampUnit !== "UNKNOWN" && input.rawProviderTimestamp !== null
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nativeOf(input: NormalizeObservationInput): NativeRecord {
  return (input.value.native ?? {}) as NativeRecord;
}

function ohlcRecords(native: NativeRecord, timestamp: SourceTimestamp): OhlcIntervalRecord[] {
  const raw = native.ohlc;
  if (!Array.isArray(raw)) return [];
  const records: OhlcIntervalRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const bar = entry as NativeRecord;
    const open = numberOrUndefined(bar.open);
    const high = numberOrUndefined(bar.high);
    const low = numberOrUndefined(bar.low);
    const close = numberOrUndefined(bar.close);
    if (open === undefined || high === undefined || low === undefined || close === undefined) continue;
    const barTs = typeof bar.ts === "number"
      ? { ...timestamp, raw: bar.ts, normalizedMs: bar.ts, trusted: true }
      : timestamp;
    const record: OhlcIntervalRecord = {
      interval: typeof bar.interval === "string" ? bar.interval : "unknown",
      open, high, low, close,
      timestamp: barTs
    };
    const vol = numberOrUndefined(bar.vol);
    if (vol !== undefined) record.volume = vol;
    records.push(record);
  }
  return records;
}

/**
 * Adapt the existing Upstox normalization boundary to the canonical component
 * model. Provider protocol work stays in UpstoxMarketDataStream; this function
 * only translates its already-decoded observation into component updates.
 * Fields absent from the feed are omitted, never fabricated or zeroed.
 */
export function upstoxComponentUpdates(input: NormalizeObservationInput): ComponentUpdate[] {
  const timestamp = sourceTimestamp(input);
  const native = nativeOf(input);
  const receivedAtMs = input.receivedAtMs;
  const provenance = {
    source: "provider-feed",
    provider: "UPSTOX" as const,
    receivedAt: new Date(receivedAtMs).toISOString(),
    sourceVersion: "v3"
  };
  const updates: ComponentUpdate[] = [];

  // --- quote ---
  const quoteSet: Partial<Record<QuoteField, { value: unknown; sourceTimestamp?: SourceTimestamp; receivedAtMs: number }>> = {};
  if (typeof input.value.ltp === "number") quoteSet.ltp = { value: input.value.ltp, sourceTimestamp: timestamp, receivedAtMs };
  // Upstox cp is the previous session close. The legacy `close` alias carries
  // the same value during migration; both are set from the same source value.
  const previousClose = numberOrUndefined(input.value.close);
  if (previousClose !== undefined) {
    quoteSet.previousClose = { value: previousClose, receivedAtMs };
    quoteSet.close = { value: previousClose, receivedAtMs };
  }
  if (typeof input.value.lastTradedQuantity === "number") {
    quoteSet.lastTradedQuantity = { value: input.value.lastTradedQuantity, sourceTimestamp: timestamp, receivedAtMs };
  }
  if (typeof input.value.open === "number") quoteSet.open = { value: input.value.open, receivedAtMs };
  if (typeof input.value.high === "number") quoteSet.high = { value: input.value.high, receivedAtMs };
  if (typeof input.value.low === "number") quoteSet.low = { value: input.value.low, receivedAtMs };
  if (typeof input.value.volume === "number") quoteSet.volume = { value: input.value.volume, receivedAtMs };
  const atp = numberOrUndefined(native.atp);
  if (atp !== undefined) quoteSet.averageTradePrice = { value: atp, receivedAtMs };
  const records = ohlcRecords(native, timestamp);
  if (records.length > 0) quoteSet.ohlc = { value: records, receivedAtMs };
  if (Object.keys(quoteSet).length > 0) {
    updates.push({
      provider: "UPSTOX", canonicalId: input.canonicalId, component: "quote",
      set: quoteSet, receivedAtMs, provenance
    });
  }

  // --- depth (market instruments only; IndexFullFeed has no depth) ---
  const depthRaw = native.depth;
  const firstDepth = native.firstDepth;
  type Level = { index: number; bidPrice?: number; askPrice?: number; bidSize?: number; askSize?: number };
  const toLevel = (l: NativeRecord, index: number): Level => {
    const level: Level = { index };
    const bidPrice = numberOrUndefined(l.bidP); if (bidPrice !== undefined) level.bidPrice = bidPrice;
    const askPrice = numberOrUndefined(l.askP); if (askPrice !== undefined) level.askPrice = askPrice;
    const bidSize = numberOrUndefined(l.bidQ); if (bidSize !== undefined) level.bidSize = bidSize;
    const askSize = numberOrUndefined(l.askQ); if (askSize !== undefined) level.askSize = askSize;
    return level;
  };
  let levels: Level[] = [];
  if (Array.isArray(depthRaw)) {
    levels = depthRaw
      .filter((l): l is NativeRecord => Boolean(l) && typeof l === "object")
      .map((l, i) => toLevel(l, i + 1));
  } else if (firstDepth && typeof firstDepth === "object") {
    levels = [toLevel(firstDepth as NativeRecord, 1)];
  }
  if (levels.length > 0) {
    updates.push({
      provider: "UPSTOX", canonicalId: input.canonicalId, component: "depth",
      set: {
        levels: { value: levels, receivedAtMs },
        levelCount: { value: levels.length, receivedAtMs }
      },
      receivedAtMs, provenance
    });
  }

  // --- derivatives (documented Full / option-greeks fields only) ---
  const derivativesSet: Record<string, { value: unknown; receivedAtMs: number }> = {};
  const oi = numberOrUndefined(native.oi);
  const iv = numberOrUndefined(native.iv);
  if (oi !== undefined) derivativesSet.oi = { value: oi, receivedAtMs };
  if (iv !== undefined) derivativesSet.iv = { value: iv, receivedAtMs };
  const greeksRaw = native.optionGreeks;
  if (greeksRaw && typeof greeksRaw === "object") {
    const g = greeksRaw as NativeRecord;
    const greeks: Record<string, number> = {};
    for (const key of ["delta", "theta", "gamma", "vega", "rho"] as const) {
      const value = numberOrUndefined(g[key]);
      if (value !== undefined) greeks[key] = value;
    }
    if (Object.keys(greeks).length > 0) derivativesSet.greeks = { value: greeks, receivedAtMs };
  }
  if (Object.keys(derivativesSet).length > 0) {
    updates.push({
      provider: "UPSTOX", canonicalId: input.canonicalId, component: "derivatives",
      set: derivativesSet, receivedAtMs, provenance
    });
  }

  return updates;
}

/**
 * Provider-neutral capability reporting for Upstox. Index instruments use
 * IndexFullFeed (LTPC + OHLC only) and never claim market depth or Greeks.
 * The option_greeks mode table says "only Greeks" while its example/schema also
 * shows extra fields; those extra fields are reported as unverified.
 */
export function upstoxCapabilities(instrumentType: "INDEX" | "MARKET", mode: "ltpc" | "full" | "full_d30" | "option_greeks"): CapabilityResult[] {
  const base = (component: CapabilityResult["component"], status: CapabilityResult["status"], extra: Partial<CapabilityResult> = {}): CapabilityResult => ({
    component, provider: "UPSTOX", status, ...extra
  });
  const results: CapabilityResult[] = [base("quote", "SUPPORTED", {
    fields: instrumentType === "INDEX" ? ["ltp", "previousClose", "ohlc"] : ["ltp", "previousClose", "lastTradedQuantity", "ohlc", "averageTradePrice"]
  })];

  if (instrumentType === "INDEX") {
    results.push(base("depth", "UNSUPPORTED", { reason: "IndexFullFeed has no marketLevel depth" }));
    results.push(base("derivatives", "UNSUPPORTED", { reason: "IndexFullFeed has no option Greeks or OI/IV" }));
    return results;
  }

  if (mode === "full" || mode === "full_d30") {
    results.push(base("depth", "SUPPORTED", { levels: mode === "full" ? 5 : 30, entitlementUnverified: mode === "full_d30" }));
    results.push(base("derivatives", "SUPPORTED", { fields: ["oi", "iv", "greeks"], entitlementUnverified: true }));
  } else if (mode === "option_greeks") {
    results.push(base("depth", "LIMITED", {
      levels: 1,
      reason: "firstDepth appears in the example/schema but the mode table says only Greeks; live delivery unverified"
    }));
    results.push(base("derivatives", "LIMITED", {
      fields: ["greeks"],
      reason: "Only Greeks are guaranteed; OI/IV appear in the example/schema but are unverified for this mode"
    }));
  } else {
    results.push(base("depth", "UNSUPPORTED", { reason: "LTPC has no depth" }));
    results.push(base("derivatives", "UNSUPPORTED", { reason: "LTPC has no derivatives fields" }));
  }
  return results;
}
