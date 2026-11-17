import type {
  ProviderConnectionState,
  ProviderId,
  SubscriptionRepository,
  SubscriptionResolution,
  SubscriptionSelection,
  SubscriptionStateView
} from "@markethub/contracts";
import type { CatalogRepository, MarketDataService, NormalizeObservationInput } from "@markethub/market-core";

// --- Provider-agnostic streaming driver seam ---
// SDK translation stays in broker-upstox. Stage D production uses the locked
// driver below; only fake drivers are exercised in tests.

export interface DriverSubscription {
  canonicalId: string;
  nativeIdentifier: string;
}

export interface DriverCallbacks {
  onObservation(input: NormalizeObservationInput): void;
  onConnectionState(state: ProviderConnectionState, error?: string | null): void;
}

export interface StreamingDriver {
  /** Locked drivers never construct an SDK, open a socket or schedule retries. */
  readonly locked?: boolean;
  start(subscriptions: DriverSubscription[], callbacks: DriverCallbacks): Promise<void>;
  updateSubscriptions(subscriptions: DriverSubscription[]): Promise<void>;
  /** Must be safely repeatable: retirement and a settling operation may both call it. */
  stop(): void;
  getConnectionState(): ProviderConnectionState;
}

export class DriverLockedError extends Error {
  constructor() {
    super("Live Upstox streaming is locked in Stage D; real driver construction is disabled");
    this.name = "DriverLockedError";
  }
}

/**
 * Production boundary for Stage D. Real SDK construction, sockets and retry
 * scheduling are unreachable: every start/update attempt fails safely. Only a
 * separately authorized and independently reviewed Stage G change may unlock
 * real driver construction and connection behavior.
 */
export class LockedUpstoxDriver implements StreamingDriver {
  readonly locked = true;

  getConnectionState(): ProviderConnectionState {
    return "NOT_STARTED";
  }

  async start(): Promise<void> {
    throw new DriverLockedError();
  }

  async updateSubscriptions(): Promise<void> {
    throw new DriverLockedError();
  }

  stop(): void {
    // No SDK instance, socket or timer exists — nothing to release. Idempotent.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Client-side failure before any persistence: unknown/duplicate canonical ids. */
export class SubscriptionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionValidationError";
  }
}

/** Server-side failure while persisting desired state. */
export class SubscriptionPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionPersistenceError";
  }
}

/** Narrow seam for deterministic reconnect-timer control in tests. */
export interface ReconnectTimerScheduler {
  set(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout>): void;
}

const defaultReconnectTimerScheduler: ReconnectTimerScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle)
};

export interface StreamSupervisorOptions {
  service: MarketDataService;
  subscriptions: SubscriptionRepository;
  catalog: CatalogRepository;
  driver: StreamingDriver;
  provider?: ProviderId;
  reconnect?: { maxAttempts: number; baseDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
  reconnectTimerScheduler?: ReconnectTimerScheduler;
}

export interface ReplaceSubscriptionsResult {
  generation: number;
  view: SubscriptionStateView;
}

/**
 * Owns desired-subscription reconciliation and runtime streaming state. Kept
 * separate from ProviderRegistry (auth/status only). Writes runtime connection
 * state through the canonical MarketDataService.
 */
export class StreamSupervisor {
  private readonly provider: ProviderId;
  private readonly trackedIds = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  /** Latest committed (desired) generation from persistence. */
  private generation = 0;
  /** Last generation whose runtime application completed successfully. */
  private appliedGeneration = 0;
  private selections: SubscriptionSelection[] = [];
  private resolutions: SubscriptionResolution[] = [];
  private connectionState: ProviderConnectionState = "NOT_STARTED";
  private lastError: string | null = null;
  private driverStarted = false;
  /** True from just before driver.start() until its promise actually settles. */
  private startPending = false;
  /** True from just before updateSubscriptions() until its promise settles. */
  private updatePending = false;
  /** Epoch of the active driver instance; incremented on every retirement. */
  private epoch = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(private readonly opts: StreamSupervisorOptions) {
    this.provider = opts.provider ?? "UPSTOX";
  }

  /** Load persisted desired state and reconcile once at startup. */
  async start(): Promise<void> {
    const state = await this.opts.subscriptions.load();
    this.generation = state.generation;
    this.selections = state.selections.map((s) => ({ ...s }));
    await this.enqueueReconcile(state.generation);
  }

  /**
   * Validate, persist transactionally, then reconcile. Validation and
   * persistence failures are typed so the transport can classify them; a
   * post-commit reconciliation failure is captured in runtime status and never
   * misrepresented as an invalid request.
   */
  async replaceSubscriptions(selections: SubscriptionSelection[]): Promise<ReplaceSubscriptionsResult> {
    if (this.stopped) throw new SubscriptionValidationError("Stream supervisor is stopped");

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

    let committed: number;
    try {
      committed = await this.opts.subscriptions.replace(selections);
    } catch (error) {
      throw new SubscriptionPersistenceError(errorMessage(error));
    }

    // Desired state is committed: expose it immediately, independent of runtime.
    this.generation = committed;
    this.selections = selections.map((s) => ({ ...s }));
    await this.enqueueReconcile(committed);
    return { generation: committed, view: this.getView() };
  }

