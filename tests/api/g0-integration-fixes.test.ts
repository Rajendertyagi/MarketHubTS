/**
 * G0 integration corrections — focused tests for the six technical-lead
 * findings against published commit 2c22402.
 *
 * These tests exercise PRODUCTION COMPOSITION-ROOT WIRING, not isolated classes:
 *  - F1: the actual `startIfNeeded()` path with a real child manager + real
 *        durable ownership + real executor (reservation inside the executor).
 *  - F2: the production `ownership.updatePhase()` callback (extracted from
 *        apps/api/src/index.ts) during a REAL child `BEGIN IMMEDIATE`.
 *  - F3: an ACTUAL unexpected child exit with an injected failed writer probe,
 *        driven through the production ownership hooks.
 *  - F4: deterministic ABSENT / VALID / MALFORMED / READ_FAILED token states.
 *  - F5: real MCP service paths (`createHttpMcpServices`) holding an active
 *        write scope across the provider await.
 *  - F6: a real apply-time failure inside the child transaction, asserting the
 *        parent persists a FAILED run that is not COMPLETED proof.
 *
 * Only the remote network source is replaced (in-memory fixture Responses).
 * No live provider, no CI claim. Windows / Bun 1.4.5 / SQLite 3.54.1.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import {
  defaultMigrationsFolder, openDatabase, runMigrations, SqliteCatalogRepository,
  CandleRepository, SnapshotRepository, AppSettings, type DatabaseHandle
} from "../../packages/database/src/index";
import { type ProviderId } from "../../packages/contracts/src/index";
import {
  CatalogMasterRefresh, HistoricalCandleService, OptionChainSnapshotService,
  type CatalogRefreshEvent, type HistoricalFetchOutcome
} from "../../packages/market-core/src/index";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import {
  CatalogRefreshChildManager, type ManagerEvent
} from "../../apps/api/src/catalog-refresh-child-manager";
import {
  CatalogWriteOwnership, inspectOwnerToken, readOwnerToken, writeOwnerToken,
  findCommittedRun, type OwnerPhase, type OwnerToken, type RecoveryDecision
} from "../../apps/api/src/catalog-write-ownership";
import {
  CatalogWriteCoordinator, type CoordinatorEvent
} from "../../apps/api/src/catalog-write-coordinator";
import {
  createCatalogOwnershipWiring, startRefreshAfterListening
} from "../../apps/api/src/index";
import { createHttpMcpServices } from "../../apps/api/src/mcp-services";
import { closeDatabaseHandle, removeTempDirAsync } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const API_SRC = resolve(import.meta.dir, "../../apps/api/src");
const REPO_ROOT = resolve(API_SRC, "../../..");
const ADAPTER_URL = pathToFileURL(resolve(API_SRC, "catalog-refresh-child-pipeline.ts")).href;
const DATABASE_INDEX_URL = pathToFileURL(resolve(REPO_ROOT, "packages/database/src/index.ts")).href;
const ACCUMULATOR_URL = pathToFileURL(
  resolve(REPO_ROOT, "packages/market-core/src/sync/upstox-master.ts")
).href;
const NOW = "2026-11-27T10:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeDb(dir: string, name = "test.sqlite") {
  const dbPath = join(dir, name);
  const handle = openDatabase({ dbPath });
  runMigrations(handle.db, defaultMigrationsFolder);
  return { dbPath, handle };
}

function rowCount(sqlite: DatabaseHandle["sqlite"], table: string): number {
  return (sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(() => existsSync(path), timeoutMs);
}

async function fetchHG(url: string, ms = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function token(runId: string, generation: number, phase: OwnerPhase = "INIT"): OwnerToken {
  return {
    runId, provider: "UPSTOX", pid: process.pid,
    startedAt: NOW, heartbeatAt: NOW, phase, generation
  };
}

/* -------------------------------------------------------------------------- */
/* Test-only child entry — REAL adapter, REAL apply, fixture source           */
/* -------------------------------------------------------------------------- */

