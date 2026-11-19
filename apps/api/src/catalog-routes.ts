import type { Hono } from "hono";
import { apiErrorSchema, canonicalInstrumentSchema } from "@markethub/contracts";
import type { CatalogRepository } from "@markethub/market-core";

export interface CatalogRouteDependencies {
  catalog: CatalogRepository;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) return null;
  return value;
}

/**
 * Read-only bounded catalog search. Safe for LAN clients — no isLocalPeer guard
 * and no authentication, consistent with the existing read-only API routes.
 */
export function registerCatalogRoutes(app: Hono, deps: CatalogRouteDependencies): void {
  app.get("/api/catalog/search", async (c) => {
    const text = (c.req.query("text") ?? "").trim();
    if (!text) {
      return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "text must be a non-empty query" }), 400);
    }
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json(apiErrorSchema.parse({ error: "invalid_request", message: `limit must be an integer between 1 and ${MAX_LIMIT}` }), 400);
    }
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !/^\S+$/.test(cursor)) {
      return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "cursor must be a non-empty token" }), 400);
    }

    // The repository fetches limit + 1 rows; discard the lookahead row and
    // derive nextCursor from the last returned record only when it exists.
    const rows = await deps.catalog.searchInstruments({
      text,
      limit,
      ...(cursor !== undefined ? { afterCanonicalId: cursor } : {})
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit && page.length > 0
      ? page[page.length - 1]!.canonicalId
      : null;

    return c.json({
      instruments: page.map((instrument) => canonicalInstrumentSchema.parse(instrument)),
      nextCursor
    });
  });
}
