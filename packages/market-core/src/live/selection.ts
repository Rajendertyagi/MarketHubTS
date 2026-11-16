import type {
  FreshnessPolicy,
  LiveFreshnessState,
  MarketSessionState,
  ProviderConnectionState,
  ProviderId,
  ProviderObservation,
  SelectedObservation
} from "@markethub/contracts";
import { evaluateFreshness } from "./freshness";
import { timestampsCompatible } from "./normalize";

const CONNECTED_STATES: ReadonlySet<ProviderConnectionState> = new Set(["STREAMING", "DEGRADED"]);

function unavailable(canonicalId: string, reason: string): SelectedObservation {
  return {
    canonicalId,
    provider: null,
    value: null,
    mode: "UNAVAILABLE",
    freshness: "UNAVAILABLE",
    reason,
    observation: null
  };
}

/**
 * Explicit source selection. Live observations from connected providers win;
 * source timestamps are compared only when semantics are compatible, otherwise
 * receivedAt is the fallback. Retained observations are used only when no live
 * observation qualifies and are always marked LAST_KNOWN.
 */
export function selectObservation(
  canonicalId: string,
  observations: Partial<Record<ProviderId, ProviderObservation>>,
  connections: ReadonlyMap<ProviderId, ProviderConnectionState>,
  session: MarketSessionState,
  policy: FreshnessPolicy,
  nowMs: number
): SelectedObservation {
  const entries = Object.values(observations).filter((o): o is ProviderObservation => o !== undefined);
  if (entries.length === 0) return unavailable(canonicalId, "no observations");

  const evaluated = entries.map((observation) => ({
    observation,
    freshness: evaluateFreshness(observation, session, policy, nowMs)
  }));

  const live = evaluated.filter(
    (e) => e.freshness === "FRESH" && CONNECTED_STATES.has(connections.get(e.observation.provider) ?? "NOT_STARTED")
  );
  if (live.length > 0) {
    const first = live[0]!;
    const compatible = live.length > 1 && live.every((e) => timestampsCompatible(e.observation, first.observation));
    const sorted = [...live].sort((a, b) => compatible
      ? (b.observation.normalizedProviderTimestampMs ?? 0) - (a.observation.normalizedProviderTimestampMs ?? 0)
      : b.observation.receivedAtMs - a.observation.receivedAtMs);
    const winner = sorted[0]!;
    return {
      canonicalId,
      provider: winner.observation.provider,
      value: winner.observation.value,
      mode: "LIVE",
      freshness: "FRESH" satisfies LiveFreshnessState,
      observation: winner.observation,
      reason: compatible
        ? "eligible live observation; ranked by compatible source timestamp"
        : "eligible live observation; receivedAt fallback (incompatible or missing source timestamps)"
    };
  }

  // Retained = any usable observation that is not eligible live. This includes
  // FRESH observations from disconnected providers: freshness by age does not
  // make a disconnected provider "currently streaming".
  const retained = evaluated.filter((e) => e.freshness !== "UNAVAILABLE");
  if (retained.length > 0) {
    const sorted = [...retained].sort((a, b) => b.observation.receivedAtMs - a.observation.receivedAtMs);
    const winner = sorted[0]!;
    return {
      canonicalId,
      provider: winner.observation.provider,
      value: winner.observation.value,
      mode: "LAST_KNOWN",
      freshness: winner.freshness === "FRESH" ? "LAST_KNOWN" : winner.freshness,
      observation: winner.observation,
      reason: "no eligible live observation; retained fallback"
    };
  }

  return unavailable(canonicalId, "no observation qualifies");
}
