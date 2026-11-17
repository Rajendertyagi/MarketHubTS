import { z } from "zod";
import type { ProviderId } from "./provider";
import { availabilityStateSchema, provenanceSchema, type AvailabilityState, type Provenance } from "./market";

// Provider ids are inlined as a value schema here so live.ts never needs a
// runtime import from provider.ts (provider.ts imports the connection schema
// from this module). This keeps the dependency direction acyclic at runtime.
const liveProviderIdSchema = z.enum(["UPSTOX", "FYERS"]);

// --- Provider connection state (owned by the streaming supervisor) ---
// Deliberately separate from observation freshness: DISCONNECTED is a connection
// state, never an observation freshness value.
export const providerConnectionStateSchema = z.enum([
  "NOT_STARTED",
  "CONNECTING",
  "STREAMING",
  "DEGRADED",
  "DISCONNECTED",
  "ERROR"
]);
export type ProviderConnectionState = z.infer<typeof providerConnectionStateSchema>;

export const providerConnectionStatusSchema = z.object({
  provider: liveProviderIdSchema,
  state: providerConnectionStateSchema,
  changedAtMs: z.number().int().nonnegative(),
  error: z.string().nullable()
});
export type ProviderConnectionStatus = z.infer<typeof providerConnectionStatusSchema>;

// --- Live observation freshness (distinct from catalog Freshness) ---
export const liveFreshnessStateSchema = z.enum(["FRESH", "LAST_KNOWN", "STALE", "UNAVAILABLE"]);
export type LiveFreshnessState = z.infer<typeof liveFreshnessStateSchema>;

export const marketSessionStateSchema = z.enum(["OPEN", "CLOSED", "UNKNOWN"]);
export type MarketSessionState = z.infer<typeof marketSessionStateSchema>;

export const timestampUnitSchema = z.enum(["MS", "SECONDS", "UNKNOWN"]);
export type TimestampUnit = z.infer<typeof timestampUnitSchema>;

/** Which clock was used as the age basis for an observation. */
export const observationAgeBasisSchema = z.enum(["SOURCE", "RECEIPT"]);
export type ObservationAgeBasis = z.infer<typeof observationAgeBasisSchema>;

// --- Canonical values actually supplied by a provider (never fabricated) ---
export interface CanonicalLiveValue {
  ltp?: number;
  lastTradedQuantity?: number;
  close?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  /** Provider-native fields preserved verbatim, attributed through provenance. */
  native?: Record<string, unknown>;
}

export const canonicalLiveValueSchema = z.object({
  ltp: z.number().finite().optional(),
  lastTradedQuantity: z.number().finite().optional(),
  close: z.number().finite().optional(),
  open: z.number().finite().optional(),
  high: z.number().finite().optional(),
  low: z.number().finite().optional(),
  volume: z.number().finite().optional(),
  native: z.record(z.string(), z.unknown()).optional()
});

// --- Latest observation retained independently for one provider/instrument ---
export interface ProviderObservation {
  provider: ProviderId;
  canonicalId: string;
  value: CanonicalLiveValue;
  rawProviderTimestamp: number | null;
  providerTimestampUnit: TimestampUnit;
  providerTimestampMeaning: string;
  normalizedProviderTimestampMs: number | null;
  timestampTrusted: boolean;
  /** SOURCE when a trusted source timestamp exists, otherwise RECEIPT. */
  ageBasis: ObservationAgeBasis;
  receivedAtMs: number;
  providerSequence: number | null;
  freshness: LiveFreshnessState;
  availability: AvailabilityState;
  provenance: Provenance;
}

export const providerObservationSchema = z.object({
  provider: liveProviderIdSchema,
  canonicalId: z.string().min(1),
  value: canonicalLiveValueSchema,
  rawProviderTimestamp: z.number().nullable(),
  providerTimestampUnit: timestampUnitSchema,
  providerTimestampMeaning: z.string(),
  normalizedProviderTimestampMs: z.number().nullable(),
  timestampTrusted: z.boolean(),
  ageBasis: observationAgeBasisSchema,
  receivedAtMs: z.number().int().nonnegative(),
  providerSequence: z.number().nullable(),
  freshness: liveFreshnessStateSchema,
  availability: availabilityStateSchema,
  provenance: provenanceSchema
});

// --- Derived selection (never an independent source of truth) ---
export const selectionModeSchema = z.enum(["LIVE", "LAST_KNOWN", "UNAVAILABLE"]);
export type SelectionMode = z.infer<typeof selectionModeSchema>;

export interface SelectedObservation {
  canonicalId: string;
  provider: ProviderId | null;
  value: CanonicalLiveValue | null;
  mode: SelectionMode;
  freshness: LiveFreshnessState;
  reason: string;
  observation: ProviderObservation | null;
}

export const selectedObservationSchema = z.object({
  canonicalId: z.string().min(1),
  provider: liveProviderIdSchema.nullable(),
  value: canonicalLiveValueSchema.nullable(),
  mode: selectionModeSchema,
  freshness: liveFreshnessStateSchema,
  reason: z.string(),
  observation: providerObservationSchema.nullable()
});

