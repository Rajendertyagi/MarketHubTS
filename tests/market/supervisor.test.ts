import { describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtemp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalInstrumentSchema, providerInstrumentMappingSchema,
  type FreshnessPolicy, type NormalizeObservationInput, type ProviderInstrumentMapping
} from "../../packages/contracts/src/index";
import { openDatabase, runMigrations, defaultMigrationsFolder, SqliteCatalogRepository, SqliteSubscriptionRepository } from "../../packages/database/src/index";
import { MarketDataService, type CatalogRepository } from "../../packages/market-core/src/index";
import {
  DriverLockedError, LockedUpstoxDriver, StreamSupervisor,
  type DriverCallbacks, type DriverSubscription, type ReconnectTimerScheduler, type StreamingDriver
} from "../../apps/api/src/stream-supervisor";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const B = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";
const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000
};

class FakeDriver implements StreamingDriver {
  starts: DriverSubscription[][] = [];
  updates: DriverSubscription[][] = [];
  stopCount = 0;
  callbacks: DriverCallbacks | null = null;
  /** All callback sets handed out, one per start(), so old instances can be replayed. */
  callbackHistory: DriverCallbacks[] = [];
  state = "NOT_STARTED";
  failStart = false;

  async start(subs: DriverSubscription[], callbacks: DriverCallbacks, _signal: AbortSignal): Promise<void> {
    this.starts.push(subs.map((s) => ({ ...s })));
    this.callbacks = callbacks;
    this.callbackHistory.push(callbacks);
    if (this.failStart) throw new Error("start failed");
    this.state = "CONNECTING";
    callbacks.onConnectionState("CONNECTING");
  }
  async updateSubscriptions(subs: DriverSubscription[], _signal: AbortSignal): Promise<void> {
    this.updates.push(subs.map((s) => ({ ...s })));
  }
  stop(): void { this.stopCount++; this.state = "DISCONNECTED"; }
  getConnectionState() { return this.state; }
  emitObservation(input: NormalizeObservationInput): void { this.callbacks?.onObservation(input); }
  emitState(state: any, error?: string): void { this.state = state; this.callbacks?.onConnectionState(state, error); }
}

function observation(canonicalId: string, ltp: number): NormalizeObservationInput {
  return {
    provider: "UPSTOX", canonicalId, value: { ltp },
    rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time", receivedAtMs: BASE
  };
}

/** Driver whose start()/updateSubscriptions() stay pending until explicitly settled. */
class DeferredDriver implements StreamingDriver {
  starts: DriverSubscription[][] = [];
  updates: DriverSubscription[][] = [];
  stopCount = 0;
  callbacks: DriverCallbacks | null = null;
  private startCalled = false;
  private readonly startWaiters: Array<() => void> = [];
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((e: Error) => void) | null = null;
  callbackHistory: DriverCallbacks[] = [];
  private updateCalled = false;
  private readonly updateWaiters: Array<() => void> = [];
  private resolveUpdate: (() => void) | null = null;
  private rejectUpdate: ((e: Error) => void) | null = null;

