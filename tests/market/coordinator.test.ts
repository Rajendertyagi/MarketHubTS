import { describe, expect, test } from "bun:test";
import { mkdtempSync as mkdtemp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FreshnessPolicy,
  NormalizeObservationInput,
  ProviderId,
  ProviderInstrumentMapping
} from "../../packages/contracts/src/index";
import { canonicalInstrumentSchema, providerInstrumentMappingSchema } from "../../packages/contracts/src/index";
import {
  openDatabase, runMigrations, defaultMigrationsFolder,
  SqliteCatalogRepository, SqliteSubscriptionRepository
} from "../../packages/database/src/index";
import { MarketDataService, type CatalogRepository } from "../../packages/market-core/src/index";
import {
  StreamSupervisor,
  type DriverCallbacks,
  type DriverSubscription,
  type StreamingDriver
} from "../../apps/api/src/stream-supervisor";
import { SubscriptionCoordinator } from "../../apps/api/src/subscription-coordinator";
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
  failStart = false;
  failWithLimit = false;
  state = "NOT_STARTED";

  async start(subs: DriverSubscription[], callbacks: DriverCallbacks, _signal: AbortSignal): Promise<void> {
    this.starts.push(subs.map((s) => ({ ...s })));
    this.callbacks = callbacks;
    if (this.failWithLimit) {
      callbacks.onTerminalFailure?.({
        kind: "LIMITED",
        reason: "maximum symbol limit exceeded",
        capabilities: [
          { component: "quote", provider: "FYERS", status: "LIMITED", reason: "maximum symbol limit exceeded", entitlementUnverified: true }
        ]
      });
      callbacks.onConnectionState("ERROR", "FYERS Data Socket limit: maximum symbol limit exceeded");
      throw new Error("FYERS Data Socket limit: maximum symbol limit exceeded");
    }
    if (this.failStart) throw new Error("start failed");
    this.state = "CONNECTING";
    callbacks.onConnectionState("CONNECTING");
  }
  async updateSubscriptions(subs: DriverSubscription[], _signal: AbortSignal): Promise<void> {
    this.updates.push(subs.map((s) => ({ ...s })));
  }
  stop(): void { this.stopCount++; this.state = "DISCONNECTED"; }
  getConnectionState() { return this.state; }
}

function observation(provider: ProviderId, canonicalId: string): NormalizeObservationInput {
  return {
    provider, canonicalId, value: { ltp: 100 },
    rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time", receivedAtMs: BASE
  };
}

function instrument(canonicalId: string) {
  return canonicalInstrumentSchema.parse({
    canonicalId,
    identityKey: canonicalId,
    exchange: "NSE",
    segment: "INDEX",
    marketType: "INDEX",
    instrumentCategory: "INDEX",
    canonicalSymbol: canonicalId,
    displayName: canonicalId
  });
}

function mapping(provider: ProviderId, canonicalId: string, native: string): ProviderInstrumentMapping {
  return providerInstrumentMappingSchema.parse({
    provider, nativeIdentifier: native, canonicalId, status: "ACTIVE"
  });
}

function harness(maxInstruments = 10) {
  const dir = mkdtemp(join(tmpdir(), "mh-coordinator-"));
  const db = openDatabase({ dbPath: join(dir, "test.sqlite") });
  runMigrations(db.db, defaultMigrationsFolder);
  const subscriptions = new SqliteSubscriptionRepository(db.db, db.sqlite);
  const catalog = new SqliteCatalogRepository(db.db, db.sqlite);
  const service = new MarketDataService({
    now: () => new Date(BASE), policy, maxInstruments, session: () => "OPEN"
  });

  const upstoxDriver = new FakeDriver();
  const fyersDriver = new FakeDriver();
  const upstox = new StreamSupervisor({
    service, subscriptions, catalog, provider: "UPSTOX", coordinated: true,
    createDriver: () => upstoxDriver
  });
  const fyers = new StreamSupervisor({
    service, subscriptions, catalog, provider: "FYERS", coordinated: true,
    createDriver: () => fyersDriver
  });
  const coordinator = new SubscriptionCoordinator({
    service, subscriptions, catalog,
    runtimes: [{ provider: "UPSTOX", supervisor: upstox }, { provider: "FYERS", supervisor: fyers }]
  });

  const seed = async (items: Array<{ instrument: ReturnType<typeof instrument>; mappings: ProviderInstrumentMapping[] }>) => {
    await catalog.transaction(async (tx) => {
      for (const item of items) {
        await tx.upsertInstrument(item.instrument);
        for (const mapping of item.mappings) await tx.upsertMapping(mapping);
      }
    });
  };

  return {
    dir, db, service, subscriptions, catalog, coordinator, upstox, fyers, upstoxDriver, fyersDriver, seed,
    cleanup: () => { coordinator.stop(); closeDatabaseHandle(db); removeTempDir(dir); }
  };
}

