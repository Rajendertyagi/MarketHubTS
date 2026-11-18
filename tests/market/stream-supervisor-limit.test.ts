import { describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtemp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalInstrumentSchema,
  providerInstrumentMappingSchema,
  type CapabilityResult,
  type DriverTerminalFailure,
  type FreshnessPolicy,
  type ProviderConnectionState
} from "../../packages/contracts/src/index";
import { openDatabase, runMigrations, defaultMigrationsFolder, SqliteCatalogRepository, SqliteSubscriptionRepository } from "../../packages/database/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import {
  StreamSupervisor,
  type DriverCallbacks,
  type DriverSubscription,
  type ReconnectTimerScheduler,
  type StreamingDriver
} from "../../apps/api/src/stream-supervisor";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const B = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";
const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000
};

const FYERS_LIMIT_CAPS: CapabilityResult[] = [
  { component: "quote", provider: "FYERS", status: "LIMITED", reason: "maximum symbol limit exceeded", entitlementUnverified: true },
  { component: "depth", provider: "FYERS", status: "LIMITED", reason: "maximum symbol limit exceeded", levels: 5, entitlementUnverified: true },
  { component: "derivatives", provider: "FYERS", status: "UNSUPPORTED", reason: "REST-only" }
];
const LIMIT_FAILURE: DriverTerminalFailure = {
  kind: "LIMITED", reason: "maximum symbol limit exceeded", capabilities: FYERS_LIMIT_CAPS
};

/**
 * Driver that reports a typed terminal failure, then the paired connection
 * failure, then rejects its start/update promise — the exact FYERS sequence.
 * Records callback order and retirement so duplicate paths are observable.
 */
class LimitDriver implements StreamingDriver {
  starts: DriverSubscription[][] = [];
  updates: DriverSubscription[][] = [];
  stopCount = 0;
  callbacks: DriverCallbacks | null = null;
  callOrder: string[] = [];
  failOn: "start" | "update" | "none" = "start";
  ordinaryFailure = false;
  /** When true, start() stays pending until failDeferredLimit()/resolveDeferred() is called. */
  deferredStart = false;
  private deferredReject: ((error: Error) => void) | null = null;
  private deferredResolve: (() => void) | null = null;

  private emitLimit(): void {
    this.callOrder.push("terminal");
    this.callbacks?.onTerminalFailure?.(LIMIT_FAILURE);
    this.callOrder.push("connection-error");
    this.callbacks?.onConnectionState("ERROR", "FYERS Data Socket limit: maximum symbol limit exceeded");
  }

  /** Fail a deferred start with the typed limit sequence (callback then rejection). */
  failDeferredLimit(): void {
    this.emitLimit();
    this.deferredReject?.(new Error("FYERS Data Socket limit: maximum symbol limit exceeded"));
  }

  /** Resolve a deferred start successfully. */
  resolveDeferred(): void {
    this.callbacks?.onConnectionState("STREAMING");
    this.deferredResolve?.();
  }

  /** Emit the typed terminal failure + paired ERROR outside any active operation. */
  emitTerminalAfterSettled(): void { this.emitLimit(); }

  /** Emit an ordinary DISCONNECTED outside any active operation. */
  emitOrdinaryDisconnect(): void {
    this.callOrder.push("connection-error");
    this.callbacks?.onConnectionState("DISCONNECTED", "ordinary disconnect");
  }

  /** True once start() has been entered and the deferred promise is armed. */
  get deferredArmed(): boolean { return this.deferredReject !== null; }

