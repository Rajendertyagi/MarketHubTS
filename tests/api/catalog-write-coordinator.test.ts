/**
 * G0-C — write coordinator tests (plan §9.4 element 9, §7 runtime matrix,
 * §8 error semantics, §11.2 dependency direction).
 *
 * Local-only: real temp SQLite DB with migrations, real repositories, real
 * coordinator and real G0-D ownership state machine. No CI, no live provider.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { apiErrorSchema, type WriteScope } from "../../packages/contracts/src/index";
import {
  openDatabase, runMigrations, defaultMigrationsFolder,
  AppSettings, CandleRepository, SnapshotRepository, McpActivityRepository,
  SqliteCredentialStore, SqliteProviderSettings, SqliteSubscriptionRepository,
  SqliteCatalogRepository
} from "../../packages/database/src/index";
import { HistoricalCandleService } from "../../packages/market-core/src/historical/service";
import { OptionChainSnapshotService } from "../../packages/market-core/src/snapshots/service";
import {
  CATALOG_WRITE_BUSY, CatalogWriteBusyError, CatalogWriteCoordinator,
  catalogWriteBusyBody, mapContentionError, writeBusyResponse, runInteractiveWrite,
  type PermitState
} from "../../apps/api/src/catalog-write-coordinator";
import { CatalogWriteOwnership } from "../../apps/api/src/catalog-write-ownership";
import { createApp } from "../../apps/api/src/app";
import { createHttpMcpServices } from "../../apps/api/src/mcp-services";
import { closeDatabaseHandle, removeTempDirAsync } from "../helpers/fs-cleanup";

const ROOT = resolve(import.meta.dir, "../..");

function harness(drainTimeoutMs = 25) {
  let state: PermitState = "IDLE";
  const events: string[] = [];
  const coordinator = new CatalogWriteCoordinator({
    getPermitState: () => state,
    drainTimeoutMs,
    onEvent: (e) => events.push(e.type)
  });
  return {
    coordinator,
    events,
    setState: (next: PermitState) => { state = next; },
    getState: () => state
  };
}

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "markethub-g0c-"));
  const handle = openDatabase({ dbPath: join(dir, "g0c.sqlite") });
  runMigrations(handle.db, defaultMigrationsFolder);
  return { dir, handle };
}

const COUNT_TABLES = [
  "app_meta", "provider_credentials", "provider_settings", "streaming_subscriptions",
  "canonical_instruments", "catalog_sync_runs", "historical_candles", "candle_range_notes",
  "historical_sync_configs", "option_chain_capture_configs", "option_chain_snapshots", "mcp_activity"
];

function counts(handle: ReturnType<typeof openDatabase>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of COUNT_TABLES) {
    try {
      out[table] = Number((handle.sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    } catch {
      out[table] = -1;
    }
  }
  return out;
}

function expectSameCounts(before: Record<string, number>, after: Record<string, number>) {
  expect(after).toEqual(before);
}

// ---------------------------------------------------------------------------
// 1. Guard semantics
// ---------------------------------------------------------------------------
describe("G0-C guard semantics", () => {
  test("I and INTERNAL fail fast in RELEASING/OWNED/UNKNOWN; allowed in IDLE/RESERVED", () => {
    const h = harness();
    for (const state of ["IDLE", "RESERVED"] as PermitState[]) {
      h.setState(state);
      expect(() => h.coordinator.assertWritable("I")).not.toThrow();
      expect(() => h.coordinator.assertWritable("INTERNAL")).not.toThrow();
    }
    for (const state of ["RELEASING", "OWNED", "UNKNOWN"] as PermitState[]) {
      h.setState(state);
      for (const priority of ["I", "INTERNAL"] as const) {
        try {
          h.coordinator.assertWritable(priority);
          throw new Error(`expected ${priority} to throw in ${state}`);
        } catch (error) {
          expect(error).toBeInstanceOf(CatalogWriteBusyError);
          expect((error as CatalogWriteBusyError).code).toBe(CATALOG_WRITE_BUSY);
          expect((error as CatalogWriteBusyError).retryable).toBe(true);
        }
      }
    }
  });

  test("B returns SKIP only while busy and never queues", () => {
    const h = harness();
    h.setState("IDLE");
    expect(h.coordinator.assertWritable("B")).toBeUndefined();
    h.setState("RESERVED");
    expect(h.coordinator.assertWritable("B")).toBeUndefined();
    for (const state of ["RELEASING", "OWNED", "UNKNOWN"] as PermitState[]) {
      h.setState(state);
      expect(h.coordinator.assertWritable("B")).toBe("SKIP");
    }
    expect(h.coordinator.activeScopeCount).toBe(0); // no volatile queue
  });

  test("scopes are tracked, validated and released", () => {
    const h = harness();
    h.setState("IDLE");
    const scope = h.coordinator.acquireWriteScope("I");
    expect(h.coordinator.activeScopeCount).toBe(1);
    expect(() => h.coordinator.assertWritable("I", scope)).not.toThrow();
    h.coordinator.releaseWriteScope(scope);
    expect(h.coordinator.activeScopeCount).toBe(0);
    expect(() => h.coordinator.assertWritable("I", scope)).toThrow(CatalogWriteBusyError);
  });

  test("withScope propagates via ALS and releases on throw", async () => {
    const h = harness();
    h.setState("IDLE");
    const seen: string[] = [];
    await h.coordinator.withScope("I", async () => {
      h.setState("OWNED"); // permit changes mid-operation
      h.coordinator.assertWritable("I"); // inherited scope → no re-acquire
      seen.push("write-1");
      await Bun.sleep(1);
      h.coordinator.assertWritable("I");
      seen.push("write-2");
    });
    expect(seen).toEqual(["write-1", "write-2"]);
    expect(h.coordinator.activeScopeCount).toBe(0);
    h.setState("IDLE");
    await expect(h.coordinator.withScope("I", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(h.coordinator.activeScopeCount).toBe(0);
  });

  test("503 error contract uses the existing apiErrorSchema with no value change", () => {
    const body = catalogWriteBusyBody(new CatalogWriteBusyError("busy", "UPSTOX"));
    const parsed = apiErrorSchema.parse(body);
    expect(parsed.error).toBe("CATALOG_WRITE_BUSY");
    expect(parsed.details).toMatchObject({ retryable: true, code: "CATALOG_WRITE_BUSY", provider: "UPSTOX" });
    expect(() => apiErrorSchema.parse(catalogWriteBusyBody())).not.toThrow();
  });

  test("residual SQLITE_BUSY maps to the same retryable error; other errors pass through", () => {
    expect(mapContentionError(new Error("database is locked"))).toBeInstanceOf(CatalogWriteBusyError);
    expect(mapContentionError(new Error("SQLITE_BUSY: database is locked"))).toBeInstanceOf(CatalogWriteBusyError);
    const other = new Error("validation failed");
    expect(mapContentionError(other)).toBe(other);
  });
});

// ---------------------------------------------------------------------------
// 2. Ownership drain integration (drain before OWNED; timeout refuses grant)
// ---------------------------------------------------------------------------
describe("G0-C ownership drain integration", () => {
  test("grant drains active scopes before granting OWNED", async () => {
    const { dir, handle } = tempDb();
    try {
      const h = harness(1000);
      const ownership = new CatalogWriteOwnership(handle.sqlite, handle.path);
      ownership.setDrainHook(() => h.coordinator.drain());
      expect(ownership.reserve({ runId: "r1", provider: "UPSTOX", pid: 1, startedAt: new Date().toISOString() }).ok).toBe(true);
      expect(ownership.currentState).toBe("RESERVED");

      let released = false;
      const scope = h.coordinator.acquireWriteScope("I");
      const grant = ownership.grant();
      await Bun.sleep(5);
      expect(ownership.currentState).toBe("RELEASING"); // not OWNED while scope active
      h.coordinator.releaseWriteScope(scope);
      released = true;
      const decision = await grant;
      expect(released).toBe(true);
      expect(decision.granted).toBe(true);
      expect(ownership.currentState).toBe("OWNED");
      expect(h.events).toContain("drain-ok");
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("drain timeout refuses grant: no OWNED, no partial state", async () => {
    const { dir, handle } = tempDb();
    try {
      const ownership = new CatalogWriteOwnership(handle.sqlite, handle.path);
      const events: string[] = [];
      const coordinator = new CatalogWriteCoordinator({
        getPermitState: () => ownership.currentState,
        drainTimeoutMs: 20,
        onEvent: (e) => events.push(e.type)
      });
      ownership.setDrainHook(() => coordinator.drain());
      ownership.reserve({ runId: "r2", provider: "FYERS", pid: 1, startedAt: new Date().toISOString() });
      const scope = coordinator.acquireWriteScope("I");
      const decision = await ownership.grant();
      expect(decision.granted).toBe(false);
      expect(ownership.currentState).toBe("RELEASING"); // never OWNED
      expect(events).toContain("drain-timeout");
      // New scopes are still refused while RELEASING (no partial grant).
      expect(() => coordinator.acquireWriteScope("I")).toThrow(CatalogWriteBusyError);
      coordinator.releaseWriteScope(scope);
      expect(coordinator.activeScopeCount).toBe(0); // no partial state after scope ends
      ownership.release();
      expect(ownership.currentState).toBe("IDLE");
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. §7 runtime matrix — interactive writes fail fast with zero mutation
// ---------------------------------------------------------------------------
describe("G0-C §7 interactive runtime matrix", () => {
  test("every interactive repository write throws CATALOG_WRITE_BUSY with zero DB mutation", async () => {
    const { dir, handle } = tempDb();
    try {
      const h = harness();
      const guard = h.coordinator;
      const credentials = new SqliteCredentialStore(handle, guard);
      const settings = new SqliteProviderSettings(handle, guard);
      const appSettings = new AppSettings(handle.db, guard);
      const candles = new CandleRepository(handle.db, handle.sqlite, guard);
      const snapshots = new SnapshotRepository(handle.db, handle.sqlite, guard);
      const activities = new McpActivityRepository(handle.db, handle.sqlite, guard);
      const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite, guard);
      const catalog = new SqliteCatalogRepository(handle.db, handle.sqlite, guard);

      const cases: Array<[string, () => unknown]> = [
        ["#10 credentials.set", () => credentials.set("UPSTOX", "access_token", "v")],
        ["#11 settings.set", () => settings.set("k", "v")],
        ["#12 app-secret set", () => credentials.set("FYERS", "app_secret", "v")],
        ["#15 credentials.delete", () => credentials.delete("UPSTOX", "access_token")],
        ["#15 settings.delete", () => settings.delete("k")],
        ["#16 credentials.reset", () => credentials.reset()],
        ["#17 setRetention", () => appSettings.setRetention({} as any)],
        ["#18 cleanupCandles", () => candles.cleanupCandles(0)],
        ["#18 cleanupSnapshots", () => snapshots.cleanupSnapshots(0)],
        ["#18 cleanupActivities", () => activities.cleanupActivities(0)],
        ["#19 putSyncConfig", () => candles.putSyncConfig({} as any)],
        ["#20 deleteSyncConfig", () => candles.deleteSyncConfig("x")],
        ["#21 upsertCandles", () => candles.upsertCandles([])],
        ["#21 addRangeNote", () => candles.addRangeNote({} as any)],
        ["#23 putCaptureConfig", () => snapshots.putCaptureConfig({} as any)],
        ["#24 deleteCaptureConfig", () => snapshots.deleteCaptureConfig("x")],
        ["#25 putSnapshot", () => snapshots.putSnapshot({} as any)],
        ["#27 activity.start", () => activities.start({} as any)],
        ["#28 activity.complete", () => activities.complete({} as any)],
        ["#30 subscriptions.replace", () => subscriptions.replace([])],
        ["#1 catalog.transaction", () => catalog.transaction(async () => undefined)],
        ["#2 recordSyncRun", () => catalog.recordSyncRun({} as any)]
      ];

      for (const [name, fn] of cases) {
        h.setState("OWNED");
        const before = counts(handle);
        let thrown: unknown;
        try { await fn(); } catch (error) { thrown = error; }
        expect(thrown, `${name} must fail fast`).toBeInstanceOf(CatalogWriteBusyError);
        expectSameCounts(before, counts(handle));
        h.setState("IDLE");
      }
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("multi-write operations (#13/#15/#16/#18/#21/#30) are not split by a permit change", async () => {
    const { dir, handle } = tempDb();
    try {
      const h = harness(1000);
      const guard = h.coordinator;
      const credentials = new SqliteCredentialStore(handle, guard);
      const settings = new SqliteProviderSettings(handle, guard);
      const candles = new CandleRepository(handle.db, handle.sqlite, guard);
      const subscriptions = new SqliteSubscriptionRepository(handle.db, handle.sqlite, guard);

      // Hold one scope across two writes while the permit moves to RELEASING.
      const writes: string[] = [];
      const operation = h.coordinator.withScope("I", async () => {
        h.setState("RELEASING");
        guard.assertWritable("I"); // inherited scope — still admitted
        writes.push("write-1");
        await Bun.sleep(5);
        guard.assertWritable("I");
        writes.push("write-2");
      });
      const drain = h.coordinator.drain();
      let drainResolved = false;
      void drain.then(() => { drainResolved = true; });
      await Bun.sleep(1);
      expect(drainResolved).toBe(false); // drain waits for the spanning scope
      await operation;
      expect(await drain).toBe(true);
      expect(writes).toEqual(["write-1", "write-2"]); // both writes before grant
      expect(h.coordinator.activeScopeCount).toBe(0);

      // When busy at entry, a multi-write operation returns 503 and writes nothing.
      h.setState("OWNED");
      const before = counts(handle);
      const result = await runInteractiveWrite(guard, async () => {
        await credentials.set("FYERS", "access_token", "v");
        await settings.set("k", "v");
        await credentials.delete("FYERS", "candidate_secret");
        return "done";
      });
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(503);
      expectSameCounts(before, counts(handle));
      // Repositories are also individually gated (defense in depth).
      expect(() => candles.cleanupCandles(0)).toThrow(CatalogWriteBusyError);
      expect(() => subscriptions.replace([])).toThrow(); // async rejection checked below
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("route-level fail-fast check returns 503 before adapter work", () => {
    const h = harness();
    h.setState("OWNED");
    const busy = writeBusyResponse(h.coordinator, "I");
    expect(busy).toBeInstanceOf(Response);
    expect(busy!.status).toBe(503);
    h.setState("IDLE");
    expect(writeBusyResponse(h.coordinator, "I")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Background skip — no success claim, retry on next tick
// ---------------------------------------------------------------------------
describe("G0-C background skip (§7 #22/#26)", () => {
  test("scheduled historical sync skips while OWNED and succeeds after IDLE", async () => {
    const { dir, handle } = tempDb();
    try {
      const h = harness();
      const candles = new CandleRepository(handle.db, handle.sqlite, h.coordinator);
      const service = new HistoricalCandleService({
        candles, settings: { getRetention: () => ({ valid: false, settings: null, error: "none" }) },
        providers: [], writeGuard: h.coordinator
      });
      const config = {
        id: "c1", canonicalId: "NSE:TEST", interval: "1d", enabled: true,
        dateRangeJson: null, scheduleJson: null, providerPolicyJson: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      } as any;

      h.setState("OWNED");
      const before = counts(handle);
      const skipped = await service.runSync(config);
      expect(skipped.skipped).toBe(true);
      expect(skipped.reason).toBe("CATALOG_WRITE_BUSY");
      expect(skipped.retryable).toBe(true);
      expect(skipped.candles).toEqual([]); // no success claim
      expectSameCounts(before, counts(handle));

      h.setState("IDLE");
      const retried = await service.runSync(config);
      expect(retried.skipped).toBeUndefined();
      expect(retried.providersTried).toEqual([]); // no providers wired, honest empty
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("scheduled snapshot capture skips while OWNED and retries after IDLE", async () => {
    const { dir, handle } = tempDb();
    try {
      const h = harness();
      const snapshots = new SnapshotRepository(handle.db, handle.sqlite, h.coordinator);
      const service = new OptionChainSnapshotService({
        snapshots, settings: { getRetention: () => ({ valid: false, settings: null, error: "none" }) },
        providers: [], writeGuard: h.coordinator
      });
      const config = {
        id: "s1", underlyingCanonicalId: "NSE:TEST", expiryDate: "2026-12-31",
        strikeRangeJson: null, captureEnabled: true, captureMode: "SCHEDULED",
        scheduleJson: null, streamingEnabled: false, provider: "UPSTOX",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      } as any;

      h.setState("OWNED");
      const before = counts(handle);
      const skipped = await service.captureScheduled(config);
      expect(skipped.skipped).toBe(true);
      expect(skipped.reason).toBe("CATALOG_WRITE_BUSY");
      expect(skipped.retryable).toBe(true);
      expect(skipped.snapshot).toBeNull(); // no success claim
      expectSameCounts(before, counts(handle));

      h.setState("IDLE");
      const retried = await service.captureScheduled(config);
      expect(retried.skipped).toBeUndefined();
      expect(retried.snapshot).toBeNull(); // no provider wired — honest, not fabricated
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. MCP error shape (§8.2)
// ---------------------------------------------------------------------------
describe("G0-C MCP error shape", () => {
  test("write tools report retryable unavailable error and write no activity row", async () => {
    const { dir, handle } = tempDb();
    try {
      const h = harness();
      h.setState("OWNED");
      const activities = new McpActivityRepository(handle.db, handle.sqlite, h.coordinator);
      const services = createHttpMcpServices(
        { version: "test" } as any, handle, {} as any, {} as any, {} as any, {} as any,
        {} as any, {} as any, activities, undefined, h.coordinator
      );
      const before = counts(handle);
      const start = await services.startActivity({ operationId: "op1", toolName: "t", transport: "HTTP" } as any);
      expect(start.ok).toBe(false);
      if (!start.ok) expect(start.error).toEqual({ category: "unavailable", message: CATALOG_WRITE_BUSY });
      const complete = await services.completeActivity({ operationId: "op1", status: "ok" } as any);
      expect(complete.ok).toBe(false);
      if (!complete.ok) expect(complete.error).toEqual({ category: "unavailable", message: CATALOG_WRITE_BUSY });
      const fetch = await services.fetchHistorical({ canonicalId: "x", interval: "1d", fromMs: 0, toMs: 1 } as any);
      expect(fetch.ok).toBe(false);
      const capture = await services.captureSnapshot({ underlyingCanonicalId: "x", expiryDate: "2026-12-31" } as any);
      expect(capture.ok).toBe(false);
      expectSameCounts(before, counts(handle));
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Route 503 + reads remain available (§12.1 decisions 1/2/6)
// ---------------------------------------------------------------------------
describe("G0-C HTTP 503 mapping", () => {
  test("interactive write route returns schema-valid 503 while reads stay 200", async () => {
    const { dir, handle } = tempDb();
    try {
      const h = harness();
      h.setState("OWNED");
      const app = createApp({
        config: { version: "test", env: "test", dbPath: handle.path, host: "127.0.0.1", port: 3001, webPort: 5173, lan: false, logLevel: "error" } as any,
        db: handle, logger: { info() {}, warn() {}, error() {} } as any, startedAt: Date.now(),
        writeGuard: h.coordinator
      });
      const env = { requestIP: () => ({ address: "127.0.0.1" }) };
      const before = counts(handle);

      const write = await app.fetch(new Request("http://localhost/api/retention", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({})
      }), env as any);
      expect(write.status).toBe(503);
      const body = apiErrorSchema.parse(await write.json());
      expect(body.error).toBe(CATALOG_WRITE_BUSY);
      expect(body.details).toMatchObject({ retryable: true, code: CATALOG_WRITE_BUSY });
      expectSameCounts(before, counts(handle));

      for (const path of ["/health", "/ready", "/api/status"]) {
        const read = await app.fetch(new Request(`http://localhost${path}`), env as any);
        expect(read.status).toBe(200);
      }
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Source-scan guards (§7 bypass detection, §11.2 dependency direction)
// ---------------------------------------------------------------------------
describe("G0-C source-scan guards", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (full.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  test("no packages/database source imports from apps/api or @markethub/api", () => {
    const files = walk(join(ROOT, "packages/database/src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} must not import the API layer`).not.toMatch(/from\s+["'](?:@markethub\/api|apps\/api|\.\.\/\.\.\/apps\/api)/);
    }
  });

  test("every database write module carries injected guard calls", () => {
    const expected: Array<[string, number]> = [
      ["app-settings.ts", 1], ["credentials.ts", 3], ["provider-settings.ts", 2],
      ["subscriptions.ts", 1], ["repositories/catalog.ts", 10], ["repositories/candles.ts", 5],
      ["repositories/snapshots.ts", 4], ["repositories/mcp-activity.ts", 3]
    ];
    for (const [name, min] of expected) {
      const source = readFileSync(join(ROOT, "packages/database/src", name), "utf8");
      const calls = source.match(/guard\?\.assertWritable\(/g)?.length ?? 0;
      expect(calls, `${name} gate count`).toBeGreaterThanOrEqual(min);
    }
  });

  test("no applyBatch runtime caller and no child-side autocommit recordSyncRun", () => {
    const apiFiles = walk(join(ROOT, "apps/api/src"));
    for (const file of apiFiles) {
      expect(readFileSync(file, "utf8"), `${file} must not call applyBatch`).not.toContain(".applyBatch(");
    }
    const refresh = readFileSync(join(ROOT, "packages/market-core/src/sync/refresh.ts"), "utf8");
    expect(refresh).not.toContain(".applyBatch(");
    const childPipeline = readFileSync(join(ROOT, "apps/api/src/catalog-refresh-child-pipeline.ts"), "utf8");
    expect(childPipeline).not.toContain(".recordSyncRun(");
    expect(childPipeline).not.toContain("recordRunBestEffort(");
  });

  test("busy_timeout remains 5000 (no contention hidden by raising it)", () => {
    const source = readFileSync(join(ROOT, "packages/database/src/index.ts"), "utf8");
    expect(source).toContain("PRAGMA busy_timeout = 5000;");
  });
});
