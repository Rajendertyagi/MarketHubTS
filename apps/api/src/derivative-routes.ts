import type { Hono } from "hono";
import {
  apiErrorSchema,
  derivativeExpiriesQuerySchema,
  derivativeExpiriesResponseSchema,
  istDateString,
  type DerivativeExpiryFreshness,
  type ProviderId
} from "@markethub/contracts";
import {
  FYERS_COVERAGE,
  FYERS_SOURCE,
  UPSTOX_COVERAGE,
  UPSTOX_SOURCE,
  serializeProviderCoverageScope,
  type CatalogRepository,
  type CatalogSyncRunRecord,
  type ProviderCoverageTuple
} from "@markethub/market-core";

export interface DerivativeRouteDependencies {
  catalog: CatalogRepository;
  /** Injectable clock for deterministic tests; defaults to the wall clock. */
  now?: () => Date;
}

/** Hard ceiling for a naturally small expiry list; no pagination (WP4B §7). */
const MAX_EXPIRIES = 100;

interface ProviderMasterDescriptor {
  source: string;
  coverage: readonly ProviderCoverageTuple[];
}

/** Stable source ID + exact coverage per provider, shared with the WP4A write path. */
function masterFor(provider: ProviderId): ProviderMasterDescriptor {
  return provider === "UPSTOX"
    ? { source: UPSTOX_SOURCE, coverage: UPSTOX_COVERAGE }
    : { source: FYERS_SOURCE, coverage: FYERS_COVERAGE };
}

/**
 * Freshness is derived only from the latest successful COMPLETE snapshot's
 * source data date (`sourceObservedAt`), interpreted as an Asia/Kolkata market
 * date. Download/finish time is never substituted. A missing or unparseable
 * source date is STALE; no qualifying run is UNKNOWN.
 */
function classifyFreshness(run: CatalogSyncRunRecord | null, todayIst: string): DerivativeExpiryFreshness {
  if (!run || !run.finishedAt) {
    return { state: "UNKNOWN", lastSuccessfulSyncAt: null };
  }
  const lastSuccessfulSyncAt = run.finishedAt;
  const observed = run.sourceObservedAt;
  if (!observed) return { state: "STALE", lastSuccessfulSyncAt };
  const observedMs = Date.parse(observed);
  if (!Number.isFinite(observedMs)) return { state: "STALE", lastSuccessfulSyncAt };
  return {
    state: istDateString(observedMs) === todayIst ? "FRESH" : "STALE",
    lastSuccessfulSyncAt
  };
}

/**
 * Read-only, bounded, provider-aware expiry discovery. Safe for LAN clients —
 * no local-owner guard and no authentication, consistent with the other
 * read-only catalogue routes. No provider-native identifier is ever returned.
 */
export function registerDerivativeRoutes(app: Hono, deps: DerivativeRouteDependencies): void {
  const now = deps.now ?? (() => new Date());

  app.get("/api/catalog/derivative-expiries", async (c) => {
    const parsed = derivativeExpiriesQuerySchema.safeParse({
      underlyingCanonicalId: c.req.query("underlyingCanonicalId"),
      provider: c.req.query("provider")
    });
    if (!parsed.success) {
      return c.json(apiErrorSchema.parse({
        error: "invalid_request",
        message: "underlyingCanonicalId must be non-empty and provider must be UPSTOX or FYERS"
      }), 400);
    }
    const { underlyingCanonicalId, provider } = parsed.data;
    const todayIst = istDateString(now().getTime());
    const master = masterFor(provider);
    // Same canonical serializer as the WP4A write path: byte-for-byte equality.
    const scopeJson = serializeProviderCoverageScope(master.coverage);

    try {
      const [expiries, run] = await Promise.all([
        deps.catalog.listDerivativeExpiries({
          underlyingCanonicalId,
          provider,
          today: todayIst,
          limit: MAX_EXPIRIES
        }),
        deps.catalog.getLatestProviderSync(
          provider,
          master.source,
          scopeJson,
          ["COMPLETED"],
          "COMPLETE"
        )
      ]);

      return c.json(derivativeExpiriesResponseSchema.parse({
        underlyingCanonicalId,
        provider,
        expiries,
        freshness: classifyFreshness(run, todayIst)
      }));
    } catch {
      // Never expose raw provider errors, native identifiers or credentials.
      return c.json(apiErrorSchema.parse({
        error: "internal_error",
        message: "Unable to load derivative expiries"
      }), 500);
    }
  });
}
