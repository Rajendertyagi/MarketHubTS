import { describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtemp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalInstrumentSchema, providerInstrumentMappingSchema,
  type FreshnessPolicy, type NormalizeObservationInput
} from "../../packages/contracts/src/index";
import { openDatabase, runMigrations, defaultMigrationsFolder, SqliteCatalogRepository, SqliteSubscriptionRepository } from "../../packages/database/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import {
  DriverLockedError, LockedUpstoxDriver, StreamSupervisor,
  type DriverCallbacks, type DriverSubscription, type OperationOutcome,
  type ReconnectTimerScheduler, type StreamingDriver
} from "../../apps/api/src/stream-supervisor";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const B = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";
const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000
};
const flush = async () => { await Bun.sleep(0); };

/** Manual timer scheduler: timers fire only when the test fires them. */
class ManualTimer implements ReconnectTimerScheduler {
  tasks: Array<{ handle: number; fn: () => void; ms: number; cancelled: boolean }> = [];
  private next = 1;
  set(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = this.next++;
    this.tasks.push({ handle, fn, ms, cancelled: false });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }
  clear(handle: ReturnType<typeof setTimeout>): void {
    const t = this.tasks.find((x) => x.handle === (handle as unknown as number));
    if (t) t.cancelled = true;
  }
  fire(handle: ReturnType<typeof setTimeout>): void {
    const t = this.tasks.find((x) => x.handle === (handle as unknown as number));
    if (t && !t.cancelled) t.fn();
  }
  get active() { return this.tasks.filter((t) => !t.cancelled); }
  get last() { return this.tasks[this.tasks.length - 1]; }
}

type Settle = (kind: "resolve" | "reject", error?: Error) => void;

/**
 * Driver whose start/update stay pending until explicitly settled. By default
 * it settles on abort (well-behaved); settleOnAbort=false models a stubborn
 * promise that remains pending until the test settles it.
 */
class DeferredDriver implements StreamingDriver {
  starts: DriverSubscription[][] = [];
  updates: DriverSubscription[][] = [];
  startSignals: AbortSignal[] = [];
  updateSignals: AbortSignal[] = [];
  stopCount = 0;
  callbacks: DriverCallbacks | null = null;
  callbackHistory: DriverCallbacks[] = [];
  state = "NOT_STARTED";
  locked = false;
  settleOnAbort = true;
  autoResolveStart = false;
  autoResolveUpdate = false;

  private startCalled = false;
  private updateCalled = false;
  private startWaiters: Array<() => void> = [];
  private updateWaiters: Array<() => void> = [];
  private startSettle: Settle | null = null;
  private updateSettle: Settle | null = null;