  async start(subs: DriverSubscription[], callbacks: DriverCallbacks, signal: AbortSignal): Promise<void> {
    this.starts.push(subs.map((s) => ({ ...s })));
    this.callbacks = callbacks;
    this.callbackHistory.push(callbacks);
    this.startCalled = true;
    for (const wake of this.startWaiters.splice(0)) wake();
    await new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async updateSubscriptions(subs: DriverSubscription[], signal: AbortSignal): Promise<void> {
    this.updates.push(subs.map((s) => ({ ...s })));
    this.updateCalled = true;
    for (const wake of this.updateWaiters.splice(0)) wake();
    await new Promise<void>((resolve, reject) => {
      this.resolveUpdate = resolve;
      this.rejectUpdate = reject;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  stop(): void { this.stopCount++; }
  getConnectionState() { return "NOT_STARTED"; }
  waitForStartCalled(): Promise<void> {
    if (this.startCalled) return Promise.resolve();
    return new Promise((resolve) => this.startWaiters.push(resolve));
  }
  waitForUpdateCalled(): Promise<void> {
    if (this.updateCalled) return Promise.resolve();
    return new Promise((resolve) => this.updateWaiters.push(resolve));
  }
  resolvePendingStart(): void { this.resolveStart?.(); }
  rejectPendingStart(error = new Error("start failed")): void { this.rejectStart?.(error); }
  resolvePendingUpdate(): void { this.resolveUpdate?.(); }
  rejectPendingUpdate(error = new Error("update failed")): void { this.rejectUpdate?.(error); }
}

/** Driver whose start() allocates a resource then rejects. */
class AllocatingFailDriver implements StreamingDriver {
  starts = 0;
  stopCount = 0;
  async start(_subs: DriverSubscription[], _callbacks: DriverCallbacks, _signal: AbortSignal): Promise<void> {
    this.starts++;
    throw new Error("start failed after allocation");
  }
  async updateSubscriptions(_subs: DriverSubscription[], _signal: AbortSignal): Promise<void> {}
  stop(): void { this.stopCount++; }
  getConnectionState() { return "NOT_STARTED"; }
}

/** Catalog that can hold mapping resolution pending for a deterministic race. */
function deferredMappings(inner: CatalogRepository) {
  let hold = true;
  const waiters: Array<() => void> = [];
  const pending: Array<{ canonicalId: string; resolve: (v: ProviderInstrumentMapping[]) => void }> = [];
  const catalog = {
    async getInstrumentByCanonicalId(canonicalId: string) {
      return inner.getInstrumentByCanonicalId(canonicalId);
    },
    listMappingsByCanonicalId(canonicalId: string): Promise<ProviderInstrumentMapping[]> {
      if (!hold) return inner.listMappingsByCanonicalId(canonicalId);
      return new Promise((resolve) => {
        pending.push({ canonicalId, resolve });
        for (const wake of waiters.splice(0)) wake();
      });
    }
  } as unknown as CatalogRepository;
  return {
    catalog,
    waitForCall: (): Promise<void> => pending.length > 0
      ? Promise.resolve()
      : new Promise((resolve) => waiters.push(resolve)),
    release: async (): Promise<void> => {
      hold = false;
      const held = pending.splice(0);
      for (const item of held) item.resolve(await inner.listMappingsByCanonicalId(item.canonicalId));
    }
  };
}

/** Catalog whose mapping resolution can be toggled to fail deterministically. */
function toggleableMappings(inner: CatalogRepository) {
  let fail = false;
  const catalog = {
    async getInstrumentByCanonicalId(canonicalId: string) {
      return inner.getInstrumentByCanonicalId(canonicalId);
    },
    async listMappingsByCanonicalId(canonicalId: string): Promise<ProviderInstrumentMapping[]> {
      if (fail) throw new Error("mapping resolution failed");
      return inner.listMappingsByCanonicalId(canonicalId);
    }
  } as unknown as CatalogRepository;
  return { catalog, setFail: (value: boolean) => { fail = value; } };
}

async function waitForGeneration(repo: SqliteSubscriptionRepository, generation: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await repo.load()).generation >= generation) return;
    await Bun.sleep(1);
  }
  throw new Error(`generation ${generation} was not committed`);
}

async function harnessWithCatalog(
  catalogFactory: (real: CatalogRepository) => CatalogRepository,
  createDriver: () => StreamingDriver = () => new FakeDriver(),
  reconnect?: { maxAttempts: number; baseDelayMs: number }
) {
  const dir = mkdtemp(join(tmpdir(), "markethub-sup2-"));
  const handle = openDatabase({ dbPath: join(dir, "sup.sqlite") });
  runMigrations(handle.db, defaultMigrationsFolder);
  const realCatalog = new SqliteCatalogRepository(handle.db, handle.sqlite);
  const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
  const service = new MarketDataService({
    now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
  });
  const instances: StreamingDriver[] = [];
  const trackedCreate = () => {
    const instance = createDriver();
    instances.push(instance);
    return instance;
  };
  const supervisor = new StreamSupervisor({ service, subscriptions, catalog: catalogFactory(realCatalog), createDriver: trackedCreate, reconnect });
  const seed = async (canonicalId: string, nativeIdentifier: string) => {
    await realCatalog.transaction(async (tx) => {
      await tx.upsertInstrument(canonicalInstrumentSchema.parse({
        canonicalId, identityKey: `key:${canonicalId}`, exchange: "NSE", segment: "INDEX",
        marketType: "INDEX", instrumentCategory: "INDEX", canonicalSymbol: canonicalId, displayName: canonicalId
      }));
      await tx.upsertMapping(providerInstrumentMappingSchema.parse({
        provider: "UPSTOX", nativeIdentifier, canonicalId, status: "ACTIVE"
      }));
    });
  };
  const cleanup = () => {
    supervisor.stop();
    closeDatabaseHandle(handle);
    removeTempDir(dir);
  };
  return { subscriptions, service, supervisor, get driver() { return instances[0]!; }, instances, seed, cleanup };
}

/** Manual reconnect timer scheduler for deterministic timer-race tests. */
class ManualTimerScheduler implements ReconnectTimerScheduler {
  tasks: Array<{ handle: number; fn: () => void; ms: number; cancelled: boolean }> = [];
  private nextHandle = 1;

