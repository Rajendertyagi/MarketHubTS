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

/** Documented expiryData representation: date (DD-MM-YYYY) + expiry (epoch string). */
function expiryData(entries: Array<{ date: string; expiry: string }>) {
  return entries.map((e) => ({ date: e.date, expiry: e.expiry }));
}

const chainRows = [
  { strike_price: -1, option_type: "", ltp: 25000, symbol: "NSE:NIFTY50-INDEX" },
  { strike_price: 25000, option_type: "CE", ltp: 100, oi: 500, volume: 10, bid: 99, ask: 101, greeks: { delta: 0.5, gamma: 0.001, theta: -2, vega: 1, iv: 18 } },
  { strike_price: 25000, option_type: "PE", ltp: 0, oi: 0, volume: 0, bid: 0, ask: 0, greeks: { delta: null, gamma: null, theta: null, vega: null, iv: null } }
];

function chainResponse(expiries: Array<{ date: string; expiry: string }>) {
  return {
    s: "ok", code: 200, message: "",
    data: { callOi: 100, putOi: 200, expiryData: expiryData(expiries), indiavixData: { ltp: 10.5 }, optionsChain: chainRows }
  };
}

/** Mock that validates each request shape and returns discovery then selected-expiry responses. */
function twoStepFetch(calls: Call[], expiries: Array<{ date: string; expiry: string }>) {
  return async (u: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(u);
    const parsed = new URL(url);
    calls.push({ url, method: String(init?.method ?? "GET"), body: init?.body as string | undefined });
    expect(parsed.origin + parsed.pathname).toBe("https://api-t1.fyers.in/data/options-chain-v3");
    expect(String(init?.method ?? "GET")).toBe("GET"); // official SDK uses GET + query
    expect(init?.body).toBeUndefined();
    const timestamp = parsed.searchParams.get("timestamp") ?? "";
    // Both responses carry the documented available-expiry list; selection is
    // driven by the exact timestamp sent in request 2, not by any flag.
    return json(chainResponse(expiries));
  };
}

describe("FyersOptionChainAdapter — exact expiry selection", () => {
  test("requested expiry is the nearest available expiry: two GETs, exact timestamp, correct mapping", async () => {
    const calls: Call[] = [];
    const expiries = [
      { date: "29-01-2026", expiry: "1769644200" },
      { date: "26-02-2026", expiry: "1772073300" }
    ];
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: twoStepFetch(calls, expiries) });
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
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: twoStepFetch(calls, expiries) });
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
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: twoStepFetch(calls, expiries) });
    const envelope = await adapter.fetchOptionChain(request("2026-02-26"));
    expect(new URL(calls[1]!.url).searchParams.get("timestamp")).toBe("1772073300");
    expect(envelope.expiryDate).toBe("2026-02-26");
  });

  test("requested expiry absent: fails closed before second request", async () => {
    const calls: Call[] = [];
    const expiries = [{ date: "29-01-2026", expiry: "1769644200" }];
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl: twoStepFetch(calls, expiries) });
    await expect(adapter.fetchOptionChain(request("2026-05-28"))).rejects.toThrow("EXPIRY_NOT_AVAILABLE");
    expect(calls.length).toBe(1); // no second request
  });

  test("second response lists a different expiry: fails closed (no nearest-expiry substitution)", async () => {
    const calls: Call[] = [];
    const discovery = [{ date: "29-01-2026", expiry: "1769644200" }];
    const fetchImpl = async (u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(u), method: String(init?.method ?? "GET"), body: init?.body as string | undefined });
      const timestamp = new URL(String(u)).searchParams.get("timestamp") ?? "";
      if (timestamp === "") return json(chainResponse(discovery));
      // Contradiction: the selected expiry is no longer in the available list.
      return json(chainResponse([{ date: "26-02-2026", expiry: "1772073300" }]));
    };
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl });
    await expect(adapter.fetchOptionChain(request("2026-01-29"))).rejects.toThrow("EXPIRY_MISMATCH");
    expect(calls.length).toBe(2);
  });

  test("undocumented expiry_flag representations are ignored; selection uses exact date", async () => {
    const calls: Call[] = [];
    const expiries = [
      { date: "29-01-2026", expiry: "1769644200" },
      { date: "26-02-2026", expiry: "1772073300" }
    ];
    // The docs mention expiry_flag but do not define its type/meaning and the
    // sample omits it. Any representation must not affect exact-date selection.
    const fetchImpl = async (u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(u), method: String(init?.method ?? "GET"), body: init?.body as string | undefined });
      const timestamp = new URL(String(u)).searchParams.get("timestamp") ?? "";
      const payload = chainResponse(expiries);
      (payload.data as Record<string, unknown>).expiryData = [
        { date: "29-01-2026", expiry: "1769644200", expiry_flag: "1" }, // string, not number
        { date: "26-02-2026", expiry: "1772073300", expiry_flag: true }  // boolean, not number
      ];
      return json(payload);
    };
    const adapter = new FyersOptionChainAdapter({ token: "t", now: () => NOW, fetchImpl });
    const envelope = await adapter.fetchOptionChain(request("2026-02-26"));
    expect(new URL(calls[1]!.url).searchParams.get("timestamp")).toBe("1772073300");
    expect(envelope.expiryDate).toBe("2026-02-26");
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