// --- Per-instrument live item: per-provider observations + derived selection ---
export interface LiveItem {
  canonicalId: string;
  observations: Partial<Record<ProviderId, ProviderObservation>>;
  selected: SelectedObservation;
  pinned: boolean;
  updatedAtMs: number;
}

export const liveItemSchema = z.object({
  canonicalId: z.string().min(1),
  observations: z.object({
    UPSTOX: providerObservationSchema.optional(),
    FYERS: providerObservationSchema.optional()
  }),
  selected: selectedObservationSchema,
  pinned: z.boolean(),
  updatedAtMs: z.number().int().nonnegative()
});

// --- Consistent snapshot with store-wide revision (SSE groundwork) ---
export interface LiveSnapshot {
  revision: number;
  capturedAtMs: number;
  items: LiveItem[];
  connections: ProviderConnectionStatus[];
}

export const liveSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  capturedAtMs: z.number().int().nonnegative(),
  items: z.array(liveItemSchema),
  connections: z.array(providerConnectionStatusSchema)
});

// --- Compact, revisioned change events emitted by the canonical service ---
export const liveItemUpdatedEventSchema = z.object({
  type: z.literal("item-updated"),
  revision: z.number().int().nonnegative(),
  canonicalId: z.string().min(1),
  item: liveItemSchema
});
export const liveItemRemovedEventSchema = z.object({
  type: z.literal("item-removed"),
  revision: z.number().int().nonnegative(),
  canonicalId: z.string().min(1)
});
export const liveProviderConnectionChangedEventSchema = z.object({
  type: z.literal("provider-connection-changed"),
  revision: z.number().int().nonnegative(),
  provider: liveProviderIdSchema,
  status: providerConnectionStatusSchema,
  requiresSnapshotRefresh: z.literal(true)
});
export const liveChangeEventSchema = z.discriminatedUnion("type", [
  liveItemUpdatedEventSchema,
  liveItemRemovedEventSchema,
  liveProviderConnectionChangedEventSchema
]);
export type LiveChangeEvent = z.infer<typeof liveChangeEventSchema>;

// Control events carry no data revision and never advance it.
export const snapshotRequiredEventSchema = z.object({
  type: z.literal("snapshot-required"),
  reason: z.string().optional()
});
export type SnapshotRequiredEvent = z.infer<typeof snapshotRequiredEventSchema>;
export const refreshEventSchema = z.object({ type: z.literal("refresh") });
export type RefreshEvent = z.infer<typeof refreshEventSchema>;

// --- Desired subscription state (persisted, durable generation) ---
export const subscriptionSelectionSchema = z.object({
  canonicalId: z.string().min(1),
  enabled: z.boolean().default(true)
});
export type SubscriptionSelection = z.infer<typeof subscriptionSelectionSchema>;

export const subscriptionReplaceRequestSchema = z.object({
  selections: z.array(subscriptionSelectionSchema)
});
export type SubscriptionReplaceRequest = z.infer<typeof subscriptionReplaceRequestSchema>;

export const subscriptionResolutionSchema = z.object({
  canonicalId: z.string().min(1),
  enabled: z.boolean(),
  available: z.boolean(),
  nativeIdentifier: z.string().nullable(),
  reason: z.string().nullable()
});
export type SubscriptionResolution = z.infer<typeof subscriptionResolutionSchema>;

export const subscriptionRuntimeStatusSchema = z.object({
  generation: z.number().int().nonnegative(),
  connectionState: providerConnectionStateSchema,
  resolutions: z.array(subscriptionResolutionSchema),
  lastError: z.string().nullable()
});
export type SubscriptionRuntimeStatus = z.infer<typeof subscriptionRuntimeStatusSchema>;

export const subscriptionStateViewSchema = z.object({
  selections: z.array(subscriptionSelectionSchema),
  generation: z.number().int().nonnegative(),
  runtime: subscriptionRuntimeStatusSchema
});
export type SubscriptionStateView = z.infer<typeof subscriptionStateViewSchema>;

export interface SubscriptionState {
  selections: SubscriptionSelection[];
  generation: number;
}

/** Persistence boundary for desired subscriptions. Implemented in @markethub/database. */
export interface SubscriptionRepository {
  load(): Promise<SubscriptionState>;
  /** Atomically replace rows and advance the durable generation; returns the committed generation. */
  replace(selections: SubscriptionSelection[]): Promise<number>;
}

/** Minimal source the realtime hub consumes. MarketDataService satisfies this structurally. */
export interface LiveEventSource {
  readonly revision: number;
  getSnapshot(): LiveSnapshot;
  subscribe(listener: (event: LiveChangeEvent) => void): () => void;
}

// --- Injected policy and clock (no assumptions inside adapters) ---
export interface FreshnessPolicy {
  openMaxAgeMs: number;
  unknownMaxAgeMs: number;
  maxRetainedObservationAgeMs: number;
}

export interface LiveStateOptions {
  now: () => Date;
  policy: FreshnessPolicy;
  maxInstruments: number;
  session: () => MarketSessionState;
  onEvict?: (canonicalId: string) => void;
}