describe("SubscriptionCoordinator ownership", () => {
  test("exactly one durable generation writer and both runtimes reconcile the same desired state", async () => {
    const h = harness();
    try {
      await h.seed([
        { instrument: instrument(A), mappings: [mapping("UPSTOX", A, "U-A"), mapping("FYERS", A, "F-A")] },
        { instrument: instrument(B), mappings: [] }
      ]);

      await h.upstox.start();
      await h.fyers.start();
      await h.coordinator.start();
      const result = await h.coordinator.replaceSubscriptions([
        { canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }
      ]);

      expect(result.generation).toBe(1);
      expect(h.upstoxDriver.starts.length).toBe(1);
      expect(h.fyersDriver.starts.length).toBe(1);
      expect(h.upstoxDriver.starts[0]?.map((s) => s.nativeIdentifier)).toEqual(["U-A"]);
      expect(h.fyersDriver.starts[0]?.map((s) => s.nativeIdentifier)).toEqual(["F-A"]);
      expect(h.upstox.getView().runtime.generation).toBe(1);
      expect(h.fyers.getView().runtime.generation).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("coordinator owns shared track/untrack; runtimes never modify tracking", async () => {
    const h = harness();
    try {
      await h.seed([{ instrument: instrument(A), mappings: [mapping("UPSTOX", A, "U-A")] }]);
      await h.upstox.start();
      await h.fyers.start();
      await h.coordinator.start();
      await h.coordinator.replaceSubscriptions([{ canonicalId: A, enabled: true }]);
      expect(h.service.getItem(A)).toBeDefined();

      await h.coordinator.replaceSubscriptions([]);
      expect(h.service.getItem(A)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("one provider failure does not affect the other runtime", async () => {
    const h = harness();
    try {
      await h.seed([
        { instrument: instrument(A), mappings: [mapping("UPSTOX", A, "U-A"), mapping("FYERS", A, "F-A")] }
      ]);
      h.upstoxDriver.failStart = true;
      await h.upstox.start();
      await h.fyers.start();
      await h.coordinator.start();
      await h.coordinator.replaceSubscriptions([{ canonicalId: A, enabled: true }]);

      expect(h.fyersDriver.starts.length).toBe(1);
      expect(h.fyers.getView().runtime.connectionState).toBe("CONNECTING");
    } finally {
      h.cleanup();
    }
  });

  test("a FYERS typed LIMITED failure leaves the UPSTOX runtime fully independent", async () => {
    const h = harness();
    try {
      await h.seed([
        { instrument: instrument(A), mappings: [mapping("UPSTOX", A, "U-A"), mapping("FYERS", A, "F-A")] }
      ]);
      h.fyersDriver.failWithLimit = true;
      await h.upstox.start();
      await h.fyers.start();
      await h.coordinator.start();
      await h.coordinator.replaceSubscriptions([{ canonicalId: A, enabled: true }]);

      // FYERS is terminally limited with structured capabilities.
      const fyView = h.fyers.getView();
      expect(fyView.runtime.connectionState).toBe("ERROR");
      expect(fyView.runtime.capabilities?.find((c) => c.component === "quote")?.status).toBe("LIMITED");

      // UPSTOX is unaffected: streaming, no limitation state, generation applied.
      const upView = h.upstox.getView();
      expect(upView.runtime.connectionState).toBe("CONNECTING");
      expect(upView.runtime.capabilities).toBeUndefined();
      expect(upView.runtime.lastError).toBeNull();
      expect(upView.runtime.generation).toBe(1);
      expect(h.upstoxDriver.starts).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test("mapping failure is provider-specific", async () => {
    const h = harness();
    try {
      await h.seed([{ instrument: instrument(A), mappings: [mapping("UPSTOX", A, "U-A")] }]);
      await h.upstox.start();
      await h.fyers.start();
      await h.coordinator.start();
      await h.coordinator.replaceSubscriptions([{ canonicalId: A, enabled: true }]);

      const upResolution = h.upstox.getView().runtime.resolutions.find((r) => r.canonicalId === A);
      const fyResolution = h.fyers.getView().runtime.resolutions.find((r) => r.canonicalId === A);
      expect(upResolution?.available).toBe(true);
      expect(fyResolution?.available).toBe(false);
      expect(fyResolution?.reason).toContain("FYERS");
      expect(fyResolution?.reason).not.toContain("UPSTOX");
      expect(h.service.getItem(A)).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  test("capacity failure is rejected before persistence and leaves state consistent", async () => {
    const h = harness(1);
    try {
      await h.seed([
        { instrument: instrument(A), mappings: [mapping("UPSTOX", A, "U-A")] },
        { instrument: instrument(B), mappings: [mapping("UPSTOX", B, "U-B")] }
      ]);
      await h.upstox.start();
      await h.fyers.start();
      await h.coordinator.start();

      await expect(h.coordinator.replaceSubscriptions([
        { canonicalId: A, enabled: true }, { canonicalId: B, enabled: true }
      ])).rejects.toThrow(/capacity/i);

      // Nothing was persisted and no runtime fan-out occurred.
      const persisted = await h.subscriptions.load();
      expect(persisted.generation).toBe(0);
      expect(persisted.selections).toHaveLength(0);
      expect(h.upstoxDriver.starts).toHaveLength(0);
      expect(h.fyersDriver.starts).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("coordinated runtime rejects direct desired-state writes", async () => {
    const h = harness();
    try {
      await expect(h.upstox.replaceSubscriptions([{ canonicalId: A, enabled: true }])).rejects.toThrow();
    } finally {
      h.cleanup();
    }
  });
});
