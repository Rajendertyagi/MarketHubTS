import type {
  CapabilityResult,
  DriverTerminalFailure,
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
  /** Optional canonical component sink; forwarded to the shared service. */
  onComponentUpdate?(update: import("@markethub/contracts").ComponentUpdate): void;
  /**
   * Optional typed terminal-failure notification. A driver calls this BEFORE
   * reporting the corresponding connection failure so the supervisor can record
   * the limitation reason and capabilities. Terminal failures are never retried.
   */
  onTerminalFailure?(failure: DriverTerminalFailure): void;
}

export interface StreamingDriver {
  /** Locked drivers never construct an SDK, open a socket or schedule retries. */
  readonly locked?: boolean;
  /** The signal is mandatory; implementations must pass it to the underlying operation. */
  start(subscriptions: DriverSubscription[], callbacks: DriverCallbacks, signal: AbortSignal): Promise<void>;
  updateSubscriptions(subscriptions: DriverSubscription[], signal: AbortSignal): Promise<void>;
  /** Must be safely repeatable; the supervisor calls it at most once per instance. */
  stop(): void;
  getConnectionState(): ProviderConnectionState;
}

export class DriverLockedError extends Error {
  constructor(provider: ProviderId = "UPSTOX") {
    super(`Live ${provider} streaming is locked; real driver construction is disabled`);
    this.name = "DriverLockedError";
  }
}

/**
 * Production boundary. Real SDK construction, sockets and retry scheduling are
 * unreachable: every start/update attempt fails safely. Only a separately
 * authorized and independently reviewed Stage G change may unlock real driver
 * construction and connection behavior.
 */
export class LockedProviderDriver implements StreamingDriver {
  readonly locked = true;

  constructor(private readonly provider: ProviderId = "UPSTOX") {}

  getConnectionState(): ProviderConnectionState {
    return "NOT_STARTED";
  }

  async start(
    _subscriptions: DriverSubscription[], _callbacks: DriverCallbacks, _signal: AbortSignal
  ): Promise<void> {
    throw new DriverLockedError(this.provider);
  }

  async updateSubscriptions(_subscriptions: DriverSubscription[], _signal: AbortSignal): Promise<void> {
    throw new DriverLockedError(this.provider);
  }

  stop(): void {
    // No SDK instance, socket or timer exists — nothing to release. Idempotent.
  }
}