  async start(subs: DriverSubscription[], callbacks: DriverCallbacks, signal: AbortSignal): Promise<void> {
    this.starts.push(subs.map((s) => ({ ...s })));
    this.callbacks = callbacks;
    this.callbackHistory.push(callbacks);
    this.startSignals.push(signal);
    this.startCalled = true;
    for (const wake of this.startWaiters.splice(0)) wake();
    if (this.autoResolveStart) return;
    await new Promise<void>((resolve, reject) => {
      this.startSettle = (kind, error) => kind === "resolve" ? resolve() : reject(error ?? new Error("start failed"));
      if (this.settleOnAbort) signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async updateSubscriptions(subs: DriverSubscription[], signal: AbortSignal): Promise<void> {
    this.updates.push(subs.map((s) => ({ ...s })));
    this.updateSignals.push(signal);
    this.updateCalled = true;
    for (const wake of this.updateWaiters.splice(0)) wake();
    if (this.autoResolveUpdate) return;
    await new Promise<void>((resolve, reject) => {
      this.updateSettle = (kind, error) => kind === "resolve" ? resolve() : reject(error ?? new Error("update failed"));
      if (this.settleOnAbort) signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  stop(): void { this.stopCount++; this.state = "DISCONNECTED"; }
  getConnectionState() { return this.state; }
  waitForStart(): Promise<void> {
    if (this.startCalled) return Promise.resolve();
    return new Promise((resolve) => this.startWaiters.push(resolve));
  }
  waitForUpdate(): Promise<void> {
    if (this.updateCalled) return Promise.resolve();
    return new Promise((resolve) => this.updateWaiters.push(resolve));
  }
  resolveStart(): void { this.startSettle?.("resolve"); }
  rejectStart(e = new Error("start failed")): void { this.startSettle?.("reject", e); }
  resolveUpdate(): void { this.updateSettle?.("resolve"); }
  rejectUpdate(e = new Error("update failed")): void { this.updateSettle?.("reject", e); }
  emitState(state: any, error?: string): void { this.state = state; this.callbacks?.onConnectionState(state, error); }
  emitObservation(input: NormalizeObservationInput): void { this.callbacks?.onObservation(input); }
}

function observation(canonicalId: string, ltp: number): NormalizeObservationInput {
  return {
    provider: "UPSTOX", canonicalId, value: { ltp },
    rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time", receivedAtMs: BASE
  };
}

interface HarnessOptions {
  createDriver?: () => StreamingDriver;
  maxAttempts?: number;
  baseDelayMs?: number;
  operationTimeoutMs?: number;
  quiescenceMs?: number;
  random?: () => number;
}

function harness(opts: HarnessOptions = {}) {
  const dir = mkdtemp(join(tmpdir(), "markethub-stagef-"));
  const handle = openDatabase({ dbPath: join(dir, "sup.sqlite") });
  runMigrations(handle.db, defaultMigrationsFolder);
  const catalog = new SqliteCatalogRepository(handle.db, handle.sqlite);
  const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
  const service = new MarketDataService({
    now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
  });
  const timer = new ManualTimer();
  const reconnectTimer = new ManualTimer();
  const instances: DeferredDriver[] = [];
  const instanceWaiters: Array<() => void> = [];
  const trackedCreate = () => {
    const d = opts.createDriver ? (opts.createDriver() as DeferredDriver) : new DeferredDriver();
    instances.push(d);
    for (const wake of instanceWaiters.splice(0)) wake();
    return d;
  };
  const supervisor = new StreamSupervisor({
    service, subscriptions, catalog,
    createDriver: trackedCreate,
    reconnect: { maxAttempts: opts.maxAttempts ?? 5, baseDelayMs: opts.baseDelayMs ?? 1000 },
    operationTimeoutMs: opts.operationTimeoutMs ?? 5000,
    quiescenceMs: opts.quiescenceMs ?? 1000,
    timerScheduler: timer,
    reconnectTimerScheduler: reconnectTimer,
    random: opts.random ?? (() => 0.5),
    sleep: async () => {}
  });
  const seed = async (canonicalId: string, nativeIdentifier: string) => {
    await catalog.transaction(async (tx) => {
      await tx.upsertInstrument(canonicalInstrumentSchema.parse({
        canonicalId, identityKey: `key:${canonicalId}`, exchange: "NSE", segment: "INDEX",
        marketType: "INDEX", instrumentCategory: "INDEX", canonicalSymbol: canonicalId, displayName: canonicalId
      }));
      await tx.upsertMapping(providerInstrumentMappingSchema.parse({
        provider: "UPSTOX", nativeIdentifier, canonicalId, status: "ACTIVE"
      }));
    });
  };
  const waitForInstance = async (n: number): Promise<DeferredDriver> => {
    while (instances.length <= n) await new Promise<void>((resolve) => instanceWaiters.push(resolve));
    return instances[n]!;
  };
  const cleanup = () => {
    supervisor.stop();
    closeDatabaseHandle(handle);
    removeTempDir(dir);
  };
  return { subscriptions, service, supervisor, timer, reconnectTimer, seed, instances, waitForInstance, cleanup };
}

/** Seed A and start the supervisor with a deferred start left pending. */
async function startPending(h: ReturnType<typeof harness>) {
  await h.seed(A, "key-A");
  await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
  const p = h.supervisor.start();
  const driver = await h.waitForInstance(0);
  await driver.waitForStart();
  return { p, driver };
}

describe("Stage F — mandatory signal and fresh-instance factory", () => {
  test("start and update receive an AbortSignal", async () => {
    const driver = new DeferredDriver();
    driver.autoResolveStart = true;
    driver.autoResolveUpdate = true;
    const h = harness({ createDriver: () => driver });
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    expect(driver.startSignals.length).toBe(1);
    expect(driver.startSignals[0]).toBeInstanceOf(AbortSignal);
    await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }]);
    expect(driver.updateSignals.length).toBe(1);
    expect(driver.updateSignals[0]).toBeInstanceOf(AbortSignal);
    h.cleanup();
  });

  test("every restart after a disconnect uses a fresh instance", async () => {
    const h = harness({
      createDriver: () => { const d = new DeferredDriver(); d.autoResolveStart = true; return d; },
      maxAttempts: 3, baseDelayMs: 1
    });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    expect(h.instances.length).toBe(1);
    h.instances[0]!.emitState("DISCONNECTED");
    expect(h.instances[0]!.stopCount).toBe(1);
    // Fire the reconnect timer to trigger a fresh start.
    const t = h.reconnectTimer.last!;
    h.reconnectTimer.fire(t.handle as unknown as ReturnType<typeof setTimeout>);
    await flush();
    expect(h.instances.length).toBe(2);
    expect(h.instances[1]!.starts.length).toBe(1);
    expect(h.instances[0]!.starts.length).toBe(1); // old instance never reused
    h.cleanup();
  });

  test("failed start retires its instance and retries with a fresh one", async () => {
    const h = harness({
      createDriver: () => { const d = new DeferredDriver(); d.autoResolveStart = false; return d; },
      maxAttempts: 2, baseDelayMs: 1
    });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    const p = h.supervisor.start();
    const first = await h.waitForInstance(0);
    await first.waitForStart();
    first.rejectStart(new Error("boom"));
    await p;
    expect(first.stopCount).toBe(1);
    expect(h.supervisor.getLastOperationOutcome()).toMatchObject({ kind: "failed" });
    const t = h.reconnectTimer.last!;
    h.reconnectTimer.fire(t.handle as unknown as ReturnType<typeof setTimeout>);
    await flush();
    expect(h.instances.length).toBe(2);
    h.cleanup();
  });
});

describe("Stage F — timeout retires the instance in both quiescence branches", () => {
  test("settles during quiescence: one stop, timed-out outcome, no applied advance", async () => {
    const driver = new DeferredDriver();
    driver.settleOnAbort = true; // settles during quiescence via abort
    const h = harness({ createDriver: () => driver, operationTimeoutMs: 10, quiescenceMs: 1000 });
    const { p } = await startPending(h);
    const timeout = h.timer.last!;
    h.timer.fire(timeout.handle as unknown as ReturnType<typeof setTimeout>);
    await flush();
    expect(driver.stopCount).toBe(1);
    expect(h.supervisor.getLastOperationOutcome()).toMatchObject({ kind: "timed-out" });
    expect(h.supervisor.getView().runtime.generation).toBe(0);
    expect(h.supervisor.getView().runtime.connectionState).toBe("ERROR");
    await p;
    h.cleanup();
  });

  test("pending at quiescence expiry: one stop, quarantine, timed-out outcome", async () => {
    const driver = new DeferredDriver();
    driver.settleOnAbort = false; // stays pending
    const h = harness({ createDriver: () => driver, operationTimeoutMs: 10, quiescenceMs: 20 });
    const { p } = await startPending(h);
    const timeout = h.timer.last!;
    h.timer.fire(timeout.handle as unknown as ReturnType<typeof setTimeout>);
    // Fire the quiescence timer (the second timer armed after timeout).
    const quiescence = h.timer.tasks.filter((t) => t.handle !== timeout.handle).at(-1)!;
    h.timer.fire(quiescence.handle as unknown as ReturnType<typeof setTimeout>);
    await flush();
    expect(driver.stopCount).toBe(1);
    expect(h.supervisor.getLastOperationOutcome()).toMatchObject({ kind: "timed-out" });
    expect(h.supervisor.getView().runtime.generation).toBe(0);
    await p;
    h.cleanup();
  });

  test("late settlement after retirement is inert and does not double-stop", async () => {
    const driver = new DeferredDriver();
    driver.settleOnAbort = false;
    const h = harness({ createDriver: () => driver, operationTimeoutMs: 10, quiescenceMs: 20 });
    const { p } = await startPending(h);
    const timeout = h.timer.last!;
    h.timer.fire(timeout.handle as unknown as ReturnType<typeof setTimeout>);
    const quiescence = h.timer.tasks.filter((t) => t.handle !== timeout.handle).at(-1)!;
    h.timer.fire(quiescence.handle as unknown as ReturnType<typeof setTimeout>);
    await flush();
    expect(driver.stopCount).toBe(1);
    // Late resolve/reject must not throw (no unhandled rejection) or stop again.
    expect(() => driver.resolveStart()).not.toThrow();
    await flush();
    expect(driver.stopCount).toBe(1);
    await p;
    h.cleanup();
  });

  test("a timed-out update cannot leave the service reporting STREAMING", async () => {
    const driver = new DeferredDriver();
    driver.autoResolveStart = true;
    driver.settleOnAbort = false;
    const h = harness({ createDriver: () => driver, operationTimeoutMs: 10, quiescenceMs: 20 });
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    driver.emitState("STREAMING");
    expect(h.service.getConnectionStatus("UPSTOX")?.state).toBe("STREAMING");
    const replace = h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }]);
    await driver.waitForUpdate();
    const timeout = h.timer.last!;
    h.timer.fire(timeout.handle as unknown as ReturnType<typeof setTimeout>);
    const quiescence = h.timer.tasks.filter((t) => t.handle !== timeout.handle).at(-1)!;
    h.timer.fire(quiescence.handle as unknown as ReturnType<typeof setTimeout>);
    await replace;
    expect(h.service.getConnectionStatus("UPSTOX")?.state).toBe("ERROR");
    h.cleanup();
  });
});

