import type { ProviderCoverageTuple } from "../types";

const SCOPE_SHAPE_VERSION = 1;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical, byte-for-byte deterministic serializer for the exact coverage
 * tuples of a complete provider snapshot. The write path (sync-run scope_json)
 * and the WP4B read-path lookup must both use this helper so the same scope
 * produces an identical string. The serialized value contains only coverage
 * tuples — no provider identity, source version, fetch time or other metadata.
 */
export function serializeProviderCoverageScope(coverage: readonly ProviderCoverageTuple[]): string {
  const tuples = coverage.map((t) => ({
    exchange: t.exchange,
    segment: t.segment,
    instrumentCategories: [...new Set(t.instrumentCategories)].sort(cmp)
  }));
  tuples.sort((a, b) =>
    cmp(a.exchange, b.exchange) ||
    cmp(a.segment, b.segment) ||
    cmp(JSON.stringify(a.instrumentCategories), JSON.stringify(b.instrumentCategories))
  );
  return JSON.stringify({ version: SCOPE_SHAPE_VERSION, coverage: tuples });
}
