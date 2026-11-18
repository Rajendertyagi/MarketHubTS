import { describe, expect, test } from "bun:test";
import type { OptionChainRequest } from "../../packages/market-core/src/index";
import { UpstoxOptionChainAdapter } from "../../packages/broker-upstox/src/index";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const request = (): OptionChainRequest => ({
  underlyingCanonicalId: "v1|NSE|INDEX|INDEX|CODE:NIFTY50", expiryDate: "2026-01-29",
  provider: "UPSTOX", nativeIdentifier: "NSE_INDEX|Nifty 50"
} as OptionChainRequest);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const chain = {
  status: "success",
  data: [{
    expiry: "2026-01-29", pcr: 1.1, strike_price: 25000,
    underlying_key: "NSE_INDEX|Nifty 50", underlying_spot_price: 25010,
    call_options: {
      instrument_key: "NSE_FO|1",
      market_data: { ltp: 100, volume: 10, oi: 500, close_price: 99, bid_price: 99, bid_qty: 1, ask_price: 101, ask_qty: 1, prev_oi: 400 },
      option_greeks: { vega: 1, theta: -2, gamma: 0.001, delta: 0.5, iv: 18, pop: 40 }
    },
    put_options: {
      instrument_key: "NSE_FO|2",
      market_data: { ltp: 0, volume: 0, oi: 0, close_price: 0, bid_price: 0, bid_qty: 0, ask_price: 0, ask_qty: 0, prev_oi: 0 },
      option_greeks: { vega: 0, theta: 0, gamma: 0, delta: 0, iv: 0, pop: 0 }
    }
  }]
};

describe("UpstoxOptionChainAdapter", () => {
  test("maps option chain fields including OI, Greeks and valid zeros", async () => {
    let url = "";
    const adapter = new UpstoxOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: async (u) => { url = String(u); return json(chain); } });
    const envelope = await adapter.fetchOptionChain(request());
    expect(url).toContain("/v2/option/chain?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=2026-01-29");
    expect(envelope.underlyingLtp).toBe(25010);
    expect(envelope.strikes.length).toBe(2);
    const ce = envelope.strikes.find((s) => s.optionType === "CE")!;
    expect(ce.oi).toBe(500);
    expect(ce.iv).toBe(18);
    expect(ce.greeks?.delta).toBe(0.5);
    const pe = envelope.strikes.find((s) => s.optionType === "PE")!;
    expect(pe.ltp).toBe(0); // valid zero preserved
    expect(pe.oi).toBe(0);
    expect(envelope.observationTimestamp).toBeNull();
  });

  test("missing greek keys stay absent; explicit provider null stays null", async () => {
    const payload = {
      status: "success",
      data: [{
        strike_price: 25000,
        call_options: {
          market_data: { ltp: 100 },
          // delta omitted, gamma explicitly null, theta/vega present
          option_greeks: { gamma: null, theta: -2, vega: 1 }
        }
      }]
    };
    const adapter = new UpstoxOptionChainAdapter({ token: "t", fetchImpl: async () => json(payload) });
    const envelope = await adapter.fetchOptionChain(request());
    const ce = envelope.strikes.find((s) => s.optionType === "CE")!;
    expect("delta" in ce.greeks!).toBe(false); // missing key absent
    expect(ce.greeks!.gamma).toBeNull(); // explicit null preserved
    expect(ce.greeks!.theta).toBe(-2);
    expect(ce.greeks!.vega).toBe(1);
  });

  test("malformed HTTP 200 is rejected", async () => {
    const adapter = new UpstoxOptionChainAdapter({ token: "t", fetchImpl: async () => json({ status: "success", data: {} }) });
    await expect(adapter.fetchOptionChain(request())).rejects.toThrow("MALFORMED_200");
  });

  test("per-API cooldown does not leak across adapter instances", async () => {
    const a = new UpstoxOptionChainAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async () => new Response("{}", { status: 429, headers: { "retry-after": "5" } })
    });
    await expect(a.fetchOptionChain(request())).rejects.toThrow();
    const b = new UpstoxOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: async () => json(chain) });
    expect((await b.fetchOptionChain(request())).strikes.length).toBe(2);
  });
});