describe("Stage F — callback-triggered retirement while an operation is pending", () => {
  test("DISCONNECTED during pending start: callback-retired, one stop, one retry, fresh instance", async () => {
    const h = harness({
      createDriver: () => { const d = new DeferredDriver(); d.settleOnAbort = false; return d; },
      maxAttempts: 3, baseDelayMs: 1, quiescenceMs: 20
    });
    const { p } = await startPending(h);
    const old = h.instances[0]!;
    const oldCallbacks = old.callbackHistory[0]!;
    old.emitState("DISCONNECTED");
    // quiescence timer was armed by the callback path
    const quiescence = h.timer.last!;
    h.timer.fire(quiescence.handle as unknown as ReturnType<typeof setTimeout>);
    await flush();
    expect(old.stopCount).toBe(1);
    expect(h.supervisor.getLastOperationOutcome()).toMatchObject({ kind: "callback-retired", reason: "DISCONNECTED" });
    expect(h.supervisor.getView().runtime.generation).toBe(0);
    // The old promise is still pending; the timeout handler must not duplicate.
    const timersBefore = h.timer.active.length;
    h.timer.fire(h.timer.last!.handle as unknown as ReturnType<typeof setTimeout>);
    expect(h.timer.active.length).toBe(timersBefore);
    // Retry with a fresh instance while the old promise is still unresolved.
    const t = h.reconnectTimer.last!;
    h.reconnectTimer.fire(t.handle as unknown as ReturnType<typeof setTimeout>);
    await flush();
    expect(h.instances.length).toBe(2);
    expect(h.instances[1]!.starts.length).toBe(1);
    // Now settle the old promise: must be inert.
    expect(() => old.resolveStart()).not.toThrow();
    await flush();
    expect(old.stopCount).toBe(1);
    // Old callbacks cannot mutate canonical state.
    const revision = h.service.revision;
    oldCallbacks.onObservation(observation(A, 999));
    oldCallbacks.onConnectionState("STREAMING");
    expect(h.service.revision).toBe(revision);
    await p;
    h.cleanup();
  });

  test("ERROR during pending update: callback-retired, one stop, one retry", async () => {
    const h = harness({
      createDriver: () => { const d = new DeferredDriver(); d.autoResolveStart = true; d.settleOnAbort = false; return d; },
      maxAttempts: 3, baseDelayMs: 1, quiescenceMs: 20
    });
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    const replace = h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }]);
    await h.instances[0]!.waitForUpdate();
    h.instances[0]!.emitState("ERROR", "stream failed");
    const quiescence = h.timer.last!;
    h.timer.fire(quiescence.handle as unknown as ReturnType<typeof setTimeout>);
    await replace;
    expect(h.instances[0]!.stopCount).toBe(1);
    expect(h.supervisor.getLastOperationOutcome()).toMatchObject({ kind: "callback-retired", reason: "ERROR" });
    expect(h.supervisor.getView().runtime.generation).toBe(1);
    h.cleanup();
  });

  test("callbacks during quiescence are inert", async () => {
    const driver = new DeferredDriver();
    driver.settleOnAbort = false;
    const h = harness({ createDriver: () => driver, operationTimeoutMs: 10, quiescenceMs: 20 });
    const { p } = await startPending(h);
    const timeout = h.timer.last!;
    h.timer.fire(timeout.handle as unknown as ReturnType<typeof setTimeout>);
    const revision = h.service.revision;
    const stateBefore = h.supervisor.getView().runtime.connectionState;
    driver.emitObservation(observation(A, 999));
    driver.emitState("STREAMING");
    expect(h.service.revision).toBe(revision);
    expect(h.supervisor.getView().runtime.connectionState).toBe(stateBefore);
    const quiescence = h.timer.tasks.filter((t) => t.handle !== timeout.handle).at(-1)!;
    h.timer.fire(quiescence.handle as unknown as ReturnType<typeof setTimeout>);
    await p;
    h.cleanup();
  });
});

