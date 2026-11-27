/**
 * G0-D — crash recovery, writer ownership and shutdown tests.
 *
 * Windows, real Bun.spawn + IPC + real SQLite. Every §6.3 scenario is driven
 * deterministically: child kill in download/parse and in-transaction, commit
 * before IPC ack, simulated parent restart with a stale token, duplicate
 * refresh prevention, ordered shutdown, startup-failure drain, lock-probe
 * refusal, the generation-fence race and the "probe is not authorization"
 * rule. No live provider is contacted; fixtures replace only the network.
 *
 * Official facts relied on (fetched 2026-11-27):
 *   https://sqlite.org/lang_transaction.html  — BEGIN IMMEDIATE, COMMIT/ROLLBACK,
 *                                               rollback on connection death
 *   https://sqlite.org/wal.html               — one writer at a time, atomic commit
 *   https://sqlite.org/pragma.html#pragma_busy_timeout — per-connection busy handler
 *   https://bun.sh/docs/runtime/child-process — IPC, onExit/exited, kill/signal
 *   https://bun.sh/docs/runtime/workers       — confirmed NOT used (child processes)
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultMigrationsFolder, openDatabase, runMigrations, SqliteCatalogRepository
} from "../../packages/database/src/index";
import { CatalogMasterRefresh } from "../../packages/market-core/src/index";
import {
  CatalogRefreshChildManager, type ManagerEvent, type ManagerOwnershipHooks
} from "../../apps/api/src/catalog-refresh-child-manager";
import {
  CatalogWriteOwnership, OWNER_META_KEY, findCommittedRun, parseOwnerToken,
  probeWriter, readGeneration, readOwnerToken, writeOwnerToken,
  type OwnerPhase, type OwnerToken, type RecoveryDecision
} from "../../apps/api/src/catalog-write-ownership";
import { fenceRepository } from "../../apps/api/src/catalog-refresh-child-pipeline";
import { closeDatabaseHandle, removeTempDirAsync } from "../helpers/fs-cleanup";
import { upstoxRows } from "../fixtures/provider-masters";

const API_SRC = resolve(import.meta.dir, "../../apps/api/src");
const REPO_ROOT = resolve(API_SRC, "../..");
const ADAPTER_URL = pathToFileURL(resolve(API_SRC, "catalog-refresh-child-pipeline.ts")).href;
const ADAPTER_SOURCE = readFileSync(resolve(API_SRC, "catalog-refresh-child-pipeline.ts"), "utf8");
const NOW = "2026-11-27T10:00:00.000Z";

function makeDb(dir: string, name = "test.sqlite") {
  const dbPath = join(dir, name);
  const handle = openDatabase({ dbPath });
  runMigrations(handle.db, defaultMigrationsFolder);
  return { dbPath, handle };
}

function token(runId: string, generation: number, phase: OwnerPhase = "INIT"): OwnerToken {
  return {
    runId, provider: "UPSTOX", pid: process.pid,
    startedAt: NOW, heartbeatAt: NOW, phase, generation
  };
}

function rowCount(sqlite: ReturnType<typeof openDatabase>["sqlite"], table: string): number {
  return (sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Real pipeline adapter with fixture fetch and optional deterministic hooks. */
function makeValidChildEntry(
  dir: string, name: string,
  opts: { delayMs?: number; suppressResult?: boolean; markerPath?: string; beforeTxnMarker?: string; beforeTxnRelease?: string } = {}
): string {
  const path = join(dir, name);
  const fixtures = JSON.stringify({ upstox: upstoxRows });
  const source = `
import { existsSync, writeFileSync } from "node:fs";
import { installChildPipeline } from ${JSON.stringify(ADAPTER_URL)};
const FIXTURES = ${fixtures};
const fetchFn = async (url) => {
  ${opts.markerPath ? `writeFileSync(${JSON.stringify(opts.markerPath)}, "downloading");` : ""}
  ${opts.delayMs ? `await Bun.sleep(${opts.delayMs});` : ""}
  if (url.includes("upstox")) return new Response(JSON.stringify(FIXTURES.upstox));
  throw new Error("unexpected url " + url);
};
const send = (message) => {
  ${opts.suppressResult ? `if (message && message.type === "result") return;` : ""}
  if (typeof process.send === "function") process.send(message);
};
const beforeTxn = ${opts.beforeTxnMarker ? `async () => {
  writeFileSync(${JSON.stringify(opts.beforeTxnMarker)}, "at-boundary");
  const deadline = Date.now() + 10_000;
  while (!existsSync(${JSON.stringify(opts.beforeTxnRelease!)}) && Date.now() < deadline) await Bun.sleep(10);
}` : "undefined"};
installChildPipeline({ fetchFn, send, beforeTxn });
`;
  writeFileSync(path, source, "utf8");
  return path;
}

/** Raw child: holds BEGIN IMMEDIATE with an uncommitted row, then waits to be killed. */
function makeTxnCrashChildEntry(dir: string, markerPath: string): string {
  const path = join(dir, "child-txn-crash.ts");
  const source = `
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
const dbPath = process.argv[2];
const sqlite = new Database(dbPath, { create: true, strict: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("BEGIN IMMEDIATE");
sqlite.exec("INSERT INTO catalog_sync_runs (run_id, source, scope_json, completeness, status, started_at, counts_json, conflicts_json) VALUES ('txn-crash-run', 'UPSTOX', '{}', 'COMPLETE', 'RUNNING', '${NOW}', '{}', '[]')");
writeFileSync(${JSON.stringify(markerPath)}, "in-txn");
setInterval(() => {}, 1 << 30);
`;
  writeFileSync(path, source, "utf8");
  return path;
}