  set(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const handle = this.nextHandle++;
    this.tasks.push({ handle, fn, ms, cancelled: false });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }
  clear(handle: ReturnType<typeof setTimeout>): void {
    const task = this.tasks.find((t) => t.handle === (handle as unknown as number));
    if (task) task.cancelled = true;
  }
  fire(handle: ReturnType<typeof setTimeout>): void {
    const task = this.tasks.find((t) => t.handle === (handle as unknown as number));
    if (task && !task.cancelled) task.fn();
  }
  get active() {
    return this.tasks.filter((t) => !t.cancelled);
  }
}

async function harness(
  createDriver: () => StreamingDriver = () => new FakeDriver(),
  reconnect?: { maxAttempts: number; baseDelayMs: number },
  reconnectTimerScheduler?: ReconnectTimerScheduler
) {
  const dir = mkdtemp(join(tmpdir(), "markethub-sup-"));
  const handle = openDatabase({ dbPath: join(dir, "sup.sqlite") });
  runMigrations(handle.db, defaultMigrationsFolder);
  const catalog = new SqliteCatalogRepository(handle.db, handle.sqlite);
  const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
  const service = new MarketDataService({
    now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
  });
  const instances: StreamingDriver[] = [];
  const trackedCreate = () => {
    const instance = createDriver();
    instances.push(instance);
    return instance;
  };
  const supervisor = new StreamSupervisor({ service, subscriptions, catalog, createDriver: trackedCreate, reconnect, reconnectTimerScheduler });

  const seed = async (canonicalId: string, nativeIdentifier: string, mappingStatus: "ACTIVE" | "INACTIVE" = "ACTIVE", provider: "UPSTOX" | "FYERS" = "UPSTOX") => {
    await catalog.transaction(async (tx) => {
      await tx.upsertInstrument(canonicalInstrumentSchema.parse({
        canonicalId, identityKey: `key:${canonicalId}`, exchange: "NSE", segment: "INDEX",
        marketType: "INDEX", instrumentCategory: "INDEX", canonicalSymbol: canonicalId, displayName: canonicalId
      }));
      await tx.upsertMapping(providerInstrumentMappingSchema.parse({
        provider, nativeIdentifier, canonicalId, status: mappingStatus
      }));
    });
  };

  const cleanup = () => {
    supervisor.stop();
    closeDatabaseHandle(handle);
    removeTempDir(dir);
  };
  return { catalog, subscriptions, service, supervisor, get driver() { return instances[0]!; }, instances, seed, cleanup };
}

describe("StreamSupervisor", () => {
  test("loads persisted state and resolves only ACTIVE UPSTOX mappings", async () => {
    const h = await harness();
    await h.seed(A, "key-A");
    await h.seed(B, "key-B-INACTIVE", "INACTIVE");
    await h.seed(B, "key-B-FYERS", "ACTIVE", "FYERS");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }]);

    await h.supervisor.start();
    const driver = h.driver as FakeDriver;
    expect(driver.starts.length).toBe(1);
    expect(driver.starts[0]).toEqual([{ canonicalId: A, nativeIdentifier: "key-A" }]);

    const view = h.supervisor.getView();
    expect(view.generation).toBe(1);
    expect(view.runtime.generation).toBe(1); // successful reconciliation applied gen 1
    expect(view.runtime.resolutions.find((r) => r.canonicalId === B)!.available).toBe(false);
    expect(view.runtime.resolutions.find((r) => r.canonicalId === B)!.reason).toBe("NO_ACTIVE_UPSTOX_MAPPING");
    // Desired selections are tracked even when their mapping is unavailable.
    expect(h.service.getItem(A)).toBeDefined();
    expect(h.service.getItem(B)).toBeDefined();
    h.cleanup();
  });

  test("empty desired set stops the stream and untracks instruments", async () => {
    const h = await harness();
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    expect((h.driver as FakeDriver).starts.length).toBe(1);

    await h.supervisor.replaceSubscriptions([]);
    expect((h.driver as FakeDriver).stopCount).toBe(1);
    expect(h.supervisor.getView().runtime.connectionState).toBe("NOT_STARTED");
    expect(h.service.getItem(A)).toBeUndefined();
    h.cleanup();
  });

  test("reconciles subscription changes through the driver", async () => {
    const h = await harness();
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();

    await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }]);
    const driver = h.driver as FakeDriver;
    expect(driver.updates.length).toBe(1);
    expect(driver.updates[0]!.map((s) => s.canonicalId).sort()).toEqual([A, B]);
    expect(h.supervisor.getView().generation).toBe(2);
    h.cleanup();
  });

  test("propagates runtime connection state into the canonical service", async () => {
    const h = await harness();
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    (h.driver as FakeDriver).emitState("STREAMING");
    expect(h.service.getConnectionStatus("UPSTOX")?.state).toBe("STREAMING");
    h.cleanup();
  });

  test("rejects unknown and duplicate canonical ids atomically", async () => {
    const h = await harness();
    await h.seed(A, "key-A");
    await h.supervisor.start();
    let rejected = 0;
    try { await h.supervisor.replaceSubscriptions([{ canonicalId: "unknown", enabled: true }]); } catch { rejected++; }
    try {
      await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }, { canonicalId: A, enabled: false }]);
    } catch { rejected++; }
    expect(rejected).toBe(2);
    expect(h.supervisor.getView().selections).toEqual([]);
    h.cleanup();
  });

  test("late driver callbacks after stop are ignored", async () => {
    const h = await harness();
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    const driver = h.driver as FakeDriver;
    const callbacks = driver.callbacks!;
    h.supervisor.stop();
    const revision = h.service.revision;
    callbacks.onObservation(observation(A, 100));
    callbacks.onConnectionState("STREAMING");
    expect(h.service.revision).toBe(revision);
    h.cleanup();
  });

  test("bounded retry is exercised with a fresh failing driver per attempt", async () => {
    const h = await harness(() => {
      const d = new FakeDriver();
      d.failStart = true;
      return d;
    }, { maxAttempts: 1, baseDelayMs: 1 });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    expect(h.instances.length).toBe(1);
    expect((h.instances[0] as FakeDriver).starts.length).toBe(1);
    await Bun.sleep(50);
    expect(h.instances.length).toBe(2); // exactly one bounded retry
    // Retired instances are never restarted and stopped at most once.
    for (const instance of h.instances) {
      expect((instance as FakeDriver).starts.length).toBe(1);
      expect((instance as FakeDriver).stopCount).toBe(1);
    }
    expect(h.instances[0]).not.toBe(h.instances[1]);
    h.cleanup();
  });

  test("a bad observation cannot corrupt shared state", async () => {
    const h = await harness();
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    const driver = h.driver as FakeDriver;
    // Observation for an untracked instrument is rejected by the service but isolated.
    expect(() => driver.emitObservation(observation("untracked", 1))).not.toThrow();
    expect(h.service.getItem(A)).toBeDefined();
    h.cleanup();
  });
});