  async start(subs: DriverSubscription[], callbacks: DriverCallbacks, _signal: AbortSignal): Promise<void> {
    this.starts.push(subs.map((s) => ({ ...s })));
    this.callbacks = callbacks;
    if (this.deferredStart) {
      await new Promise<void>((resolve, reject) => {
        this.deferredResolve = resolve;
        this.deferredReject = reject;
      });
      return;
    }
    if (this.failOn === "start") {
      if (this.ordinaryFailure) {
        this.callOrder.push("connection-error");
        callbacks.onConnectionState("ERROR", "ordinary transient error");
        throw new Error("ordinary transient error");
      }
      this.emitLimit();
      throw new Error("FYERS Data Socket limit: maximum symbol limit exceeded");
    }
    callbacks.onConnectionState("STREAMING");
  }

  async updateSubscriptions(subs: DriverSubscription[], _signal: AbortSignal): Promise<void> {
    this.updates.push(subs.map((s) => ({ ...s })));
    if (this.failOn === "update") {
      this.emitLimit();
      throw new Error("FYERS Data Socket limit: maximum symbol limit exceeded");
    }
  }

  stop(): void { this.stopCount++; }
  getConnectionState(): ProviderConnectionState { return "NOT_STARTED"; }
}

/** Manual reconnect timer scheduler so "no retry" is deterministic. */
class ManualTimer implements ReconnectTimerScheduler {
  tasks: Array<{ handle: number; fn: () => void; cancelled: boolean }> = [];
  private next = 1;
  set(fn: () => void, _ms: number): ReturnType<typeof setTimeout> {
    const handle = this.next++;
    this.tasks.push({ handle, fn, cancelled: false });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }
  clear(handle: ReturnType<typeof setTimeout>): void {
    const t = this.tasks.find((x) => x.handle === (handle as unknown as number));
    if (t) t.cancelled = true;
  }
  get active() { return this.tasks.filter((t) => !t.cancelled); }
}

interface DriverConfig {
  failOn: "start" | "update" | "none";
  ordinaryFailure: boolean;
  deferredStart: boolean;
}

interface H {
  subscriptions: SqliteSubscriptionRepository;
  supervisor: StreamSupervisor;
  instances: LimitDriver[];
  timers: ManualTimer;
  /** Read by the driver factory at creation time; mutate before a new generation. */
  driverConfig: DriverConfig;
  seed(canonicalId: string, nativeIdentifier: string): Promise<void>;
  /** Commit desired state to the repo and apply that exact generation to the runtime. */
  commitAndApply(selections: Array<{ canonicalId: string; enabled: boolean }>): Promise<number>;
  cleanup(): void;
}

