/**
 * Targeted correction (technical-lead review of a6264b1): shutdown must NOT
 * delete the durable catalog-write ownership token while the permit is UNKNOWN.
 *
 * Before the correction, both shutdown cleanup paths called `ownership.release()`
 * unconditionally. After an unobserved child exit the manager clears its active
 * slot, so `childManager.shutdown()` has nothing to wait on, and the unconditional
 * release deleted the token retained by the unobserved-exit fail-closed fix.
 * A restart then saw ABSENT -> NO_TOKEN -> IDLE and could admit a second writer
 * while the original child might still be alive.
 *
 * This test drives the ACTUAL manager + ACTUAL production ownership wiring
 * (`createCatalogOwnershipWiring`) + the ACTUAL production shutdown ownership
 * step (`releaseOwnershipForShutdown`, shared by `drainStartupFailure` and the
 * normal `shutdown` path). Only the remote network source is absent: the test
 * child deliberately never reaches a transaction. Windows / Bun 1.4.5.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultMigrationsFolder, openDatabase, runMigrations, SqliteCatalogRepository,
  type DatabaseHandle
} from "../../packages/database/src/index";
import { type ProviderId } from "../../packages/contracts/src/index";
import { CatalogMasterRefresh, type CatalogRefreshEvent } from "../../packages/market-core/src/index";
import { CatalogRefreshChildManager, type ManagerEvent } from "../../apps/api/src/catalog-refresh-child-manager";
import {
  CatalogWriteOwnership, readOwnerToken, type RecoveryDecision
} from "../../apps/api/src/catalog-write-ownership";
import { CatalogWriteCoordinator } from "../../apps/api/src/catalog-write-coordinator";
import {
  createCatalogOwnershipWiring, releaseOwnershipForShutdown
} from "../../apps/api/src/index";
import { closeDatabaseHandle, removeTempDirAsync } from "../helpers/fs-cleanup";

const API_SRC = resolve(import.meta.dir, "../../apps/api/src");
const REPO_ROOT = resolve(API_SRC, "../..");
const NOW = "2026-11-27T10:00:00.000Z";

function makeDb(dir: string) {
  const dbPath = join(dir, "test.sqlite");
  const handle = openDatabase({ dbPath });
  runMigrations(handle.db, defaultMigrationsFolder);
  return { dbPath, handle };
}

/**
 * Test-only child: completes the ready + grant handshake, then deliberately
 * never sends a terminal result and ignores `shutdown`. The parent must bound
 * the terminal/exit waits, escalate to a kill, and — because the escalation
 * window is forced to 0 ms — record the exit as UNOBSERVED.
 */
