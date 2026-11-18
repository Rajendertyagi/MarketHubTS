import { describe, expect, test } from "bun:test";
import type { CandleRangeRequest } from "../../packages/contracts/src/index";
import { createFyersRestCooldown, FyersHistoricalAdapter, FyersOptionChainAdapter } from "../../packages/broker-fyers/src/index";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const request = (overrides: Partial<CandleRangeRequest> = {}): CandleRangeRequest => ({
  canonicalId: "v1|NSE|EQ|EQ|CODE:SBIN", interval: "1D",
  fromMs: Date.parse("2026-01-01T00:00:00Z"), toMs: Date.parse("2026-01-05T00:00:00Z"),
  nativeIdentifier: "NSE:SBIN-EQ", ...overrides
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("FyersHistoricalAdapter", () => {
  test("regular history: /data/history, epoch range, 6-element candles", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const adapter = new FyersHistoricalAdapter({
      token: "appid:token", now: () => NOW,
      fetchImpl: async (u, init) => { url = String(u); body = JSON.parse(String(init?.body ?? "{}")); return json({ s: "ok", code: 200, candles: [[1767225600, 100, 102, 99, 101, 1000]] }); }
    });
    const candles = (await adapter.fetchCandles(request())).candles;
    expect(url).toBe("https://api-t1.fyers.in/data/history");
    expect(body.date_format).toBe("0");
    expect(body.oi_flag).toBe("1");
    expect(candles.length).toBe(1);
    expect(candles[0]!.tsMs).toBe(1767225600000);
    expect(candles[0]!.close).toBe(101);
    expect(candles[0]!.provider).toBe("FYERS");
  });

  test("expired F&O uses distinct endpoint and reads optional columns by name", async () => {
    let url = "";
    const adapter = new FyersHistoricalAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async (u) => { url = String(u); return json({
        s: "ok", code: 200,
        columns: ["timestamp", "open", "high", "low", "close", "volume", "open_interest", "iv", "delta", "gamma", "theta", "vega"],
        candles: [[1767225600, 100, 102, 99, 101, 1000, 500, 18, 0.5, null, null, null]]
      }); }
    });
    const candles = (await adapter.fetchCandles(request({ expired: true, nativeIdentifier: "NSE:NIFTY25MAR23000CE" }))).candles;
    expect(url).toBe("https://api-t1.fyers.in/data/history/fno/expired/historical-data");
    expect(candles[0]!.oi).toBe(500);
  });

  test("no_data yields empty candles plus an explicit authoritative no-data signal", async () => {
    const adapter = new FyersHistoricalAdapter({ token: "t", fetchImpl: async () => json({ s: "no_data", candles: [] }) });
    const outcome = await adapter.fetchCandles(request());
    expect(outcome.candles.length).toBe(0);
    expect(outcome.noData).toBe(true);
  });

  test("422 is request-specific; 403 is entitlement; 429 sets Data API cooldown", async () => {
    const bad = new FyersHistoricalAdapter({ token: "t", fetchImpl: async () => json({ code: -50 }, 422) });
    await expect(bad.fetchCandles(request())).rejects.toThrow("REQUEST_SPECIFIC_422");
    const forbidden = new FyersHistoricalAdapter({ token: "t", fetchImpl: async () => json({}, 403) });
    await expect(forbidden.fetchCandles(request())).rejects.toThrow("ENTITLEMENT_REQUIRED");
    const throttled = new FyersHistoricalAdapter({ token: "t", now: () => NOW, fetchImpl: async () => json({}, 429, { "retry-after": "5" }) });
    await expect(throttled.fetchCandles(request())).rejects.toThrow("TRANSIENT_THROTTLE_429");
    expect(throttled.getCooldown().dataApi.notBeforeMs).toBe(NOW + 5000);
  });

  test("account-level block is separate from Data API cooldown", async () => {
    const adapter = new FyersHistoricalAdapter({ token: "t", now: () => NOW, fetchImpl: async () => json({ s: "ok", candles: [] }) });
    adapter.markAccountBlock(null, "user blocked for rest of day");
    const c = adapter.getCooldown();
    expect(c.accountBlock.unknownReset).toBe(true);
    expect(c.accountBlock.notBeforeMs).toBeNull();
    expect(c.dataApi.notBeforeMs).toBeNull(); // unaffected
  });

  test("shared cooldown: a Data API throttle on history suppresses option chain, and account block suppresses both", async () => {
    const shared = createFyersRestCooldown();
    const history = new FyersHistoricalAdapter({
      token: "t", now: () => NOW, cooldown: shared,
      fetchImpl: async () => json({}, 429, { "retry-after": "5" })
    });
    const chain = new FyersOptionChainAdapter({
      token: "t", now: () => NOW, cooldown: shared,
      fetchImpl: async () => new Response("{}", { status: 200 })
    });
    const chainRequest = {
      underlyingCanonicalId: "v1|NSE|INDEX|INDEX|CODE:NIFTY50", expiryDate: "2026-01-29",
      nativeIdentifier: "NSE:NIFTY50-INDEX"
    };

    // Throttle observed on the history Data API must suppress option chain (same category).
    await expect(history.fetchCandles(request())).rejects.toThrow("TRANSIENT_THROTTLE_429");
    await expect(chain.fetchOptionChain(chainRequest)).rejects.toThrow("FYERS_DATA_API_COOLDOWN");

    // Account-level block suppresses all REST categories regardless of trigger.
    history.markAccountBlock(NOW + 60000, "daily REST block");
    await expect(chain.fetchOptionChain(chainRequest)).rejects.toThrow("FYERS_ACCOUNT_BLOCK");
    await expect(history.fetchCandles(request())).rejects.toThrow("FYERS_ACCOUNT_BLOCK");
  });
});
