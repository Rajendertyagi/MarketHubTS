import { z } from "zod";
import type { ProviderId } from "./provider";
import type { AvailabilityState, Provenance } from "./market";

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

export interface ProviderConnectionStatus {
  provider: ProviderId;
  state: ProviderConnectionState;
  changedAtMs: number;
  error: string | null;
}

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

// --- Per-instrument live item: per-provider observations + derived selection ---
export interface LiveItem {
  canonicalId: string;
  observations: Partial<Record<ProviderId, ProviderObservation>>;
  selected: SelectedObservation;
  pinned: boolean;
  updatedAtMs: number;
}

// --- Consistent snapshot with store-wide revision (SSE groundwork) ---
export interface LiveSnapshot {
  revision: number;
  capturedAtMs: number;
  items: LiveItem[];
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
