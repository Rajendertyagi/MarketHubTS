import { Hono } from "../../apps/api/node_modules/hono";
import { describe, expect, test } from "bun:test";
import { registerCatalogRoutes } from "../../apps/api/src/catalog-routes";
import { canonicalInstrumentSchema, type CanonicalInstrument } from "../../packages/contracts/src/index";
import type { CatalogRepository } from "../../packages/market-core/src/index";

function instrument(id: string, symbol: string, name: string): CanonicalInstrument {
  return {
    canonicalId: id, identityKey: `key:${id}`, identityVersion: 1,
    exchange: "NSE", segment: "EQ", marketType: "CASH", instrumentCategory: "EQUITY",
    canonicalSymbol: symbol, displayName: name, tradingStatus: "ACTIVE", lifecycleStatus: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  } as CanonicalInstrument;
}

const INSTRUMENTS = [
  instrument("v1|NSE|EQ|EQ|CODE:AAAA", "AAAA", "Alpha"),
  instrument("v1|NSE|EQ|EQ|CODE:BBBB", "BBBB", "Beta"),
  instrument("v1|NSE|EQ|EQ|CODE:CCCC", "CCCC", "Gamma")
];

/** In-memory fake: no SQLite/WAL files, so no cross-test file-lock interference. */
function fakeCatalog(): CatalogRepository {
  return {
    async searchInstruments({ limit, afterCanonicalId }) {
      const start = afterCanonicalId ? INSTRUMENTS.findIndex((i) => i.canonicalId === afterCanonicalId) + 1 : 0;
      // Fetch limit + 1 rows to exercise the route's lookahead/cursor derivation.
      return INSTRUMENTS.slice(start, start + limit + 1);
    }
  } as unknown as CatalogRepository;
}

function makeApp() {
  const app = new Hono();
  registerCatalogRoutes(app, { catalog: fakeCatalog() });
  return app;
}

describe("GET /api/catalog/search route", () => {
  test("successful response has a bounded, schema-valid envelope", async () => {
    const res = await makeApp().request("/api/catalog/search?text=abc&limit=2");
    expect(res.status).toBe(200);
    const json = await res.json() as { instruments: unknown[]; nextCursor: string | null };
    expect(Array.isArray(json.instruments)).toBe(true);
    expect(json.instruments.length).toBeLessThanOrEqual(2);
    for (const row of json.instruments) expect(canonicalInstrumentSchema.safeParse(row).success).toBe(true);
    expect(json.nextCursor).toBe(INSTRUMENTS[1]!.canonicalId);
  });

  test("empty query and invalid limits are rejected", async () => {
    const app = makeApp();
    expect((await app.request("/api/catalog/search?text=")).status).toBe(400);
    expect((await app.request("/api/catalog/search?text=%20%20")).status).toBe(400);
    expect((await app.request("/api/catalog/search?text=abc&limit=0")).status).toBe(400);
    expect((await app.request("/api/catalog/search?text=abc&limit=101")).status).toBe(400);
    expect((await app.request("/api/catalog/search?text=abc&limit=abc")).status).toBe(400);
  });

  test("cursor is forwarded and nextCursor is derived from the last returned record", async () => {
    const res = await makeApp().request("/api/catalog/search?text=abc&limit=1&cursor=" + encodeURIComponent(INSTRUMENTS[0]!.canonicalId));
    expect(res.status).toBe(200);
    const json = await res.json() as { instruments: CanonicalInstrument[]; nextCursor: string | null };
    expect(json.instruments.map((i) => i.canonicalId)).toEqual([INSTRUMENTS[1]!.canonicalId]);
    expect(json.nextCursor).toBe(INSTRUMENTS[1]!.canonicalId);
  });

  test("invalid cursor token is rejected", async () => {
    const res = await makeApp().request("/api/catalog/search?text=abc&cursor=%20%20");
    expect(res.status).toBe(400);
  });

  test("no unbounded list path: limit is always bounded", async () => {
    const res = await makeApp().request("/api/catalog/search?text=abc");
    expect(res.status).toBe(200);
    const json = await res.json() as { instruments: unknown[] };
    expect(json.instruments.length).toBeLessThanOrEqual(25);
  });
});