describe("Stage F — retry exhaustion after ERROR and DISCONNECTED", () => {
  test("repeated ERROR callbacks exhaust the budget with a final ERROR state", async () => {
    const h = harness({
      createDriver: () => { const d = new DeferredDriver(); d.autoResolveStart = true; return d; },
      maxAttempts: 2, baseDelayMs: 1
    });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    for (let i = 0; i < 3; i++) {
      h.instances[i]!.emitState("ERROR", `failure ${i}`);
      const t = h.reconnectTimer.active.at(-1);
      if (t) h.reconnectTimer.fire(t.handle as unknown as ReturnType<typeof setTimeout>);
      await flush();
    }
    const view = h.supervisor.getView();
    expect(view.runtime.connectionState).toBe("ERROR");
    expect(view.runtime.lastError).toContain("exhausted");
    h.cleanup();
  });

  test("repeated DISCONNECTED callbacks without error strings use a fallback message", async () => {
    const h = harness({
      createDriver: () => { const d = new DeferredDriver(); d.autoResolveStart = true; return d; },
      maxAttempts: 2, baseDelayMs: 1
    });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    for (let i = 0; i < 3; i++) {
      h.instances[i]!.emitState("DISCONNECTED");
      const t = h.reconnectTimer.active.at(-1);
      if (t) h.reconnectTimer.fire(t.handle as unknown as ReturnType<typeof setTimeout>);
      await flush();
    }
    const view = h.supervisor.getView();
    expect(view.runtime.connectionState).toBe("ERROR");
    expect(view.runtime.lastError).toContain("disconnected");
    h.cleanup();
  });
});