/** Backwards-compatible Upstox locked driver used by existing Stage D tests. */
export class LockedUpstoxDriver extends LockedProviderDriver {
  constructor() {
    super("UPSTOX");
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

/** Narrow seam for deterministic timer control in tests. */
export interface ReconnectTimerScheduler {
  set(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clear(handle: ReturnType<typeof setTimeout>): void;
}

const defaultReconnectTimerScheduler: ReconnectTimerScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle)
};

/**
 * Supervisor-owned logical outcome. Only a normal successful settle reports
 * `applied`; every other terminal path reports a distinct non-applied outcome.
 * Queue release never implies successful application.
 */
export type OperationOutcome =
  | { kind: "applied" }
  | { kind: "failed"; error: string }
  | { kind: "timed-out"; error: string }
  | { kind: "callback-retired"; reason: "DISCONNECTED" | "ERROR" }
  | { kind: "shutdown" };

type OperationState = "active" | "aborting" | "settled" | "retired";

interface DriverInstance {
  readonly driver: StreamingDriver;
  readonly locked: boolean;
  readonly epoch: number;
  retired: boolean;
  callbacksEnabled: boolean;
  underlyingSettled: boolean;
  currentOperation: Operation | null;
  /** Generation last successfully applied by this driver; owns callbacks after
   * the operation settles and currentOperation is cleared. */
  lastAppliedGeneration: number | null;
}

/** Identity-bearing reconnect timer record. The token lets a late callback
 * verify it still owns the timer before touching the timer reference. */
interface ReconnectTimerRecord {
  readonly token: symbol;
  readonly generation: number;
  readonly epoch: number;
  readonly handle: ReturnType<typeof setTimeout>;
}

interface Operation {
  readonly kind: "start" | "update";
  /** Desired generation this operation applies; captured so a late driver
   * callback is attributed to its own generation, not a newer one committed
   * while the driver was connecting. */
  readonly generation: number;
  readonly controller: AbortController;
  readonly instance: DriverInstance;
  readonly logicalCompletion: Promise<OperationOutcome>;
  readonly resolveLogical: (outcome: OperationOutcome) => void;
  state: OperationState;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

export interface StreamSupervisorOptions {
  service: MarketDataService;
  subscriptions: SubscriptionRepository;
  catalog: CatalogRepository;
  /** Factory for a fresh driver instance on every acquisition/restart. */
  createDriver: () => StreamingDriver;
  provider?: ProviderId;
  reconnect?: { maxAttempts: number; baseDelayMs: number };
  sleep?: (ms: number) => Promise<void>;
  reconnectTimerScheduler?: ReconnectTimerScheduler;
  /** Timer seam for operation timeouts and bounded quiescence. */
  timerScheduler?: ReconnectTimerScheduler;
  operationTimeoutMs?: number;
  quiescenceMs?: number;
  /** Deterministic jitter source; delay = base * 2^attempt * (0.5 + random()*0.5). */
  random?: () => number;
  /**
   * When true, this supervisor is a provider runtime driven by a shared
   * SubscriptionCoordinator: it does not write the subscription repository and
   * does not track/untrack canonical instruments. Desired state is supplied via
   * applyDesiredState(). Default false preserves the standalone Stage D behavior.
   */
  coordinated?: boolean;
}

export interface ReplaceSubscriptionsResult {
  generation: number;
  view: SubscriptionStateView;
}

/**
 * Owns desired-subscription reconciliation and runtime streaming state. Kept
 * separate from ProviderRegistry (auth/status only). Writes runtime connection
 * state through the canonical MarketDataService.
 *
 * Every driver instance is terminal: once retired it is never restarted or
 * reused. Every start acquires a fresh factory-created instance, including
 * ordinary disconnects, errors and failed start/update operations.
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
  private currentInstance: DriverInstance | null = null;
  private lockedDriver = false;
  private readonly operations = new Set<Operation>();
  private readonly quiescenceWaiters = new Set<(force: boolean) => void>();
  /** Number of queued/in-flight reconciliations; guards duplicate enqueues. */
  private pendingReconciles = 0;
  /** Epoch of the active driver instance; incremented on every retirement. */
  private epoch = 0;
  private stopped = false;
  private reconnectTimer: ReconnectTimerRecord | null = null;
  private reconnectAttempts = 0;
  private lastOutcome: OperationOutcome | null = null;
  /** Typed terminal failure (e.g. LIMITED) captured before the connection failure callback. */
  private terminalFailure: DriverTerminalFailure | null = null;
  /** Desired generation that hit a terminal failure; reconciliation for it is blocked. */
  private limitedGeneration: number | null = null;
  /** Capability results from the terminal failure, retained across driver retirement. */
  private capabilities: CapabilityResult[] = [];

  constructor(private readonly opts: StreamSupervisorOptions) {
    this.provider = opts.provider ?? "UPSTOX";
  }

  /** Diagnostic seam: the most recently resolved logical operation outcome. */
  getLastOperationOutcome(): OperationOutcome | null {
    return this.lastOutcome;
  }

  /** Diagnostic seam: generation currently marked terminal, if any. */
  getLimitedGeneration(): number | null {
    return this.limitedGeneration;
  }

  /** Load persisted desired state and reconcile once at startup. */
  async start(): Promise<void> {
    if (this.opts.coordinated) {
      // The coordinator owns desired state and calls applyDesiredState().
      return;
    }
    const state = await this.opts.subscriptions.load();
    this.generation = state.generation;
    this.selections = state.selections.map((s) => ({ ...s }));
    await this.enqueueReconcile(state.generation);
  }

  /**
   * Coordinator-driven desired-state application. The runtime reconciles the
   * supplied generation without writing shared persistence or shared tracking.
   */
  async applyDesiredState(selections: SubscriptionSelection[], generation: number): Promise<void> {
    if (!this.opts.coordinated) {
      throw new Error("applyDesiredState requires a coordinated provider runtime");
    }
    if (this.stopped) return;
    // A genuinely newer desired generation invalidates any retry timer owned
    // by an older generation before the new reconciliation is queued.
    if (generation > this.generation) this.cancelReconnectTimer();
    this.generation = generation;
    this.selections = selections.map((s) => ({ ...s }));
    await this.enqueueReconcile(generation);
  }

