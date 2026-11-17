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
    // No SDK instance, socket or timer exists — nothing to release.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface StreamSupervisorOptions {
  service: MarketDataService;
  subscriptions: SubscriptionRepository;
  catalog: CatalogRepository;
  driver: StreamingDriver;
  provider?: ProviderId;
  reconnect?: { maxAttempts: number; baseDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
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
  private generation = 0;
  private selections: SubscriptionSelection[] = [];
  private resolutions: SubscriptionResolution[] = [];
  private connectionState: ProviderConnectionState = "NOT_STARTED";
  private lastError: string | null = null;
  private driverStarted = false;
  private epoch = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(private readonly opts: StreamSupervisorOptions) {
    this.provider = opts.provider ?? "UPSTOX";
  }

  /** Load persisted desired state and reconcile once at startup. */
  async start(): Promise<void> {
    await this.enqueueReconcile();
  }

  /** Validate, persist transactionally, then reconcile against the latest committed generation. */
  async replaceSubscriptions(selections: SubscriptionSelection[]): Promise<ReplaceSubscriptionsResult> {
    if (this.stopped) throw new Error("Stream supervisor is stopped");
    const seen = new Set<string>();
    for (const selection of selections) {
      if (seen.has(selection.canonicalId)) {
        throw new Error(`Duplicate canonical id: ${selection.canonicalId}`);
      }
      seen.add(selection.canonicalId);
      const instrument = await this.opts.catalog.getInstrumentByCanonicalId(selection.canonicalId);
      if (!instrument) {
        throw new Error(`Unknown canonical id: ${selection.canonicalId}`);
      }
    }

    const committed = await this.opts.subscriptions.replace(selections);
    await this.enqueueReconcile();
    return { generation: committed, view: this.getView() };
  }

  private enqueueReconcile(): Promise<void> {
    const run = async () => {
      if (this.stopped) return;
      const state = await this.opts.subscriptions.load();
      // An older reconciliation must never overwrite newer desired state.
      if (state.generation < this.generation) return;
      this.generation = state.generation;
      await this.applySelections(state.selections);
    };
    const queued = this.queue.then(run, run);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async applySelections(selections: SubscriptionSelection[]): Promise<void> {
    if (this.stopped) return;
    this.selections = selections.map((s) => ({ ...s }));
    const enabled = selections.filter((s) => s.enabled);
    const desiredIds = new Set(enabled.map((s) => s.canonicalId));

    // Canonical service tracks every enabled desired selection, even when its
    // provider mapping is unavailable (never fabricate a provider identifier).
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

    const resolutions: SubscriptionResolution[] = [];
    const driverSubscriptions: DriverSubscription[] = [];
    for (const selection of enabled) {
      const mappings = await this.opts.catalog.listMappingsByCanonicalId(selection.canonicalId);
      const active = mappings.find((m) => m.provider === this.provider && m.status === "ACTIVE");
      if (active) {
        resolutions.push({
          canonicalId: selection.canonicalId, enabled: true, available: true,
          nativeIdentifier: active.nativeIdentifier, reason: null
        });
        driverSubscriptions.push({ canonicalId: selection.canonicalId, nativeIdentifier: active.nativeIdentifier });
      } else {
        resolutions.push({
          canonicalId: selection.canonicalId, enabled: true, available: false,
          nativeIdentifier: null, reason: "NO_ACTIVE_UPSTOX_MAPPING"
        });
      }
    }
    for (const selection of selections.filter((s) => !s.enabled)) {
      resolutions.push({
        canonicalId: selection.canonicalId, enabled: false, available: false,
        nativeIdentifier: null, reason: "DISABLED"
      });
    }
    this.resolutions = resolutions;

    // Empty desired set is valid: stop any stream and report NOT_STARTED.
    if (driverSubscriptions.length === 0) {
      if (this.driverStarted) {
        this.opts.driver.stop();
        this.driverStarted = false;
      }
      this.setConnectionState("NOT_STARTED", null);
      return;
    }

    if (!this.driverStarted) {
      await this.startDriver(driverSubscriptions);
    } else {
      try {
        await this.opts.driver.updateSubscriptions(driverSubscriptions);
      } catch (error) {
        this.lastError = errorMessage(error);
        this.setConnectionState("ERROR", this.lastError);
        this.opts.driver.stop();
        this.driverStarted = false;
        if (!this.opts.driver.locked) this.scheduleReconnect(this.epoch);
      }
    }
  }

  private async startDriver(subscriptions: DriverSubscription[]): Promise<void> {
    const epoch = ++this.epoch;
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
              this.scheduleReconnect(epoch);
            }
          } catch {
            // Callback failures are isolated from the driver and the service.
          }
        }
      });
      if (epoch !== this.epoch || this.stopped) return;
      this.driverStarted = true;
      this.lastError = null;
    } catch (error) {
      if (epoch !== this.epoch || this.stopped) return;
      this.lastError = errorMessage(error);
      this.setConnectionState("ERROR", this.lastError);
      this.driverStarted = false;
      // Locked drivers never schedule connection retries.
      if (!this.opts.driver.locked) this.scheduleReconnect(epoch);
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (epoch !== this.epoch || this.stopped) return;
      void sleep(0).then(() => this.enqueueReconcile());
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
      generation: this.generation,
      runtime: {
        generation: this.generation,
        connectionState: this.connectionState,
        resolutions: this.resolutions.map((r) => ({ ...r })),
        lastError: this.lastError
      }
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.epoch++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.driverStarted) {
      this.opts.driver.stop();
      this.driverStarted = false;
    }
    this.setConnectionState("NOT_STARTED", null);
  }
}