describe("review fixes — supervisor lifecycle and generation", () => {
  test("stop cancels a pending driver start and cleans up the resolved driver", async () => {
    const driver = new DeferredDriver();
    const h = await harness(() => driver);
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);

    const startPromise = h.supervisor.start();
    await driver.waitForStartCalled();
    expect(driver.starts.length).toBe(1);

    h.supervisor.stop();
    expect(driver.stopCount).toBe(1); // stopped while start() was still pending

    const revisionAtStop = h.service.revision;
    driver.resolvePendingStart();
    await startPromise;

    // Terminal retirement: the instance is stopped exactly once; late settlement is inert.
    expect(driver.stopCount).toBe(1);
    expect(h.service.revision).toBe(revisionAtStop);
    expect(h.service.getConnectionStatus("UPSTOX")?.state).toBe("NOT_STARTED");

    // Late callbacks from the resolved driver are ignored.
    driver.callbacks!.onObservation(observation(A, 100));
    driver.callbacks!.onConnectionState("STREAMING");
    expect(h.service.revision).toBe(revisionAtStop);
    h.cleanup();
  });

  test("stop then rejection of a pending start performs final cleanup", async () => {
    const driver = new DeferredDriver();
    const h = await harness(() => driver);
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);

    const startPromise = h.supervisor.start();
    await driver.waitForStartCalled();
    h.supervisor.stop();
    expect(driver.stopCount).toBe(1); // immediate stop while pending

    const revisionAtStop = h.service.revision;
    driver.rejectPendingStart();
    await startPromise;

    expect(driver.stopCount).toBe(1); // terminal retirement; late rejection is inert
    expect(h.service.revision).toBe(revisionAtStop);
    expect(h.service.getConnectionStatus("UPSTOX")?.state).toBe("NOT_STARTED");
    h.cleanup();
  });

  test("a current start failure cleans up before retrying with a fresh instance", async () => {
    const h = await harness(() => new AllocatingFailDriver(), { maxAttempts: 1, baseDelayMs: 1 });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();

    // First failed start already cleaned up its partial allocation.
    expect(h.instances.length).toBe(1);
    expect((h.instances[0] as AllocatingFailDriver).starts).toBe(1);
    expect((h.instances[0] as AllocatingFailDriver).stopCount).toBe(1);
    await Bun.sleep(50);
    expect(h.instances.length).toBe(2); // one bounded retry
    // Each instance started once and was stopped at most once; none restarted.
    for (const instance of h.instances) {
      expect((instance as AllocatingFailDriver).starts).toBe(1);
      expect((instance as AllocatingFailDriver).stopCount).toBe(1);
    }
    expect(h.instances[0]).not.toBe(h.instances[1]);
    h.cleanup();
  });

  test("a pending update rejection after stop leaves NOT_STARTED with no retry", async () => {
    const driver = new DeferredDriver();
    const h = await harness(() => driver, { maxAttempts: 1, baseDelayMs: 1 });
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);

    const startPromise = h.supervisor.start();
    await driver.waitForStartCalled();
    driver.resolvePendingStart();
    await startPromise; // driver is now started
    expect(driver.starts.length).toBe(1);

    const replacePromise = h.supervisor.replaceSubscriptions([
      { canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }
    ]);
    await driver.waitForUpdateCalled();
    expect(driver.updates.length).toBe(1);

    h.supervisor.stop();
    const revisionAtStop = h.service.revision;
    driver.rejectPendingUpdate();
    await replacePromise;

    expect(h.service.getConnectionStatus("UPSTOX")?.state).toBe("NOT_STARTED");
    expect(driver.starts.length).toBe(1); // no retry scheduled
    expect(h.service.revision).toBe(revisionAtStop); // no late canonical mutation
    h.cleanup();
  });

  test("a stale generation cannot mutate tracking or driver state after a concurrent commit", async () => {
    const dir = mkdtemp(join(tmpdir(), "markethub-race-"));
    const handle = openDatabase({ dbPath: join(dir, "race.sqlite") });
    runMigrations(handle.db, defaultMigrationsFolder);
    const realCatalog = new SqliteCatalogRepository(handle.db, handle.sqlite);
    const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
    const service = new MarketDataService({
      now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
    });
    const driver = new FakeDriver();
    const deferred = deferredMappings(realCatalog);
    const supervisor = new StreamSupervisor({ service, subscriptions, catalog: deferred.catalog, createDriver: () => driver });

    await realCatalog.transaction(async (tx) => {
      for (const [id, key] of [[A, "key-A"], [B, "key-B"]] as const) {
        await tx.upsertInstrument(canonicalInstrumentSchema.parse({
          canonicalId: id, identityKey: `key:${id}`, exchange: "NSE", segment: "INDEX",
          marketType: "INDEX", instrumentCategory: "INDEX", canonicalSymbol: id, displayName: id
        }));
        await tx.upsertMapping(providerInstrumentMappingSchema.parse({
          provider: "UPSTOX", nativeIdentifier: key, canonicalId: id, status: "ACTIVE"
        }));
      }
    });

    // Generation 1 with selection A, persisted directly (bypassing the supervisor).
    await subscriptions.replace([{ canonicalId: A, enabled: true }]);

    const startPromise = supervisor.start(); // reconcile gen 1, held on mapping resolution
    await deferred.waitForCall();

    // Commit generation 2 with selection B while gen 1 resolution is pending.
    const replacePromise = supervisor.replaceSubscriptions([{ canonicalId: B, enabled: true }]);
    await waitForGeneration(subscriptions, 2);

    await deferred.release();
    await startPromise;
    await replacePromise;

    // Stale gen 1 must not have tracked A or started/updated the driver with A.
    expect(service.getItem(A)).toBeUndefined();
    expect(service.getItem(B)).toBeDefined();
    expect(driver.starts.length).toBe(1);
    expect(driver.starts[0]).toEqual([{ canonicalId: B, nativeIdentifier: "key-B" }]);
    expect(driver.updates.length).toBe(0);
    expect(supervisor.getView().generation).toBe(2);
    expect(supervisor.getView().selections).toEqual([{ canonicalId: B, enabled: true }]);

    supervisor.stop();
    closeDatabaseHandle(handle);
    removeTempDir(dir);
  });

  test("post-commit reconciliation failure is captured in runtime status, not thrown", async () => {
    const dir = mkdtemp(join(tmpdir(), "markethub-reconfail-"));
    const handle = openDatabase({ dbPath: join(dir, "fail.sqlite") });
    runMigrations(handle.db, defaultMigrationsFolder);
    const realCatalog = new SqliteCatalogRepository(handle.db, handle.sqlite);
    const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
    const service = new MarketDataService({
      now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
    });
    const failingCatalog = {
      async getInstrumentByCanonicalId(canonicalId: string) {
        return realCatalog.getInstrumentByCanonicalId(canonicalId);
      },
      async listMappingsByCanonicalId(): Promise<ProviderInstrumentMapping[]> {
        throw new Error("mapping resolution failed");
      }
    } as unknown as CatalogRepository;
    const supervisor = new StreamSupervisor({
      service, subscriptions, catalog: failingCatalog, createDriver: () => new FakeDriver()
    });

    await realCatalog.transaction(async (tx) => {
      await tx.upsertInstrument(canonicalInstrumentSchema.parse({
        canonicalId: A, identityKey: `key:${A}`, exchange: "NSE", segment: "INDEX",
        marketType: "INDEX", instrumentCategory: "INDEX", canonicalSymbol: A, displayName: A
      }));
    });

    const result = await supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }]);
    // Desired state is committed and exposed despite the runtime failure.
    expect(result.generation).toBe(1);
    expect(result.view.selections).toEqual([{ canonicalId: A, enabled: true }]);
    expect(result.view.runtime.lastError).toContain("mapping resolution failed");
    expect((await subscriptions.load()).generation).toBe(1);

    supervisor.stop();
    closeDatabaseHandle(handle);
    removeTempDir(dir);
  });

  test("desired generation advances while applied generation stays on reconciliation failure", async () => {
    let toggle!: ReturnType<typeof toggleableMappings>;
    const h = await harnessWithCatalog((real) => {
      toggle = toggleableMappings(real);
      return toggle.catalog;
    });
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]); // gen 1
    await h.supervisor.start(); // gen 1 applies successfully
    expect(h.supervisor.getView().runtime.generation).toBe(1);

    toggle.setFail(true);
    await h.supervisor.replaceSubscriptions([{ canonicalId: B, enabled: true }]); // gen 2 fails
    const view = h.supervisor.getView();
    expect(view.generation).toBe(2); // desired committed
    expect(view.runtime.generation).toBe(1); // applied unchanged
    expect(view.runtime.lastError).toContain("mapping resolution failed");
    expect(view.selections).toEqual([{ canonicalId: B, enabled: true }]); // not hidden
    h.cleanup();
  });

  test("applied generation advances after a successful retry of the same generation", async () => {
    let toggle!: ReturnType<typeof toggleableMappings>;
    const h = await harnessWithCatalog((real) => {
      toggle = toggleableMappings(real);
      return toggle.catalog;
    }, () => new FakeDriver(), { maxAttempts: 1, baseDelayMs: 1 });
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]); // gen 1
    await h.supervisor.start();
    expect(h.supervisor.getView().runtime.generation).toBe(1);

    toggle.setFail(true);
    await h.supervisor.replaceSubscriptions([{ canonicalId: B, enabled: true }]); // gen 2 fails
    expect(h.supervisor.getView().runtime.generation).toBe(1);

    toggle.setFail(false);
    // A driver-reported disconnect triggers a bounded reconnect that reconciles
    // the latest committed generation (2) without a new PUT.
    (h.instances[0] as FakeDriver).emitState("DISCONNECTED");
    await Bun.sleep(50);

    expect(h.instances.length).toBe(2);
    for (const instance of h.instances) {
      expect((instance as FakeDriver).starts.length).toBe(1); // never restarted
      expect((instance as FakeDriver).stopCount).toBeLessThanOrEqual(1); // at most once
    }
    const view = h.supervisor.getView();
    expect(view.generation).toBe(2);
    expect(view.runtime.generation).toBe(2); // advanced after successful retry
    expect(view.runtime.lastError).toBeNull();
    h.cleanup();
  });
});