  /**
   * Serialized reconciliation. A reconciliation for an older generation is
   * skipped; post-commit runtime failures are recorded in lastError rather
   * than thrown, so committed desired state is never hidden. The applied
   * generation advances only after a successful application of that generation.
   */
  private enqueueReconcile(expectedGeneration: number): Promise<void> {
    const run = async () => {
      if (this.stopped) return;
      try {
        const state = await this.opts.subscriptions.load();
        if (state.generation < expectedGeneration) return;
        const applied = await this.applySelections(state.selections, state.generation);
        if (applied && state.generation > this.appliedGeneration) {
          this.appliedGeneration = state.generation;
        }
      } catch (error) {
        this.lastError = errorMessage(error);
      }
    };
    const queued = this.queue.then(run, run);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Returns true only when this generation's runtime state was fully applied. */
  private async applySelections(selections: SubscriptionSelection[], generation: number): Promise<boolean> {
    if (this.stopped) return false;
    const enabled = selections.filter((s) => s.enabled);

    // Phase 1: resolve mappings (async). No canonical service or driver mutation.
    const resolutions: SubscriptionResolution[] = [];
    const driverSubscriptions: DriverSubscription[] = [];
    for (const selection of enabled) {
      const mappings = await this.opts.catalog.listMappingsByCanonicalId(selection.canonicalId);
      const active = mappings.find((m) => m.provider === this.provider && m.status === "ACTIVE");
      if (active) {
        // Native identifier stays internal — used only for the driver handoff.
        resolutions.push({
          canonicalId: selection.canonicalId, enabled: true, available: true, reason: null
        });
        driverSubscriptions.push({ canonicalId: selection.canonicalId, nativeIdentifier: active.nativeIdentifier });
      } else {
        resolutions.push({
          canonicalId: selection.canonicalId, enabled: true, available: false,
          reason: "NO_ACTIVE_UPSTOX_MAPPING"
        });
      }
    }
    for (const selection of selections.filter((s) => !s.enabled)) {
      resolutions.push({
        canonicalId: selection.canonicalId, enabled: false, available: false, reason: "DISABLED"
      });
    }

    // Phase 2: generation guard after all async resolution. A concurrent PUT
    // that committed a newer generation invalidates this reconciliation.
    const latest = await this.opts.subscriptions.load();
    if (this.stopped || latest.generation !== generation) return false;

    // Phase 3: apply runtime state. No await occurs before the mutations below
    // except the driver calls, which begin synchronously.
    this.lastError = null;
    this.resolutions = resolutions;
    const desiredIds = new Set(enabled.map((s) => s.canonicalId));
    for (const id of [...this.trackedIds]) {
      if (!desiredIds.has(id)) {
        this.opts.service.untrack(id);
        this.trackedIds.delete(id);
      }
    }
    for (const id of desiredIds) {
      if (!this.trackedIds.has(id)) {
        this.opts.service.track(id);
        this.trackedIds.add(id);
      }
    }

    // Empty desired set / no eligible mappings: retire any current driver and
    // invalidate its callbacks, then report NOT_STARTED.
    if (driverSubscriptions.length === 0) {
      this.retireDriver();
      this.setConnectionState("NOT_STARTED", null);
      return true;
    }

    // A retired/disconnected driver must be replaced with a fresh start, never
    // updated in place (a disconnected adapter's update does not reconnect).
    if (!this.driverStarted) {
      return await this.startDriver(driverSubscriptions);
    }

    const updateEpoch = this.epoch;
    this.updatePending = true;
    try {
      await this.opts.driver.updateSubscriptions(driverSubscriptions);
      if (this.stopped || updateEpoch !== this.epoch) {
        // Settled after shutdown/retirement: final cleanup, not a success.
        this.finishPendingUpdate();
        return false;
      }
      this.updatePending = false;
      return true;
    } catch (error) {
      if (this.stopped || updateEpoch !== this.epoch) {
        // Late rejection: final cleanup only; no state/error/retry mutation.
        this.finishPendingUpdate();
        return false;
      }
      this.updatePending = false;
      this.lastError = errorMessage(error);
      this.setConnectionState("ERROR", this.lastError);
      this.retireDriver();
      if (!this.opts.driver.locked) this.scheduleReconnect(this.epoch);
      return false;
    }
  }

  /** Final cleanup for an update that settled after shutdown or retirement. */
  private finishPendingUpdate(): void {
    if (this.updatePending) {
      this.opts.driver.stop();
      this.updatePending = false;
    }
  }

  /**
   * Retire the current driver instance: invalidate its callback epoch, cancel
   * any reconnect timer scheduled for the old instance, and stop the driver.
   * Pending start/update flags are retained so their settle paths perform
   * final cleanup. Returns the new epoch for reconnect scheduling.
   */
  private retireDriver(): number {
    this.epoch++;
    this.cancelReconnectTimer();
    this.stopDriverResource();
    return this.epoch;
  }

  /** Cancel a pending reconnect timer so it cannot suppress a newer retry. */
  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) {
      (this.opts.reconnectTimerScheduler ?? defaultReconnectTimerScheduler).clear(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Stop the driver resource. Does not clear startPending/updatePending: those
   * flags are retained so in-flight operations can clean up when they settle.
   */
  private stopDriverResource(): void {
    if (this.driverStarted || this.startPending || this.updatePending) {
      this.opts.driver.stop();
      this.driverStarted = false;
    }
  }

  /** Returns true only when the driver start completed for the current epoch. */
  private async startDriver(subscriptions: DriverSubscription[]): Promise<boolean> {
    const epoch = ++this.epoch;
    this.startPending = true;
    this.setConnectionState("CONNECTING", null);
    try {
      await this.opts.driver.start(subscriptions, {
        onObservation: (input) => {
          if (epoch !== this.epoch || this.stopped) return;
          try {
            this.opts.service.applyProviderUpdate(input);
          } catch {
            // Late or invalid observations must not corrupt shared state.
          }
        },
        onConnectionState: (state, error) => {
          if (epoch !== this.epoch || this.stopped) return;
          try {
            this.setConnectionState(state, error ?? null);
            if (state === "STREAMING") {
              this.reconnectAttempts = 0;
            } else if ((state === "DISCONNECTED" || state === "ERROR") && !this.opts.driver.locked) {
              // Loss of this driver instance/session: retire it (invalidating
              // its callbacks) so the bounded retry performs a fresh start.
              if (state === "ERROR") this.lastError = error ?? "provider error";
              const newEpoch = this.retireDriver();
              this.scheduleReconnect(newEpoch);
            }
          } catch {
            // Callback failures are isolated from the driver and the service.
          }
        }
      });
      if (epoch !== this.epoch || this.stopped) {
        // Settled after stop/retirement: final cleanup; never mark started.
        if (this.startPending) {
          this.opts.driver.stop();
          this.startPending = false;
        }
        return false;
      }
      this.startPending = false;
      this.driverStarted = true;
      this.lastError = null;
      return true;
    } catch (error) {
      if (epoch !== this.epoch || this.stopped) {
        // A rejected start may have allocated resources: final cleanup.
        if (this.startPending) {
          this.opts.driver.stop();
          this.startPending = false;
        }
        return false;
      }
      this.startPending = false;
      this.lastError = errorMessage(error);
      this.setConnectionState("ERROR", this.lastError);
      this.driverStarted = false;
      // A failed start may have partially allocated resources: stop before retry.
      this.opts.driver.stop();
      // Invalidate callbacks from the failed attempt and cancel any stale timer
      // from a previous instance, then retry with a fresh epoch.
      this.epoch++;
      this.cancelReconnectTimer();
      if (!this.opts.driver.locked) this.scheduleReconnect(this.epoch);
      return false;
    }
  }

  private scheduleReconnect(epoch: number): void {
    if (this.reconnectTimer || this.stopped || this.opts.driver.locked) return;
    const maxAttempts = this.opts.reconnect?.maxAttempts ?? 5;
    const baseDelayMs = this.opts.reconnect?.baseDelayMs ?? 1000;
    if (this.reconnectAttempts >= maxAttempts) return;
    const delay = baseDelayMs * 2 ** this.reconnectAttempts;
    this.reconnectAttempts++;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const scheduler = this.opts.reconnectTimerScheduler ?? defaultReconnectTimerScheduler;
    this.reconnectTimer = scheduler.set(() => {
      this.reconnectTimer = null;
      if (epoch !== this.epoch || this.stopped) return;
      void sleep(0).then(() => this.enqueueReconcile(this.generation));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private setConnectionState(state: ProviderConnectionState, error: string | null): void {
    this.connectionState = state;
    this.opts.service.setProviderConnection(this.provider, state, error);
  }

  getView(): SubscriptionStateView {
    return {
      selections: this.selections.map((s) => ({ ...s })),
      // Desired (committed) generation — visible immediately after persistence.
      generation: this.generation,
      runtime: {
        // Last generation whose runtime application actually succeeded.
        generation: this.appliedGeneration,
        connectionState: this.connectionState,
        resolutions: this.resolutions.map((r) => ({ ...r })),
        lastError: this.lastError
      }
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // retireDriver invalidates callbacks, cancels any pending reconnect timer
    // and stops the driver; pending operations retain their flags so their
    // settle paths perform final cleanup.
    this.retireDriver();
    this.setConnectionState("NOT_STARTED", null);
  }
}