/**
 * Raw child that models the OPPOSITE crash-recovery ordering: it obtains
 * `BEGIN IMMEDIATE`, inserts a COMPLETED row carrying the EXACT parent-generated
 * runId, then waits on a release marker before COMMITting. This lets the test
 * hold the write lock while a new parent starts recovery, and commit BEFORE the
 * new parent can bump the generation — the narrow window in which a successful
 * old refresh could otherwise be repeated.
 */
function makeCommittingChildEntry(dir: string, runId: string, releasePath: string): string {
  const path = join(dir, "child-commit-before-bump.ts");
  const inTxnMarker = join(dir, "old-in-txn.marker");
  const committedMarker = join(dir, "old-committed.marker");
  const source = `
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
const dbPath = process.argv[2];
const runId = ${JSON.stringify(runId)};
const sqlite = new Database(dbPath, { create: true, strict: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("BEGIN IMMEDIATE");
sqlite.query("INSERT INTO catalog_sync_runs (run_id, source, provider, scope_json, completeness, status, started_at, counts_json, conflicts_json) VALUES (?, 'UPSTOX', 'UPSTOX', '{}', 'COMPLETE', 'COMPLETED', ?, '{}', '[]')").run(runId, ${JSON.stringify(NOW)});
writeFileSync(${JSON.stringify(inTxnMarker)}, "in-txn");
const deadline = Date.now() + 10_000;
while (!existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) await Bun.sleep(10);
sqlite.exec("COMMIT");
writeFileSync(${JSON.stringify(committedMarker)}, "committed");
sqlite.close();
`;
  writeFileSync(path, source, "utf8");
  return path;
}

/**
 * Minimal child that completes the ready + grant handshake, then drops its IPC
 * channel (`process.disconnect`) while staying alive. It never sends a terminal
 * message and never touches SQLite, so the parent must bound the wait, escalate
 * to a kill, and verify ownership before any new writer is admitted.
 */
function makeIpcDisconnectChildEntry(dir: string): string {
  const path = join(dir, "child-ipc-disconnect.ts");
  const source = `
const keepAlive = setInterval(() => {}, 1 << 30);
process.on("message", (raw) => {
  const m = raw;
  if (m.type === "refresh") {
    process.send?.({
      type: "ready", runId: m.runId, pid: process.pid,
      dbPath: process.argv[2], journalMode: "wal", sqliteVersion: process.versions.sqlite
    });
    process.send?.({ type: "txn-starting", runId: m.runId });
    return;
  }
  if (m.type === "txn-granted") {
    // IPC channel dies while the child is alive and holds the write permit.
    process.disconnect?.();
    return;
  }
  if (m.type === "shutdown") {
    clearInterval(keepAlive);
    process.exit(0);
  }
});
`;
  writeFileSync(path, source, "utf8");
  return path;
}

function makeManager(
  dbPath: string, childEntryPath: string, onEvent?: (event: ManagerEvent) => void,
  hooks?: ManagerOwnershipHooks, pipelineExitTimeoutMs = 15_000
): CatalogRefreshChildManager {
  return new CatalogRefreshChildManager({
    dbPath, mode: "pipeline", childEntryPath, cwd: REPO_ROOT,
    pipelineExitTimeoutMs, onEvent, ownershipHooks: hooks
  });
}

function ownedHooks(
  ownership: CatalogWriteOwnership, decisions: RecoveryDecision[] = []
): ManagerOwnershipHooks {
  return {
    requestGrant: async () => {
      const decision = await ownership.grant();
      return decision.granted
        ? { granted: true, generation: decision.generation }
        : { granted: false, reason: decision.reason };
    },
    onUnexpectedExit: () => {
      ownership.markUnknown();
      decisions.push(ownership.recover());
    },
    onSettled: () => { ownership.release(); }
  };
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path) && performance.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

