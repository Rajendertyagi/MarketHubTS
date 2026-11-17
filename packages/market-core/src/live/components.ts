import type {
  ComponentKind,
  ComponentObservation,
  ComponentUpdate,
  ComponentValue,
  FieldTimestamp,
  ProviderId,
  SelectedComponent,
  SourceTimestamp
} from "@markethub/contracts";
import type {
  FreshnessPolicy,
  LiveFreshnessState,
  MarketSessionState,
  ProviderConnectionState,
  ProviderObservation
} from "@markethub/contracts";
import { evaluateFreshness } from "./freshness";
import { UntrackedInstrumentError } from "./store";

const CONNECTED_STATES: ReadonlySet<ProviderConnectionState> = new Set(["STREAMING", "DEGRADED"]);

function cloneTimestamp(ts: SourceTimestamp | null | undefined): SourceTimestamp | null {
  return ts ? { ...ts } : null;
}

function cloneFieldTimestamps(map: Record<string, FieldTimestamp>): Record<string, FieldTimestamp> {
  const out: Record<string, FieldTimestamp> = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = { source: cloneTimestamp(value.source), receivedAtMs: value.receivedAtMs };
  }
  return out;
}

/** Newest trusted source timestamp among the fields supplied by an update. */
function newestTrustedTimestamp(update: ComponentUpdate): SourceTimestamp | null {
  let best: SourceTimestamp | null = null;
  for (const field of Object.values(update.set)) {
    if (!field) continue;
    const ts = field.sourceTimestamp;
    if (ts?.trusted && ts.normalizedMs !== null) {
      if (!best || (best.normalizedMs ?? 0) < ts.normalizedMs) best = ts;
    }
  }
  return cloneTimestamp(best);
}

/** Reuse the existing session-aware freshness evaluator for a component observation. */
function componentFreshness(
  observation: ComponentObservation,
  session: MarketSessionState,
  policy: FreshnessPolicy,
  nowMs: number
): LiveFreshnessState {
  const asObservation: ProviderObservation = {
    provider: observation.provider,
    canonicalId: observation.canonicalId,
    value: {},
    rawProviderTimestamp: observation.sourceTimestamp?.raw ?? null,
    providerTimestampUnit: observation.sourceTimestamp?.unit ?? "UNKNOWN",
    providerTimestampMeaning: observation.sourceTimestamp?.meaning ?? "component",
    normalizedProviderTimestampMs: observation.sourceTimestamp?.normalizedMs ?? null,
    timestampTrusted: observation.sourceTimestamp?.trusted === true,
    ageBasis: observation.sourceTimestamp?.trusted ? "SOURCE" : "RECEIPT",
    receivedAtMs: observation.receivedAtMs,
    providerSequence: null,
    freshness: observation.freshness,
    availability: observation.availability,
    provenance: observation.provenance
  };
  return evaluateFreshness(asObservation, session, policy, nowMs);
}

function unavailableComponent(canonicalId: string, component: ComponentKind, reason: string): SelectedComponent {
  return {
    canonicalId,
    component,
    provider: null,
    value: null,
    mode: "UNAVAILABLE",
    freshness: "UNAVAILABLE",
    reason,
    observation: null
  };
}

/**
 * Bounded per-(provider, canonical instrument, component) storage with explicit
 * partial-merge semantics and per-field timestamps. This is the canonical
 * component state holder; provider attribution and selection stay at component
 * level, while per-field timestamps are used only for honest field age.
 */
export class ComponentStore {
  private readonly items = new Map<string, Map<ProviderId, Map<ComponentKind, ComponentObservation>>>();

  constructor(private readonly now: () => Date) {}

  track(canonicalId: string): void {
    if (!this.items.has(canonicalId)) this.items.set(canonicalId, new Map());
  }

  untrack(canonicalId: string): boolean {
    return this.items.delete(canonicalId);
  }

  has(canonicalId: string): boolean {
    return this.items.has(canonicalId);
  }