async function harness(initialFailMode: "start" | "update" | "none" = "start", ordinary = false): Promise<H> {
  const dir = mkdtemp(join(tmpdir(), "mh-limit-"));
  const handle = openDatabase({ dbPath: join(dir, "sup.sqlite") });
  runMigrations(handle.db, defaultMigrationsFolder);
  const catalog = new SqliteCatalogRepository(handle.db, handle.sqlite);
  const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
  const service = new MarketDataService({ now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN" });
  const instances: LimitDriver[] = [];
  const timers = new ManualTimer();
  const driverConfig: DriverConfig = { failOn: initialFailMode, ordinaryFailure: ordinary, deferredStart: false };
  const supervisor = new StreamSupervisor({
    service, subscriptions, catalog,
    createDriver: () => {
      const d = new LimitDriver();
      d.failOn = driverConfig.failOn;
      d.ordinaryFailure = driverConfig.ordinaryFailure;
      d.deferredStart = driverConfig.deferredStart;
      instances.push(d);
      return d;
    },
    provider: "FYERS",
    coordinated: true,
    reconnect: { maxAttempts: 5, baseDelayMs: 1000 },
    reconnectTimerScheduler: timers
  });
  const seed = async (canonicalId: string, nativeIdentifier: string) => {
    await catalog.transaction(async (tx) => {
      await tx.upsertInstrument(canonicalInstrumentSchema.parse({
        canonicalId, identityKey: `key:${canonicalId}`, exchange: "NSE", segment: "INDEX",
        marketType: "INDEX", instrumentCategory: "INDEX", canonicalSymbol: canonicalId, displayName: canonicalId
      }));
      await tx.upsertMapping(providerInstrumentMappingSchema.parse({
        provider: "FYERS", nativeIdentifier, canonicalId, status: "ACTIVE"
      }));
    });
  };
  const commitAndApply = async (selections: Array<{ canonicalId: string; enabled: boolean }>): Promise<number> => {
    const gen = await subscriptions.replace(selections);
    await supervisor.applyDesiredState(selections, gen);
    return gen;
  };
  const cleanup = () => { supervisor.stop(); closeDatabaseHandle(handle); removeTempDir(dir); };
  return { subscriptions, supervisor, instances, timers, driverConfig, seed, commitAndApply, cleanup };
}

describe("Stage C Finding 3 — typed LIMITED terminal failure", () => {
  test("startup limit rejection: ERROR state + structured LIMITED capabilities, reason preserved", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("ERROR");
      expect(view.runtime.lastError).toContain("maximum symbol limit exceeded");
      expect(view.runtime.capabilities).toBeDefined();
      expect(view.runtime.capabilities!.find((c) => c.component === "quote")?.status).toBe("LIMITED");
      expect(view.runtime.capabilities!.find((c) => c.component === "depth")?.status).toBe("LIMITED");
      expect(view.runtime.capabilities!.find((c) => c.component === "derivatives")?.status).toBe("UNSUPPORTED");
    } finally { h.cleanup(); }
  });

  test("no automatic retry is scheduled for the limited generation", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      expect(h.timers.active.length).toBe(0);
      expect(h.instances.length).toBe(1); // no fresh driver acquired
    } finally { h.cleanup(); }
  });

  test("desired state stays committed; applied generation does not advance", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      const view = h.supervisor.getView();
      expect(view.generation).toBe(1);
      expect(view.selections).toEqual([{ canonicalId: A, enabled: true }]);
      expect(view.runtime.generation).toBe(0); // failed generation not applied
    } finally { h.cleanup(); }
  });

  test("a new desired generation clears stale limitation and permits a fresh attempt", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      expect(h.supervisor.getView().runtime.capabilities).toBeDefined();
      // New generation: the fresh driver now succeeds.
      h.driverConfig.failOn = "none";
      await h.commitAndApply([{ canonicalId: B, enabled: true }]);
      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("STREAMING");
      expect(view.runtime.capabilities).toBeUndefined(); // stale limitation cleared
      expect(view.runtime.generation).toBe(2);
      expect(h.instances.length).toBe(2); // fresh driver for new generation
    } finally { h.cleanup(); }
  });

  test("a limit on an older connecting driver does not block a newer committed generation", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");

      // gen1 starts a driver that stays pending (awaiting the SDK connect event).
      h.driverConfig.deferredStart = true;
      const gen1 = await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
      const apply1 = h.supervisor.applyDesiredState([{ canonicalId: A, enabled: true }], gen1);
      for (let i = 0; i < 100 && !h.instances[0]?.deferredArmed; i++) await Bun.sleep(1);
      expect(h.instances.length).toBe(1);
      const driver1 = h.instances[0]!;
      expect(driver1.deferredArmed).toBe(true);

      // While driver1 is still connecting, gen2 is committed. The supervisor's
      // mutable this.generation is now 2, but driver1 belongs to gen1.
      const gen2 = await h.subscriptions.replace([{ canonicalId: B, enabled: true }]);
      const apply2 = h.supervisor.applyDesiredState([{ canonicalId: B, enabled: true }], gen2);
      h.driverConfig.deferredStart = false; // gen2's fresh driver will succeed
      h.driverConfig.failOn = "none";

      // driver1 hits the limit. The failure must be attributed to gen1, so the
      // newer gen2 is neither blocked nor left with stale LIMITED capabilities.
      driver1.failDeferredLimit();
      await Promise.all([apply1, apply2]);

      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("STREAMING");
      expect(view.runtime.capabilities).toBeUndefined(); // no stale limitation
      expect(view.runtime.generation).toBe(2);
      expect(h.instances.length).toBe(2); // gen2 got its own fresh driver
    } finally { h.cleanup(); }
  });

  test("stale-generation terminal failure schedules no retry that can overlap the newer start", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");

      // gen1 starts a deferred driver (its start is still pending).
      h.driverConfig.deferredStart = true;
      const gen1 = await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
      const apply1 = h.supervisor.applyDesiredState([{ canonicalId: A, enabled: true }], gen1);
      for (let i = 0; i < 100 && !h.instances[0]?.deferredArmed; i++) await Bun.sleep(1);
      const driver1 = h.instances[0]!;
      expect(driver1.deferredArmed).toBe(true);

      // gen2 is committed while gen1 is still connecting. Its reconciliation is
      // queued behind gen1's in-flight operation.
      const gen2 = await h.subscriptions.replace([{ canonicalId: B, enabled: true }]);
      const apply2 = h.supervisor.applyDesiredState([{ canonicalId: B, enabled: true }], gen2);
      h.driverConfig.failOn = "none"; // gen2's fresh driver will succeed (still deferred)

      // gen1 fails terminally. The failure belongs to gen1, so it must NOT
      // schedule a retry: gen2's queued reconciliation owns recovery.
      driver1.failDeferredLimit();
      for (let i = 0; i < 100 && !h.instances[1]?.deferredArmed; i++) await Bun.sleep(1);
      expect(h.instances.length).toBe(2); // gen2's driver is the only new instance

      // No stale retry timer from gen1 may exist. Fire anything present anyway
      // to prove that even a manually-triggered stale timer cannot create a
      // third driver while gen2's start is still pending.
      expect(h.timers.active.length).toBe(0);
      for (const task of [...h.timers.active]) task.fn();
      expect(h.instances.length).toBe(2); // no overlapping start / third driver

      // gen2 eventually connects successfully.
      h.instances[1]!.resolveDeferred();
      await Promise.all([apply1, apply2]);
      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("STREAMING");
      expect(view.runtime.generation).toBe(2);
      expect(view.runtime.capabilities).toBeUndefined();
      expect(h.instances.length).toBe(2);
    } finally { h.cleanup(); }
  });

  test("a terminal failure landing between enqueue and run blocks the queued same-generation run", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      h.driverConfig.deferredStart = true;
      const gen = await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);

      // First apply starts a deferred driver that has not failed yet.
      const apply1 = h.supervisor.applyDesiredState([{ canonicalId: A, enabled: true }], gen);
      for (let i = 0; i < 100 && !h.instances[0]?.deferredArmed; i++) await Bun.sleep(1);
      const driver1 = h.instances[0]!;

      // A second apply for the SAME generation is enqueued while the first
      // driver is still connecting (no terminal failure recorded yet).
      const apply2 = h.supervisor.applyDesiredState([{ canonicalId: A, enabled: true }], gen);

      // Now the first driver fails terminally. The queued run must re-check the
      // guard at run time and refuse to start a retry driver for gen.
      driver1.failDeferredLimit();
      await Promise.all([apply1, apply2]);

      expect(h.instances.length).toBe(1); // no retry driver for the limited generation
      expect(h.supervisor.getView().runtime.connectionState).toBe("ERROR");
      expect(h.supervisor.getView().runtime.capabilities).toBeDefined();
    } finally { h.cleanup(); }
  });

  test("repeated reconciliation of the same limited generation is blocked", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      const gen = await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      const countAfterFirst = h.instances.length;
      // Re-apply the exact same generation that was just limited: it must be
      // blocked without acquiring a fresh driver.
      await h.supervisor.applyDesiredState([{ canonicalId: A, enabled: true }], gen);
      expect(h.instances.length).toBe(countAfterFirst); // no new attempt
    } finally { h.cleanup(); }
  });

  test("ordinary recoverable error still schedules a reconnect", async () => {
    const h = await harness("start", true); // ordinary failure, not LIMITED
    try {
      await h.seed(A, "key-A");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("ERROR");
      expect(view.runtime.capabilities).toBeUndefined(); // no structured limitation
      expect(h.timers.active.length).toBe(1); // ordinary error retries
    } finally { h.cleanup(); }
  });

  test("limit failure during subscription update is handled consistently", async () => {
    const h = await harness("none"); // first start succeeds
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");
      // First start succeeds.
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      expect(h.supervisor.getView().runtime.connectionState).toBe("STREAMING");
      // Next update hits the limit.
      h.instances[0]!.failOn = "update";
      await h.commitAndApply([{ canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }]);
      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("ERROR");
      expect(view.runtime.lastError).toContain("maximum symbol limit exceeded");
      expect(view.runtime.capabilities!.find((c) => c.component === "quote")?.status).toBe("LIMITED");
      expect(view.runtime.generation).toBe(1); // gen 2 not applied
      expect(h.timers.active.length).toBe(0); // no retry
    } finally { h.cleanup(); }
  });

  test("async terminal notification and promise rejection cause exactly one retirement", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      const d = h.instances[0]!;
      expect(d.callOrder.filter((x) => x === "terminal")).toHaveLength(1);
      expect(d.callOrder[0]).toBe("terminal"); // before connection-error
      expect(d.stopCount).toBe(1); // retired once despite both paths
      expect(h.timers.active.length).toBe(0);
    } finally { h.cleanup(); }
  });

  test("capability results survive driver retirement", async () => {
    const h = await harness();
    try {
      await h.seed(A, "key-A");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      expect(h.instances[0]!.stopCount).toBe(1);
      expect(h.supervisor.getView().runtime.capabilities).toBeDefined();
    } finally { h.cleanup(); }
  });
});