function makeStubbornChildEntry(dir: string): string {
  const path = join(dir, "child-stubborn.ts");
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
    // Never send a terminal result; stay alive without touching SQLite.
    return;
  }
  if (m.type === "shutdown") {
    // Deliberately ignore graceful shutdown so the parent escalates to kill.
    return;
  }
});
`;
  writeFileSync(path, source, "utf8");
  return path;
}

interface Harness {
  dbPath: string;
  parent: DatabaseHandle;
  ownership: CatalogWriteOwnership;
  manager: CatalogRefreshChildManager;
  events: ManagerEvent[];
  refreshEvents: CatalogRefreshEvent[];
  recoveryDecisions: RecoveryDecision[];
  runProvider: (provider: ProviderId) => Promise<void>;
  /** Exact ownership-release step used by both production shutdown paths. */
  shutdownOwnership: () => { released: boolean; skippedUnknown: boolean };
  close: () => Promise<void>;
}

function makeHarness(dir: string, childEntry: string): Harness {
  const { dbPath, handle: parent } = makeDb(dir);
  const events: ManagerEvent[] = [];
  const refreshEvents: CatalogRefreshEvent[] = [];
  const recoveryDecisions: RecoveryDecision[] = [];

  const ownership = new CatalogWriteOwnership(parent.sqlite, dbPath);
  const coordinator = new CatalogWriteCoordinator({
    getPermitState: () => ownership.currentState,
    onEvent: () => {}
  });
  ownership.setDrainHook(() => coordinator.drain());

  // EXACT production composition-root wiring from apps/api/src/index.ts.
  const wiring = createCatalogOwnershipWiring(ownership, ({ decision }) => {
    recoveryDecisions.push(decision);
  });
  const manager = new CatalogRefreshChildManager({
    dbPath, mode: "pipeline", childEntryPath: childEntry, cwd: REPO_ROOT,
    pipelineExitTimeoutMs: 300,
    // Force the post-kill exit observation to time out deterministically.
    exitEscalationTimeoutMs: 0,
    onEvent: (e) => { wiring.onManagerEvent(e); events.push(e); },
    ownershipHooks: wiring.ownershipHooks
  });

  // EXACT production executor shape: reserve BEFORE requestRefresh.
  const refresh = new CatalogMasterRefresh({
    catalog: new SqliteCatalogRepository(parent.db, parent.sqlite, coordinator),
    sync: {} as never,
    now: () => new Date(NOW),
    onEvent: (e) => refreshEvents.push(e),
    executor: async ({ provider, runId, nowIso }) => {
      const reservation = ownership.reserve({ runId, provider, pid: process.pid, startedAt: nowIso });
      if (!reservation.ok) {
        return {
          status: "FAILED", counts: {}, cancelled: false, applyAttempted: false,
          error: `catalog write ownership unavailable: ${reservation.reason}`
        };
      }
      const result = await manager.requestRefresh({
        runId, provider, nowIso, intentKey: "g0-shutdown-token", generation: reservation.generation
      });
      const terminal = result.terminal;
      if (terminal?.type === "result") {
        return {
          status: terminal.status, counts: terminal.counts,
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
    }
  });

  return {
    dbPath, parent, ownership, manager, events, refreshEvents, recoveryDecisions,
    runProvider: async (provider: ProviderId) => {
      await (refresh as unknown as { refreshProvider: (p: ProviderId) => Promise<void> }).refreshProvider(provider);
    },
    shutdownOwnership: () => releaseOwnershipForShutdown(ownership),
    close: async () => {
      try { await refresh.stopAndWait(); } catch {}
      try { await manager.shutdown(); } catch {}
      try { ownership.release(); } catch {}
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  };
}

describe("G0 shutdown token preservation (review of a6264b1)", () => {
  test("unobserved exit + shutdown retains the token; a restart cannot admit a writer while unresolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0-shutdown-token-"));
    const harness = makeHarness(dir, makeStubbornChildEntry(dir));
    try {
      // 1) Unobserved child exit via the existing forced-timeout seam.
      await harness.runProvider("UPSTOX");
      expect(harness.events.filter((e) => e.type === "spawn").length).toBe(1);
      expect(harness.ownership.currentState).toBe("UNKNOWN");
      const firstToken = readOwnerToken(harness.parent.sqlite);
      expect(firstToken).not.toBeNull();
      const firstRunId = firstToken!.runId;
      expect(harness.recoveryDecisions.some(
        (d) => d.decision === "REFUSED" && "reason" in d &&
          d.reason === "child exit unobserved after kill escalation"
      )).toBe(true);

      // 2) Run the exact production shutdown ownership step. The manager's
      //    active slot is already null after the unobserved exit, so there is
      //    no child for shutdown to wait on — this is the failing scenario.
      const shutdownResult = harness.shutdownOwnership();
      expect(shutdownResult).toEqual({ released: false, skippedUnknown: true });
      expect(harness.ownership.currentState).toBe("UNKNOWN");
      const retained = readOwnerToken(harness.parent.sqlite);
      expect(retained).not.toBeNull();
      expect(retained!.runId).toBe(firstRunId);
      expect(retained!.generation).toBe(firstToken!.generation);

      // 3) Simulated restart: a NEW ownership instance reads the SAME database.
      //    Hold a write lock on a separate connection to model the original
      //    writer still being unresolved (the probe must fail closed).
      const blocker = new Database(harness.dbPath, { create: false, strict: true });
      try {
        blocker.exec("BEGIN IMMEDIATE");
        const restarted = new CatalogWriteOwnership(harness.parent.sqlite, harness.dbPath);
        const decision = restarted.recoverForStartup();
        expect(decision.decision).toBe("RETRY");
        expect(restarted.currentState).toBe("UNKNOWN");
        // The retained token is still the evidence for a later recovery.
        expect(readOwnerToken(harness.parent.sqlite)!.runId).toBe(firstRunId);
        // No writer may be admitted while the original ownership is unresolved.
        expect(restarted.reserve({
          runId: "restart-writer", provider: "FYERS", pid: process.pid, startedAt: NOW
        }).ok).toBe(false);
        expect(await restarted.grant()).toEqual({ granted: false, reason: "cannot grant from UNKNOWN" });
      } finally {
        try { blocker.exec("ROLLBACK"); } catch {}
        try { blocker.close(); } catch {}
      }
    } finally {
      await harness.close();
    }
  }, 20_000);

  test("ordinary clean shutdown still releases the token (no over-correction)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0-shutdown-clean-"));
    const { dbPath, handle } = makeDb(dir);
    try {
      const ownership = new CatalogWriteOwnership(handle.sqlite, dbPath);
      const reservation = ownership.reserve({
        runId: "clean-run", provider: "UPSTOX", pid: process.pid, startedAt: NOW
      });
      expect(reservation.ok).toBe(true);
      expect(ownership.currentState).toBe("RESERVED");
      expect(readOwnerToken(handle.sqlite)).not.toBeNull();

      const result = releaseOwnershipForShutdown(ownership);
      expect(result).toEqual({ released: true, skippedUnknown: false });
      expect(ownership.currentState).toBe("IDLE");
      expect(readOwnerToken(handle.sqlite)).toBeNull();
    } finally {
      closeDatabaseHandle(handle);
      await removeTempDirAsync(dir);
    }
  });
});
