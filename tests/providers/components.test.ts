import { describe, expect, test } from "bun:test";
import type { NormalizeObservationInput } from "../../packages/market-core/src/index";
import { upstoxCapabilities, upstoxComponentUpdates } from "../../packages/broker-upstox/src/index";

const BASE = 1_700_000_000_000;

function input(native: Record<string, unknown>, value: Record<string, unknown> = {}): NormalizeObservationInput {
  return {
    provider: "UPSTOX",
    canonicalId: "v1|NSE|FO|INDEX_OPTION|v1|NSE|INDEX|INDEX|CODE:NIFTY50|2026-12-31|18000|CE",
    value: { ltp: 100, ...value, native },
    rawProviderTimestamp: BASE,
    providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time",
    receivedAtMs: BASE
  };
}

describe("Upstox component adaptation", () => {
  test("previousClose and OHLC interval close remain distinct", () => {
    const updates = upstoxComponentUpdates(input({
      ohlc: [{ interval: "1d", open: 99, high: 102, low: 98, close: 101, vol: 5000, ts: BASE }]
    }, { close: 99 }));
    const quote = updates.find((u) => u.component === "quote")!;
    const set = quote.set as Record<string, { value: unknown }>;
    expect(set.previousClose?.value).toBe(99);
    expect(set.close?.value).toBe(99);
    const ohlc = set.ohlc?.value as Array<{ interval: string; close: number }>;
    expect(ohlc[0]?.interval).toBe("1d");
    expect(ohlc[0]?.close).toBe(101);
    expect(ohlc[0]?.close).not.toBe(set.previousClose?.value);
  });

  test("depth and derivatives are emitted only when the feed supplies them", () => {
    const updates = upstoxComponentUpdates(input({
      depth: [{ bidP: 99, askP: 100, bidQ: 10, askQ: 20 }],
      oi: 1000, iv: 0.2, optionGreeks: { delta: 0.5, theta: -1, gamma: 0.01, vega: 2, rho: 1 }
    }));
    expect(updates.map((u) => u.component)).toEqual(["quote", "depth", "derivatives"]);
    const depth = updates.find((u) => u.component === "depth")!;
    expect((depth.set as Record<string, { value: unknown }>).levelCount?.value).toBe(1);
  });

  test("index feed does not emit depth or derivatives", () => {
    const updates = upstoxComponentUpdates(input({
      ohlc: [{ interval: "1d", open: 100, high: 101, low: 99, close: 100.5, ts: BASE }]
    }));
    expect(updates.map((u) => u.component)).toEqual(["quote"]);
  });

  test("explicit zero volume is preserved", () => {
    const updates = upstoxComponentUpdates(input({}, { volume: 0 }));
    const quote = updates.find((u) => u.component === "quote")!;
    expect((quote.set as Record<string, { value: unknown }>).volume?.value).toBe(0);
  });
});

describe("Upstox capability reporting", () => {
  test("index instruments never claim market depth or Greeks", () => {
    const results = upstoxCapabilities("INDEX", "full");
    const depth = results.find((r) => r.component === "depth")!;
    const derivatives = results.find((r) => r.component === "derivatives")!;
    expect(depth.status).toBe("UNSUPPORTED");
    expect(derivatives.status).toBe("UNSUPPORTED");
  });

  test("market Full reports five-level depth and derivatives with entitlement uncertainty", () => {
    const results = upstoxCapabilities("MARKET", "full");
    const depth = results.find((r) => r.component === "depth")!;
    const derivatives = results.find((r) => r.component === "derivatives")!;
    expect(depth.status).toBe("SUPPORTED");
    expect(depth.levels).toBe(5);
    expect(derivatives.fields).toContain("greeks");
    expect(derivatives.entitlementUnverified).toBe(true);
  });

  test("option_greeks does not claim undocumented extra fields as guaranteed", () => {
    const results = upstoxCapabilities("MARKET", "option_greeks");
    const derivatives = results.find((r) => r.component === "derivatives")!;
    expect(derivatives.status).toBe("LIMITED");
    expect(derivatives.fields).toEqual(["greeks"]);
    expect(derivatives.reason).toContain("unverified");
  });

  test("LTPC does not claim depth or derivatives", () => {
    const results = upstoxCapabilities("MARKET", "ltpc");
    expect(results.find((r) => r.component === "depth")?.status).toBe("UNSUPPORTED");
    expect(results.find((r) => r.component === "derivatives")?.status).toBe("UNSUPPORTED");
  });
});