  /**
   * Validate, persist transactionally, then reconcile. Validation and
   * persistence failures are typed so the transport can classify them; a
   * post-commit reconciliation failure is captured in runtime status and never
   * misrepresented as an invalid request.
   */
  async replaceSubscriptions(selections: SubscriptionSelection[]): Promise<ReplaceSubscriptionsResult> {
    if (this.opts.coordinated) {
      throw new SubscriptionValidationError("Coordinated runtimes cannot write shared desired state; use SubscriptionCoordinator");
    }
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
        // Re-check the terminal guard at RUN time, not only at enqueue time: a
        // terminal failure may have landed after this reconcile was queued.
        // Block the exact generation that hit the limit; clear stale limitation
        // info for a genuinely newer generation so it gets a fresh attempt.
        if (this.limitedGeneration === state.generation) return;
        if (this.limitedGeneration !== null && this.limitedGeneration !== state.generation) {
          this.clearLimitationState();
        }
        const applied = await this.applySelections(state.selections, state.generation);
        if (applied && state.generation > this.appliedGeneration) {
          this.appliedGeneration = state.generation;
        }
      } catch (error) {
        this.lastError = errorMessage(error);
      }
    };
    this.pendingReconciles++;
    const queued = this.queue.then(run, run);
    this.queue = queued.then(
      () => { this.pendingReconciles--; },
      () => { this.pendingReconciles--; }
    );
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
        resolutions.push({
          canonicalId: selection.canonicalId, enabled: true, available: true, reason: null
        });
        driverSubscriptions.push({ canonicalId: selection.canonicalId, nativeIdentifier: active.nativeIdentifier });
      } else {
        resolutions.push({
          canonicalId: selection.canonicalId, enabled: true, available: false,
          reason: `NO_ACTIVE_${this.provider}_MAPPING`
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
    // In coordinated mode the SubscriptionCoordinator is the sole owner of
    // shared track/untrack decisions; runtimes never modify shared tracking.
    if (!this.opts.coordinated) {
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
    }

    // Empty desired set / no eligible mappings: retire any current driver and
    // invalidate its callbacks, then report NOT_STARTED.
    if (driverSubscriptions.length === 0) {
      if (this.currentInstance) this.retireInstance(this.currentInstance, "no-subscriptions");
      this.setConnectionState("NOT_STARTED", null);
      return true;
    }

    // A retired/disconnected driver must be replaced with a fresh start, never
    // updated in place (a disconnected adapter's update does not reconnect).
    if (!this.currentInstance || this.currentInstance.retired || !this.driverStarted) {
      return await this.startDriver(driverSubscriptions, generation);
    }
    return await this.updateDriver(driverSubscriptions, generation);
  }

  /** Acquire a fresh driver instance from the factory. */
  private acquireInstance(): DriverInstance {
    const driver = this.opts.createDriver();
    const instance: DriverInstance = {
      driver,
      locked: driver.locked === true,
      epoch: this.epoch,
      retired: false,
      callbacksEnabled: true,
      underlyingSettled: false,
      currentOperation: null,
      lastAppliedGeneration: null
    };
    this.currentInstance = instance;
    this.lockedDriver = instance.locked;
    this.driverStarted = false;
    return instance;
  }

  /** Begin a supervisor-owned logical operation on an instance. */
  private beginOperation(instance: DriverInstance, kind: "start" | "update", generation: number): Operation {
    const controller = new AbortController();
    let resolveLogical!: (outcome: OperationOutcome) => void;
    const logicalCompletion = new Promise<OperationOutcome>((resolve) => { resolveLogical = resolve; });
    const op: Operation = {
      kind,
      generation,
      controller,
      instance,
      logicalCompletion,
      resolveLogical,
      state: "active",
      timeoutHandle: null
    };
    instance.currentOperation = op;
    this.operations.add(op);
    return op;
  }

  /** Resolve an operation's logical completion exactly once. */
  private resolveOperation(op: Operation, outcome: OperationOutcome): void {
    this.clearOperationTimeout(op);
    op.state = outcome.kind === "applied" ? "settled" : "retired";
    // Record ownership BEFORE clearing currentOperation so post-settlement
    // callbacks can still be attributed to the generation this driver applied.
    if (outcome.kind === "applied") op.instance.lastAppliedGeneration = op.generation;
    op.instance.currentOperation = null;
    this.operations.delete(op);
    this.lastOutcome = outcome;
    op.resolveLogical(outcome);
  }

  private clearOperationTimeout(op: Operation): void {
    if (op.timeoutHandle) {
      this.timer.clear(op.timeoutHandle);
      op.timeoutHandle = null;
    }
  }

  private get timer(): ReconnectTimerScheduler {
    return this.opts.timerScheduler ?? defaultReconnectTimerScheduler;
  }

  private armOperationTimeout(op: Operation): void {
    const ms = this.opts.operationTimeoutMs ?? 5000;
    op.timeoutHandle = this.timer.set(() => { void this.onOperationTimeout(op); }, ms);
  }

  /**
   * Attach consumers to the raw driver promise. While active, a settle performs
   * normal handling; while aborting, it only records settlement and wakes the
   * quiescence waiter; after retirement it is fully inert. Late settle/reject
   * is always consumed so there is no unhandled rejection.
   */
  private attachSettlement(op: Operation, raw: Promise<void>): void {
    const settle = (kind: "resolve" | "reject", error?: unknown) => {
      op.instance.underlyingSettled = true;
      if (op.state === "active") {
        this.clearOperationTimeout(op);
        if (kind === "resolve") {
          this.driverStarted = true;
          this.lastError = null;
          this.resolveOperation(op, { kind: "applied" });
        } else {
          const message = errorMessage(error);
          this.recordError(message);
          this.setConnectionState("ERROR", this.lastError ?? message);
          this.retireInstance(op.instance, "failed");
          this.resolveOperation(op, { kind: "failed", error: this.lastError ?? message });
          this.scheduleGenerationRetry(op.generation, message);
        }
      } else if (op.state === "aborting") {
        this.wakeQuiescence();
      }
      // settled/retired: inert.
    };
    raw.then(() => settle("resolve"), (error) => settle("reject", error));
  }

  /** Await bounded quiescence on the underlying driver promise. */
  private awaitQuiescence(op: Operation): Promise<void> {
    if (op.instance.underlyingSettled) return Promise.resolve();
    const ms = this.opts.quiescenceMs ?? 1000;
    return new Promise<void>((resolve) => {
      let done = false;
      let handle: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (handle) this.timer.clear(handle);
        this.quiescenceWaiters.delete(onSettled);
        resolve();
      };
      const onSettled = (force: boolean) => { if (force || op.instance.underlyingSettled) finish(); };
      this.quiescenceWaiters.add(onSettled);
      handle = this.timer.set(() => finish(), ms);
    });
  }

  /** Wake quiescence waiters on underlying settlement. */
  private wakeQuiescence(): void {
    for (const wake of [...this.quiescenceWaiters]) wake(false);
  }

  /** Force-wake all quiescence waiters on shutdown, regardless of settlement. */
  private forceWakeQuiescence(): void {
    for (const wake of [...this.quiescenceWaiters]) wake(true);
  }

  /**
   * The single idempotent retirement owner. The only code that calls
   * instance.stop(); at most once per instance. Returns true if this caller
   * owned the retirement.
   */
  private retireInstance(instance: DriverInstance, reason: string): boolean {
    if (instance.retired) return false;
    instance.retired = true;
    instance.callbacksEnabled = false;
    this.epoch++;
    this.cancelReconnectTimer();
    if (this.currentInstance === instance) {
      this.currentInstance = null;
      this.driverStarted = false;
    }
    try { instance.driver.stop(); } catch { /* retirement must not throw */ }
    return true;
  }

  /** Timeout lifecycle owner: retire, stop once, resolve timed-out, own retry. */
  private async onOperationTimeout(op: Operation): Promise<void> {
    if (op.state !== "active") return; // single-flight
    op.state = "aborting";
    op.instance.callbacksEnabled = false; // synchronous, before abort
    const error = `operation timed out after ${this.opts.operationTimeoutMs ?? 5000}ms`;
    this.recordError(error);
    this.setConnectionState("ERROR", this.lastError ?? error);
    try { op.controller.abort(); } catch { /* abort must not throw */ }
    await this.awaitQuiescence(op);
    // Shutdown may have resolved this op with `shutdown` while quiescing.
    if (op.state !== "aborting" || this.stopped) return;
    this.retireInstance(op.instance, "timeout");
    this.resolveOperation(op, { kind: "timed-out", error });
    this.scheduleGenerationRetry(op.generation, error);
  }

  /** Callback lifecycle owner for a DISCONNECTED/ERROR during a pending op. */
  private async retireFromCallback(
    instance: DriverInstance, op: Operation, cause: string, reason: "DISCONNECTED" | "ERROR"
  ): Promise<void> {
    instance.callbacksEnabled = false; // synchronous, before abort
    op.state = "aborting";
    try { op.controller.abort(); } catch { /* abort must not throw */ }
    this.clearOperationTimeout(op);
    await this.awaitQuiescence(op);
    // Shutdown may have resolved this op with `shutdown` while quiescing.
    if (op.state !== "aborting" || this.stopped) return;
    this.retireInstance(instance, `callback:${reason.toLowerCase()}`);
    this.resolveOperation(op, { kind: "callback-retired", reason });
    this.scheduleGenerationRetry(op.generation, cause);
  }

  /**
   * Generation that owns a driver's callback: the active operation's generation
   * while one exists, otherwise the generation this driver last applied. Never
   * falls back to mutable this.generation — a stale driver must not be treated
   * as belonging to a newer desired generation.
   */
  private instanceGeneration(instance: DriverInstance): number | null {
    return instance.currentOperation?.generation ?? instance.lastAppliedGeneration;
  }

  /**
   * Record a failure message. When a typed terminal failure is active for the
   * current generation, its reason is authoritative and must not be overwritten
   * by the paired connection-failure callback or promise rejection.
   */
  private recordError(message: string): void {
    if (this.terminalFailure !== null && this.limitedGeneration === this.generation) {
      this.lastError = this.terminalFailure.reason;
      return;
    }
    this.lastError = message;
  }

  /** True when the current generation is terminally blocked (e.g. LIMITED). */
  private isCurrentGenerationTerminal(): boolean {
    return this.terminalFailure !== null && this.limitedGeneration === this.generation;
  }

  /** Clear stale limitation info when a genuinely new generation is attempted. */
  private clearLimitationState(): void {
    this.terminalFailure = null;
    this.limitedGeneration = null;
    this.capabilities = [];
  }

  /** Build the callback set for an instance, gated by instance and epoch. */
  private makeCallbacks(instance: DriverInstance): DriverCallbacks {
    const epoch = instance.epoch;
    return {
      onObservation: (input) => {
        if (!instance.callbacksEnabled || this.stopped || epoch !== this.epoch) return;
        try {
          this.opts.service.applyProviderUpdate(input);
        } catch {
          // Late or invalid observations must not corrupt shared state.
        }
      },
      onComponentUpdate: (update) => {
        if (!instance.callbacksEnabled || this.stopped || epoch !== this.epoch) return;
        try {
          this.opts.service.applyComponentUpdate(update);
        } catch {
          // Late or invalid component updates must not corrupt shared state.
        }
      },
      onTerminalFailure: (failure) => {
        if (!instance.callbacksEnabled || this.stopped || epoch !== this.epoch) return;
        // Attribute to the owning operation, or to the generation this driver
        // last applied once its operation has settled. Never fall back to the
        // mutable this.generation: a stale driver's limit must not mark a newer
        // desired generation terminal or attach stale capabilities to it.
        const generation = this.instanceGeneration(instance);
        if (generation === null) return; // no valid owner: do not attribute
        // Capture the typed terminal failure and its capability results. This is
        // recorded BEFORE the paired connection-failure callback, so recordError
        // preserves this reason. It does NOT retire or resolve anything: the
        // existing connection-failure / promise-rejection paths own that, once.
        this.terminalFailure = failure;
        this.limitedGeneration = generation;
        this.capabilities = failure.capabilities.map((c) => ({ ...c }));
        this.lastError = failure.reason;
      },
      onConnectionState: (state, error) => {
        if (!instance.callbacksEnabled || this.stopped || epoch !== this.epoch) return;
        try {
          if (state === "STREAMING") {
            // A confirmed stream supersedes any reconnect timer left over from
            // an earlier retired instance; otherwise that stale timer could
            // fire a redundant reconciliation against the healthy instance.
            this.cancelReconnectTimer();
            this.setConnectionState("STREAMING", null);
            this.reconnectAttempts = 0; // reset only on confirmed STREAMING
            return;
          }
          if (state === "DISCONNECTED" || state === "ERROR") {
            const cause = state === "ERROR"
              ? (error ?? "provider error")
              : (error ?? "provider disconnected");
            if (state === "ERROR") this.recordError(cause);
            // Keep the connection state honest (ERROR) even for a terminal
            // limitation; only the reason/capabilities are structured.
            this.setConnectionState(state, state === "ERROR" ? (this.lastError ?? cause) : (error ?? null));
            const op = instance.currentOperation;
            if (op && op.state === "active") {
              void this.retireFromCallback(instance, op, cause, state);
            } else {
              // No active operation: attribute to the generation this driver
              // owns (its last applied generation), never to mutable this.generation.
              const generation = this.instanceGeneration(instance);
              this.retireInstance(instance, `callback:${state.toLowerCase()}`);
              if (generation === this.generation) {
                this.scheduleGenerationRetry(generation, cause);
              } else if (generation !== null && this.pendingReconciles === 0) {
                // Stale driver failure: do not schedule a generation-attributed
                // retry for the newer desired generation. Its own reconciliation
                // owns recovery; only when none is queued/in-flight, trigger it
                // directly (serialized, no new timer) so a failed earlier
                // reconciliation can still recover without a duplicate.
                this.enqueueReconcile(this.generation);
              }
            }
            return;
          }
          this.setConnectionState(state, error ?? null);
        } catch {
          // Callback failures are isolated from the driver and the service.
        }
      }
    };
  }

  /** Returns true only when the driver start completed for the current epoch. */
  private async startDriver(subscriptions: DriverSubscription[], generation: number): Promise<boolean> {
    let instance: DriverInstance;
    try {
      instance = this.acquireInstance();
    } catch (error) {
      // Factory failure: no instance acquired, never classified as locked.
      this.lockedDriver = false;
      this.lastError = `driver factory failed: ${errorMessage(error)}`;
      this.setConnectionState("ERROR", this.lastError);
      this.scheduleGenerationRetry(generation, this.lastError);
      return false;
    }

    const op = this.beginOperation(instance, "start", generation);
    this.setConnectionState("CONNECTING", null);
    let raw: Promise<void>;
    try {
      raw = instance.driver.start(subscriptions, this.makeCallbacks(instance), op.controller.signal);
    } catch (error) {
      const message = errorMessage(error);
      this.recordError(message);
      this.setConnectionState("ERROR", this.lastError ?? message);
      this.retireInstance(instance, "failed");
      this.resolveOperation(op, { kind: "failed", error: this.lastError ?? message });
      this.scheduleGenerationRetry(generation, message);
      return false;
    }
    this.attachSettlement(op, raw);
    this.armOperationTimeout(op);
    return await op.logicalCompletion.then((outcome) => outcome.kind === "applied");
  }

  /** Returns true only when the driver update completed for the current epoch. */
  private async updateDriver(subscriptions: DriverSubscription[], generation: number): Promise<boolean> {
    const instance = this.currentInstance!;
    const op = this.beginOperation(instance, "update", generation);
    let raw: Promise<void>;
    try {
      raw = instance.driver.updateSubscriptions(subscriptions, op.controller.signal);
    } catch (error) {
      const message = errorMessage(error);
      this.recordError(message);
      this.setConnectionState("ERROR", this.lastError ?? message);
      this.retireInstance(instance, "failed");
      this.resolveOperation(op, { kind: "failed", error: this.lastError ?? message });
      this.scheduleGenerationRetry(generation, message);
      return false;
    }
    this.attachSettlement(op, raw);
    this.armOperationTimeout(op);
    return await op.logicalCompletion.then((outcome) => outcome.kind === "applied");
  }

  /** Cancel a pending reconnect timer so it cannot suppress a newer retry. */
  private cancelReconnectTimer(): void {
    const record = this.reconnectTimer;
    if (!record) return;
    // Invalidate synchronously BEFORE clearing so a late callback sees it no
    // longer owns the timer and cannot clear/suppress a newer one.
    this.reconnectTimer = null;
    (this.opts.reconnectTimerScheduler ?? defaultReconnectTimerScheduler).clear(record.handle);
  }

  /**
   * Schedule a retry only for a failure belonging to the current desired
   * generation. A stale operation's failure must not schedule a retry: the
   * newer generation's queued reconciliation owns recovery, and a retry could
   * otherwise acquire a second driver while the newer start is still pending
   * (driverStarted stays false until the driver confirms start).
   */
  private scheduleGenerationRetry(generation: number | null, cause: string): void {
    if (generation === null) return; // no owning generation: no retry
    if (generation !== this.generation) return;
    if (this.isCurrentGenerationTerminal()) return;
    this.scheduleReconnect(generation, this.epoch, cause);
  }

  private scheduleReconnect(generation: number, epoch: number, cause: string): void {
    // Terminal failures (e.g. LIMITED) are non-retryable: never schedule an
    // automatic reconnect for a generation blocked by a typed terminal failure.
    if (this.isCurrentGenerationTerminal()) return;
    if (this.reconnectTimer || this.stopped || this.lockedDriver) return;
    const maxAttempts = this.opts.reconnect?.maxAttempts ?? 5;
    const baseDelayMs = this.opts.reconnect?.baseDelayMs ?? 1000;
    if (this.reconnectAttempts >= maxAttempts) {
      // Explicit exhaustion: the previous silent return left state unchanged.
      const message = `retry budget exhausted after ${maxAttempts} attempts: ${cause}`;
      this.lastError = message;
      this.setConnectionState("ERROR", message);
      return;
    }
    const jitter = 0.5 + (this.opts.random?.() ?? 0.5) * 0.5;
    const delay = baseDelayMs * 2 ** this.reconnectAttempts * jitter;
    this.reconnectAttempts++;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const scheduler = this.opts.reconnectTimerScheduler ?? defaultReconnectTimerScheduler;
    const token = Symbol("reconnect");
    const fire = (): void => {
      // A cancelled/late callback must not clear or suppress a newer timer.
      const current = this.reconnectTimer;
      if (!current || current.token !== token) return;
      if (this.stopped || generation !== this.generation || epoch !== this.epoch || this.isCurrentGenerationTerminal()) {
        this.reconnectTimer = null; // consume only the timer we still own
        return;
      }
      this.reconnectTimer = null; // consume before the async delay
      void sleep(0).then(() => {
        // Repeat every relevant check after the delay, and never enqueue for a
        // generation other than the one captured when this timer was scheduled.
        if (this.stopped) return;
        if (generation !== this.generation || epoch !== this.epoch) return;
        if (this.isCurrentGenerationTerminal()) return;
        if (this.reconnectTimer !== null) return; // a newer timer owns recovery
        // A driver that confirmed STREAMING during the delay already recovered;
        // do not enqueue a redundant reconcile against the healthy instance.
        if (this.driverStarted && this.currentInstance && !this.currentInstance.retired) return;
        this.enqueueReconcile(generation);
      });
    };
    const handle = scheduler.set(fire, delay);
    this.reconnectTimer = { token, generation, epoch, handle };
    handle.unref?.();
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
        lastError: this.lastError,
        // Structured capability results (e.g. FYERS LIMITED) survive retirement,
        // but only belong to the view while their owning generation is current.
        ...(this.capabilities.length > 0 && this.limitedGeneration === this.generation
          ? { capabilities: this.capabilities.map((c) => ({ ...c })) } : {})
      }
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const op of [...this.operations]) {
      if (op.state !== "active" && op.state !== "aborting") continue;
      op.instance.callbacksEnabled = false; // synchronous, before abort
      if (op.state === "active") {
        op.state = "aborting";
        try { op.controller.abort(); } catch { /* abort must not throw */ }
      }
      // Resolve every outstanding logical completion (including ops already
      // quiescing from a timeout/callback) so the serialized queue is released.
      this.resolveOperation(op, { kind: "shutdown" });
    }
    this.forceWakeQuiescence();
    this.cancelReconnectTimer();
    if (this.currentInstance) this.retireInstance(this.currentInstance, "shutdown");
    this.setConnectionState("NOT_STARTED", null);
  }
}
