import { describe, expect, test } from "bun:test";
import type { OptionChainRequest } from "../../packages/market-core/src/index";
import { FyersOptionChainAdapter } from "../../packages/broker-fyers/src/index";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const request = (expiryDate = "2026-01-29"): OptionChainRequest => ({
  underlyingCanonicalId: "v1|NSE|INDEX|INDEX|CODE:NIFTY50", expiryDate,
  provider: "FYERS", nativeIdentifier: "NSE:NIFTY50-INDEX"
} as OptionChainRequest);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call { url: string; method: string; body: string | undefined }

function expiryData(entries: Array<{ date: string; expiry: string; flag?: number }>) {
  return entries.map((e) => ({ date: e.date, expiry: e.expiry, ...(e.flag !== undefined ? { expiry_flag: e.flag } : {}) }));
}

const chainRows = [
  { strike_price: -1, option_type: "", ltp: 25000, symbol: "NSE:NIFTY50-INDEX" },
  { strike_price: 25000, option_type: "CE", ltp: 100, oi: 500, volume: 10, bid: 99, ask: 101, greeks: { delta: 0.5, gamma: 0.001, theta: -2, vega: 1, iv: 18 } },
  { strike_price: 25000, option_type: "PE", ltp: 0, oi: 0, volume: 0, bid: 0, ask: 0, greeks: { delta: null, gamma: null, theta: null, vega: null, iv: null } }
];

function chainResponse(expiries: Array<{ date: string; expiry: string; flag?: number }>) {
  return {
    s: "ok", code: 200, message: "",
    data: { callOi: 100, putOi: 200, expiryData: expiryData(expiries), indiavixData: { ltp: 10.5 }, optionsChain: chainRows }
  };
}

/** Mock that validates each request shape and returns discovery then selected-expiry responses. */
function twoStepFetch(calls: Call[], expiries: Array<{ date: string; expiry: string; flag?: number }>, selectedExpiry: string) {
  return async (u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(u);
    const parsed = new URL(url);
    calls.push({ url, method: String(init?.method ?? "GET"), body: init?.body as string | undefined });
    expect(parsed.origin + parsed.pathname).toBe("https://api-t1.fyers.in/data/options-chain-v3");
    expect(String(init?.method ?? "GET")).toBe("GET"); // official SDK uses GET + query
    expect(init?.body).toBeUndefined();
    const timestamp = parsed.searchParams.get("timestamp") ?? "";
    if (timestamp === "") return json(chainResponse(expiries)); // discovery
    // Selected-expiry response: echo the requested expiry as the selected one.
    return json(chainResponse(expiries.map((e) => ({ ...e, flag: e.expiry === selectedExpiry ? 1 : 0 }))));
  };
}

describe("FyersOptionChainAdapter — exact expiry selection", () => {
  test("requested expiry is the nearest available expiry: two GETs, exact timestamp, correct mapping", async () => {
    const calls: Call[] = [];
    const expiries = [
      { date: "29-01-2026", expiry: "1769644200" },
      { date: "26-02-2026", expiry: "1772073300" }
    ];
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: twoStepFetch(calls, expiries, "1769644200") });
    const envelope = await adapter.fetchOptionChain(request("2026-01-29"));

    expect(calls.length).toBe(2); // discovery + selected expiry
    expect(calls[0]!.url).toContain("timestamp="); // empty on discovery
    const second = new URL(calls[1]!.url);
    expect(second.searchParams.get("timestamp")).toBe("1769644200");
    expect(second.searchParams.get("greeks")).toBe("1");
    expect(second.searchParams.get("strikecount")).toBe("50");
    expect(second.searchParams.get("symbol")).toBe("NSE:NIFTY50-INDEX");
    expect(envelope.expiryDate).toBe("2026-01-29");
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

  test("requested expiry is a later available expiry: selects that exact expiry", async () => {
    const calls: Call[] = [];
    const expiries = [
      { date: "29-01-2026", expiry: "1769644200" },
      { date: "26-02-2026", expiry: "1772073300" },
      { date: "26-03-2026", expiry: "1774752600" }
    ];
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: twoStepFetch(calls, expiries, "1774752600") });
    const envelope = await adapter.fetchOptionChain(request("2026-03-26"));
    expect(calls.length).toBe(2);
    expect(new URL(calls[1]!.url).searchParams.get("timestamp")).toBe("1774752600");
    expect(envelope.expiryDate).toBe("2026-03-26");
  });

  test("provider returns multiple expiries: exact match wins, no nearest-expiry substitution", async () => {
    const calls: Call[] = [];
    const expiries = [
      { date: "29-01-2026", expiry: "1769644200" },
      { date: "26-02-2026", expiry: "1772073300" }
    ];
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: twoStepFetch(calls, expiries, "1772073300") });
    const envelope = await adapter.fetchOptionChain(request("2026-02-26"));
    expect(new URL(calls[1]!.url).searchParams.get("timestamp")).toBe("1772073300");
    expect(envelope.expiryDate).toBe("2026-02-26");
  });

  test("requested expiry absent: fails closed before second request", async () => {
    const calls: Call[] = [];
    const expiries = [{ date: "29-01-2026", expiry: "1769644200" }];
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: twoStepFetch(calls, expiries, "1769644200") });
    await expect(adapter.fetchOptionChain(request("2026-05-28"))).rejects.toThrow("EXPIRY_NOT_AVAILABLE");
    expect(calls.length).toBe(1); // no second request
  });

  test("returned expiry does not match request: fails closed, never persists under requested expiry", async () => {
    const calls: Call[] = [];
    const expiries = [{ date: "29-01-2026", expiry: "1769644200" }];
    // Second response marks a DIFFERENT expiry as selected.
    const fetchImpl = async (u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(u), method: String(init?.method ?? "GET"), body: init?.body as string | undefined });
      const timestamp = new URL(String(u)).searchParams.get("timestamp") ?? "";
      if (timestamp === "") return json(chainResponse(expiries));
      return json(chainResponse([{ date: "26-02-2026", expiry: "1772073300", flag: 1 }]));
    };
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl });
    await expect(adapter.fetchOptionChain(request("2026-01-29"))).rejects.toThrow("EXPIRY_MISMATCH");
  });

  test("malformed or incomplete expiry metadata fails closed", async () => {
    for (const payload of [
      { s: "ok", data: { optionsChain: chainRows } }, // no expiryData
      { s: "ok", data: { expiryData: [{ date: "bad" }], optionsChain: chainRows } }, // missing expiry epoch
      { s: "ok", data: { expiryData: "not-an-array", optionsChain: chainRows } }
    ]) {
      const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: async () => json(payload) });
      await expect(adapter.fetchOptionChain(request("2026-01-29"))).rejects.toThrow(/EXPIRY|MALFORMED/);
    }
  });

  test("malformed HTTP 200 is rejected (missing expiry metadata fails closed)", async () => {
    const adapter = new FyersOptionChainAdapter({ token: "t", fetchImpl: async () => json({ s: "ok", data: {} }) });
    await expect(adapter.fetchOptionChain(request())).rejects.toThrow(/EXPIRY|MALFORMED/);
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
