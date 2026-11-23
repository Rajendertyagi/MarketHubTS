import { Hono } from "../../apps/api/node_modules/hono";
import { describe, expect, test } from "bun:test";
import { registerDerivativeRoutes } from "../../apps/api/src/derivative-routes";
import {
  derivativeExpiriesResponseSchema,
  type ProviderId
} from "../../packages/contracts/src/index";
import {
  FYERS_COVERAGE, FYERS_SOURCE, UPSTOX_COVERAGE, UPSTOX_SOURCE, serializeProviderCoverageScope,
  type CatalogRepository, type CatalogSyncRunRecord
} from "../../packages/market-core/src/index";

/** 2026-11-24T18:30Z is exactly 2026-11-25 00:00 in Asia/Kolkata. */
const FIXED_NOW = new Date("2026-11-24T18:30:00.000Z");
const TODAY_IST = "2026-11-25";

interface ExpiryCall { underlyingCanonicalId: string; provider: ProviderId; today: string; limit: number }
interface SyncCall {
  provider: ProviderId; source: string; scopeJson: string;
  statuses: string[]; completeness: unknown;
}

function fakeCatalog(opts: {
  expiries?: string[];
  run?: CatalogSyncRunRecord | null;
  throwOnExpiries?: boolean;
} = {}) {
  const expiryCalls: ExpiryCall[] = [];
  const syncCalls: SyncCall[] = [];
  const catalog = {
    async listDerivativeExpiries(q: ExpiryCall) {
      expiryCalls.push(q);
      if (opts.throwOnExpiries) throw new Error("upstream native identifier NSE_FO|SECRET-TOKEN leaked");
      return opts.expiries ?? [];
    },
    async getLatestProviderSync(
      provider: ProviderId, source: string, scopeJson: string,
      statuses: string[], completeness: unknown
    ) {
      syncCalls.push({ provider, source, scopeJson, statuses, completeness });
      return opts.run ?? null;
    }
  } as unknown as CatalogRepository;
  return { catalog, expiryCalls, syncCalls };
}

function makeApp(catalog: CatalogRepository) {
  const app = new Hono();
  registerDerivativeRoutes(app, { catalog, now: () => FIXED_NOW });
  return app;
}

function run(overrides: Partial<CatalogSyncRunRecord> = {}): CatalogSyncRunRecord {
  return {
    runId: "R1", source: UPSTOX_SOURCE, provider: "UPSTOX",
    scopeJson: serializeProviderCoverageScope(UPSTOX_COVERAGE),
    completeness: "COMPLETE", status: "COMPLETED",
    startedAt: "2026-11-24T00:00:00.000Z", finishedAt: "2026-11-24T01:00:00.000Z",
    sourceObservedAt: "2026-11-24T18:30:00.000Z", // today in IST
    countsJson: "{}", conflictsJson: "[]",
    ...overrides
  };
}

const BASE = "/api/catalog/derivative-expiries?underlyingCanonicalId=u1&provider=UPSTOX";

describe("GET /api/catalog/derivative-expiries — validation", () => {
  test("missing or invalid provider is rejected with the standard 400", async () => {
    const app = makeApp(fakeCatalog().catalog);
    expect((await app.request("/api/catalog/derivative-expiries?underlyingCanonicalId=u1")).status).toBe(400);
    expect((await app.request("/api/catalog/derivative-expiries?underlyingCanonicalId=u1&provider=AUTO")).status).toBe(400);
    expect((await app.request("/api/catalog/derivative-expiries?underlyingCanonicalId=u1&provider=")).status).toBe(400);
  });

  test("missing or empty underlying canonical id is rejected with 400", async () => {
    const app = makeApp(fakeCatalog().catalog);
    expect((await app.request("/api/catalog/derivative-expiries?provider=UPSTOX")).status).toBe(400);
    expect((await app.request("/api/catalog/derivative-expiries?underlyingCanonicalId=&provider=UPSTOX")).status).toBe(400);
    expect((await app.request("/api/catalog/derivative-expiries?underlyingCanonicalId=%20%20&provider=UPSTOX")).status).toBe(400);
  });

  test("unknown underlying / no matches returns an empty list with honest freshness", async () => {
    const app = makeApp(fakeCatalog({ expiries: [] }).catalog);
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(derivativeExpiriesResponseSchema.safeParse(json).success).toBe(true);
    expect(json.expiries).toEqual([]);
    expect(json.freshness).toEqual({ state: "UNKNOWN", lastSuccessfulSyncAt: null });
  });

  test("repository errors are sanitized (no native identifiers or raw errors exposed)", async () => {
    const app = makeApp(fakeCatalog({ throwOnExpiries: true }).catalog);
    const res = await app.request(BASE);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("SECRET-TOKEN");
    expect(text).not.toContain("NSE_FO|");
    expect(text).not.toContain("upstream native identifier");
    expect(JSON.parse(text).error).toBe("internal_error");
  });
});

