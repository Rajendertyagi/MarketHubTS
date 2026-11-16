import type {
  CanonicalLiveValue,
  ProviderId,
  ProviderObservation,
  Provenance,
  TimestampUnit
} from "@markethub/contracts";

export interface NormalizeObservationInput {
  provider: ProviderId;
  canonicalId: string;
  value: CanonicalLiveValue;
  rawProviderTimestamp: number | null;
  providerTimestampUnit: TimestampUnit;
  providerTimestampMeaning: string;
  receivedAtMs: number;
  providerSequence?: number | null;
  sourceVersion?: string;
  notes?: string;
}

/** 2100-01-01 — anything beyond this is not a plausible epoch value. */
const MAX_SANE_EPOCH_MS = 4_102_444_800_000;

/**
 * Convert a provider timestamp to ms epoch only when the unit is documented and
 * the value is finite, positive and plausible. Returns null when conversion is
 * not reliable — callers must then fall back to local receipt time.
 */
export function normalizeProviderTimestamp(raw: number | null, unit: TimestampUnit): number | null {
  if (raw === null || !Number.isFinite(raw)) return null;
  if (unit === "UNKNOWN") return null;
  const ms = unit === "MS" ? raw : raw * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_SANE_EPOCH_MS) return null;
  return Math.round(ms);
}

/** Two observations may be ranked by source timestamp only if semantics match. */
export function timestampsCompatible(a: ProviderObservation, b: ProviderObservation): boolean {
  return a.timestampTrusted &&
    b.timestampTrusted &&
    a.normalizedProviderTimestampMs !== null &&
    b.normalizedProviderTimestampMs !== null &&
    a.providerTimestampUnit === b.providerTimestampUnit &&
    a.providerTimestampMeaning === b.providerTimestampMeaning;
}

/** Build a validated observation. Freshness is assigned later by the evaluator. */
export function normalizeObservation(input: NormalizeObservationInput): ProviderObservation {
  const normalizedMs = normalizeProviderTimestamp(input.rawProviderTimestamp, input.providerTimestampUnit);
  const provenance: Provenance = {
    source: "provider-feed",
    provider: input.provider,
    receivedAt: new Date(input.receivedAtMs).toISOString(),
    ...(normalizedMs !== null ? { sourceObservedAt: new Date(normalizedMs).toISOString() } : {}),
    ...(input.sourceVersion ? { sourceVersion: input.sourceVersion } : {}),
    ...(input.notes ? { notes: input.notes } : {})
  };
  return {
    provider: input.provider,
    canonicalId: input.canonicalId,
    value: input.value,
    rawProviderTimestamp: input.rawProviderTimestamp,
    providerTimestampUnit: input.providerTimestampUnit,
    providerTimestampMeaning: input.providerTimestampMeaning,
    normalizedProviderTimestampMs: normalizedMs,
    timestampTrusted: normalizedMs !== null,
    receivedAtMs: input.receivedAtMs,
    providerSequence: input.providerSequence ?? null,
    freshness: "UNAVAILABLE",
    availability: "AVAILABLE",
    provenance
  };
}