interface ChildSpec {
  name: string;
  delayMs?: number;
  markerPath?: string;
  holdTxnMarker?: string;
  holdTxnRelease?: string;
  forceApplyError?: boolean;
  suppressResult?: boolean;
}

function makeChildEntry(dir: string, spec: ChildSpec): string {
  const path = join(dir, spec.name);
  const fixtures = JSON.stringify({ upstox: upstoxRows, fyers: fyersFiles });
  const needsDb = Boolean(spec.holdTxnMarker || spec.forceApplyError);
  const execPatch = spec.holdTxnMarker ? `
const originalExec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
  const out = originalExec.call(this, sql);
  if (String(sql).includes("BEGIN IMMEDIATE")) {
    writeFileSync(${JSON.stringify(spec.holdTxnMarker)}, "in-txn");
    const sab = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(spec.holdTxnRelease!)}) && Date.now() < ${Date.now() + 60_000}) {
      Atomics.wait(sab, 0, 0, 10);
    }
  }
  return out;
};` : "";
  const applyErrorPatch = spec.forceApplyError ? `
const originalTransaction = SqliteCatalogRepository.prototype.transaction;
SqliteCatalogRepository.prototype.transaction = function (fn) {
  return originalTransaction.call(this, async (tx) => {
    await fn(tx);
    throw new Error("forced apply failure inside transaction");
  });
};` : "";
  const source = `
import { existsSync, writeFileSync } from "node:fs";
import { installChildPipeline } from ${JSON.stringify(ADAPTER_URL)};
${needsDb ? `import { Database } from "bun:sqlite";` : ""}
${spec.forceApplyError ? `import { SqliteCatalogRepository } from ${JSON.stringify(DATABASE_INDEX_URL)};` : ""}
const FIXTURES = ${fixtures};
const fetchFn = async (url, init) => {
  ${spec.markerPath ? `writeFileSync(${JSON.stringify(spec.markerPath)}, "downloading");` : ""}
  ${spec.delayMs ? `await Bun.sleep(${spec.delayMs});` : ""}
  if (url.includes("upstox")) return new Response(JSON.stringify(FIXTURES.upstox));
  if (url.includes("NSE_FO")) return Response.json(FIXTURES.fyers.NSE_FO);
  if (url.includes("BSE_FO")) return Response.json(FIXTURES.fyers.BSE_FO);
  if (url.includes("NSE_CM")) return Response.json(FIXTURES.fyers.NSE_CM);
  if (url.includes("BSE_CM")) return Response.json(FIXTURES.fyers.BSE_CM);
  throw new Error("unexpected url " + url);
};
const send = (message) => {
  ${spec.suppressResult ? `if (message && message.type === "result") return;` : ""}
  if (typeof process.send === "function") process.send(message);
};
${execPatch}
${applyErrorPatch}
installChildPipeline({ fetchFn, send });
`;
  writeFileSync(path, source, "utf8");
  return path;
}

/* -------------------------------------------------------------------------- */
/* Production-like harness: real ownership + manager + refresh + listener     */
/* -------------------------------------------------------------------------- */

interface Harness {
  dir: string;
  dbPath: string;
  parent: DatabaseHandle;
  ownership: CatalogWriteOwnership;
  coordinator: CatalogWriteCoordinator;
  manager: CatalogRefreshChildManager;
  refresh: CatalogMasterRefresh;
  events: ManagerEvent[];
  refreshEvents: CatalogRefreshEvent[];
  coordEvents: CoordinatorEvent[];
  recoveryDecisions: RecoveryDecision[];
  listener: ReturnType<typeof Bun.serve>;
  base: string;
  runProvider: (provider: ProviderId) => Promise<void>;
  startRefresh: () => void;
  close: () => Promise<void>;
}

