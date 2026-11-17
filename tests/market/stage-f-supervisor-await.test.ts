import { describe, expect, test } from "bun:test";
import type {
  ProviderInstrumentMapping, SubscriptionRepository, SubscriptionSelection, SubscriptionState
} from "../../packages/contracts/src/index";
import type { CatalogRepository } from "../../packages/market-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import {
  StreamSupervisor, SubscriptionPersistenceError, SubscriptionValidationError,
  type DriverCallbacks, type DriverSubscription, type StreamingDriver
} from "../../apps/api/src/stream-supervisor";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const BASE = 1_700_000_000_000;
const policy = { openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000 };
const flush = async () => { await Bun.sleep(0); };

class FakeSubscriptions implements SubscriptionRepository {
  state: SubscriptionState = { generation: 0, selections: [] };
  failLoad = false;
  failReplace = false;
  loadCalls = 0;
  async load(): Promise<SubscriptionState> {
    this.loadCalls++;
    if (this.failLoad) throw new Error("load failed");
    return { generation: this.state.generation, selections: this.state.selections.map((s) => ({ ...s })) };
  }
  async replace(selections: SubscriptionSelection[]): Promise<number> {
    if (this.failReplace) throw new Error("replace failed");
    this.state = { generation: this.state.generation + 1, selections: selections.map((s) => ({ ...s })) };
    return this.state.generation;
  }
}

class FakeDriver implements StreamingDriver {
  starts: DriverSubscription[][] = [];
  updates: DriverSubscription[][] = [];
  stopCount = 0;
  callbacks: DriverCallbacks | null = null;
  failStart = false;
  failUpdate = false;
  async start(subs: DriverSubscription[], callbacks: DriverCallbacks, _signal: AbortSignal): Promise<void> {
    this.starts.push(subs.map((s) => ({ ...s })));
    this.callbacks = callbacks;
    if (this.failStart) throw new Error("start failed");
  }
  async updateSubscriptions(subs: DriverSubscription[], _signal: AbortSignal): Promise<void> {
    this.updates.push(subs.map((s) => ({ ...s })));
    if (this.failUpdate) throw new Error("update failed");
  }
  stop(): void { this.stopCount++; }
  getConnectionState() { return "NOT_STARTED"; }
}

function mapping(): ProviderInstrumentMapping {
  return { provider: "UPSTOX", nativeIdentifier: "key-A", canonicalId: A, status: "ACTIVE" } as ProviderInstrumentMapping;
}

function harness(opts: {
  subscriptions?: FakeSubscriptions;
  catalog?: CatalogRepository;
  driver?: StreamingDriver;
  maxAttempts?: number;
  baseDelayMs?: number;
} = {}) {
  const subscriptions = opts.subscriptions ?? new FakeSubscriptions();
  const catalog = opts.catalog ?? ({
    async getInstrumentByCanonicalId() { return { canonicalId: A } as any; },
    async listMappingsByCanonicalId() { return [mapping()]; }
  } as unknown as CatalogRepository);
  const service = new MarketDataService({
    now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
  });
  const driver = opts.driver ?? new FakeDriver();
  const supervisor = new StreamSupervisor({
    service, subscriptions, catalog, createDriver: () => driver,
    reconnect: { maxAttempts: opts.maxAttempts ?? 5, baseDelayMs: opts.baseDelayMs ?? 1000 },
    sleep: async () => {}
  });
  return { subscriptions, catalog, service, driver, supervisor };
}

