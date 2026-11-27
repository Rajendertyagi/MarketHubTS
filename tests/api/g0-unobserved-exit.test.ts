/**
 * Bounded correction — unobserved child exit must never admit a second writer.
 *
 * Regression: after a last-resort kill whose exit could NOT be confirmed, the
 * manager used to compute `unexpectedExit` from code/signal only. With both
 * null (child possibly still alive) `onUnexpectedExit` was skipped, and the
 * production `onSettled` released the durable token / returned the permit to
 * IDLE — admitting another child while the old process might still hold the
 * write lock.
 *
 * This test drives the ACTUAL manager + ACTUAL production ownership wiring
 * (`createCatalogOwnershipWiring`) + ACTUAL production executor shape
 * (reserve BEFORE dispatch). Only the remote network source is absent: the
 * test child deliberately never reaches a transaction. Windows / Bun 1.4.5.
 */
import { describe, expect, test } from "bun:test";
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
import { createCatalogOwnershipWiring } from "../../apps/api/src/index";
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

function rowCount(sqlite: DatabaseHandle["sqlite"], table: string): number {
  return (sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
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
        runId, provider, nowIso, intentKey: "g0-unobserved", generation: reservation.generation
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
    close: async () => {
      try { await refresh.stopAndWait(); } catch {}
      try { await manager.shutdown(); } catch {}
      try { ownership.release(); } catch {}
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  };
}

describe("G0 unobserved-exit correction (commit 539c4a7)", () => {
  test("unobserved child exit keeps UNKNOWN + token and refuses every subsequent writer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0-unobserved-"));
    const harness = makeHarness(dir, makeStubbornChildEntry(dir));
    try {
      // First run: the child handshakes, then never exits observably.
      await harness.runProvider("UPSTOX");

      const spawnCount = harness.events.filter((e) => e.type === "spawn").length;
      expect(spawnCount).toBe(1);
      expect(harness.events.some((e) => e.type === "settled")).toBe(true);

      // The manager recorded an unobserved exit and the PRODUCTION hooks kept
      // the permit UNKNOWN with the durable token intact.
      expect(harness.ownership.currentState).toBe("UNKNOWN");
      const token = readOwnerToken(harness.parent.sqlite);
      expect(token).not.toBeNull();
      const firstRunId = token!.runId;

      // A non-authorizing REFUSED recovery diagnostic was surfaced (no RESUME).
      expect(harness.recoveryDecisions.some(
        (d) => d.decision === "REFUSED" && "reason" in d &&
          d.reason === "child exit unobserved after kill escalation"
      )).toBe(true);
      expect(harness.recoveryDecisions.some((d) => d.decision === "RESUME")).toBe(false);

      // Both synchronous guards refuse a second writer while UNKNOWN.
      expect(harness.ownership.reserve({
        runId: "second-writer", provider: "FYERS", pid: process.pid, startedAt: NOW
      }).ok).toBe(false);
      expect(await harness.ownership.grant()).toEqual({ granted: false, reason: "cannot grant from UNKNOWN" });

      // A subsequent production refresh is admitted only as a FAILED outcome:
      // reserve() refuses before dispatch, so NO second child is spawned and
      // no second writer touches SQLite.
      await harness.runProvider("FYERS");
      expect(harness.events.filter((e) => e.type === "spawn").length).toBe(1);
      expect(harness.refreshEvents.some(
        (e) => e.outcome === "FAILED" && (e.reason ?? "").includes("catalog write ownership unavailable")
      )).toBe(true);
      expect(rowCount(harness.parent.sqlite, "canonical_instruments")).toBe(0);
      expect(rowCount(harness.parent.sqlite, "catalog_sync_runs")).toBe(0);

      // Still UNKNOWN with the original token after the refused second run.
      expect(harness.ownership.currentState).toBe("UNKNOWN");
      expect(readOwnerToken(harness.parent.sqlite)!.runId).toBe(firstRunId);
    } finally {
      await harness.close();
    }
  }, 20_000);
});