describe("final supervisor lifecycle corrections", () => {
  test("DISCONNECTED retires the driver and retries with a fresh start", async () => {
    const h = await harness(() => new FakeDriver(), { maxAttempts: 1, baseDelayMs: 1 });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();

    const first = h.instances[0] as FakeDriver;
    expect(first.starts.length).toBe(1);
    expect(first.updates.length).toBe(0);
    expect(h.supervisor.getView().runtime.generation).toBe(1);
    const oldCallbacks = first.callbackHistory[0]!;

    // Simulate the driver losing its session.
    first.emitState("DISCONNECTED");
    expect(first.stopCount).toBe(1); // old driver retired immediately

    // Bounded retry must perform a fresh start, not update the dead driver.
    await Bun.sleep(50);
    expect(h.instances.length).toBe(2);
    const second = h.instances[1] as FakeDriver;
    expect(second.starts.length).toBe(1);
    expect(second.updates.length).toBe(0);
    expect(first.starts.length).toBe(1); // retired instance never restarted
    expect(first.stopCount).toBe(1); // stopped at most once

    // New driver instance reaches STREAMING.
    second.emitState("STREAMING");
    const view = h.supervisor.getView();
    expect(view.runtime.connectionState).toBe("STREAMING");
    expect(view.runtime.generation).toBe(1);

    // Callbacks retained by the old driver cannot mutate canonical state or
    // the new driver's connection state.
    const revision = h.service.revision;
    oldCallbacks.onObservation(observation(A, 999));
    oldCallbacks.onConnectionState("ERROR", "late error");
    expect(h.service.revision).toBe(revision);
    expect(h.supervisor.getView().runtime.connectionState).toBe("STREAMING");
    h.cleanup();
  });

  test("ERROR retires the driver and retries with a fresh start", async () => {
    const h = await harness(() => new FakeDriver(), { maxAttempts: 1, baseDelayMs: 1 });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    const first = h.instances[0] as FakeDriver;
    const oldCallbacks = first.callbackHistory[0]!;

    first.emitState("ERROR", "stream failed");
    expect(h.supervisor.getView().runtime.lastError).toContain("stream failed"); // recorded immediately
    await Bun.sleep(50);
    expect(h.instances.length).toBe(2);
    const second = h.instances[1] as FakeDriver;
    expect(second.starts.length).toBe(1);
    expect(second.updates.length).toBe(0);
    expect(first.starts.length).toBe(1); // retired instance never restarted
    expect(first.stopCount).toBe(1); // stopped at most once

    second.emitState("STREAMING");
    expect(h.supervisor.getView().runtime.lastError).toBeNull(); // cleared on successful restart
    const revision = h.service.revision;
    oldCallbacks.onObservation(observation(A, 999));
    oldCallbacks.onConnectionState("DISCONNECTED");
    expect(h.service.revision).toBe(revision);
    expect(h.supervisor.getView().runtime.connectionState).toBe("STREAMING");
    h.cleanup();
  });

  test("empty desired set retires the driver and invalidates its callbacks", async () => {
    const driver = new FakeDriver();
    const h = await harness(() => driver);
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    const oldCallbacks = driver.callbackHistory[0]!;
    const stopCountBefore = driver.stopCount;

    await h.supervisor.replaceSubscriptions([]); // no eligible mappings / empty set
    expect(driver.stopCount).toBe(stopCountBefore + 1);
    expect(h.supervisor.getView().runtime.connectionState).toBe("NOT_STARTED");

    const revision = h.service.revision;
    oldCallbacks.onObservation(observation(A, 999));
    oldCallbacks.onConnectionState("STREAMING");
    expect(h.service.revision).toBe(revision);
    expect(h.supervisor.getView().runtime.connectionState).toBe("NOT_STARTED");
    h.cleanup();
  });

  test("pending update resolving after stop cleans up again without advancing applied generation", async () => {
    const driver = new DeferredDriver();
    const h = await harness(() => driver);
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);

    const startPromise = h.supervisor.start();
    await driver.waitForStartCalled();
    driver.resolvePendingStart();
    await startPromise;
    expect(h.supervisor.getView().runtime.generation).toBe(1);

    const replacePromise = h.supervisor.replaceSubscriptions([
      { canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }
    ]);
    await driver.waitForUpdateCalled();
    const stopCountBefore = driver.stopCount;

    h.supervisor.stop();
    expect(driver.stopCount).toBe(stopCountBefore + 1); // immediate stop

    const revisionAtStop = h.service.revision;
    driver.resolvePendingUpdate();
    await replacePromise;

    expect(driver.stopCount).toBe(stopCountBefore + 1); // terminal retirement; late settlement is inert
    expect(h.supervisor.getView().runtime.connectionState).toBe("NOT_STARTED");
    expect(h.supervisor.getView().runtime.generation).toBe(1); // not advanced
    expect(h.service.revision).toBe(revisionAtStop);

    const oldCallbacks = driver.callbackHistory[0]!;
    oldCallbacks.onObservation(observation(A, 999));
    oldCallbacks.onConnectionState("STREAMING");
    expect(h.service.revision).toBe(revisionAtStop);
    expect(h.supervisor.getView().runtime.connectionState).toBe("NOT_STARTED");
    h.cleanup();
  });

  test("pending update rejecting after stop cleans up again with no retry or state overwrite", async () => {
    const driver = new DeferredDriver();
    const h = await harness(() => driver, { maxAttempts: 1, baseDelayMs: 1 });
    await h.seed(A, "key-A");
    await h.seed(B, "key-B");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);

    const startPromise = h.supervisor.start();
    await driver.waitForStartCalled();
    driver.resolvePendingStart();
    await startPromise;

    const replacePromise = h.supervisor.replaceSubscriptions([
      { canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }
    ]);
    await driver.waitForUpdateCalled();
    const stopCountBefore = driver.stopCount;

    h.supervisor.stop();
    const revisionAtStop = h.service.revision;
    driver.rejectPendingUpdate(new Error("late update failure"));
    await replacePromise;
    await Bun.sleep(30); // surface any incorrect retry

    expect(driver.stopCount).toBe(stopCountBefore + 1); // terminal retirement; late settlement is inert
    expect(driver.starts.length).toBe(1); // no retry
    const view = h.supervisor.getView();
    expect(view.runtime.connectionState).toBe("NOT_STARTED");
    expect(view.runtime.lastError).toBeNull(); // no new runtime error after shutdown
    expect(view.runtime.generation).toBe(1); // not advanced
    expect(h.service.revision).toBe(revisionAtStop);

    const oldCallbacks = driver.callbackHistory[0]!;
    oldCallbacks.onObservation(observation(A, 999));
    oldCallbacks.onConnectionState("ERROR", "late error");
    expect(h.service.revision).toBe(revisionAtStop);
    expect(h.supervisor.getView().runtime.connectionState).toBe("NOT_STARTED");
    h.cleanup();
  });

  test("stale reconnect timer is cancelled so a newer driver epoch can retry", async () => {
    const scheduler = new ManualTimerScheduler();
    const h = await harness(() => new FakeDriver(), { maxAttempts: 3, baseDelayMs: 1000 }, scheduler);
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();

    // 1. Driver A started successfully.
    const a = h.instances[0] as FakeDriver;
    expect(a.starts.length).toBe(1);
    const callbacksA = a.callbackHistory[0]!;

    // 2. A disconnects -> reconnect timer T1 is scheduled.
    a.emitState("DISCONNECTED");
    expect(scheduler.active.length).toBe(1);
    const t1 = scheduler.active[0]!.handle;

    // 3. Before T1 fires, a subscription replacement starts fresh driver B.
    await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }]);
    expect(h.instances.length).toBe(2);
    const b = h.instances[1] as FakeDriver;
    const callbacksB = b.callbackHistory[0]!;
    // T1 is still pending at this point (a fresh start does not retire a timer).
    expect(scheduler.active.some((t) => t.handle === t1)).toBe(true);

    // 4. B disconnects before T1 fires.
    b.emitState("DISCONNECTED");
    // 5. T1 is cancelled and a new timer T2 is scheduled for B.
    expect(scheduler.tasks.find((t) => t.handle === t1)!.cancelled).toBe(true);
    expect(scheduler.active.length).toBe(1);
    const t2 = scheduler.active[0]!.handle;
    expect(t2).not.toBe(t1);

    // 6. Fire T2 -> a third fresh start occurs; no update of a dead driver.
    scheduler.fire(t2);
    await Bun.sleep(20);
    expect(h.instances.length).toBe(3);
    const c = h.instances[2] as FakeDriver;
    expect(c.starts.length).toBe(1);
    expect(a.updates.length).toBe(0);
    expect(b.updates.length).toBe(0);
    for (const instance of [a, b, c]) {
      expect(instance.starts.length).toBe(1); // retired instances never restarted
      expect(instance.stopCount).toBeLessThanOrEqual(1); // at most once
    }

    // 8. Callbacks from A and B cannot mutate canonical state or connection state.
    const revision = h.service.revision;
    const stateBefore = h.supervisor.getView().runtime.connectionState;
    callbacksA.onObservation(observation(A, 999));
    callbacksA.onConnectionState("ERROR", "late A error");
    callbacksB.onObservation(observation(A, 888));
    callbacksB.onConnectionState("DISCONNECTED");
    expect(h.service.revision).toBe(revision);
    expect(h.supervisor.getView().runtime.connectionState).toBe(stateBefore);
    h.cleanup();
  });

  test("confirmed STREAMING cancels a stale reconnect timer from a retired instance", async () => {
    const scheduler = new ManualTimerScheduler();
    const h = await harness(() => new FakeDriver(), { maxAttempts: 3, baseDelayMs: 1000 }, scheduler);
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();

    // A disconnects and schedules T1.
    const a = h.instances[0] as FakeDriver;
    a.emitState("DISCONNECTED");
    expect(scheduler.active.length).toBe(1);
    const t1 = scheduler.active[0]!.handle;

    // A manual reconciliation starts fresh B while T1 is still pending.
    await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }]);
    expect(h.instances.length).toBe(2);
    const b = h.instances[1] as FakeDriver;
    expect(scheduler.active.some((t) => t.handle === t1)).toBe(true);

    // B confirms STREAMING -> the stale timer is cancelled.
    b.emitState("STREAMING");
    expect(scheduler.tasks.find((t) => t.handle === t1)!.cancelled).toBe(true);
    expect(scheduler.active.length).toBe(0);

    // Firing the stale timer cannot trigger a redundant reconciliation.
    const startsBefore = h.instances.reduce((n, i) => n + (i as FakeDriver).starts.length, 0);
    const updatesBefore = h.instances.reduce((n, i) => n + (i as FakeDriver).updates.length, 0);
    scheduler.fire(t1);
    await Bun.sleep(20);
    expect(h.instances.length).toBe(2); // no new instance acquired
    expect(h.instances.reduce((n, i) => n + (i as FakeDriver).starts.length, 0)).toBe(startsBefore);
    expect(h.instances.reduce((n, i) => n + (i as FakeDriver).updates.length, 0)).toBe(updatesBefore);
    expect(h.supervisor.getView().runtime.connectionState).toBe("STREAMING");
    h.cleanup();
  });
});

