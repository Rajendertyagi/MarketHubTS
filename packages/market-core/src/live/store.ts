import type {
  FreshnessPolicy,
  LiveItem,
  LiveSnapshot,
  LiveStateOptions,
  MarketSessionState,
  ProviderConnectionState,
  ProviderConnectionStatus,
  ProviderId,
  ProviderObservation
} from "@markethub/contracts";
import { evaluateFreshness } from "./freshness";
import { selectObservation } from "./selection";

export class LiveStateCapacityError extends Error {
  constructor(canonicalId: string, maxInstruments: number) {
    super(`live state capacity reached (${maxInstruments}); cannot track ${canonicalId}`);
    this.name = "LiveStateCapacityError";
  }
}

export class UntrackedInstrumentError extends Error {
  constructor(canonicalId: string) {
    super(`canonical instrument is not tracked: ${canonicalId}`);
    this.name = "UntrackedInstrumentError";
  }
}

/**
 * Bounded in-memory live state. Holds only the latest observation per
 * provider/instrument, keeps connection state separate, and exposes atomic
 * snapshot reads with a store-wide monotonic revision.
 */
export class LiveStateStore {
  private readonly items = new Map<string, LiveItem>();
  private readonly connections = new Map<ProviderId, ProviderConnectionStatus>();
  private readonly now: () => Date;
  private readonly policy: FreshnessPolicy;
  private readonly maxInstruments: number;
  private readonly session: () => MarketSessionState;
  private readonly onEvict: ((canonicalId: string) => void) | undefined;
  private revisionValue = 0;

  constructor(options: LiveStateOptions) {
    this.now = options.now;
    this.policy = options.policy;
    this.maxInstruments = options.maxInstruments;
    this.session = options.session;
    this.onEvict = options.onEvict;
  }

  get revision(): number {
    return this.revisionValue;
  }

  /** Explicitly track an instrument. No automatic or silent eviction. */
  track(canonicalId: string, pinned = false): void {
    if (this.items.has(canonicalId)) return;
    if (this.items.size >= this.maxInstruments) {
      throw new LiveStateCapacityError(canonicalId, this.maxInstruments);
    }
    this.items.set(canonicalId, {
      canonicalId,
      observations: {},
      selected: selectObservation(canonicalId, {}, this.connectionStates(), this.session(), this.policy, this.now().getTime()),
      pinned,
      updatedAtMs: this.now().getTime()
    });
    this.revisionValue++;
  }

  /** Explicit removal only. Returns true if an item was removed. */
  untrack(canonicalId: string): boolean {
    const removed = this.items.delete(canonicalId);
    if (removed) {
      this.revisionValue++;
      this.onEvict?.(canonicalId);
    }
    return removed;
  }

  /** Replace only this provider's observation; the other provider is untouched. */
  applyObservation(observation: ProviderObservation): void {
    const item = this.items.get(observation.canonicalId);
    if (!item) throw new UntrackedInstrumentError(observation.canonicalId);
    const nowMs = this.now().getTime();
    const stored: ProviderObservation = {
      ...observation,
      freshness: evaluateFreshness(observation, this.session(), this.policy, nowMs)
    };
    item.observations = { ...item.observations, [observation.provider]: stored };
    item.updatedAtMs = nowMs;
    item.selected = selectObservation(
      item.canonicalId, item.observations, this.connectionStates(), this.session(), this.policy, nowMs
    );
    this.revisionValue++;
  }

  /** Connection state is owned here, never stored inside observations. */
  setConnectionState(provider: ProviderId, state: ProviderConnectionState, error: string | null = null): void {
    const previous = this.connections.get(provider);
    if (previous?.state === state && previous.error === error) return;
    this.connections.set(provider, { provider, state, changedAtMs: this.now().getTime(), error });
    // Connectedness affects selection eligibility, so recompute all selections.
    const nowMs = this.now().getTime();
    for (const item of this.items.values()) {
      item.selected = selectObservation(
        item.canonicalId, item.observations, this.connectionStates(), this.session(), this.policy, nowMs
      );
    }
    this.revisionValue++;
  }

  getConnectionStatus(provider: ProviderId): ProviderConnectionStatus | undefined {
    const status = this.connections.get(provider);
    return status ? { ...status } : undefined;
  }

  allConnectionStatuses(): ProviderConnectionStatus[] {
    return [...this.connections.values()].map((status) => ({ ...status }));
  }

  getItem(canonicalId: string): LiveItem | undefined {
    const item = this.items.get(canonicalId);
    return item ? this.materialize(item, this.now().getTime()) : undefined;
  }

  /** Atomic, consistent read: snapshot and revision captured in one synchronous call. */
  getSnapshot(): LiveSnapshot {
    const nowMs = this.now().getTime();
    return {
      revision: this.revisionValue,
      capturedAtMs: nowMs,
      items: [...this.items.values()].map((item) => this.materialize(item, nowMs))
    };
  }

  private materialize(item: LiveItem, nowMs: number): LiveItem {
    const observations: Partial<Record<ProviderId, ProviderObservation>> = { ...item.observations };
    for (const [provider, observation] of Object.entries(observations)) {
      if (observation) {
        observations[provider as ProviderId] = {
          ...observation,
          freshness: evaluateFreshness(observation, this.session(), this.policy, nowMs)
        };
      }
    }
    return {
      ...item,
      observations,
      selected: selectObservation(
        item.canonicalId, observations, this.connectionStates(), this.session(), this.policy, nowMs
      )
    };
  }

  private connectionStates(): Map<ProviderId, ProviderConnectionState> {
    const states = new Map<ProviderId, ProviderConnectionState>();
    for (const [provider, status] of this.connections) states.set(provider, status.state);
    return states;
  }
}
