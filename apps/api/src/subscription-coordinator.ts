import type {
  ProviderId,
  SubscriptionSelection,
  SubscriptionStateView
} from "@markethub/contracts";
import type { CatalogRepository, MarketDataService } from "@markethub/market-core";
import type { SubscriptionRepository } from "@markethub/contracts";
import {
  SubscriptionPersistenceError,
  SubscriptionValidationError,
  type StreamSupervisor
} from "./stream-supervisor";

export interface ProviderRuntimeBinding {
  provider: ProviderId;
  supervisor: StreamSupervisor;
}

export interface SubscriptionCoordinatorOptions {
  service: MarketDataService;
  subscriptions: SubscriptionRepository;
  catalog: CatalogRepository;
  runtimes: ProviderRuntimeBinding[];
}

/**
 * The single owner of shared desired subscription state. Validates canonical
 * selections, persists them transactionally, owns shared track/untrack from the
 * owner's desired enabled selections, and fans the desired generation out to
 * independent provider runtimes. Provider runtimes never write shared state.
 */
export class SubscriptionCoordinator {
  private readonly runtimes: ProviderRuntimeBinding[];
  private generation = 0;
  private selections: SubscriptionSelection[] = [];
  private trackedIds = new Set<string>();
  private stopped = false;

  constructor(private readonly opts: SubscriptionCoordinatorOptions) {
    this.runtimes = opts.runtimes.map((binding) => ({ ...binding }));
  }

  /** Load persisted desired state, apply shared tracking, and fan out to runtimes. */
  async start(): Promise<void> {
    const state = await this.opts.subscriptions.load();
    await this.applyDesiredState(state.selections, state.generation);
  }

  /** Validate, persist once, update shared tracking, then fan out to runtimes. */
  async replaceSubscriptions(selections: SubscriptionSelection[]): Promise<SubscriptionStateView> {
    if (this.stopped) throw new SubscriptionValidationError("Subscription coordinator is stopped");
    await this.validate(selections);
    // Pre-flight capacity check BEFORE persistence: a later track() failure
    // must not leave a committed generation with unapplied shared tracking.
    this.assertCapacity(selections);

    let committed: number;
    try {
      committed = await this.opts.subscriptions.replace(selections);
    } catch (error) {
      throw new SubscriptionPersistenceError(error instanceof Error ? error.message : String(error));
    }
    await this.applyDesiredState(selections, committed);
    return this.getView();
  }

  private async validate(selections: SubscriptionSelection[]): Promise<void> {
    const seen = new Set<string>();
    for (const selection of selections) {
      if (seen.has(selection.canonicalId)) {
        throw new SubscriptionValidationError(`Duplicate canonical id: ${selection.canonicalId}`);
      }
      seen.add(selection.canonicalId);
      const instrument = await this.opts.catalog.getInstrumentByCanonicalId(selection.canonicalId);
      if (!instrument) {
        throw new SubscriptionValidationError(`Unknown canonical id: ${selection.canonicalId}`);
      }
    }
  }

  /** Reject desired state that would exceed live-state capacity before any write. */
  private assertCapacity(selections: SubscriptionSelection[]): void {
    const desired = new Set(selections.filter((s) => s.enabled).map((s) => s.canonicalId));
    if (desired.size > this.opts.service.maxInstruments) {
      throw new SubscriptionValidationError(
        `desired enabled selections (${desired.size}) exceed live state capacity (${this.opts.service.maxInstruments})`
      );
    }
  }

  private async applyDesiredState(selections: SubscriptionSelection[], generation: number): Promise<void> {
    this.assertCapacity(selections);
    this.generation = generation;
    this.selections = selections.map((s) => ({ ...s }));
    this.syncTracking();
    // Fan out without awaiting a healthy runtime on another provider's failure.
    await Promise.all(this.runtimes.map(async (binding) => {
      try {
        await binding.supervisor.applyDesiredState(this.selections, generation);
      } catch {
        // Runtime failures are recorded in that runtime's own status; they must
        // not block the coordinator or another provider.
      }
    }));
  }

  /** Shared tracking comes solely from the owner's desired enabled selections. */
  private syncTracking(): void {
    const desired = new Set(this.selections.filter((s) => s.enabled).map((s) => s.canonicalId));
    for (const id of [...this.trackedIds]) {
      if (!desired.has(id)) {
        this.opts.service.untrack(id);
        this.trackedIds.delete(id);
      }
    }
    for (const id of desired) {
      if (!this.trackedIds.has(id)) {
        this.opts.service.track(id);
        this.trackedIds.add(id);
      }
    }
  }

  getView(): SubscriptionStateView {
    const runtimes: Record<string, SubscriptionStateView["runtime"]> = {};
    for (const binding of this.runtimes) {
      const view = binding.supervisor.getView();
      runtimes[binding.provider] = view.runtime;
    }
    const first = this.runtimes[0]?.supervisor.getView().runtime;
    return {
      selections: this.selections.map((s) => ({ ...s })),
      generation: this.generation,
      runtime: first ?? {
        generation: 0,
        connectionState: "NOT_STARTED",
        resolutions: [],
        lastError: null
      },
      runtimes
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const binding of this.runtimes) {
      try { binding.supervisor.stop(); } catch { /* shutdown must not throw */ }
    }
  }
}
