import { describe, expect, test } from "bun:test";
import type { OptionChainRequest } from "../../packages/market-core/src/index";
import { FyersOptionChainAdapter } from "../../packages/broker-fyers/src/index";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const request = (): OptionChainRequest => ({
  underlyingCanonicalId: "v1|NSE|INDEX|INDEX|CODE:NIFTY50", expiryDate: "29-01-2026",
  provider: "FYERS", nativeIdentifier: "NSE:NIFTY50-INDEX"
} as OptionChainRequest);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const chain = {
  s: "ok", code: 200, message: "",
  data: {
    callOi: 100, putOi: 200,
    expiryData: [{ date: "29-01-2026", expiry: "1769644200" }],
    indiavixData: { ltp: 10.5, symbol: "NSE:INDIAVIX-INDEX" },
    optionsChain: [
      { strike_price: -1, option_type: "", ltp: 25000, symbol: "NSE:NIFTY50-INDEX" },
      { strike_price: 25000, option_type: "CE", ltp: 100, oi: 500, volume: 10, bid: 99, ask: 101, greeks: { delta: 0.5, gamma: 0.001, theta: -2, vega: 1, iv: 18 } },
      { strike_price: 25000, option_type: "PE", ltp: 0, oi: 0, volume: 0, bid: 0, ask: 0, greeks: { delta: null, gamma: null, theta: null, vega: null, iv: null } }
    ]
  }
};

describe("FyersOptionChainAdapter", () => {
  test("maps option chain with underlying, OI, Greeks and null preservation", async () => {
    let url = "";
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: async (u) => { url = String(u); return json(chain); } });
    const envelope = await adapter.fetchOptionChain(request());
    expect(url).toBe("https://api-t1.fyers.in/data/options-chain-v3");
    expect(envelope.underlyingLtp).toBe(25000);
    expect(envelope.strikes.length).toBe(2);
    const ce = envelope.strikes.find((s) => s.optionType === "CE")!;
    expect(ce.oi).toBe(500);
    expect(ce.iv).toBe(18);
    expect(ce.greeks?.delta).toBe(0.5);
    const pe = envelope.strikes.find((s) => s.optionType === "PE")!;
    expect(pe.ltp).toBe(0);
    expect(pe.greeks?.delta).toBeNull(); // explicit null preserved
    expect(envelope.observationTimestamp).toBeNull();
    expect((envelope.providerExtensions as Record<string, unknown>).callOi).toBe(100);
  });

  test("malformed HTTP 200 is rejected", async () => {
    const adapter = new FyersOptionChainAdapter({ token: "t", fetchImpl: async () => json({ s: "ok", data: {} }) });
    await expect(adapter.fetchOptionChain(request())).rejects.toThrow("MALFORMED_200");
  });

  test("Data API throttle is scoped and expires by time", async () => {
    const adapter = new FyersOptionChainAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async () => new Response("{}", { status: 429, headers: { "retry-after": "5" } })
    });
    await expect(adapter.fetchOptionChain(request())).rejects.toThrow("TRANSIENT_THROTTLE_429");
    expect(adapter.getCooldown().dataApi.notBeforeMs).toBe(NOW + 5000);
    await expect(adapter.fetchOptionChain(request())).rejects.toThrow("COOLDOWN");
  });
});