describe("GET /api/catalog/derivative-expiries — bounded query and freshness", () => {
  test("response uses the shared schema and forwards a bounded IST query", async () => {
    const f = fakeCatalog({ expiries: ["2026-11-25", "2026-12-29"] });
    const res = await makeApp(f.catalog).request(BASE);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(derivativeExpiriesResponseSchema.safeParse(json).success).toBe(true);
    expect(json.expiries).toEqual(["2026-11-25", "2026-12-29"]);
    expect(json.underlyingCanonicalId).toBe("u1");
    expect(json.provider).toBe("UPSTOX");
    expect(f.expiryCalls).toEqual([{
      underlyingCanonicalId: "u1", provider: "UPSTOX", today: TODAY_IST, limit: 100
    }]);
  });

  test("lookup uses the stable source ID and the shared serializer's exact scopeJson", async () => {
    const f = fakeCatalog();
    await makeApp(f.catalog).request(BASE);
    expect(f.syncCalls).toEqual([{
      provider: "UPSTOX",
      source: UPSTOX_SOURCE,
      scopeJson: serializeProviderCoverageScope(UPSTOX_COVERAGE),
      statuses: ["COMPLETED"],
      completeness: "COMPLETE"
    }]);

    const fy = fakeCatalog();
    await makeApp(fy.catalog).request("/api/catalog/derivative-expiries?underlyingCanonicalId=u1&provider=FYERS");
    expect(fy.syncCalls).toEqual([{
      provider: "FYERS",
      source: FYERS_SOURCE,
      scopeJson: serializeProviderCoverageScope(FYERS_COVERAGE),
      statuses: ["COMPLETED"],
      completeness: "COMPLETE"
    }]);
  });

  test("UNKNOWN when no successful complete snapshot exists", async () => {
    const res = await makeApp(fakeCatalog({ run: null }).catalog).request(BASE);
    expect((await res.json() as any).freshness).toEqual({ state: "UNKNOWN", lastSuccessfulSyncAt: null });
  });

  test("FRESH when the source data date equals today's Asia/Kolkata market date", async () => {
    const successful = run();
    const res = await makeApp(fakeCatalog({ run: successful }).catalog).request(BASE);
    expect((await res.json() as any).freshness).toEqual({
      state: "FRESH", lastSuccessfulSyncAt: successful.finishedAt
    });
  });

  test("STALE for an older source date, even when finishedAt is today", async () => {
    const older = run({
      sourceObservedAt: "2026-11-23T10:00:00.000Z",
      finishedAt: "2026-11-24T23:00:00.000Z"
    });
    const res = await makeApp(fakeCatalog({ run: older }).catalog).request(BASE);
    expect((await res.json() as any).freshness).toEqual({
      state: "STALE", lastSuccessfulSyncAt: older.finishedAt
    });
  });

  test("STALE for missing or unparseable source data date (never substitutes finishedAt)", async () => {
    for (const sourceObservedAt of [undefined, "not-a-date", ""]) {
      const r = run({ sourceObservedAt });
      const res = await makeApp(fakeCatalog({ run: r }).catalog).request(BASE);
      expect((await res.json() as any).freshness).toEqual({
        state: "STALE", lastSuccessfulSyncAt: r.finishedAt
      });
    }
  });

  test("a run without finishedAt is not a successful snapshot (UNKNOWN)", async () => {
    const r = run({ finishedAt: undefined });
    const res = await makeApp(fakeCatalog({ run: r }).catalog).request(BASE);
    expect((await res.json() as any).freshness).toEqual({ state: "UNKNOWN", lastSuccessfulSyncAt: null });
  });

  test("lastSuccessfulSyncAt is the selected successful run's finishedAt, not a later attempt", async () => {
    // The repository selects the last COMPLETED/COMPLETE run; a later failed
    // attempt is filtered out there. The route must report exactly that run's
    // finishedAt and source date, never a download/failure timestamp.
    const successful = run({
      finishedAt: "2026-11-24T01:00:00.000Z",
      sourceObservedAt: "2026-11-24T18:30:00.000Z"
    });
    const res = await makeApp(fakeCatalog({ run: successful, expiries: ["2026-11-25"] }).catalog).request(BASE);
    const json = await res.json() as any;
    expect(json.freshness.lastSuccessfulSyncAt).toBe("2026-11-24T01:00:00.000Z");
    expect(json.freshness.state).toBe("FRESH");
  });

  test("IST midnight boundary: 18:30Z is the next India-market date", async () => {
    const f = fakeCatalog({ expiries: ["2026-11-25"] });
    const res = await makeApp(f.catalog).request(BASE);
    expect(f.expiryCalls[0]!.today).toBe("2026-11-25");
    expect((await res.json() as any).expiries).toEqual(["2026-11-25"]);
  });
});