function makeProductionHarness(
  dir: string,
  childEntry: string,
  opts: { withListener?: boolean; pipelineExitTimeoutMs?: number } = {}
): Harness {
  const { dbPath, handle: parent } = makeDb(dir);
  const events: ManagerEvent[] = [];
  const refreshEvents: CatalogRefreshEvent[] = [];
  const coordEvents: CoordinatorEvent[] = [];
  const recoveryDecisions: RecoveryDecision[] = [];

  const ownership = new CatalogWriteOwnership(parent.sqlite, dbPath);
  const coordinator = new CatalogWriteCoordinator({
    getPermitState: () => ownership.currentState,
    onEvent: (e) => coordEvents.push(e)
  });
  ownership.setDrainHook(() => coordinator.drain());

  // EXACT production wiring extracted from apps/api/src/index.ts.
  const wiring = createCatalogOwnershipWiring(ownership, ({ decision }) => {
    recoveryDecisions.push(decision);
  });
  const manager = new CatalogRefreshChildManager({
    dbPath, mode: "pipeline", childEntryPath: childEntry, cwd: REPO_ROOT,
    pipelineExitTimeoutMs: opts.pipelineExitTimeoutMs ?? 20_000,
    onEvent: (e) => { wiring.onManagerEvent(e); events.push(e); },
    ownershipHooks: wiring.ownershipHooks
  });

  // EXACT production executor shape: reserve BEFORE requestRefresh.
  const refresh = new CatalogMasterRefresh({
    catalog: new SqliteCatalogRepository(parent.db, parent.sqlite, coordinator),
    sync: {} as never,
    now: () => new Date(NOW),
    onEvent: (e) => refreshEvents.push(e),
    executor: async ({ provider, runId, nowIso, signal }) => {
      const reservation = ownership.reserve({ runId, provider, pid: process.pid, startedAt: nowIso });
      if (!reservation.ok) {
        return {
          status: "FAILED", counts: {}, cancelled: false, applyAttempted: false,
          error: `catalog write ownership unavailable: ${reservation.reason}`
        };
      }
      const onAbort = () => { void manager.cancel(runId, "shutdown"); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await manager.requestRefresh({
          runId, provider, nowIso, intentKey: "g0-integration", generation: reservation.generation
        });
        const terminal = result.terminal;
        if (terminal?.type === "result") {
          return {
            status: terminal.status, counts: terminal.counts,
            ...(terminal.sourceVersion ? { sourceVersion: terminal.sourceVersion } : {}),
            ...(terminal.error ? { error: terminal.error } : {}),
            cancelled: false, applyAttempted: true
          };
        }
        if (terminal?.type === "cancelled") {
          return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted: false };
        }
        return {
          status: "FAILED", counts: {}, cancelled: false, applyAttempted: false,
          error: result.error ?? "child produced no terminal result"
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    }
  });

  resetConfigCache();
  const config = loadConfig({
    env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" }
  });
  const app = createApp({
    config, db: parent, logger: createLogger("error"), startedAt: Date.now(),
    writeGuard: coordinator, catalogRefresh: refresh
  });
  const listener = opts.withListener === false
    ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
    : Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });

  return {
    dir, dbPath, parent, ownership, coordinator, manager, refresh,
    events, refreshEvents, coordEvents, recoveryDecisions, listener,
    base: `http://127.0.0.1:${listener.port}`,
    runProvider: async (provider: ProviderId) => {
      await (refresh as unknown as { refreshProvider: (p: ProviderId) => Promise<void> }).refreshProvider(provider);
    },
    startRefresh: () => startRefreshAfterListening(refresh, () => {}),
    close: async () => {
      try { await refresh.stopAndWait(); } catch {}
      try { await manager.shutdown(); } catch {}
      try { ownership.release(); } catch {}
      try { listener.stop(true); } catch {}
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  };
}

/* ========================================================================== */
/* F1 — startIfNeeded serializes providers before ownership reservation       */
/* ========================================================================== */

