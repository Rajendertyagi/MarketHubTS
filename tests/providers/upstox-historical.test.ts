import { describe, expect, test } from "bun:test";
import type { CandleRangeRequest } from "../../packages/contracts/src/index";
import { UpstoxHistoricalAdapter } from "../../packages/broker-upstox/src/index";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const request = (overrides: Partial<CandleRangeRequest> = {}): CandleRangeRequest => ({
  canonicalId: "v1|NSE|EQ|EQ|CODE:SBIN", interval: "1D",
  fromMs: Date.parse("2026-01-01T00:00:00Z"), toMs: Date.parse("2026-01-05T00:00:00Z"),
  nativeIdentifier: "NSE_EQ|INE848E01016", ...overrides
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("UpstoxHistoricalAdapter", () => {
  test("V3 active endpoint: URL, auth, 7-element candle mapping", async () => {
    let url = "";
    const adapter = new UpstoxHistoricalAdapter({
      token: "appid:token", now: () => NOW,
      fetchImpl: async (u) => { url = String(u); return json({ status: "success", data: { candles: [["2026-01-02T00:00:00+05:30", 10, 12, 9, 11, 1000, 50]] } }); }
    });
    const candles = (await adapter.fetchCandles(request())).candles;
    expect(url).toContain("/v3/historical-candle/NSE_EQ%7CINE848E01016/days/1/");
    expect(candles.length).toBe(1);
    expect(candles[0]!.close).toBe(11);
    expect(candles[0]!.volume).toBe(1000);
    expect(candles[0]!.oi).toBe(50);
    expect(candles[0]!.provider).toBe("UPSTOX");
  });

  test("expired V2 endpoint uses documented interval tokens and is distinct from V3", async () => {
    let url = "";
    const adapter = new UpstoxHistoricalAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async (u) => { url = String(u); return json({ status: "success", data: { candles: [] } }); }
    });
    await adapter.fetchCandles(request({ expired: true, nativeIdentifier: "NSE_FO|73507|24-04-2025", interval: "30m" }));
    expect(url).toContain("/v2/expired-instruments/historical-candle/NSE_FO%7C73507%7C24-04-2025/30minute/");
    expect(url).not.toContain("/v3/historical-candle");

    await adapter.fetchCandles(request({ expired: true, nativeIdentifier: "NSE_FO|73507|24-04-2025", interval: "1D" }));
    expect(url).toContain("/day/");
  });

  test("date-only path params use India-local calendar dates, not UTC", async () => {
    let url = "";
    const adapter = new UpstoxHistoricalAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async (u) => { url = String(u); return json({ status: "success", data: { candles: [] } }); }
    });
    // 2026-01-04T18:30:00Z is 2026-01-05 00:00 IST (Monday) but 2026-01-04 in UTC.
    await adapter.fetchCandles(request({
      fromMs: Date.parse("2026-01-04T18:30:00.000Z"),
      toMs: Date.parse("2026-01-05T18:30:00.000Z")
    }));
    expect(url).toContain("/2026-01-06/2026-01-05"); // to_date/from_date in IST
    expect(url).not.toContain("/2026-01-05/2026-01-04");
  });

  test("unsupported expired interval is rejected rather than silently mis-mapped", async () => {
    const adapter = new UpstoxHistoricalAdapter({
      token: "t", fetchImpl: async () => json({ status: "success", data: { candles: [] } })
    });
    await expect(adapter.fetchCandles(request({ expired: true, interval: "120m" }))).rejects.toThrow("UNSUPPORTED_EXPIRED_INTERVAL");
  });

  test("malformed HTTP 200 is rejected", async () => {
    const adapter = new UpstoxHistoricalAdapter({ token: "t", fetchImpl: async () => json({ unexpected: true }) });
    await expect(adapter.fetchCandles(request())).rejects.toThrow("MALFORMED_200");
  });

  test("403 is classified as entitlement; 429 sets a scoped cooldown", async () => {
    const forbidden = new UpstoxHistoricalAdapter({ token: "t", fetchImpl: async () => json({}, 403) });
    await expect(forbidden.fetchCandles(request())).rejects.toThrow("ENTITLEMENT_REQUIRED");

    const throttled = new UpstoxHistoricalAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async () => json({}, 429, { "retry-after": "5" })
    });
    await expect(throttled.fetchCandles(request())).rejects.toThrow("TRANSIENT_THROTTLE_429");
    expect(throttled.getCooldown().notBeforeMs).toBe(NOW + 5000);
  });

  test("cooldown blocks only this API family and expires by time", async () => {
    const adapter = new UpstoxHistoricalAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async () => json({}, 429, { "retry-after": "5" })
    });
    await expect(adapter.fetchCandles(request())).rejects.toThrow();
    await expect(adapter.fetchCandles(request())).rejects.toThrow("COOLDOWN");
    // After the reset time, a fresh attempt is allowed (mocked fetch now succeeds).
    (adapter as any).now = () => NOW + 6000;
    (adapter as any).fetchImpl = async () => json({ status: "success", data: { candles: [] } });
    expect((await adapter.fetchCandles(request())).candles.length).toBe(0);
  });
});