describe("G0-D — crash recovery, writer ownership and shutdown", () => {
  test("verified runtime baseline and official-source discipline", () => {
    expect(Bun.version).toBe("1.4.5");
    expect(process.versions.sqlite).toBe("3.54.1");
    // Workers are explicitly NOT used: the architecture uses Bun.spawn children.
    expect(ADAPTER_SOURCE).not.toContain("new Worker(");
    expect(ADAPTER_SOURCE).toContain("readGeneration(sqlite)");
  });

  test("permit state machine and monotonic generation across a simulated restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-permit-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      const events: string[] = [];
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath, (e) => events.push(`${e.from}->${e.to}`));
      expect(ownership.currentState).toBe("IDLE");
      expect(ownership.currentGeneration).toBe(0);
      // No grant is possible before a reservation exists.
      expect(await ownership.grant()).toEqual({ granted: false, reason: "cannot grant from IDLE" });

      const first = ownership.reserve({ runId: "r1", provider: "UPSTOX", pid: process.pid, startedAt: NOW });
      expect(first).toEqual({ ok: true, generation: 1 });
      expect(ownership.currentState).toBe("RESERVED");
      expect(readOwnerToken(handle.sqlite)!.generation).toBe(1);
      // A second reserve while RESERVED is refused: no two writers.
      expect(ownership.reserve({ runId: "r2", provider: "FYERS", pid: process.pid, startedAt: NOW }).ok).toBe(false);

      const granted = await ownership.grant();
      expect(granted).toEqual({ granted: true, generation: 1 });
      expect(ownership.currentState).toBe("OWNED");
      ownership.release();
      expect(ownership.currentState).toBe("IDLE");
      expect(readOwnerToken(handle.sqlite)).toBeNull();

      // Simulated restart: a fresh instance reads the persisted generation from
      // the token left by an un-settled process and bumps it, never reusing G.
      writeOwnerToken(handle.sqlite, token("stale", 4));
      const restarted = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(restarted.currentGeneration).toBe(4);
      const second = restarted.reserve({ runId: "r3", provider: "FYERS", pid: process.pid, startedAt: NOW });
      expect(second).toEqual({ ok: true, generation: 5 });
      expect(readOwnerToken(handle.sqlite)!.generation).toBe(5);
      expect(events).toContain("IDLE->RESERVED");
      expect(events).toContain("RESERVED->RELEASING");
      expect(events).toContain("RELEASING->OWNED");
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("lock probe is supporting evidence only: active writer forces RETRY, no new grant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-probe-"));
    const { dbPath, handle } = makeDb(dir);
    let blocker: ReturnType<typeof openDatabase>["sqlite"] | null = null;
    try {
      writeOwnerToken(handle.sqlite, token("writer-active", 2));
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);

      blocker = openDatabase({ dbPath, migrate: false }).sqlite;
      blocker.exec("BEGIN IMMEDIATE");
      expect(probeWriter(dbPath, 200).ok).toBe(false);

      const decision = ownership.recover();
      expect(decision.decision).toBe("RETRY");
      expect(ownership.currentState).toBe("UNKNOWN");
      // No new child may be granted while a writer may still be active.
      expect(ownership.reserve({ runId: "next", provider: "UPSTOX", pid: process.pid, startedAt: NOW }).ok).toBe(false);
      expect(readOwnerToken(handle.sqlite)!.runId).toBe("writer-active");

      blocker.exec("ROLLBACK");
      blocker.close();
      blocker = null;
      const resumed = ownership.recover();
      expect(resumed.decision).toBe("RESUME");
      expect(ownership.currentState).toBe("IDLE");
      expect(ownership.reserve({ runId: "next", provider: "UPSTOX", pid: process.pid, startedAt: NOW })).toEqual({ ok: true, generation: 3 });
    } finally {
      try { blocker?.close(); } catch {}
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("committed COMPLETED row with the exact runId is the sole positive proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-proof-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      // Positive proof: COMPLETED row located by the token's exact runId.
      handle.sqlite.query(
        "INSERT INTO catalog_sync_runs (run_id, source, scope_json, completeness, status, started_at, counts_json, conflicts_json) VALUES (?, 'UPSTOX', '{}', 'COMPLETE', 'COMPLETED', ?, '{}', '[]')"
      ).run("exact-run", NOW);
      writeOwnerToken(handle.sqlite, token("exact-run", 3));
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(findCommittedRun(handle.sqlite, "exact-run")!.status).toBe("COMPLETED");
      expect(ownership.recover()).toEqual({ decision: "COMMITTED", runId: "exact-run", generation: 3 });
      expect(readOwnerToken(handle.sqlite)).toBeNull();
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(1); // no re-apply

      // A FAILED row is diagnostic only — never proof of commit.
      handle.sqlite.query(
        "INSERT INTO catalog_sync_runs (run_id, source, scope_json, completeness, status, started_at, counts_json, conflicts_json) VALUES (?, 'UPSTOX', '{}', 'COMPLETE', 'FAILED', ?, '{}', '[]')"
      ).run("failed-run", NOW);
      writeOwnerToken(handle.sqlite, token("failed-run", 4));
      const second = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(second.recover().decision).toBe("RESUME");
      expect(findCommittedRun(handle.sqlite, "failed-run")).toBeNull();

      // Absence of a terminal row is also not proof.
      writeOwnerToken(handle.sqlite, token("missing-run", 5));
      expect(new CatalogWriteOwnership(handle.sqlite, dbPath).recover().decision).toBe("RESUME");
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("no lock-probe-only recovery: committed row wins even while a writer holds the lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-not-probe-"));
    const { dbPath, handle } = makeDb(dir);
    let blocker: ReturnType<typeof openDatabase>["sqlite"] | null = null;
    try {
      // Test-local short busy timeout so the best-effort token cleanup does not
      // wait the production 5 s while the artificial writer lock is held.
      handle.sqlite.exec("PRAGMA busy_timeout = 100");
      handle.sqlite.query(
        "INSERT INTO catalog_sync_runs (run_id, source, scope_json, completeness, status, started_at, counts_json, conflicts_json) VALUES ('committed-while-locked', 'UPSTOX', '{}', 'COMPLETE', 'COMPLETED', ?, '{}', '[]')"
      ).run(NOW);
      writeOwnerToken(handle.sqlite, token("committed-while-locked", 6));
      blocker = openDatabase({ dbPath, migrate: false }).sqlite;
      blocker.exec("BEGIN IMMEDIATE");
      expect(probeWriter(dbPath, 200).ok).toBe(false); // probe would refuse

      // Run-state verification is checked FIRST: a committed row is positive
      // proof regardless of the probe, and no re-application is authorized.
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(ownership.recover()).toEqual({ decision: "COMMITTED", runId: "committed-while-locked", generation: 6 });
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(1);
      // Token cleanup is best-effort while a writer holds the lock; the
      // decision and the no-re-apply guarantee do not depend on it.
      blocker!.exec("ROLLBACK");
      blocker!.close();
      blocker = null;
    } finally {
      try { blocker?.close(); } catch {}
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("commit-then-kill-before-ack: exact runId found on restart, snapshot not re-applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-commit-ack-"));
    const { dbPath, handle } = makeDb(dir);
    const runId = "g0d-parent-run-ack-lost";
    // Simulate the parent having written the durable token before dispatch.
    writeOwnerToken(handle.sqlite, token(runId, 1));
    // The child commits with the parent runId but its `result` IPC is lost.
    const entry = makeValidChildEntry(dir, "child-no-ack.ts", { suppressResult: true });
    const manager = makeManager(dbPath, entry, undefined, undefined, 10_000);
    try {
      const result = await manager.requestRefresh({
        runId, provider: "UPSTOX", nowIso: NOW, intentKey: "g0d", generation: 1
      });
      expect(result.terminal).toBeUndefined(); // ack genuinely lost
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const runs = await repo.listSyncRuns({ status: "COMPLETED" });
      expect(runs.length).toBe(1);
      expect(runs[0]!.runId).toBe(runId); // exact parent-generated ID
      const instrumentsBefore = rowCount(handle.sqlite, "canonical_instruments");
      expect(instrumentsBefore).toBe(8);

      // Simulated parent restart: token still present (parent never settled).
      const restarted = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(restarted.recover()).toEqual({ decision: "COMMITTED", runId, generation: 1 });
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(1); // no re-apply
      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(instrumentsBefore);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("child kill during download/parse: no DB write, UNKNOWN then verified RESUME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-kill-download-"));
    const { dbPath, handle } = makeDb(dir);
    const marker = join(dir, "downloading.marker");
    const entry = makeValidChildEntry(dir, "child-slow.ts", { markerPath: marker, delayMs: 60_000 });
    const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
    const decisions: RecoveryDecision[] = [];
    const manager = makeManager(dbPath, entry, undefined, ownedHooks(ownership, decisions));
    try {
      expect(ownership.reserve({ runId: "kill-download", provider: "UPSTOX", pid: process.pid, startedAt: NOW }).ok).toBe(true);
      const runPromise = manager.requestRefresh({
        runId: "kill-download", provider: "UPSTOX", nowIso: NOW, intentKey: "g0d", generation: 1
      });
      await waitForFile(marker);
      manager.activeSubprocess!.kill("SIGKILL");
      const result = await runPromise;
      expect(result.ok).toBe(false);
      expect(result.exit.signal !== null || result.exit.code !== 0).toBe(true);

      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(0);
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(0);
      expect(decisions.some((d) => d.decision === "RESUME")).toBe(true);
      expect(ownership.currentState).toBe("IDLE"); // settlement released after verification
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("child kill during transaction: SQLite rolls back uncommitted rows on connection death", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-kill-txn-"));
    const { dbPath, handle } = makeDb(dir);
    const marker = join(dir, "in-txn.marker");
    const entry = makeTxnCrashChildEntry(dir, marker);
    const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
    const decisions: RecoveryDecision[] = [];
    const manager = makeManager(dbPath, entry, undefined, ownedHooks(ownership, decisions), 10_000);
    try {
      expect(ownership.reserve({ runId: "kill-txn", provider: "UPSTOX", pid: process.pid, startedAt: NOW }).ok).toBe(true);
      const runPromise = manager.requestRefresh({
        runId: "kill-txn", provider: "UPSTOX", nowIso: NOW, intentKey: "g0d", generation: 1
      });
      await waitForFile(marker);
      // The uncommitted RUNNING row is visible to the child's own connection but
      // must not be visible to the parent while the write lock is held.
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(0);
      manager.activeSubprocess!.kill("SIGKILL");
      await runPromise;

      // Connection death rolled the transaction back: no committed row at all.
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(0);
      expect(findCommittedRun(handle.sqlite, "txn-crash-run")).toBeNull();
      expect(decisions.some((d) => d.decision === "RESUME")).toBe(true);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("simulated parent restart with stale token bumps generation before dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-stale-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      writeOwnerToken(handle.sqlite, token("orphan-run", 7, "TXN"));
      const restarted = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(restarted.recover()).toEqual({ decision: "RESUME", generation: 7 });
      // Token is KEPT on RESUME; reserve overwrites it with G+1 before dispatch.
      expect(readOwnerToken(handle.sqlite)!.generation).toBe(7);
      const reservation = restarted.reserve({ runId: "fresh-run", provider: "FYERS", pid: process.pid, startedAt: NOW });
      expect(reservation).toEqual({ ok: true, generation: 8 });
      expect(readOwnerToken(handle.sqlite)!.generation).toBe(8);
      expect(readOwnerToken(handle.sqlite)!.runId).toBe("fresh-run");
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("duplicate refresh prevention: single-flight per provider, stale token not in-flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-duplicate-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const catalog = {
        listSyncRuns: async () => [],
        recordSyncRun: async () => {}
      } as any;
      const refresh = new CatalogMasterRefresh({
        catalog, sync: {} as any, now: () => new Date(NOW),
        executor: async () => { calls++; await gate; return { status: "COMPLETED", counts: {}, cancelled: false, applyAttempted: true }; }
      });
      refresh.startIfNeeded();
      refresh.startIfNeeded(); // duplicate trigger while both providers are in flight
      await Bun.sleep(50); // let the async single-flight tasks reach the executor
      // G0 integration fix #1: executor calls are serialized before ownership
      // reservation, so only the first provider is in flight; the second is
      // queued and duplicate triggers are skipped by single-flight.
      expect(calls).toBe(1);
      release();
      // Let the queued provider start before shutdown; a run still queued when
      // STOPPING begins is correctly cancelled rather than dispatched.
      await Bun.sleep(50);
      expect(calls).toBe(2); // both providers ran exactly once, sequentially
      await refresh.stopAndWait();

      // A stale token does not by itself admit a second writer: reserve from a
      // non-IDLE permit is refused.
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
      ownership.reserve({ runId: "first", provider: "UPSTOX", pid: process.pid, startedAt: NOW });
      expect(ownership.reserve({ runId: "second", provider: "UPSTOX", pid: process.pid, startedAt: NOW }).ok).toBe(false);
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("graceful shutdown ordering: exit and permit release precede drain resolution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-shutdown-"));
    const { dbPath, handle } = makeDb(dir);
    const entry = makeValidChildEntry(dir, "child-shutdown.ts", { delayMs: 400 });
    const events: ManagerEvent[] = [];
    const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
    const manager = makeManager(dbPath, entry, (e) => events.push(e), ownedHooks(ownership));
    try {
      ownership.reserve({ runId: "graceful", provider: "UPSTOX", pid: process.pid, startedAt: NOW });
      const runPromise = manager.requestRefresh({
        runId: "graceful", provider: "UPSTOX", nowIso: NOW, intentKey: "g0d", generation: 1
      });
      let shutdownResolved = false;
      const shutdownPromise = manager.shutdown().then(() => { shutdownResolved = true; });
      await runPromise;
      await shutdownPromise;

      const indexOf = (type: string) => events.findIndex((e) => e.type === type);
      const spawn = indexOf("spawn"), exit = indexOf("exit"), settled = indexOf("settled");
      expect(spawn).toBeGreaterThanOrEqual(0);
      expect(exit).toBeGreaterThan(spawn);
      expect(settled).toBeGreaterThan(exit);
      expect(shutdownResolved).toBe(true);
      expect(manager.activeSubprocess).toBeNull();
      expect(manager.queuedCount).toBe(0);
      expect(readOwnerToken(handle.sqlite)).toBeNull(); // permit released before DB close
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("startup-failure drain: queued runs settle and no child spawns after shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-drain-"));
    const { dbPath, handle } = makeDb(dir);
    const entry = makeValidChildEntry(dir, "child-drain.ts", { delayMs: 200 });
    const events: ManagerEvent[] = [];
    const manager = makeManager(dbPath, entry, (e) => events.push(e));
    try {
      const first = manager.requestRefresh({ runId: "drain-1", provider: "UPSTOX", nowIso: NOW, intentKey: "g0d", generation: 1 });
      const second = manager.requestRefresh({ runId: "drain-2", provider: "FYERS", nowIso: NOW, intentKey: "g0d", generation: 1 });
      const drain = manager.shutdown();
      const [a, b] = await Promise.all([first, second]);
      await drain;
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false); // queued run refused during shutdown
      expect(b.error).toContain("shutting down");
      const spawnsAfterShutdown = events.filter((e) => e.type === "spawn").length;
      expect(spawnsAfterShutdown).toBe(1);
      expect(manager.activeSubprocess).toBeNull();
      expect(manager.queuedCount).toBe(0);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("generation fence unit: mismatch throws before any catalog write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-fence-unit-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      const writes: string[] = [];
      const base = {
        transaction: async <T>(fn: (tx: any) => Promise<T> | T): Promise<T> => fn({
          createSyncRun: async () => { writes.push("createSyncRun"); },
          upsertInstrument: async () => { writes.push("upsertInstrument"); }
        } as any)
      } as unknown as SqliteCatalogRepository;

      let granted: number | null = 1;
      const settled: string[] = [];
      let fences = 0;
      const repo = fenceRepository(
        base, handle.sqlite, () => granted,
        (outcome) => settled.push(outcome), () => { fences++; }
      );

      writeOwnerToken(handle.sqlite, token("fence-unit", 1));
      await repo.transaction(async (tx) => { await tx.createSyncRun({} as any); });
      expect(writes).toEqual(["createSyncRun"]);
      expect(settled).toEqual(["COMMITTED"]);

      // New parent bumps to G+1; the old child still holds G=1.
      writeOwnerToken(handle.sqlite, token("fence-unit-new", 2));
      let fencedError: unknown;
      try {
        await repo.transaction(async (tx) => { await tx.upsertInstrument({} as any); });
      } catch (error) { fencedError = error; }
      expect(fencedError).toBeInstanceOf(Error);
      expect((fencedError as Error).message).toContain("generation mismatch");
      expect(writes).toEqual(["createSyncRun"]); // zero writes after the fence
      expect(fences).toBe(1);
      expect(settled).toEqual(["COMMITTED", "FENCED"]);
      expect(readGeneration(handle.sqlite)).toBe(2);
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("generation-fence race: old child (G) fenced with zero writes, new child (G+1) commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-fence-race-"));
    const { dbPath, handle } = makeDb(dir);
    const marker = join(dir, "old-at-boundary.marker");
    const release = join(dir, "old-release.marker");
    const oldEntry = makeValidChildEntry(dir, "child-old.ts", { beforeTxnMarker: marker, beforeTxnRelease: release });
    const newEntry = makeValidChildEntry(dir, "child-new.ts");
    const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
    const manager = makeManager(dbPath, oldEntry, undefined, ownedHooks(ownership));
    try {
      // Parent grants generation G=1 to the old child before crashing.
      expect(ownership.reserve({ runId: "old-run", provider: "UPSTOX", pid: process.pid, startedAt: NOW })).toEqual({ ok: true, generation: 1 });
      const oldPromise = manager.requestRefresh({
        runId: "old-run", provider: "UPSTOX", nowIso: NOW, intentKey: "g0d", generation: 1
      });
      await waitForFile(marker); // old child is at BEGIN IMMEDIATE boundary

      // New parent: probe succeeds, bumps to G+1, spawns a fresh child with G+1.
      expect(probeWriter(dbPath).ok).toBe(true);
      writeOwnerToken(handle.sqlite, token("new-run", 2));
      writeFileSync(release, "go");

      const oldResult = await oldPromise;
      expect(oldResult.terminal?.type).toBe("result");
      expect(oldResult.terminal!.type === "result" && oldResult.terminal!.status).toBe("FENCED");
      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(0); // old child wrote nothing
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(0);

      // The new child (generation 2) commits exactly one snapshot. The old
      // child's settlement released the token, so a fresh reserve bumps from
      // the in-memory generation to G+1 = 2.
      const newManager = makeManager(dbPath, newEntry, undefined, ownedHooks(ownership));
      expect(ownership.reserve({ runId: "new-run", provider: "UPSTOX", pid: process.pid, startedAt: NOW })).toEqual({ ok: true, generation: 2 });
      const newResult = await newManager.requestRefresh({
        runId: "new-run", provider: "UPSTOX", nowIso: NOW, intentKey: "g0d", generation: 2
      });
      expect(newResult.terminal!.type === "result" && newResult.terminal!.status).toBe("COMPLETED");
      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(8);
      const runs = await new SqliteCatalogRepository(handle.db, handle.sqlite).listSyncRuns({ status: "COMPLETED" });
      expect(runs.length).toBe(1); // exactly one writer, no duplicate reconciliation
      expect(runs[0]!.runId).toBe("new-run");
      await newManager.shutdown();
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("narrow window: old child commits before reserve; parent freshness check skips re-apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-narrow-window-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      // A stale token from a crashed parent. Recovery finds no COMPLETED row for
      // that exact runId and RESUMEs, keeping the token for a generation bump.
      writeOwnerToken(handle.sqlite, token("old-parent-run", 7, "TXN"));
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
      expect(ownership.recover()).toEqual({ decision: "RESUME", generation: 7 });

      // Narrow window: the old child commits its snapshot BEFORE the new parent
      // reaches reserve(). The token still names the old runId, so the exact-ID
      // proof cannot see this row; only the parent-side freshness check can.
      handle.sqlite.query(
        "INSERT INTO catalog_sync_runs (run_id, source, provider, scope_json, completeness, status, started_at, counts_json, conflicts_json) VALUES (?, 'UPSTOX', 'UPSTOX', '{}', 'COMPLETE', 'COMPLETED', ?, '{}', '[]')"
      ).run("old-child-committed", NOW);
      expect(findCommittedRun(handle.sqlite, "old-parent-run")).toBeNull();

      let reserved = 0;
      let dispatched = 0;
      const events: Array<{ provider: string; outcome: string; reason?: string }> = [];
      const refresh = new CatalogMasterRefresh({
        catalog: new SqliteCatalogRepository(handle.db, handle.sqlite),
        sync: {} as any,
        now: () => new Date(NOW),
        executor: async () => {
          reserved++;
          const next = ownership.reserve({ runId: "new-run", provider: "UPSTOX", pid: process.pid, startedAt: NOW });
          if (!next.ok) throw new Error(next.reason);
          dispatched++;
          return { status: "COMPLETED", counts: {}, cancelled: false, applyAttempted: true };
        },
        onEvent: (e) => events.push(e)
      });

      await (refresh as any).refreshProvider("UPSTOX");

      // refresh.ts:333-350 sees today's COMPLETED row and skips before
      // reserve/dispatch: no re-apply, no second writer, stale token untouched.
      expect(reserved).toBe(0);
      expect(dispatched).toBe(0);
      expect(events.some((e) => e.outcome === "SKIPPED" && e.reason === "ALREADY_REFRESHED_TODAY")).toBe(true);
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(1);
      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(0);
      expect(readOwnerToken(handle.sqlite)!.generation).toBe(7);
      expect(ownership.currentState).toBe("IDLE");
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("old child commits before generation bump: exact runId COMPLETED row found after bump, refresh skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-commit-before-bump-"));
    const { dbPath, handle } = makeDb(dir);
    const oldRunId = "g0d-old-child-exact-run";
    const release = join(dir, "old-release.marker");
    const entry = makeCommittingChildEntry(dir, oldRunId, release);
    let child: ReturnType<typeof Bun.spawn> | null = null;
    try {
      // Parent granted generation G=7 to the old child, then crashed mid-txn.
      // The durable token still names the EXACT parent-generated runId.
      writeOwnerToken(handle.sqlite, token(oldRunId, 7, "TXN"));
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);

      // 1-3. Old child obtains BEGIN IMMEDIATE and holds it; the new parent
      // starts recovery while that lock is held: the probe fails -> RETRY, so
      // no generation bump and no second writer is admitted.
      child = Bun.spawn([process.execPath, entry, dbPath], {
        cwd: REPO_ROOT, stdout: "ignore", stderr: "ignore"
      });
      await waitForFile(join(dir, "old-in-txn.marker"));
      expect(ownership.recover().decision).toBe("RETRY");
      expect(ownership.currentState).toBe("UNKNOWN");
      expect(ownership.reserve({
        runId: "new-run", provider: "UPSTOX", pid: process.pid, startedAt: NOW
      }).ok).toBe(false);

      // 4. Old child commits a COMPLETED row with the EXACT parent runId BEFORE
      // the new parent can bump generation.
      writeFileSync(release, "go");
      await waitForFile(join(dir, "old-committed.marker"));
      expect(await child.exited).toBe(0);
      child = null;

      // Capture the exact parent-generated runId from the pre-bump token.
      const preBump = readOwnerToken(handle.sqlite)!;
      expect(preBump.runId).toBe(oldRunId);
      expect(preBump.generation).toBe(7);

      // 5. New parent obtains the write lock and increments generation (G -> G+1).
      //    release() clears the UNKNOWN state left by the RETRY; reserve() bumps.
      ownership.release();
      expect(ownership.reserve({
        runId: "new-run", provider: "UPSTOX", pid: process.pid, startedAt: NOW
      })).toEqual({ ok: true, generation: 8 });
      expect(readOwnerToken(handle.sqlite)!.runId).toBe("new-run"); // token overwritten

      // 6. AFTER the generation bump, the new parent re-reads the exact old
      //    runId and finds the committed COMPLETED row — proof the old refresh
      //    succeeded. The post-bump token no longer names this run, so relying
      //    on it alone would miss the commit and repeat the refresh.
      expect(findCommittedRun(handle.sqlite, preBump.runId)).toEqual({
        runId: oldRunId, status: "COMPLETED"
      });

      // No re-application, no second writer: the parent-side freshness check
      // sees today's COMPLETED row and skips before any dispatch.
      let reserved = 0;
      let dispatched = 0;
      const events: Array<{ provider: string; outcome: string; reason?: string }> = [];
      const refresh = new CatalogMasterRefresh({
        catalog: new SqliteCatalogRepository(handle.db, handle.sqlite),
        sync: {} as any,
        now: () => new Date(NOW),
        executor: async () => {
          reserved++;
          dispatched++;
          return { status: "COMPLETED", counts: {}, cancelled: false, applyAttempted: true };
        },
        onEvent: (e) => events.push(e)
      });

      await (refresh as any).refreshProvider("UPSTOX");

      expect(reserved).toBe(0);
      expect(dispatched).toBe(0);
      expect(events.some((e) => e.outcome === "SKIPPED" && e.reason === "ALREADY_REFRESHED_TODAY")).toBe(true);
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(1); // no re-application
      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(0); // no second writer
    } finally {
      try { child?.kill("SIGKILL"); } catch {}
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("IPC disconnection while child alive: UNKNOWN, no grant until verification, bounded escalation, no second writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-ipc-disconnect-"));
    const { dbPath, handle } = makeDb(dir);
    const entry = makeIpcDisconnectChildEntry(dir);
    const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
    const events: string[] = [];
    const decisions: RecoveryDecision[] = [];
    const statesAtUnknown: string[] = [];
    let grantWhileUnknown: Promise<{ granted: boolean; reason?: string }> | null = null;
    let reserveWhileUnknown: { ok: boolean; reason?: string } | null = null;
    let grantCalls = 0;
    const hooks: ManagerOwnershipHooks = {
      requestGrant: async () => {
        grantCalls++;
        const decision = await ownership.grant();
        return decision.granted
          ? { granted: true, generation: decision.generation }
          : { granted: false, reason: decision.reason };
      },
      onUnexpectedExit: () => {
        ownership.markUnknown();
        statesAtUnknown.push(ownership.currentState);
        // Capture the synchronous guards while the permit is still UNKNOWN:
        // neither a grant nor a reserve may admit a second writer before the
        // freshness verification below runs.
        grantWhileUnknown = ownership.grant();
        reserveWhileUnknown = ownership.reserve({
          runId: "second-writer", provider: "UPSTOX", pid: process.pid, startedAt: NOW
        });
        decisions.push(ownership.recover());
      },
      onSettled: () => { ownership.release(); }
    };
    const manager = makeManager(dbPath, entry, (e) => events.push(e.type), hooks, 800);
    try {
      expect(ownership.reserve({ runId: "ipc-disconnect", provider: "UPSTOX", pid: process.pid, startedAt: NOW })).toEqual({ ok: true, generation: 1 });
      const started = performance.now();
      const result = await manager.requestRefresh({
        runId: "ipc-disconnect", provider: "UPSTOX", nowIso: NOW, intentKey: "g0d", generation: 1
      });
      const elapsed = performance.now() - started;

      // Bounded settlement: terminal wait times out, shutdown send is refused
      // on the closed channel, exit wait times out, then a kill is escalated.
      expect(result.ok).toBe(false);
      expect(result.error).toContain("timed out waiting for result/cancelled/error from child");
      expect(result.error).toContain("child killed after exit timeout");
      expect(result.exit.signal).not.toBeNull();
      expect(elapsed).toBeLessThan(8_000);
      expect(events).toContain("exit");
      expect(events).toContain("settled");
      expect(manager.activeSubprocess).toBeNull();

      // Exactly one grant was issued (before the disconnect); while UNKNOWN
      // both grant and reserve were refused until recover() verified state.
      expect(grantCalls).toBe(1);
      expect(statesAtUnknown).toEqual(["UNKNOWN"]);
      expect(await grantWhileUnknown!).toEqual({ granted: false, reason: "cannot grant from UNKNOWN" });
      expect(reserveWhileUnknown!.ok).toBe(false);
      expect(decisions.some((d) => d.decision === "RESUME")).toBe(true);

      // No second writer: the child never reached its transaction, so no row
      // was applied and the permit was released after settlement.
      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(0);
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(0);
      expect(ownership.currentState).toBe("IDLE");
      expect(readOwnerToken(handle.sqlite)).toBeNull();
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("source-scan: child writes only in the atomic txn and never records diagnostics", () => {
    expect(ADAPTER_SOURCE).toContain("disableDiagnosticRunRecording: true");
    expect(ADAPTER_SOURCE).not.toMatch(/\.recordSyncRun\s*\(/);
    expect(ADAPTER_SOURCE).toContain("readGeneration(sqlite)");
    expect(ADAPTER_SOURCE).toContain("return fn(tx)"); // fence check precedes fn
    expect(ADAPTER_SOURCE).toContain("migrate: false");
    expect(OWNER_META_KEY).toBe("catalog_refresh_owner");
    expect(parseOwnerToken(JSON.stringify(token("p", 1)))).not.toBeNull();
    expect(parseOwnerToken("{bad json")).toBeNull();
  });

  /**
   * Test-only repository wrapper — faults the catalog_sync_runs lookup SEAM,
   * never the recovery logic itself. The first lookup is the ordinary pre-bump
   * `findCommittedRun` (the old child has not committed yet in the race); the
   * second is the fail-closed post-bump `verifyRecoveryAfterBump`. All other
   * queries (app_meta token read/write) pass through to the real repository.
   */
  function makePostBumpRepo(
    sqlite: ReturnType<typeof openDatabase>["sqlite"],
    opts: { failPostBump?: boolean } = {}
  ) {
    let catalogRunQueries = 0;
    const wrapped = new Proxy(sqlite, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string) => {
            if (String(sql).includes("catalog_sync_runs")) {
              catalogRunQueries++;
              if (catalogRunQueries === 1) {
                // Pre-bump check: old child has not committed yet.
                return { get: () => null } as never;
              }
              if (opts.failPostBump) {
                throw new Error("injected post-bump catalog_sync_runs lookup failure");
              }
            }
            return (target as any).query(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as typeof sqlite;
    return { wrapped, get catalogRunQueries() { return catalogRunQueries; } };
  }

  test("post-bump lookup failure REFUSES refresh: UNKNOWN, token retained, no dispatch, observable diagnostic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-post-bump-refuse-"));
    const { dbPath, handle } = makeDb(dir);
    const oldRunId = "g0d-old-child-exact-run-post-bump";
    try {
      // Stale token from a crashed parent naming the EXACT parent-generated
      // runId. No committed row exists yet in the real DB (the old child's
      // commit is the ambiguous event the post-bump check must verify).
      writeOwnerToken(handle.sqlite, token(oldRunId, 7, "TXN"));

      const repo = makePostBumpRepo(handle.sqlite, { failPostBump: true });
      const transitions: string[] = [];
      const ownership = new CatalogWriteOwnership(repo.wrapped, dbPath, (e) => {
        transitions.push(`${e.from}->${e.to}`);
      });

      // Actual startup/recovery entry point (the same one index.ts calls).
      const decision = ownership.recoverForStartup();

      // Fail-closed decision with an observable reason.
      expect(decision.decision).toBe("REFUSED");
      expect(decision.decision === "REFUSED" && decision.reason).toContain(
        "injected post-bump catalog_sync_runs lookup failure"
      );
      expect(repo.catalogRunQueries).toBe(2); // pre-bump check + post-bump check

      // Permit stays UNKNOWN; token retained with the bumped generation.
      expect(ownership.currentState).toBe("UNKNOWN");
      const retained = readOwnerToken(handle.sqlite)!;
      expect(retained.runId).toBe(oldRunId);
      expect(retained.generation).toBe(8); // generation bump occurred (7 -> 8)
      expect(transitions).toContain("IDLE->UNKNOWN"); // observable refusal diagnostic

      // NO second writer: reserve and grant are both refused while UNKNOWN.
      expect(ownership.reserve({
        runId: "second-writer", provider: "UPSTOX", pid: process.pid, startedAt: NOW
      }).ok).toBe(false);
      expect(await ownership.grant()).toEqual({ granted: false, reason: "cannot grant from UNKNOWN" });
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(0);
      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(0);
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });

  test("post-bump committed COMPLETED row settles refresh: no re-apply, no second writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0d-post-bump-committed-"));
    const { dbPath, handle } = makeDb(dir);
    const oldRunId = "g0d-old-child-exact-run-post-bump-committed";
    try {
      // The old child committed a COMPLETED row with the EXACT parent-generated
      // runId AFTER the pre-bump check but BEFORE the post-bump verification.
      handle.sqlite.query(
        "INSERT INTO catalog_sync_runs (run_id, source, provider, scope_json, completeness, status, started_at, counts_json, conflicts_json) VALUES (?, 'UPSTOX', 'UPSTOX', '{}', 'COMPLETE', 'COMPLETED', ?, '{}', '[]')"
      ).run(oldRunId, NOW);
      writeOwnerToken(handle.sqlite, token(oldRunId, 7, "TXN"));

      // The wrapper hides the row on the pre-bump lookup (race) and delegates
      // the post-bump lookup to the real repository, which finds the commit.
      const repo = makePostBumpRepo(handle.sqlite);
      const ownership = new CatalogWriteOwnership(repo.wrapped, dbPath);

      const decision = ownership.recoverForStartup();

      expect(decision).toEqual({ decision: "COMMITTED", runId: oldRunId, generation: 8 });
      expect(repo.catalogRunQueries).toBe(2);
      // Settled: token cleared, permit IDLE, no re-application.
      expect(readOwnerToken(handle.sqlite)).toBeNull();
      expect(ownership.currentState).toBe("IDLE");
      expect(rowCount(handle.sqlite, "catalog_sync_runs")).toBe(1);
      expect(rowCount(handle.sqlite, "canonical_instruments")).toBe(0);
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });
});
