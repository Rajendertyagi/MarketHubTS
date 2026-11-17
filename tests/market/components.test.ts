import { describe, expect, test } from "bun:test";
import type {
  ComponentUpdate,
  FieldUpdate,
  FreshnessPolicy,
  MarketSessionState,
  ProviderId,
  QuoteField,
  SourceTimestamp
} from "../../packages/contracts/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";

const NIFTY = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000,
  unknownMaxAgeMs: 5_000,
  maxRetainedObservationAgeMs: 60_000
};

function harness() {
  let nowMs = BASE;
  let session: MarketSessionState = "OPEN";
  const service = new MarketDataService({
    now: () => new Date(nowMs),
    policy,
    maxInstruments: 10,
    session: () => session
  });
  service.track(NIFTY);
  return {
    service,
    setNow: (ms: number) => { nowMs = ms; },
    setSession: (s: MarketSessionState) => { session = s; },
    connect: (provider: ProviderId) => service.setProviderConnection(provider, "STREAMING")
  };
}

function ts(raw: number, meaning = "last traded time"): SourceTimestamp {
  return { raw, unit: "MS", meaning, normalizedMs: raw, trusted: true };
}

function field<T>(value: T, receivedAtMs: number, source?: SourceTimestamp): FieldUpdate<T> {
  return { value, receivedAtMs, ...(source ? { sourceTimestamp: source } : {}) };
}

function quoteUpdate(
  provider: ProviderId,
  set: Partial<Record<QuoteField, FieldUpdate>>,
  receivedAtMs: number,
  complete = false
): ComponentUpdate<QuoteField> {
  return {
    provider,
    canonicalId: NIFTY,
    component: "quote",
    set,
    complete,
    receivedAtMs,
    provenance: { source: "provider-feed", provider, receivedAt: new Date(receivedAtMs).toISOString() }
  };
}

function depthUpdate(provider: ProviderId, levelCount: number, receivedAtMs: number): ComponentUpdate {
  const levels = Array.from({ length: levelCount }, (_, i) => ({
    index: i + 1,
    bidPrice: 100 - i,
    askPrice: 100 + i,
    bidSize: 10,
    askSize: 20
  }));
  return {
    provider,
    canonicalId: NIFTY,
    component: "depth",
    set: { levels: field(levels, receivedAtMs), levelCount: field(levelCount, receivedAtMs) },
    receivedAtMs,
    provenance: { source: "provider-feed", provider, receivedAt: new Date(receivedAtMs).toISOString() }
  };
}

