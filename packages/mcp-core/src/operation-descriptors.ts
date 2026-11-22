import type { McpOperationDescriptor } from "@markethub/contracts";

/**
 * Single owner of MCP operation names and safe display metadata.
 *
 * Every registration function consumes the named constants below for its
 * name, description and (where present) title, so no duplicate literal lives
 * at a registration call site. Operation type is derived from the owning
 * group by {@link listMcpOperationDescriptors}; it is not stored per entry.
 *
 * Tools carry no `title` — their MCP-visible metadata is unchanged. Resources
 * and prompts reuse the title their SDK registration already accepts.
 */

// --- Tools (9) -------------------------------------------------------------

export const healthDescriptor = {
  name: "markethub_health",
  description: "Get MarketHubTS API and database health status via the local API."
} as const;

export const catalogSearchDescriptor = {
  name: "catalog_search",
  description: "Search the canonical instrument catalog by symbol, display name or identity key. Read-only, bounded, keyset-paginated."
} as const;

export const providerStatusDescriptor = {
  name: "provider_status",
  description: "Get composed UPSTOX and FYERS provider status, including runtime streaming state. Read-only."
} as const;

export const marketSnapshotDescriptor = {
  name: "market_snapshot",
  description: "Get the canonical live market snapshot. When canonicalId is supplied, only snapshot.items are filtered; revision, capturedAtMs and connections are preserved. Read-only."
} as const;

export const historicalCandlesDescriptor = {
  name: "historical_candles",
  description: "Read cached candles or derived coverage for a canonical instrument and range. The onDemand mode may cache retrieved candles (a bounded persistence side effect); cached and coverage modes are read-only. Never changes saved sync configuration."
} as const;

export const optionChainSnapshotDescriptor = {
  name: "option_chain_snapshot",
  description: "List or get stored option-chain snapshots (read-only), or capture one on demand. Capture persists a snapshot with configId = null and does not read or modify saved capture configurations."
} as const;

export const onDemandRetrievalDescriptor = {
  name: "on_demand_retrieval",
  description: "Thin dispatch for on-demand data: historical retrieval may cache candles; option-chain capture persists a snapshot with configId = null. Never changes saved operational configuration."
} as const;

export const futuresChainDescriptor = {
  name: "futures_chain",
  description: "Unavailable in M6 — no shared futures-chain service exists."
} as const;

export const marketInformationDescriptor = {
  name: "market_information",
  description: "Unavailable in M6 — no shared market-information service exists."
} as const;

// --- Resources (7) ---------------------------------------------------------

export const catalogInstrumentsDescriptor = {
  name: "catalog-instruments",
  title: "Catalog instruments",
  description: "Bounded, keyset-paginated canonical instrument search. Requires a non-empty query; no unfiltered listing."
} as const;

export const marketSnapshotResourceDescriptor = {
  name: "market-snapshot",
  title: "Market snapshot",
  description: "Canonical live market snapshot (quotes/depth). Empty state is honest, never fabricated."
} as const;

export const historicalCandlesResourceDescriptor = {
  name: "historical-candles",
  title: "Historical candles and coverage",
  description: "Cached candles plus derived coverage for a canonical instrument and ISO-8601 range."
} as const;

export const snapshotsConfigDescriptor = {
  name: "snapshots-config",
  title: "Snapshots by capture configuration",
  description: "Newest-first bounded page of snapshots for a real capture configuration ID (including 'none'). Stored-data opaque cursor."
} as const;

export const snapshotsNullConfigDescriptor = {
  name: "snapshots-null-config",
  title: "Null-config snapshots",
  description: "Newest-first bounded page of snapshots with no capture config: on-demand captures and snapshots retained after config deletion. Stored-data opaque cursor."
} as const;

export const eventsLiveDescriptor = {
  name: "events-live",
  title: "Live event feed",
  description: "Bounded replay page from the in-memory live event hub. Cursor is runtime-scoped and does not survive restart; snapshot-required is an explicit recovery result."
} as const;

export const eventsAlertsDescriptor = {
  name: "events-alerts",
  title: "Alert events (unavailable in M6)",
  description: "Contract-only placeholder. Durable alert records are an M7 dependency; reads return an explicit unavailable error, never an empty feed."
} as const;

// --- Prompts (3) -----------------------------------------------------------

export const explainMarketSnapshotDescriptor = {
  name: "explain_market_snapshot",
  title: "Explain a market snapshot",
  description: "Guidance for reading the canonical live market snapshot resource."
} as const;

export const interpretCoverageGapsDescriptor = {
  name: "interpret_coverage_gaps",
  title: "Interpret coverage gaps",
  description: "Guidance for interpreting historical candle coverage and gaps."
} as const;

export const howToCaptureSnapshotDescriptor = {
  name: "how_to_capture_snapshot",
  title: "How to capture an option-chain snapshot",
  description: "Guidance for on-demand option-chain capture and its persistence semantics."
} as const;

// --- Grouped registries (deterministic order) ------------------------------

export const TOOL_DESCRIPTORS = [
  healthDescriptor,
  catalogSearchDescriptor,
  providerStatusDescriptor,
  marketSnapshotDescriptor,
  historicalCandlesDescriptor,
  optionChainSnapshotDescriptor,
  onDemandRetrievalDescriptor,
  futuresChainDescriptor,
  marketInformationDescriptor
] as const;

export const RESOURCE_DESCRIPTORS = [
  catalogInstrumentsDescriptor,
  marketSnapshotResourceDescriptor,
  historicalCandlesResourceDescriptor,
  snapshotsConfigDescriptor,
  snapshotsNullConfigDescriptor,
  eventsLiveDescriptor,
  eventsAlertsDescriptor
] as const;

export const PROMPT_DESCRIPTORS = [
  explainMarketSnapshotDescriptor,
  interpretCoverageGapsDescriptor,
  howToCaptureSnapshotDescriptor
] as const;

/** Deterministic, ordered descriptor list with the type derived from its group. */
export function listMcpOperationDescriptors(): McpOperationDescriptor[] {
  return [
    ...TOOL_DESCRIPTORS.map((d) => ({ ...d, type: "tool" as const })),
    ...RESOURCE_DESCRIPTORS.map((d) => ({ ...d, type: "resource" as const })),
    ...PROMPT_DESCRIPTORS.map((d) => ({ ...d, type: "prompt" as const }))
  ];
}