  /**
   * Apply a component update. Rules: component isolation; only supplied fields
   * are set; omitted fields are preserved; explicit zero is a value; `clear`
   * is the only removal path; `complete` replaces the component wholesale.
   */
  applyUpdate(update: ComponentUpdate): void {
    const perProvider = this.items.get(update.canonicalId);
    if (!perProvider) throw new UntrackedInstrumentError(update.canonicalId);
    let perComponent = perProvider.get(update.provider);
    if (!perComponent) {
      perComponent = new Map();
      perProvider.set(update.provider, perComponent);
    }
    const existing = perComponent.get(update.component);
    const value: Record<string, unknown> = update.complete
      ? {}
      : { ...(structuredClone(existing?.value ?? {}) as Record<string, unknown>) };
    const fieldTimestamps: Record<string, FieldTimestamp> = update.complete
      ? {}
      : cloneFieldTimestamps(existing?.fieldTimestamps ?? {});

    for (const [field, fieldUpdate] of Object.entries(update.set)) {
      if (!fieldUpdate) continue;
      value[field] = structuredClone(fieldUpdate.value);
      fieldTimestamps[field] = {
        source: cloneTimestamp(fieldUpdate.sourceTimestamp),
        receivedAtMs: fieldUpdate.receivedAtMs
      };
    }
    for (const field of update.clear ?? []) {
      delete value[field];
      delete fieldTimestamps[field];
    }

    const suppliedTimestamp = newestTrustedTimestamp(update);
    const sourceTimestamp = suppliedTimestamp ?? cloneTimestamp(existing?.sourceTimestamp);
    const observation: ComponentObservation = {
      provider: update.provider,
      canonicalId: update.canonicalId,
      component: update.component,
      value: value as Partial<ComponentValue>,
      fieldTimestamps,
      sourceTimestamp,
      receivedAtMs: update.receivedAtMs,
      freshness: "UNAVAILABLE",
      availability: update.availability ?? "AVAILABLE",
      provenance: structuredClone(update.provenance)
    };
    perComponent.set(update.component, observation);
  }

  get(canonicalId: string, provider: ProviderId, component: ComponentKind): ComponentObservation | undefined {
    const observation = this.items.get(canonicalId)?.get(provider)?.get(component);
    return observation ? structuredClone(observation) : undefined;
  }

  all(canonicalId: string, component: ComponentKind): ComponentObservation[] {
    const perProvider = this.items.get(canonicalId);
    if (!perProvider) return [];
    const out: ComponentObservation[] = [];
    for (const perComponent of perProvider.values()) {
      const observation = perComponent.get(component);
      if (observation) out.push(structuredClone(observation));
    }
    return out;
  }

  /** Independently select one provider's component; never blend fields across providers. */
  select(
    canonicalId: string,
    component: ComponentKind,
    connections: ReadonlyMap<ProviderId, ProviderConnectionState>,
    session: MarketSessionState,
    policy: FreshnessPolicy,
    nowMs: number
  ): SelectedComponent {
    const observations = this.all(canonicalId, component);
    if (observations.length === 0) return unavailableComponent(canonicalId, component, "no observations");

    const evaluated = observations.map((observation) => ({
      observation,
      freshness: componentFreshness(observation, session, policy, nowMs)
    }));

    const live = evaluated.filter(
      (entry) => entry.freshness === "FRESH" && CONNECTED_STATES.has(connections.get(entry.observation.provider) ?? "NOT_STARTED")
    );
    if (live.length > 0) {
      const first = live[0]!;
      const compatible = live.length > 1 && live.every((entry) => this.compatible(entry.observation, first.observation));
      const sorted = [...live].sort((a, b) => {
        if (compatible) {
          const bySource = (b.observation.sourceTimestamp?.normalizedMs ?? 0) - (a.observation.sourceTimestamp?.normalizedMs ?? 0);
          // Equal source timestamps must not fall back to insertion order;
          // receipt ordering is the controlled tie-breaker.
          if (bySource !== 0) return bySource;
        }
        return b.observation.receivedAtMs - a.observation.receivedAtMs;
      });
      const winner = sorted[0]!;
      return {
        canonicalId,
        component,
        provider: winner.observation.provider,
        value: structuredClone(winner.observation.value) as ComponentValue,
        mode: "LIVE",
        freshness: "FRESH",
        reason: compatible
          ? "eligible live component; ranked by compatible source timestamp, receipt time breaks ties"
          : "eligible live component; receivedAt fallback (incompatible or missing source timestamps)",
        observation: structuredClone(winner.observation)
      };
    }

    const retained = evaluated.filter((entry) => entry.freshness !== "UNAVAILABLE");
    if (retained.length > 0) {
      const sorted = [...retained].sort((a, b) => b.observation.receivedAtMs - a.observation.receivedAtMs);
      const winner = sorted[0]!;
      return {
        canonicalId,
        component,
        provider: winner.observation.provider,
        value: structuredClone(winner.observation.value) as ComponentValue,
        mode: "LAST_KNOWN",
        freshness: winner.freshness === "FRESH" ? "LAST_KNOWN" : winner.freshness,
        reason: "no eligible live component; retained fallback",
        observation: structuredClone(winner.observation)
      };
    }

    return unavailableComponent(canonicalId, component, "no component observation qualifies");
  }

  private compatible(a: ComponentObservation, b: ComponentObservation): boolean {
    return a.sourceTimestamp?.trusted === true &&
      b.sourceTimestamp?.trusted === true &&
      a.sourceTimestamp.normalizedMs !== null &&
      b.sourceTimestamp.normalizedMs !== null &&
      a.sourceTimestamp.meaning === b.sourceTimestamp.meaning;
  }
}