describe("quote field semantics", () => {
  test("legacy close alias maps only to previous session close", () => {
    const h = harness();
    h.service.applyProviderUpdate({
      provider: "UPSTOX", canonicalId: NIFTY,
      value: { ltp: 100, close: 99 },
      rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
      providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    const value = h.service.getItem(NIFTY)?.selected.value;
    expect(value?.previousClose).toBe(99);
    expect(value?.close).toBe(99);
    expect(value?.ltp).toBe(100);
  });
});

describe("canonical component storage and partial merge", () => {
  test("quote and depth updates cannot overwrite each other", () => {
    const h = harness();
    h.connect("UPSTOX");
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", { ltp: field(100, BASE, ts(BASE)) }, BASE));
    h.service.applyComponentUpdate(depthUpdate("UPSTOX", 5, BASE + 1));

    const quote = h.service.getSelectedComponent(NIFTY, "quote");
    const depth = h.service.getSelectedComponent(NIFTY, "depth");
    expect(quote?.value).toMatchObject({ ltp: 100 });
    expect(depth?.value).toMatchObject({ levelCount: 5 });
  });

  test("partial quote update preserves omitted OHLC, volume and previous close", () => {
    const h = harness();
    h.connect("FYERS");
    h.service.applyComponentUpdate(quoteUpdate("FYERS", {
      ltp: field(100, BASE, ts(BASE)),
      previousClose: field(99, BASE, ts(BASE - 1, "previous close")),
      open: field(99.5, BASE),
      high: field(101, BASE),
      volume: field(5000, BASE)
    }, BASE));
    h.service.applyComponentUpdate(quoteUpdate("FYERS", {
      ltp: field(100.5, BASE + 1000, ts(BASE + 1000)),
      lastTradedQuantity: field(12, BASE + 1000)
    }, BASE + 1000));

    const quote = h.service.getSelectedComponent(NIFTY, "quote")?.value as Record<string, unknown>;
    expect(quote.ltp).toBe(100.5);
    expect(quote.previousClose).toBe(99);
    expect(quote.open).toBe(99.5);
    expect(quote.high).toBe(101);
    expect(quote.volume).toBe(5000);
  });

  test("per-field timestamps advance only for fields included in an update", () => {
    const h = harness();
    h.connect("FYERS");
    h.service.applyComponentUpdate(quoteUpdate("FYERS", {
      ltp: field(100, BASE, ts(BASE)),
      volume: field(5000, BASE)
    }, BASE));
    h.service.applyComponentUpdate(quoteUpdate("FYERS", {
      ltp: field(100.5, BASE + 1000, ts(BASE + 1000))
    }, BASE + 1000));

    const observation = h.service.getComponent(NIFTY, "FYERS", "quote")!;
    expect(observation.fieldTimestamps.ltp?.receivedAtMs).toBe(BASE + 1000);
    expect(observation.fieldTimestamps.volume?.receivedAtMs).toBe(BASE);
    expect(observation.receivedAtMs).toBe(BASE + 1000);
  });

  test("explicit zero is stored as zero, not treated as missing", () => {
    const h = harness();
    h.connect("UPSTOX");
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", { volume: field(0, BASE) }, BASE));
    const quote = h.service.getSelectedComponent(NIFTY, "quote")?.value as Record<string, unknown>;
    expect(quote.volume).toBe(0);
    expect(quote.volume).not.toBeUndefined();
  });

  test("clear removes only explicitly cleared fields", () => {
    const h = harness();
    h.connect("UPSTOX");
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", {
      ltp: field(100, BASE),
      volume: field(5000, BASE)
    }, BASE));
    const clearUpdate: ComponentUpdate<QuoteField> = {
      ...quoteUpdate("UPSTOX", {}, BASE + 1),
      clear: ["volume"]
    };
    h.service.applyComponentUpdate(clearUpdate);
    const quote = h.service.getSelectedComponent(NIFTY, "quote")?.value as Record<string, unknown>;
    expect(quote.ltp).toBe(100);
    expect(quote.volume).toBeUndefined();
  });

  test("complete snapshot replaces only the intended component", () => {
    const h = harness();
    h.connect("UPSTOX");
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", {
      ltp: field(100, BASE),
      volume: field(5000, BASE)
    }, BASE));
    h.service.applyComponentUpdate(depthUpdate("UPSTOX", 5, BASE));
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", { ltp: field(101, BASE + 1) }, BASE + 1, true));

    const quote = h.service.getSelectedComponent(NIFTY, "quote")?.value as Record<string, unknown>;
    const depth = h.service.getSelectedComponent(NIFTY, "depth")?.value as Record<string, unknown>;
    expect(quote.ltp).toBe(101);
    expect(quote.volume).toBeUndefined();
    expect(depth.levelCount).toBe(5);
  });

  test("equal source timestamps do not discard successive updates", () => {
    const h = harness();
    h.connect("UPSTOX");
    const sameTs = ts(BASE);
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", { ltp: field(100, BASE, sameTs) }, BASE));
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", { ltp: field(100.5, BASE + 1, sameTs) }, BASE + 1));
    const quote = h.service.getSelectedComponent(NIFTY, "quote")?.value as Record<string, unknown>;
    expect(quote.ltp).toBe(100.5);
  });

  test("unverified timestamps use receipt ordering", () => {
    const h = harness();
    h.connect("FYERS");
    const unverified: SourceTimestamp = { raw: 1690953622, unit: "UNKNOWN", meaning: "last traded time", normalizedMs: null, trusted: false };
    h.service.applyComponentUpdate(quoteUpdate("FYERS", { ltp: field(100, BASE, unverified) }, BASE));
    h.service.applyComponentUpdate(quoteUpdate("FYERS", { ltp: field(101, BASE + 1, unverified) }, BASE + 1));
    const quote = h.service.getSelectedComponent(NIFTY, "quote")?.value as Record<string, unknown>;
    expect(quote.ltp).toBe(101);
  });
});

describe("per-component provider selection", () => {
  test("Upstox quote and FYERS depth coexist with independent attribution", () => {
    const h = harness();
    h.connect("UPSTOX");
    h.connect("FYERS");
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", { ltp: field(100, BASE, ts(BASE)) }, BASE));
    h.service.applyComponentUpdate(depthUpdate("FYERS", 5, BASE + 1));

    const quote = h.service.getSelectedComponent(NIFTY, "quote");
    const depth = h.service.getSelectedComponent(NIFTY, "depth");
    expect(quote?.provider).toBe("UPSTOX");
    expect(depth?.provider).toBe("FYERS");
    expect(quote?.observation?.provenance.provider).toBe("UPSTOX");
    expect(depth?.observation?.provenance.provider).toBe("FYERS");
  });

  test("missing component remains unavailable rather than fabricated", () => {
    const h = harness();
    h.connect("UPSTOX");
    const derivatives = h.service.getSelectedComponent(NIFTY, "derivatives");
    expect(derivatives?.mode).toBe("UNAVAILABLE");
    expect(derivatives?.value).toBeNull();
  });

  test("fields are never blended across providers into one selected component", () => {
    const h = harness();
    h.connect("UPSTOX");
    h.connect("FYERS");
    h.service.applyComponentUpdate(quoteUpdate("UPSTOX", { ltp: field(100, BASE, ts(BASE)) }, BASE));
    h.service.applyComponentUpdate(quoteUpdate("FYERS", { volume: field(5000, BASE, ts(BASE)) }, BASE));

    const quote = h.service.getSelectedComponent(NIFTY, "quote")?.value as Record<string, unknown>;
    // Selection picks one provider's component; it does not assemble a composite.
    expect(quote.ltp === 100 || quote.volume === 5000).toBe(true);
    expect(quote.ltp !== undefined && quote.volume !== undefined).toBe(false);
  });
});
