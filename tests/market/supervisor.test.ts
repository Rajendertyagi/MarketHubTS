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
  type DriverCallbacks, type DriverSubscription, type StreamingDriver
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
  state = "NOT_STARTED";
  failStart = false;

  async start(subs: DriverSubscription[], callbacks: DriverCallbacks): Promise<void> {
    this.starts.push(subs.map((s) => ({ ...s })));
    this.callbacks = callbacks;
    if (this.failStart) throw new Error("start failed");
    this.state = "CONNECTING";
    callbacks.onConnectionState("CONNECTING");
  }
  async updateSubscriptions(subs: DriverSubscription[]): Promise<void> {
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

async function harness(driver: StreamingDriver = new FakeDriver(), reconnect?: { maxAttempts: number; baseDelayMs: number }) {
  const dir = mkdtemp(join(tmpdir(), "markethub-sup-"));
  const handle = openDatabase({ dbPath: join(dir, "sup.sqlite") });
  runMigrations(handle.db, defaultMigrationsFolder);
  const catalog = new SqliteCatalogRepository(handle.db, handle.sqlite);
  const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite);
  const service = new MarketDataService({
    now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
  });
  const supervisor = new StreamSupervisor({ service, subscriptions, catalog, driver, reconnect });

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
  return { catalog, subscriptions, service, supervisor, driver, seed, cleanup };
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

  test("bounded retry is exercised with a fake driver", async () => {
    const driver = new FakeDriver();
    driver.failStart = true;
    const h = await harness(driver, { maxAttempts: 1, baseDelayMs: 1 });
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    expect(driver.starts.length).toBe(1);
    await Bun.sleep(50);
    expect(driver.starts.length).toBe(2); // exactly one bounded retry
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

describe("locked production driver boundary", () => {
  test("locked driver fails safely and never constructs an SDK or schedules retries", async () => {
    const locked = new LockedUpstoxDriver();
    expect(locked.getConnectionState()).toBe("NOT_STARTED");
    let rejected = 0;
    try { await locked.start([], { onObservation: () => {}, onConnectionState: () => {} }); } catch (e) {
      expect(e).toBeInstanceOf(DriverLockedError); rejected++;
    }
    try { await locked.updateSubscriptions([]); } catch (e) {
      expect(e).toBeInstanceOf(DriverLockedError); rejected++;
    }
    expect(() => locked.stop()).not.toThrow();
    expect(rejected).toBe(2);
    expect(locked.getConnectionState()).toBe("NOT_STARTED");
  });

  test("supervisor with the locked driver reports ERROR without any real connection", async () => {
    const h = await harness(new LockedUpstoxDriver());
    await h.seed(A, "key-A");
    await h.subscriptions.replace([{ canonicalId: A, enabled: true }]);
    await h.supervisor.start();
    const runtime = h.supervisor.getView().runtime;
    expect(runtime.connectionState).toBe("ERROR");
    expect(runtime.lastError).toContain("locked");
    // No retry is scheduled: state stays ERROR after a wait.
    await Bun.sleep(20);
    expect(h.supervisor.getView().runtime.connectionState).toBe("ERROR");
    h.cleanup();
  });
});