describe("Stage F — shutdown and locked boundary", () => {
  test("shutdown of a pending start resolves shutdown and does not advance applied generation", async () => {
    const driver = new DeferredDriver();
    driver.settleOnAbort = false;
    const h = harness({ createDriver: () => driver });
    const { p } = await startPending(h);
    h.supervisor.stop();
    expect(driver.stopCount).toBe(1);
    expect(h.supervisor.getLastOperationOutcome()).toMatchObject({ kind: "shutdown" });
    expect(h.supervisor.getView().runtime.generation).toBe(0);
    expect(h.supervisor.getView().runtime.connectionState).toBe("NOT_STARTED");
    await p;
    h.cleanup();
  });

  test("locked driver fails safely with no retries and no real connection", async () => {
    const locked = new LockedUpstoxDriver();
    expect(locked.getConnectionState()).toBe("NOT_STARTED");
    let rejected = 0;
    try { await locked.start([], { onObservation: () => {}, onConnectionState: () => {} }, new AbortController().signal); } catch (e) {
      expect(e).toBeInstanceOf(DriverLockedError); rejected++;
    }
    try { await locked.updateSubscriptions([], new AbortController().signal); } catch (e) {
      expect(e).toBeInstanceOf(DriverLockedError); rejected++;
    }
    expect(rejected).toBe(2);
    expect(locked.getConnectionState()).toBe("NOT_STARTED");
  });

  test("supervisor with locked driver reports ERROR and schedules no retry", async () => {
    const h = harness({ createDriver: () => new LockedUpstoxDriver() });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    const view = h.supervisor.getView();
    expect(view.runtime.connectionState).toBe("ERROR");
    expect(view.runtime.lastError).toContain("locked");
    expect(h.reconnectTimer.active.length).toBe(0);
    h.cleanup();
  });

  test("factory failure is retried, not classified as locked", async () => {
    let calls = 0;
    const h = harness({
      createDriver: () => {
        calls++;
        if (calls === 1) throw new Error("factory failed");
        const d = new DeferredDriver(); d.autoResolveStart = true; return d;
      },
      maxAttempts: 2, baseDelayMs: 1
    });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    expect(h.supervisor.getView().runtime.lastError).toContain("factory failed");
    const t = h.reconnectTimer.last!;
    h.reconnectTimer.fire(t.handle as unknown as ReturnType<typeof setTimeout>);
    await flush();
    expect(calls).toBe(2);
    expect(h.supervisor.getView().runtime.generation).toBe(1);
    h.cleanup();
  });
});
