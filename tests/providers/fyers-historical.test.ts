import { describe, expect, test } from "bun:test";
import type { CandleRangeRequest } from "../../packages/contracts/src/index";
import { createFyersRestAdapters, createFyersRestCooldown, FyersHistoricalAdapter, FyersOptionChainAdapter } from "../../packages/broker-fyers/src/index";

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
  test("regular history: GET /data/history with query params and mapped resolution", async () => {
    let url = "";
    let method = "";
    let body: string | undefined;
    const adapter = new FyersHistoricalAdapter({
      token: "appid:token", now: () => NOW,
      fetchImpl: async (u, init) => {
        url = String(u); method = String(init?.method ?? "GET"); body = init?.body as string | undefined;
        return json({ s: "ok", code: 200, candles: [[1767225600, 100, 102, 99, 101, 1000]] });
      }
    });
    const candles = (await adapter.fetchCandles(request())).candles;
    const parsed = new URL(url);
    expect(method).toBe("GET"); // official SDK uses GET with query parameters
    expect(body).toBeUndefined(); // no JSON body
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api-t1.fyers.in/data/history");
    expect(parsed.searchParams.get("date_format")).toBe("0");
    expect(parsed.searchParams.get("oi_flag")).toBe("1");
    expect(parsed.searchParams.get("cont_flag")).toBe("1");
    expect(parsed.searchParams.get("resolution")).toBe("1D");
    expect(parsed.searchParams.get("symbol")).toBe("NSE:SBIN-EQ");
    expect(parsed.searchParams.get("range_from")).toBe(String(Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000)));
    expect(parsed.searchParams.get("range_to")).toBe(String(Math.floor(Date.parse("2026-01-05T00:00:00Z") / 1000)));
    expect(candles.length).toBe(1);
    expect(candles[0]!.tsMs).toBe(1767225600000);
    expect(candles[0]!.close).toBe(101);
    expect(candles[0]!.provider).toBe("FYERS");
  });

  test("canonical intraday intervals map to FYERS bare-number resolutions", async () => {
    const seen: string[] = [];
    const adapter = new FyersHistoricalAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async (u) => {
        seen.push(new URL(String(u)).searchParams.get("resolution") ?? "");
        return json({ s: "ok", candles: [] });
      }
    });
    for (const interval of ["1m", "5m", "15m", "60m", "120m", "240m", "1D", "1W", "1M"] as const) {
      await adapter.fetchCandles(request({ interval }));
    }
    expect(seen).toEqual(["1", "5", "15", "60", "120", "240", "1D", "1W", "1M"]);
  });

  test("unsupported regular-history resolution is rejected explicitly", async () => {
    const adapter = new FyersHistoricalAdapter({ token: "t", fetchImpl: async () => json({ s: "ok", candles: [] }) });
    await expect(adapter.fetchCandles(request({ interval: "180m" }))).rejects.toThrow("UNSUPPORTED_RESOLUTION");
  });

  test("expired F&O uses GET with query params, distinct endpoint and columns by name", async () => {
    let url = "";
    let method = "";
    const adapter = new FyersHistoricalAdapter({
      token: "t", now: () => NOW,
      fetchImpl: async (u, init) => {
        url = String(u); method = String(init?.method ?? "GET");
        return json({
          s: "ok", code: 200,
          columns: ["timestamp", "open", "high", "low", "close", "volume", "open_interest", "iv", "delta", "gamma", "theta", "vega"],
          candles: [[1767225600, 100, 102, 99, 101, 1000, 500, 18, 0.5, null, null, null]]
        });
      }
    });
    const candles = (await adapter.fetchCandles(request({ expired: true, nativeIdentifier: "NSE:NIFTY25MAR23000CE", interval: "60m" }))).candles;
    const parsed = new URL(url);
    expect(method).toBe("GET");
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api-t1.fyers.in/data/history/fno/expired/historical-data");
    expect(parsed.searchParams.get("resolution")).toBe("60");
    expect(parsed.searchParams.get("include_oi")).toBe("1");
    expect(parsed.searchParams.get("include_greeks")).toBe("0");
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

  test("FYERS Data API unknown reset clears a stale timed block (advisory never blocks)", async () => {
    const { applyFyersDataThrottle, fyersBlockReason, createFyersRestCooldown } = await import("../../packages/broker-fyers/src/cooldown");
    const state = createFyersRestCooldown();

    // Trustworthy reset sets a timed block.
    applyFyersDataThrottle(state, "5", 429, NOW, "throttle");
    expect(state.dataApi.notBeforeMs).toBe(NOW + 5000);
    expect(fyersBlockReason(state, NOW)).toBe("DATA_API_COOLDOWN");

    // Later unknown/unusable reset clears the stale block — advisory only.
    applyFyersDataThrottle(state, "0", 429, NOW, "throttle");
    expect(state.dataApi.notBeforeMs).toBeNull();
    expect(state.dataApi.unknownReset).toBe(true);
    expect(fyersBlockReason(state, NOW)).toBeNull(); // never blocks
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

  test("supported composition shares one cooldown; independent runtimes do not", async () => {
    const chainRequest = {
      underlyingCanonicalId: "v1|NSE|INDEX|INDEX|CODE:NIFTY50", expiryDate: "2026-01-29",
      nativeIdentifier: "NSE:NIFTY50-INDEX"
    };
    const runtime = createFyersRestAdapters({
      token: "t", now: () => NOW,
      fetchImpl: async () => json({}, 429, { "retry-after": "5" })
    });
    // Data API throttle on history suppresses option chain in the same runtime.
    await expect(runtime.history.fetchCandles(request())).rejects.toThrow("TRANSIENT_THROTTLE_429");
    await expect(runtime.optionChain.fetchOptionChain(chainRequest)).rejects.toThrow("FYERS_DATA_API_COOLDOWN");
    // Account block set on the runtime suppresses both adapters.
    runtime.markAccountBlock(NOW + 60000, "daily REST block");
    await expect(runtime.history.fetchCandles(request())).rejects.toThrow("FYERS_ACCOUNT_BLOCK");
    await expect(runtime.optionChain.fetchOptionChain(chainRequest)).rejects.toThrow("FYERS_ACCOUNT_BLOCK");

    // A second, independent runtime has fresh state — no accidental sharing.
    const other = createFyersRestAdapters({
      token: "t", now: () => NOW,
      fetchImpl: async () => json({ s: "ok", candles: [] })
    });
    expect(other.cooldown.dataApi.notBeforeMs).toBeNull();
    expect(other.cooldown.accountBlock.notBeforeMs).toBeNull();
    expect((await other.history.fetchCandles(request())).candles.length).toBe(0);
  });
});