describe("locked production driver boundary", () => {
  test("locked driver fails safely and never constructs an SDK or schedules retries", async () => {
    const locked = new LockedUpstoxDriver();
    expect(locked.getConnectionState()).toBe("NOT_STARTED");
    let rejected = 0;
    const signal = new AbortController().signal;
    try { await locked.start([], { onObservation: () => {}, onConnectionState: () => {} }, signal); } catch (e) {
      expect(e).toBeInstanceOf(DriverLockedError); rejected++;
    }
    try { await locked.updateSubscriptions([], signal); } catch (e) {
      expect(e).toBeInstanceOf(DriverLockedError); rejected++;
    }
    expect(() => locked.stop()).not.toThrow();
    expect(rejected).toBe(2);
    expect(locked.getConnectionState()).toBe("NOT_STARTED");
  });

  test("supervisor with the locked driver reports ERROR without any real connection", async () => {
    const h = await harness(() => new LockedUpstoxDriver());
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    const view = h.supervisor.getView();
    expect(view.generation).toBe(1); // desired generation loaded at startup
    expect(view.runtime.generation).toBe(0); // no successful reconciliation yet
    const runtime = view.runtime;
    expect(runtime.connectionState).toBe("ERROR");
    expect(runtime.lastError).toContain("locked");
    // No retry is scheduled: state stays ERROR after a wait.
    await Bun.sleep(20);
    expect(h.supervisor.getView().runtime.connectionState).toBe("ERROR");
    h.cleanup();
  });
});