describe("Stage C — generation ownership and retry timer lifecycle", () => {
  test("A: terminal callback after successful start belongs to gen1, not gen2", async () => {
    const h = await harness("none");
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]); // gen1 starts
      expect(h.supervisor.getView().runtime.connectionState).toBe("STREAMING");
      expect(h.instances[0]!.stopCount).toBe(0); // op settled, driver still owned

      // gen2 is committed (this.generation becomes 2 synchronously) but its
      // reconciliation is queued behind the current microtask.
      const gen2 = await h.subscriptions.replace([{ canonicalId: B, enabled: true }]);
      const apply2 = h.supervisor.applyDesiredState([{ canonicalId: B, enabled: true }], gen2);

      // Old driver emits terminal + ERROR after its operation settled. It owns
      // gen1, so gen2 must not be marked terminal or inherit stale capabilities.
      h.instances[0]!.emitTerminalAfterSettled();
      expect(h.supervisor.getView().runtime.capabilities).toBeUndefined();

      await apply2;
      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("STREAMING");
      expect(view.runtime.generation).toBe(2);
      expect(view.runtime.capabilities).toBeUndefined();
      expect(h.instances.length).toBe(2); // gen2 got a fresh driver
      expect(h.timers.active.length).toBe(0); // stale callback scheduled no retry
      // gen2's reconciliation was already queued; the stale callback must not
      // enqueue a duplicate that would update the recovered driver.
      await Bun.sleep(0); // let any duplicate queued reconcile run
      expect(h.instances[1]!.updates).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("B: terminal callback after successful update belongs to gen2, not gen3", async () => {
    const h = await harness("none");
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]); // gen1 start
      await h.commitAndApply([{ canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }]); // gen2 update
      expect(h.instances.length).toBe(1); // same driver applied gen2
      expect(h.instances[0]!.updates).toHaveLength(1);

      // gen3 is committed (this.generation becomes 3 synchronously) but its
      // reconciliation is queued. The driver owns gen2 via its last applied
      // generation, advanced by the successful update above.
      const gen3 = await h.subscriptions.replace([{ canonicalId: B, enabled: true }]);
      const apply3 = h.supervisor.applyDesiredState([{ canonicalId: B, enabled: true }], gen3);
      h.instances[0]!.emitTerminalAfterSettled(); // must attribute to gen2, not gen3
      // Directly observable attribution: the terminal generation is gen2, not
      // the mutable current generation 3 and not the original start gen1.
      expect(h.supervisor.getLimitedGeneration()).toBe(2);
      expect(h.supervisor.getView().runtime.capabilities).toBeUndefined(); // gen3 not blocked
      expect(h.timers.active.length).toBe(0); // terminal generation never retries

      // A genuinely newer generation clears the stale limitation and recovers.
      await apply3;
      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("STREAMING");
      expect(view.runtime.generation).toBe(3);
      expect(view.runtime.capabilities).toBeUndefined();
      expect(h.instances.length).toBe(2);
    } finally { h.cleanup(); }
  });

  test("C: stale non-operation disconnect schedules no retry for gen2", async () => {
    const h = await harness("none");
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]); // gen1 applied

      const gen2 = await h.subscriptions.replace([{ canonicalId: B, enabled: true }]);
      const apply2 = h.supervisor.applyDesiredState([{ canonicalId: B, enabled: true }], gen2);
      h.instances[0]!.emitOrdinaryDisconnect(); // stale gen1 callback, no active op

      // The stale callback must not schedule a retry for gen2.
      expect(h.timers.active.length).toBe(0);
      await apply2;
      const view = h.supervisor.getView();
      expect(view.runtime.connectionState).toBe("STREAMING");
      expect(view.runtime.generation).toBe(2);
      expect(h.instances.length).toBe(2); // gen2's queued reconcile recovered
      // The stale callback must not enqueue a duplicate reconcile that would
      // update the recovered gen2 driver.
      await Bun.sleep(0); // let any duplicate queued reconcile run
      expect(h.instances[1]!.updates).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("D: stale retry timer cannot enqueue, create a driver, or clear a newer timer", async () => {
    const h = await harness("start", true); // gen1 ordinary failure
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      expect(h.timers.active.length).toBe(1); // gen1 retry scheduled
      const oldTask = h.timers.tasks.find((t) => !t.cancelled)!;

      // gen2 committed before the timer fires: the old timer is invalidated
      // synchronously when applyDesiredState commits the newer generation.
      const gen2 = await h.subscriptions.replace([{ canonicalId: B, enabled: true }]);
      h.driverConfig.ordinaryFailure = false;
      h.driverConfig.failOn = "none";
      h.driverConfig.deferredStart = true; // gen2's fresh driver stays pending
      const apply2 = h.supervisor.applyDesiredState([{ canonicalId: B, enabled: true }], gen2);
      expect(h.timers.active.length).toBe(0); // cancelled synchronously on commit
      for (let i = 0; i < 100 && !h.instances[1]?.deferredArmed; i++) await Bun.sleep(1);
      expect(h.instances.length).toBe(2);

      // Manually invoke the cancelled gen1 timer callback.
      oldTask.fn();
      await Bun.sleep(0);
      expect(h.instances.length).toBe(2); // no third driver / no duplicate reconcile
      expect(h.timers.active.length).toBe(0); // did not create or clear a timer

      h.instances[1]!.resolveDeferred();
      await apply2;
      await Bun.sleep(0); // let any duplicate queued reconcile run
      expect(h.supervisor.getView().runtime.connectionState).toBe("STREAMING");
      expect(h.supervisor.getView().runtime.generation).toBe(2);
      // A stale timer that enqueued a duplicate gen2 reconcile would cause an
      // extra updateSubscriptions on the recovered driver.
      await Bun.sleep(0); // let any duplicate queued reconcile run
      expect(h.instances[1]!.updates).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  test("E: stale timer cannot affect a newer generation's own retry", async () => {
    const h = await harness("start", true); // gen1 ordinary failure
    try {
      await h.seed(A, "key-A");
      await h.seed(B, "key-B");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      const oldTask = h.timers.tasks.find((t) => !t.cancelled)!;

      // gen2 committed: gen1 timer cancelled. gen2's driver fails ordinarily.
      const gen2 = await h.subscriptions.replace([{ canonicalId: B, enabled: true }]);
      h.driverConfig.ordinaryFailure = true; // gen2's driver also fails
      const apply2 = h.supervisor.applyDesiredState([{ canonicalId: B, enabled: true }], gen2);
      await apply2;
      expect(h.timers.active.length).toBe(1); // gen2's own retry
      const newTask = h.timers.active[0]!;
      expect(newTask.handle).not.toBe(oldTask.handle);

      // Make gen2's next driver deferred so a driver start is observable.
      h.driverConfig.ordinaryFailure = false;
      h.driverConfig.failOn = "none";
      h.driverConfig.deferredStart = true;

      // Invoke gen1's stale timer: it must not enqueue a reconcile or create a
      // driver, and must not clear/suppress gen2's still-owned timer.
      oldTask.fn();
      await Bun.sleep(0);
      expect(h.instances.length).toBe(2); // no driver from the stale timer
      expect(h.timers.active.length).toBe(1);
      expect(h.timers.active[0]!.handle).toBe(newTask.handle);
      expect(h.timers.active[0]!.cancelled).toBe(false);

      // gen2 recovers normally through its own timer.
      newTask.fn();
      for (let i = 0; i < 100 && !h.instances[2]?.deferredArmed; i++) await Bun.sleep(1);
      expect(h.instances.length).toBe(3); // only gen2's own timer created a driver
      h.instances[2]!.resolveDeferred();
      await Bun.sleep(0);
      for (let i = 0; i < 100 && h.supervisor.getView().runtime.connectionState !== "STREAMING"; i++) await Bun.sleep(1);
      expect(h.supervisor.getView().runtime.connectionState).toBe("STREAMING");
      expect(h.supervisor.getView().runtime.generation).toBe(2);
    } finally { h.cleanup(); }
  });

  test("F: current-generation retries remain bounded and LIMITED never retries", async () => {
    // Ordinary current-generation failure retries through the timer and recovers.
    const h = await harness("start", true);
    try {
      await h.seed(A, "key-A");
      await h.commitAndApply([{ canonicalId: A, enabled: true }]);
      expect(h.timers.active.length).toBe(1);
      const task = h.timers.active[0]!;
      h.driverConfig.ordinaryFailure = false;
      h.driverConfig.failOn = "none";
      task.fn();
      await Bun.sleep(0);
      for (let i = 0; i < 100 && h.supervisor.getView().runtime.connectionState !== "STREAMING"; i++) await Bun.sleep(1);
      expect(h.supervisor.getView().runtime.connectionState).toBe("STREAMING");
      expect(h.instances.length).toBe(2);
    } finally { h.cleanup(); }

    // Current-generation LIMITED failure schedules no retry.
    const limited = await harness();
    try {
      await limited.seed(A, "key-A");
      await limited.commitAndApply([{ canonicalId: A, enabled: true }]);
      expect(limited.timers.active.length).toBe(0);
      expect(limited.supervisor.getView().runtime.capabilities).toBeDefined();
    } finally { limited.cleanup(); }
  });
});

describe("Stage C Finding 3 — contract backward compatibility", () => {
  test("existing runtime status payload without capabilities remains valid", async () => {
    const { subscriptionRuntimeStatusSchema } = await import("../../packages/contracts/src/index");
    const legacy = { generation: 1, connectionState: "STREAMING", resolutions: [], lastError: null };
    const parsed = subscriptionRuntimeStatusSchema.parse(legacy);
    expect(parsed.capabilities).toBeUndefined();
  });
});