describe("Stage F — supervisor await points (#1–#8)", () => {
  test("#1 subscriptions.load() in start() propagates out untyped", async () => {
    const subscriptions = new FakeSubscriptions();
    subscriptions.failLoad = true;
    const h = harness({ subscriptions });
    let message = "";
    try { await h.supervisor.start(); } catch (e) { message = (e as Error).message; }
    expect(message).toBe("load failed");
  });

  test("#2 catalog.getInstrumentByCanonicalId() failure propagates raw, not SubscriptionValidationError", async () => {
    const catalog = {
      async getInstrumentByCanonicalId() { throw new Error("catalog lookup failed"); },
      async listMappingsByCanonicalId() { return [mapping()]; }
    } as unknown as CatalogRepository;
    const h = harness({ catalog });
    let error: unknown = null;
    try { await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }]); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("catalog lookup failed");
    expect(error).not.toBeInstanceOf(SubscriptionValidationError);
  });

  test("#3 subscriptions.replace() failure becomes SubscriptionPersistenceError", async () => {
    const subscriptions = new FakeSubscriptions();
    subscriptions.failReplace = true;
    const h = harness({ subscriptions });
    let error: unknown = null;
    try { await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }]); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SubscriptionPersistenceError);
    expect((error as Error).message).toContain("replace failed");
  });

  test("#4 subscriptions.load() in reconcile is caught into lastError", async () => {
    const subscriptions = new FakeSubscriptions();
    subscriptions.state = { generation: 1, selections: [{ canonicalId: A, enabled: true }] };
    const h = harness({ subscriptions });
    // First load in start() succeeds; subsequent load in reconcile fails.
    let calls = 0;
    const original = subscriptions.load.bind(subscriptions);
    subscriptions.load = async () => {
      calls++;
      if (calls > 1) throw new Error("reconcile load failed");
      return original();
    };
    await h.supervisor.start();
    expect(h.supervisor.getView().runtime.lastError).toContain("reconcile load failed");
  });

  test("#5 catalog.listMappingsByCanonicalId() failure is caught; desired state preserved", async () => {
    const catalog = {
      async getInstrumentByCanonicalId() { return { canonicalId: A } as any; },
      async listMappingsByCanonicalId() { throw new Error("mapping failed"); }
    } as unknown as CatalogRepository;
    const h = harness({ catalog });
    const result = await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }]);
    expect(result.generation).toBe(1);
    expect(result.view.selections).toEqual([{ canonicalId: A, enabled: true }]);
    expect(result.view.runtime.lastError).toContain("mapping failed");
    expect(result.view.runtime.generation).toBe(0);
  });

  test("#6 subscriptions.load() generation-guard failure is caught; no driver application", async () => {
    const subscriptions = new FakeSubscriptions();
    subscriptions.state = { generation: 1, selections: [{ canonicalId: A, enabled: true }] };
    const h = harness({ subscriptions });
    let calls = 0;
    const original = subscriptions.load.bind(subscriptions);
    subscriptions.load = async () => {
      calls++;
      // start() load (1), reconcile load (2), generation guard load (3)
      if (calls === 3) throw new Error("guard load failed");
      return original();
    };
    await h.supervisor.start();
    expect(h.supervisor.getView().runtime.lastError).toContain("guard load failed");
    expect((h.driver as FakeDriver).starts.length).toBe(0);
  });

  test("#7 driver.updateSubscriptions() rejection retires and reports failed", async () => {
    const driver = new FakeDriver();
    driver.failUpdate = true;
    const subscriptions = new FakeSubscriptions();
    subscriptions.state = { generation: 1, selections: [{ canonicalId: A, enabled: true }] };
    const h = harness({ driver, subscriptions, maxAttempts: 2, baseDelayMs: 1 });
    await h.supervisor.start();
    expect(driver.starts.length).toBe(1);
    await h.supervisor.replaceSubscriptions([{ canonicalId: A, enabled: true }]);
    expect(driver.updates.length).toBe(1);
    expect(driver.stopCount).toBe(1);
    expect(h.supervisor.getLastOperationOutcome()).toMatchObject({ kind: "failed" });
    h.supervisor.stop();
  });

  test("#8 driver.start() rejection retires and reports failed", async () => {
    const driver = new FakeDriver();
    driver.failStart = true;
    const subscriptions = new FakeSubscriptions();
    subscriptions.state = { generation: 1, selections: [{ canonicalId: A, enabled: true }] };
    const h = harness({ driver, subscriptions, maxAttempts: 1, baseDelayMs: 1 });
    await h.supervisor.start();
    expect(driver.starts.length).toBe(1);
    expect(driver.stopCount).toBe(1);
    expect(h.supervisor.getLastOperationOutcome()).toMatchObject({ kind: "failed" });
    expect(h.supervisor.getView().runtime.connectionState).toBe("ERROR");
    h.supervisor.stop();
  });
});
