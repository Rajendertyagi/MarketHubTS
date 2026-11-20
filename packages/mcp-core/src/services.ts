import type { CanonicalInstrument, HealthStatus } from "@markethub/contracts";

/** Uniform result shape shared by all MCP service operations. */
export type McpResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { category: "validation" | "unavailable" | "provider" | "internal"; message: string } };

/**
 * Structural mirror of realtime OutboundEvent, kept local so mcp-core needs no
 * new workspace dependency. OutboundEvent[] is structurally assignable to this.
 */
export interface McpFeedEvent {
  event: string;
  id?: string;
  data: unknown;
}

/** Bounded catalog page. `nextCursor` is the opaque keyset cursor for the next page. */
export interface McpCatalogPage {
  instruments: CanonicalInstrument[];
  nextCursor: string | null;
}

/**
 * Bounded event-feed result. A successful page always carries a runtime-scoped
 * `resumeCursor` checkpoint (including final and empty caught-up pages); a
 * snapshot-recovery result carries no checkpoint and forces a fresh snapshot.
 * `nextCursor` is only the pagination continuation token and may be null on a
 * successful final page.
 */
export type McpFeedPage =
  | {
      events: McpFeedEvent[];
      nextCursor: string | null;
      resumeCursor: string;
      snapshotRequired?: never;
    }
  | {
      events: [];
      nextCursor: null;
      snapshotRequired: { reason: string };
      resumeCursor?: never;
    };

/**
 * The seam through which shared MCP registration reaches application capabilities.
 * M6-A exposed only `getHealth()`; M6-B1 adds only the two operations needed by
 * the catalog-search and event-feed parity endpoints. No tools/resources/prompts
 * are registered in B1, and no activity hooks (M6-C) are present.
 */
export interface McpServices {
  getHealth(): Promise<McpResult<HealthStatus>>;
  searchCatalog(req: { text: string; limit: number; afterCanonicalId?: string }): Promise<McpResult<McpCatalogPage>>;
  readEventFeed(req: { after?: string; limit: number }): Promise<McpResult<McpFeedPage>>;
}
