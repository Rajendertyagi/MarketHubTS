import { afterEach, describe, expect, test } from "bun:test";
import type { CanonicalInstrument } from "../../packages/contracts/src/index";
import {
  buildCatalogQuery, CatalogHttpError, formatInstrumentLabel, searchInstruments
} from "../../apps/web/src/lib/catalog";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function instrument(id: string, symbol: string, name: string): CanonicalInstrument {
  return {
    canonicalId: id, identityKey: `key:${id}`, identityVersion: 1,
    exchange: "NSE", segment: "EQ", marketType: "CASH", instrumentCategory: "EQUITY",
    canonicalSymbol: symbol, displayName: name, tradingStatus: "ACTIVE", lifecycleStatus: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  } as CanonicalInstrument;
}

const SBIN = instrument("v1|NSE|EQ|EQ|CODE:SBIN", "SBIN", "State Bank of India");

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("catalog client", () => {
  test("buildCatalogQuery trims text, clamps limit and forwards cursor", () => {
    const qs = buildCatalogQuery({ text: "  sbin  ", limit: 500, cursor: "abc" });
    const params = new URLSearchParams(qs);
    expect(params.get("text")).toBe("sbin");
    expect(params.get("limit")).toBe("100");
    expect(params.get("cursor")).toBe("abc");
    expect(buildCatalogQuery({ text: "x" })).toContain("limit=25");
  });

  test("formatInstrumentLabel uses display fields, not canonicalId", () => {
    const label = formatInstrumentLabel(SBIN);
    expect(label).toContain("State Bank of India");
    expect(label).toContain("SBIN");
    expect(label).toContain("NSE/EQ");
  });

  test("searchInstruments parses a valid envelope", async () => {
    fakeFetch(() => ({ status: 200, body: { instruments: [SBIN], nextCursor: null } }));
    const page = await searchInstruments({ text: "sbin" });
    expect(page.instruments).toHaveLength(1);
    expect(page.instruments[0]!.canonicalId).toBe(SBIN.canonicalId);
    expect(page.nextCursor).toBeNull();
  });

  test("empty text issues no request", async () => {
    let called = false;
    fakeFetch(() => { called = true; return { status: 200, body: { instruments: [], nextCursor: null } }; });
    const page = await searchInstruments({ text: "   " });
    expect(called).toBe(false);
    expect(page).toEqual({ instruments: [], nextCursor: null });
  });

  test("400 and 500 become typed errors", async () => {
    fakeFetch((url) => ({ status: url.includes("bad") ? 400 : 500, body: { message: "oops" } }));
    await expect(searchInstruments({ text: "bad" })).rejects.toBeInstanceOf(CatalogHttpError);
    await expect(searchInstruments({ text: "other" })).rejects.toMatchObject({ kind: "internal" });
  });

  test("malformed envelope is rejected", async () => {
    fakeFetch(() => ({ status: 200, body: { instruments: "not-an-array", nextCursor: null } }));
    await expect(searchInstruments({ text: "x" })).rejects.toThrow();
  });

  test("malformed instrument rows are rejected", async () => {
    fakeFetch(() => ({ status: 200, body: { instruments: [{ canonicalId: 123 }], nextCursor: null } }));
    await expect(searchInstruments({ text: "x" })).rejects.toThrow();
  });

  test("invalid nextCursor values are rejected", async () => {
    for (const nextCursor of [123, "", {}, true]) {
      fakeFetch(() => ({ status: 200, body: { instruments: [], nextCursor } }));
      await expect(searchInstruments({ text: "x" })).rejects.toThrow();
    }
  });

  test("AbortSignal reaches fetch and AbortError propagates unchanged", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      if (receivedSignal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(JSON.stringify({ instruments: [], nextCursor: null }), { status: 200 });
    }) as typeof fetch;
    controller.abort();
    await expect(searchInstruments({ text: "x", signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal).toBe(controller.signal);
  });
});
