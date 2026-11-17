import type {
  ComponentKind,
  ComponentObservation,
  ComponentUpdate,
  FreshnessPolicy,
  LiveChangeEvent,
  LiveItem,
  LiveSnapshot,
  LiveStateOptions,
  MarketSessionState,
  ProviderConnectionState,
  ProviderConnectionStatus,
  ProviderId,
  ProviderObservation,
  SelectedComponent
} from "@markethub/contracts";
import { evaluateFreshness } from "./freshness";
import { selectObservation } from "./selection";
import { ComponentStore } from "./components";

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
  private readonly listeners = new Set<(event: LiveChangeEvent) => void>();
  /** Canonical component storage (quote/depth/derivatives) per provider/instrument. */
  private readonly components = new ComponentStore(() => this.now());
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

  /**
   * Subscribe to successful revision changes. Notifications are synchronous and
   * carry detached data. Listener failures are isolated and never break the
   * mutation or other listeners. Returns an unsubscribe function.
   */
  subscribe(listener: (event: LiveChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(event: LiveChangeEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A misbehaving consumer must not corrupt canonical state or peers.
      }
    }
  }

  /** Explicitly track an instrument. No automatic or silent eviction. */
  track(canonicalId: string, pinned = false): void {
    if (this.items.has(canonicalId)) return;
    if (this.items.size >= this.maxInstruments) {
      throw new LiveStateCapacityError(canonicalId, this.maxInstruments);
    }
    const nowMs = this.now().getTime();
    const item: LiveItem = {
      canonicalId,
      observations: {},
      selected: selectObservation(canonicalId, {}, this.connectionStates(), this.session(), this.policy, nowMs),
      pinned,
      updatedAtMs: nowMs
    };
    this.items.set(canonicalId, item);
    this.components.track(canonicalId);
    this.revisionValue++;
    this.notify({ type: "item-updated", revision: this.revisionValue, canonicalId, item: this.materialize(item, nowMs) });
  }

  /** Explicit removal only. Returns true if an item was removed. */
  untrack(canonicalId: string): boolean {
    const removed = this.items.delete(canonicalId);
    if (removed) {
      this.components.untrack(canonicalId);
      this.revisionValue++;
      this.onEvict?.(canonicalId);
      this.notify({ type: "item-removed", revision: this.revisionValue, canonicalId });
    }
    return removed;
  }

  /** Replace only this provider's observation; the other provider is untouched. */
  applyObservation(observation: ProviderObservation): void {
    const item = this.items.get(observation.canonicalId);
    if (!item) throw new UntrackedInstrumentError(observation.canonicalId);
    const nowMs = this.now().getTime();
    // Take ownership: clone the incoming observation so later caller mutation
    // (including nested native fields and provenance) cannot reach internal state.
    const cloned = structuredClone(observation);
    const stored: ProviderObservation = {
      ...cloned,
      freshness: evaluateFreshness(cloned, this.session(), this.policy, nowMs)
    };
    item.observations = { ...item.observations, [observation.provider]: stored };
    item.updatedAtMs = nowMs;
    item.selected = selectObservation(
      item.canonicalId, item.observations, this.connectionStates(), this.session(), this.policy, nowMs
    );
    this.revisionValue++;
    this.notify({
      type: "item-updated", revision: this.revisionValue, canonicalId: observation.canonicalId,
      item: this.materialize(item, nowMs)
    });
  }

  /**
   * Apply a canonical component update. Partial updates merge into the same
   * provider/component before selection; per-field timestamps are preserved.
   */
  applyComponentUpdate(update: ComponentUpdate): void {
    this.components.applyUpdate(update);
    const item = this.items.get(update.canonicalId);
    if (item) item.updatedAtMs = this.now().getTime();
    this.revisionValue++;
    const nowMs = this.now().getTime();
    const materialized = item ? this.materialize(item, nowMs) : this.emptyItem(update.canonicalId, nowMs);
    this.notify({ type: "item-updated", revision: this.revisionValue, canonicalId: update.canonicalId, item: materialized });
  }

  /** Independently selected component for one canonical instrument. */
  getSelectedComponent(canonicalId: string, component: ComponentKind): SelectedComponent | undefined {
    if (!this.items.has(canonicalId)) return undefined;
    return this.components.select(
      canonicalId, component, this.connectionStates(), this.session(), this.policy, this.now().getTime()
    );
  }

  /** A retained component observation for one provider, or undefined. */
  getComponent(canonicalId: string, provider: ProviderId, component: ComponentKind): ComponentObservation | undefined {
    return this.components.get(canonicalId, provider, component);
  }

  private emptyItem(canonicalId: string, nowMs: number): LiveItem {
    return {
      canonicalId,
      observations: {},
      selected: selectObservation(canonicalId, {}, this.connectionStates(), this.session(), this.policy, nowMs),
      pinned: false,
      updatedAtMs: nowMs,
      components: this.selectAllComponents(canonicalId, nowMs)
    };
  }

  private selectAllComponents(canonicalId: string, nowMs: number): Partial<Record<ComponentKind, SelectedComponent>> {
    const out: Partial<Record<ComponentKind, SelectedComponent>> = {};
    for (const component of ["quote", "depth", "derivatives"] as const) {
      out[component] = this.components.select(
        canonicalId, component, this.connectionStates(), this.session(), this.policy, nowMs
      );
    }
    return out;
  }

  /** Connection state is owned here, never stored inside observations. */
  setConnectionState(provider: ProviderId, state: ProviderConnectionState, error: string | null = null): void {
    const previous = this.connections.get(provider);
    if (previous?.state === state && previous.error === error) return;
    const status: ProviderConnectionStatus = { provider, state, changedAtMs: this.now().getTime(), error };
    this.connections.set(provider, status);
    // Connectedness affects selection eligibility, so recompute all selections.
    const nowMs = this.now().getTime();
    for (const item of this.items.values()) {
      item.selected = selectObservation(
        item.canonicalId, item.observations, this.connectionStates(), this.session(), this.policy, nowMs
      );
    }
    this.revisionValue++;
    this.notify({
      type: "provider-connection-changed", revision: this.revisionValue, provider,
      status: { ...status }, requiresSnapshotRefresh: true
    });
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
      items: [...this.items.values()].map((item) => this.materialize(item, nowMs)),
      connections: this.allConnectionStatuses()
    };
  }

  private materialize(item: LiveItem, nowMs: number): LiveItem {
    // Deep clone the whole item first: values, native fields, provenance and
    // the existing selection are all detached from internal storage.
    const copy: LiveItem = structuredClone(item);
    const observations: Partial<Record<ProviderId, ProviderObservation>> = copy.observations;
    for (const [provider, observation] of Object.entries(observations)) {
      if (observation) {
        observations[provider as ProviderId] = {
          ...observation,
          freshness: evaluateFreshness(observation, this.session(), this.policy, nowMs)
        };
      }
    }
    copy.selected = selectObservation(
      copy.canonicalId, observations, this.connectionStates(), this.session(), this.policy, nowMs
    );
    copy.components = this.selectAllComponents(copy.canonicalId, nowMs);
    return copy;
  }

  private connectionStates(): Map<ProviderId, ProviderConnectionState> {
    const states = new Map<ProviderId, ProviderConnectionState>();
    for (const [provider, status] of this.connections) states.set(provider, status.state);
    return states;
  }
}
