import type {
  FreshnessPolicy,
  LiveFreshnessState,
  MarketSessionState,
  ProviderObservation
} from "@markethub/contracts";

/**
 * Session-aware freshness. The maximum retained age is enforced independently
 * of session state. CLOSED never yields FRESH; UNKNOWN never claims FRESH
 * without a validated source timestamp.
 */
export function evaluateFreshness(
  observation: ProviderObservation,
  session: MarketSessionState,
  policy: FreshnessPolicy,
  nowMs: number
): LiveFreshnessState {
  const transportAge = nowMs - observation.receivedAtMs;
  if (!Number.isFinite(transportAge) || transportAge > policy.maxRetainedObservationAgeMs) {
    return "UNAVAILABLE";
  }

  if (session === "CLOSED") return "LAST_KNOWN";

  if (session === "UNKNOWN") {
    if (!observation.timestampTrusted || observation.normalizedProviderTimestampMs === null) {
      return "LAST_KNOWN";
    }
    const age = nowMs - observation.normalizedProviderTimestampMs;
    if (age < 0) return "LAST_KNOWN";
    return age <= policy.unknownMaxAgeMs ? "FRESH" : "STALE";
  }

  // OPEN: prefer a validated source timestamp; otherwise use local receipt time.
  const basisMs = observation.timestampTrusted && observation.normalizedProviderTimestampMs !== null
    ? observation.normalizedProviderTimestampMs
    : observation.receivedAtMs;
  const age = nowMs - basisMs;
  if (age < 0) return "LAST_KNOWN";
  return age <= policy.openMaxAgeMs ? "FRESH" : "STALE";
}
