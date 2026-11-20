import type { z } from "zod/v4";
import type {
  CandleRangeRequest, CanonicalInstrument, DataUnavailableReport, HealthStatus, ProviderId
} from "@markethub/contracts";
import {
  candleGapSchema, candleRangeNoteSchema, historicalCandleSchema, liveSnapshotSchema,
  optionChainSnapshotSchema, providerStatusMapSchema, type SnapshotPageSelector,
  type McpActivityStartRequest, type McpActivityStartResult,
  type McpActivityCompleteRequest, type McpActivityCompleteResult
} from "@markethub/contracts";

/** Uniform result shape shared by all MCP service operations. */
export type McpResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { category: "validation" | "unavailable" | "provider" | "internal"; message: string } };

/**
 * B3 snapshot page result. The `reason` discriminator lets the resource map an
 * unknown configuration to a genuine not-found while a valid config with zero
 * snapshots stays a successful empty page.
 */
export type McpSnapshotPageResult =
  | { ok: true; value: { snapshots: McpOptionChainSnapshot[]; nextCursor: string | null } }
  | { ok: false; error: { category: "validation" | "unavailable" | "internal"; message: string; reason?: "unknown_config" } };

/** Zod-inferred canonical shapes (assignable from both service interfaces and validated API responses). */
export type McpProviderStatusMap = z.infer<typeof providerStatusMapSchema>;
export type McpLiveSnapshot = z.infer<typeof liveSnapshotSchema>;
export type McpOptionChainSnapshot = z.infer<typeof optionChainSnapshotSchema>;
export type McpHistoricalCandle = z.infer<typeof historicalCandleSchema>;
export type McpCandleGap = z.infer<typeof candleGapSchema>;
export type McpCandleRangeNote = z.infer<typeof candleRangeNoteSchema>;

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

// Structural mirrors of market-core result types without Zod schemas.
export interface McpCoverageStatus {
  gaps: McpCandleGap[];
  unavailableNotes: McpCandleRangeNote[];
}
export interface McpHistoricalFetchResult {
  candles: McpHistoricalCandle[];
  gaps: McpCandleGap[];
  unavailable: DataUnavailableReport[];
  conflicts: number;
  providersTried: ProviderId[];
}
export interface McpCaptureResult {
  snapshot: McpOptionChainSnapshot | null;
  error: string | null;
}
export interface McpOptionChainRequest {
  underlyingCanonicalId: string;
  expiryDate: string;
  provider?: ProviderId;
  strikeRangeJson?: string | null;
  nativeIdentifier?: string;
}

/**
 * The seam through which shared MCP registration reaches application capabilities.
 * M6-A exposed `getHealth()`; M6-B1 added catalog search and event-feed reads;
 * M6-B2 added the operations consumed by the nine registered tools; M6-B3 adds
 * `listSnapshotsPage`; M6-C adds activity start/complete and an optional
 * diagnostic hook. No subscription methods (M6-D), no speculative methods.
 */
export interface McpServices {
  getHealth(): Promise<McpResult<HealthStatus>>;
  searchCatalog(req: { text: string; limit: number; afterCanonicalId?: string }): Promise<McpResult<McpCatalogPage>>;
  readEventFeed(req: { after?: string; limit: number }): Promise<McpResult<McpFeedPage>>;
  getProviderStatus(): Promise<McpResult<McpProviderStatusMap>>;
  getLiveSnapshot(): Promise<McpResult<McpLiveSnapshot>>;
  getCachedCandles(req: CandleRangeRequest): Promise<McpResult<{ candles: McpHistoricalCandle[] }>>;
  getCoverage(req: CandleRangeRequest): Promise<McpResult<McpCoverageStatus>>;
  fetchHistorical(req: CandleRangeRequest): Promise<McpResult<McpHistoricalFetchResult>>;
  listSnapshots(filter: { configId?: string; fromMs?: number; toMs?: number }): Promise<McpResult<{ snapshots: McpOptionChainSnapshot[] }>>;
  /** B3 — discriminated selector + opaque cursor, forwarded unchanged by both adapters. */
  listSnapshotsPage(req: { selector: SnapshotPageSelector; limit: number; cursor?: string }): Promise<McpSnapshotPageResult>;
  getSnapshot(id: string): Promise<McpResult<McpOptionChainSnapshot>>;
  captureSnapshot(req: McpOptionChainRequest): Promise<McpResult<McpCaptureResult>>;
  /** M6-C — durable activity recording (best-effort). */
  startActivity(req: McpActivityStartRequest): Promise<McpResult<McpActivityStartResult>>;
  completeActivity(req: McpActivityCompleteRequest): Promise<McpResult<McpActivityCompleteResult>>;
  /** Optional diagnostic sink for activity-write failures; never affects operation outcomes. */
  onActivityError?: (error: unknown) => void;
}