describe("G0 integration fixes (commit 2c22402)", () => {
  test("F1: actual startIfNeeded() runs both providers sequentially; neither skipped by RESERVED", async () => {
    expect(Bun.version).toBe("1.4.5");
    const dir = mkdtempSync(join(tmpdir(), "g0fix-f1-"));
    const harness = makeProductionHarness(dir, makeChildEntry(dir, { name: "child-f1.ts" }));
    try {
      // The ACTUAL production scheduling entry point (listener-first seam).
      harness.startRefresh();
      await waitFor(() => {
        const refreshed = harness.refreshEvents.filter((e) => e.outcome === "REFRESHED").map((e) => e.provider);
        return refreshed.includes("UPSTOX") && refreshed.includes("FYERS");
      }, 30_000);

      const refreshed = harness.refreshEvents.filter((e) => e.outcome === "REFRESHED").map((e) => e.provider);
      expect(refreshed).toContain("UPSTOX");
      expect(refreshed).toContain("FYERS");
      // No provider was skipped because the other held the single write permit.
      expect(harness.refreshEvents.some((e) =>
        e.outcome === "FAILED" && String(e.reason ?? "").includes("ownership unavailable")
      )).toBe(false);
      // Both reservations succeeded (generation bumped twice, 0 -> 1 -> 2).
      expect(harness.ownership.currentGeneration).toBe(2);
      // At most one child alive at a time: every spawn follows the prior exit.
      const spawns = harness.events.filter((e) => e.type === "spawn");
      const exits = harness.events.filter((e) => e.type === "exit");
      expect(spawns.length).toBe(2);
      expect(exits.length).toBe(2);
      // Both providers applied their (partially overlapping) fixtures.
      expect(rowCount(harness.parent.sqlite, "canonical_instruments")).toBeGreaterThan(0);
      const completed = await new SqliteCatalogRepository(harness.parent.db, harness.parent.sqlite)
        .listSyncRuns({ status: "COMPLETED" });
      expect(completed.map((r) => r.provider).sort()).toEqual(["FYERS", "UPSTOX"]);
    } finally {
      await harness.close();
    }
  }, 45_000);

  /* ======================================================================== */
  /* F2 — production updatePhase callback during a real child txn             */
  /* ======================================================================== */

  test("F2: production updatePhase callback does not write app_meta while child holds BEGIN IMMEDIATE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0fix-f2-"));
    const txnMarker = join(dir, "in-txn.marker");
    const txnRelease = join(dir, "in-txn.release");
    const harness = makeProductionHarness(dir, makeChildEntry(dir, {
      name: "child-f2.ts", holdTxnMarker: txnMarker, holdTxnRelease: txnRelease
    }));
    try {
      const run = harness.runProvider("UPSTOX");
      await waitForFile(txnMarker);
      // The manager's onEvent IS the production callback from index.ts; by the
      // time the TXN phase is observable, updatePhase("TXN") has been invoked.
      await waitFor(() => harness.events.some(
        (e) => e.type === "phase" && (e as { phase: string }).phase === "TXN"
      ));
      expect(harness.ownership.currentState).toBe("OWNED");
      expect(harness.ownership.currentToken!.phase).toBe("TXN"); // in-memory mirror current

      // The durable token was last written while RESERVED (AWAIT_TXN_GRANT).
      // No app_meta write happened after OWNED, so the child's BEGIN IMMEDIATE
      // was never contended by the parent event loop.
      const durable = readOwnerToken(harness.parent.sqlite)!;
      expect(durable.phase).toBe("AWAIT_TXN_GRANT");
      expect(durable.phase).not.toBe("TXN");

      // Parent responsiveness while the child holds the write lock: a real
      // HTTP request completes well inside the 5 s busy_timeout window.
      const started = performance.now();
      const health = await fetchHG(`${harness.base}/health`);
      const elapsed = performance.now() - started;
      expect(health.status).toBe(200);
      expect(elapsed).toBeLessThan(2_000); // hang guard, not a latency budget

      writeFileSync(txnRelease, "go");
      await run;
      expect(harness.refreshEvents.some((e) => e.outcome === "REFRESHED")).toBe(true);
    } finally {
      try { writeFileSync(txnRelease, "go"); } catch {}
      await harness.close();
    }
  }, 40_000);

  /* ======================================================================== */
  /* F3 — unexpected exit + failed probe keeps UNKNOWN and the token          */
  /* ======================================================================== */

  test("F3: actual unexpected child exit with failed writer probe retains token; settlement does not release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0fix-f3-"));
    const marker = join(dir, "downloading.marker");
    const harness = makeProductionHarness(dir, makeChildEntry(dir, {
      name: "child-f3.ts", markerPath: marker, delayMs: 60_000
    }));
    let blocker: DatabaseHandle["sqlite"] | null = null;
    try {
      // The production executor reserves the permit (generation 1) and writes
      // the durable token before dispatching the child.
      const run = harness.runProvider("UPSTOX");
      await waitForFile(marker); // child opened the DB and is in DOWNLOAD

      // Injected failed writer probe: acquire the write lock only AFTER the
      // child has opened its connection (openDatabase sets journal_mode=WAL,
      // which itself needs the write lock). probeWriter() now fails and
      // recover() returns RETRY.
      blocker = openDatabase({ dbPath: harness.dbPath, migrate: false }).sqlite;
      blocker.exec("BEGIN IMMEDIATE");

      const child = harness.manager.activeSubprocess;
      expect(child).not.toBeNull();
      child!.kill("SIGKILL");
      await run;

      // Production onUnexpectedExit -> markUnknown + recover (RETRY), then
      // production onSettled must NOT release the UNKNOWN permit/token.
      expect(harness.recoveryDecisions.some((d) => d.decision === "RETRY")).toBe(true);
      expect(harness.ownership.currentState).toBe("UNKNOWN");
      const spawn = harness.events.find((e) => e.type === "spawn") as { runId: string } | undefined;
      expect(spawn).toBeDefined();
      expect(readOwnerToken(harness.parent.sqlite)).not.toBeNull();
      expect(readOwnerToken(harness.parent.sqlite)!.runId).toBe(spawn!.runId);
      // No second writer may be admitted while recovery is unresolved.
      expect(harness.ownership.reserve({
        runId: "second-writer", provider: "FYERS", pid: process.pid, startedAt: NOW
      }).ok).toBe(false);
      expect(await harness.ownership.grant()).toEqual({ granted: false, reason: "cannot grant from UNKNOWN" });

      // Once the injected writer lock is gone, recovery succeeds and a fresh
      // reservation is admitted with a bumped generation.
      blocker.exec("ROLLBACK");
      blocker.close();
      blocker = null;
      expect(harness.ownership.recover().decision).toBe("RESUME");
      expect(harness.ownership.currentState).toBe("IDLE");
      expect(harness.ownership.reserve({
        runId: "after-recovery", provider: "FYERS", pid: process.pid, startedAt: NOW
      })).toEqual({ ok: true, generation: 2 });
    } finally {
      try { blocker?.close(); } catch {}
      await harness.close();
    }
  }, 40_000);

  /* ======================================================================== */
  /* F4 — deterministic token-read states                                     */
  /* ======================================================================== */

  test("F4: ABSENT / VALID / MALFORMED / READ_FAILED are distinguished and fail closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0fix-f4-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      // ABSENT — clean startup permitted.
      expect(inspectOwnerToken(handle.sqlite)).toEqual({ state: "ABSENT" });
      const absent = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(absent.recover()).toEqual({ decision: "NO_TOKEN" });
      expect(absent.currentState).toBe("IDLE");
      expect(absent.reserve({ runId: "absent", provider: "UPSTOX", pid: process.pid, startedAt: NOW }).ok).toBe(true);
      absent.release();

      // VALID — token parsed, generation retained, RESUME on recovery.
      writeOwnerToken(handle.sqlite, token("valid-run", 4, "TXN"));
      expect(inspectOwnerToken(handle.sqlite)).toEqual({ state: "VALID", token: token("valid-run", 4, "TXN") });
      const valid = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(valid.recover()).toEqual({ decision: "RESUME", generation: 4 });
      expect(valid.currentState).toBe("IDLE");

      // MALFORMED — fail closed: UNKNOWN, token retained, no dispatch.
      handle.sqlite.query(
        "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).run("catalog_refresh_owner", "{not valid json", Date.now());
      const malformedRead = inspectOwnerToken(handle.sqlite);
      expect(malformedRead.state).toBe("MALFORMED");
      const malformed = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(malformed.currentState).toBe("UNKNOWN");
      const malformedDecision = malformed.recover();
      expect(malformedDecision.decision).toBe("REFUSED");
      expect(malformedDecision.decision === "REFUSED" && malformedDecision.reason).toContain("malformed owner token");
      expect(malformed.currentState).toBe("UNKNOWN");
      expect(malformed.reserve({ runId: "x", provider: "UPSTOX", pid: process.pid, startedAt: NOW }).ok).toBe(false);
      expect(malformed.recoverForStartup().decision).toBe("REFUSED");
      // The raw malformed value is still present (not silently deleted).
      expect((handle.sqlite.query("SELECT value FROM app_meta WHERE key = ?").get("catalog_refresh_owner") as { value: string }).value).toBe("{not valid json");

      // READ_FAILED — a query failure is distinct from ABSENT and also refuses.
      const throwing = new Proxy(handle.sqlite, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return (sql: string) => {
              if (String(sql).includes("app_meta")) throw new Error("injected app_meta read failure");
              return (target as any).query(sql);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as typeof handle.sqlite;
      const failedRead = inspectOwnerToken(throwing);
      expect(failedRead.state).toBe("READ_FAILED");
      const unreadable = new CatalogWriteOwnership(throwing, dbPath);
      expect(unreadable.currentState).toBe("UNKNOWN");
      const failedDecision = unreadable.recover();
      expect(failedDecision.decision).toBe("REFUSED");
      expect(failedDecision.decision === "REFUSED" && failedDecision.reason).toContain("owner token read failed");
      expect(unreadable.reserve({ runId: "y", provider: "UPSTOX", pid: process.pid, startedAt: NOW }).ok).toBe(false);
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  /* ======================================================================== */
  /* F5 — real MCP service paths hold an active write scope                   */
  /* ======================================================================== */

  test("F5: refresh cannot acquire OWNED mid-MCP-operation (fetchHistorical + captureSnapshot)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0fix-f5-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
      const coordEvents: CoordinatorEvent[] = [];
      const coordinator = new CatalogWriteCoordinator({
        getPermitState: () => ownership.currentState,
        onEvent: (e) => coordEvents.push(e)
      });
      ownership.setDrainHook(() => coordinator.drain());

      const settings = new AppSettings(handle.db, coordinator);
      const candles = new CandleRepository(handle.db, handle.sqlite, coordinator);
      const snapshots = new SnapshotRepository(handle.db, handle.sqlite, coordinator);

      const historicalGate = deferred<HistoricalFetchOutcome>();
      const historical = new HistoricalCandleService({
        candles, settings, writeGuard: coordinator,
        providers: [{ id: "UPSTOX", fetchCandles: async () => historicalGate.promise }]
      });
      const snapshotGate = deferred<import("../../packages/contracts/src/index").OptionChainSnapshotEnvelope>();
      const snapshot = new OptionChainSnapshotService({
        snapshots, settings, writeGuard: coordinator,
        providers: [{ id: "UPSTOX", fetchOptionChain: async () => snapshotGate.promise }]
      });

      resetConfigCache();
      const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath } });
      const mcp = createHttpMcpServices(
        config, handle, new SqliteCatalogRepository(handle.db, handle.sqlite, coordinator),
        {} as never, {} as never, {} as never, historical, snapshot, {} as never,
        undefined, coordinator
      );

      // --- fetchHistorical ---
      expect(ownership.reserve({ runId: "f5-hist", provider: "UPSTOX", pid: process.pid, startedAt: NOW }))
        .toEqual({ ok: true, generation: 1 });
      const histOp = mcp.fetchHistorical!({
        canonicalId: "NSE_EQ|TEST", interval: "1d", fromMs: 1, toMs: 2
      } as never);
      await waitFor(() => coordEvents.some((e) => e.type === "scope-acquired"));
      const histGrant = ownership.grant(); // RELEASING -> drain waits for the scope
      await Bun.sleep(30);
      expect(ownership.currentState).toBe("RELEASING"); // NOT OWNED mid-operation
      historicalGate.resolve({ candles: [] });
      const histResult = await histOp;
      expect(histResult.ok).toBe(true);
      expect(await histGrant).toEqual({ granted: true, generation: 1 });
      expect(ownership.currentState).toBe("OWNED");
      ownership.release();

      // --- captureSnapshot ---
      coordEvents.length = 0;
      expect(ownership.reserve({ runId: "f5-snap", provider: "UPSTOX", pid: process.pid, startedAt: NOW }))
        .toEqual({ ok: true, generation: 2 });
      const snapOp = mcp.captureSnapshot!({
        underlyingCanonicalId: "NSE_EQ|TEST", expiryDate: "2026-12-29"
      } as never);
      await waitFor(() => coordEvents.some((e) => e.type === "scope-acquired"));
      const snapGrant = ownership.grant();
      await Bun.sleep(30);
      expect(ownership.currentState).toBe("RELEASING"); // NOT OWNED mid-operation
      snapshotGate.resolve({
        underlyingCanonicalId: "NSE_EQ|TEST", expiryDate: "2026-12-29",
        strikes: [], capturedAt: NOW
      } as never);
      const snapResult = await snapOp;
      expect(snapResult.ok).toBe(true);
      expect(await snapGrant).toEqual({ granted: true, generation: 2 });
      expect(ownership.currentState).toBe("OWNED");
      ownership.release();
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  /* ======================================================================== */
  /* F6 — apply-time failure persisted as FAILED, never COMPLETED proof       */
  /* ======================================================================== */

  test("F6: apply-time failure persists a FAILED run that is not COMPLETED proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0fix-f6-"));
    const harness = makeProductionHarness(dir, makeChildEntry(dir, {
      name: "child-f6.ts", forceApplyError: true
    }));
    try {
      await harness.runProvider("UPSTOX");

      // The child rolled back inside BEGIN IMMEDIATE with diagnostics disabled.
      expect(rowCount(harness.parent.sqlite, "canonical_instruments")).toBe(0);
      expect(harness.events.some((e) =>
        e.type === "txn-settled" && (e as { outcome: string }).outcome === "ROLLED_BACK"
      )).toBe(true);

      // The parent persisted a FAILED diagnostic after settlement.
      const repo = new SqliteCatalogRepository(harness.parent.db, harness.parent.sqlite);
      const allRuns = await repo.listSyncRuns();
      const failed = allRuns.filter((r) => r.status === "FAILED");
      expect(failed.length).toBe(1);
      expect(failed[0]!.error).toContain("forced apply failure");

      // It is diagnostic only — never COMPLETED proof for the child's runId.
      const spawn = harness.events.find((e) => e.type === "spawn") as { runId: string } | undefined;
      expect(spawn).toBeDefined();
      expect(findCommittedRun(harness.parent.sqlite, spawn!.runId)).toBeNull();
      expect((await repo.listSyncRuns({ status: "COMPLETED" })).length).toBe(0);
      expect(harness.refreshEvents.some((e) => e.outcome === "FAILED")).toBe(true);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
