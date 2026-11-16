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
  // Age basis: trusted source observation time when available, otherwise local
  // receipt time. A recently received but genuinely old observation must not
  // stay eligible for retained fallback indefinitely.
  const hasSource = observation.timestampTrusted && observation.normalizedProviderTimestampMs !== null;
  const basisMs = hasSource ? observation.normalizedProviderTimestampMs! : observation.receivedAtMs;
  const age = nowMs - basisMs;
  if (!Number.isFinite(age) || age > policy.maxRetainedObservationAgeMs) {
    return "UNAVAILABLE";
  }

  if (session === "CLOSED") return "LAST_KNOWN";

  if (session === "UNKNOWN") {
    if (!hasSource) return "LAST_KNOWN";
    if (age < 0) return "LAST_KNOWN";
    return age <= policy.unknownMaxAgeMs ? "FRESH" : "STALE";
  }

  // OPEN: prefer a validated source timestamp; otherwise use local receipt time.
  if (age < 0) return "LAST_KNOWN";
  return age <= policy.openMaxAgeMs ? "FRESH" : "STALE";
}
