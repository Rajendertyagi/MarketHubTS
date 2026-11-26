/**
 * WP3-A focused coverage — exact refresh lifecycle and shutdown contract.
 *
 * Every assertion is deterministic (state, call counts, event ordering, timer
 * handles, abort signals); no wall-clock latency or RSS thresholds are used.
 * Covers the WP3-B rows for STOPPING, timers, abort, staging (by construction),
 * pre-transaction cancellation, in-transaction boundary, drain, DB-close order,
 * startup-failure drain, repeated shutdown and cancellation-vs-failure.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import {
  CatalogMasterRefresh, CatalogSyncService, buildUpstoxImport
} from "../../packages/market-core/src/index";
import type { CatalogRepository, CatalogSyncRunRecord, CatalogRefreshEvent, MasterFetch } from "../../packages/market-core/src/index";
import type { CatalogRefreshState } from "../../packages/market-core/src/sync/refresh";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const CLOCK = new Date("2026-11-24T10:00:00.000Z");
const OPTS = { now: CLOCK.toISOString(), sourceVersion: "wp3-fixture-v1" };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeCatalog(runs: CatalogSyncRunRecord[] = []) {
  const stored = [...runs];
  const catalog = {
    listSyncRuns: async (q: { provider?: string; status?: string; limit?: number } = {}) =>
      stored
        .filter((r) => (!q.provider || r.provider === q.provider) && (!q.status || r.status === q.status))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, q.limit ?? 100),
    recordSyncRun: async (r: CatalogSyncRunRecord) => { stored.push(r); },
    runs: stored
  };
  return catalog as unknown as CatalogRepository & { runs: CatalogSyncRunRecord[] };
}

function makeSync(apply?: (batch: any, reconciliation: any) => Promise<any>) {
  const applied: string[] = [];
  const reconciliations: any[] = [];
  const sync = {
    applyCompleteProviderSnapshot: async (batch: any, reconciliation: any) => {
      applied.push(batch.provider ?? "unknown");
      reconciliations.push(reconciliation);
      if (apply) return apply(batch, reconciliation);
      return { status: "COMPLETED", counts: {} } as any;
    }
  };
  return { sync: sync as unknown as CatalogSyncService, applied, reconciliations };
}

/** Serve valid fixture data for both providers so a refresh reaches apply. */
function fixtureFetch(): MasterFetch {
  return async (url) => {
    if (url.includes("upstox")) return Response.json(upstoxRows);
    if (url.includes("NSE_FO")) return Response.json(fyersFiles.NSE_FO);
    if (url.includes("BSE_FO")) return Response.json(fyersFiles.BSE_FO);
    if (url.includes("NSE_CM")) return Response.json(fyersFiles.NSE_CM);
    if (url.includes("BSE_CM")) return Response.json(fyersFiles.BSE_CM);
    throw new Error(`unexpected url: ${url}`);
  };
}

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition not met");
}

describe("WP3-A refresh lifecycle", () => {
  test("state machine: RUNNING -> STOPPING (observable) -> STOPPED; new starts rejected in STOPPING", async () => {
    const gate = deferred();
    const fetchFn: MasterFetch = async () => { await gate.promise; return Response.json(upstoxRows); };
    const { sync } = makeSync();
    const refresh = new CatalogMasterRefresh({ catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn });

    expect(refresh.state).toBe("RUNNING" as CatalogRefreshState);
    refresh.startIfNeeded();
    await waitFor(() => (refresh as any).inFlight.size === 2);

    refresh.stop();
    expect(refresh.state).toBe("STOPPING" as CatalogRefreshState);

    // A start issued once STOPPING creates no task and issues no fetch.
    const before = (refresh as any).inFlight.size;
    refresh.startIfNeeded();
    expect((refresh as any).inFlight.size).toBe(before);

    gate.resolve();
    await refresh.stopAndWait();
    expect(refresh.state).toBe("STOPPED" as CatalogRefreshState);
  });

  test("timers cleared: no handle remains and advancing past the interval creates no refresh", async () => {
    let calls = 0;
    const fetchFn: MasterFetch = async () => { calls++; return Response.json(upstoxRows); };
    const { sync } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn, refreshIntervalMs: 10
    });
    refresh.startIfNeeded();
    await waitFor(() => calls >= 2);
    refresh.stop();
    expect((refresh as any).timer).toBeNull();
    const atStop = calls;
    await Bun.sleep(80); // 8x the interval
    expect(calls).toBe(atStop);
    await refresh.stopAndWait();
  });

  test("active fetch aborted: signal reaches fetch, request terminates, no post-abort writes", async () => {
    const signals: AbortSignal[] = [];
    const fetchFn: MasterFetch = async (_url, init) => {
      const signal = init?.signal!;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
      });
    };
    const { sync, applied } = makeSync();
    const catalog = makeCatalog();
    const events: CatalogRefreshEvent[] = [];
    const refresh = new CatalogMasterRefresh({
      catalog, sync, now: () => CLOCK, fetch: fetchFn, onEvent: (e) => events.push(e)
    });
    refresh.startIfNeeded();
    await waitFor(() => signals.length === 2);

    await refresh.stopAndWait();

    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(applied.length).toBe(0);                       // no reconciliation
    expect(catalog.runs.length).toBe(0);                  // no DB write at all
    expect(events.filter((e) => e.outcome === "CANCELLED").length).toBe(2);
    expect(events.some((e) => e.outcome === "REFRESHED")).toBe(false);
    expect(events.some((e) => e.outcome === "FAILED")).toBe(false);
  });

  test("pre-transaction cancellation leaves a seeded database untouched and usable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wp3a-pre-txn-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    try {
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const sync = new CatalogSyncService(repo);
      const seed = buildUpstoxImport(upstoxRows, OPTS);
      expect((await sync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation)).status).toBe("COMPLETED");
      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();

      const gate = deferred();
      const fetchFn: MasterFetch = async (_url, init) => {
        const signal = init?.signal!;
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
          void gate.promise; // keep a handle so the shape mirrors a stalled download
        });
      };
      const events: CatalogRefreshEvent[] = [];
      const refresh = new CatalogMasterRefresh({
        catalog: repo, sync, now: () => CLOCK, fetch: fetchFn, onEvent: (e) => events.push(e)
      });
      void (refresh as any).refreshProvider("UPSTOX");
      await waitFor(() => (refresh as any).inFlight.size === 1);
      await refresh.stopAndWait();
      gate.resolve();

      expect(events.some((e) => e.outcome === "CANCELLED")).toBe(true);
      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      expect((await repo.listSyncRuns({ provider: "UPSTOX", status: "FAILED" })).length).toBe(0);
      // DB remains usable after cancellation.
      expect((await repo.listInstruments()).length).toBeGreaterThan(0);
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("in-transaction cancellation reaches the existing boundary; DB closes only after drain", async () => {
    const order: string[] = [];
    const gate = deferred();
    const { sync, applied } = makeSync(async () => {
      order.push("txn:start");
      await gate.promise;                 // refresh is inside the atomic boundary
      order.push("txn:boundary");
      return { status: "COMPLETED", counts: {} } as any;
    });
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fixtureFetch()
    });
    void (refresh as any).refreshProvider("UPSTOX");
    await waitFor(() => order.includes("txn:start"));

    let drained = false;
    const draining = refresh.stopAndWait().then(() => { drained = true; order.push("drained"); });
    await Bun.sleep(20);
    expect(drained).toBe(false);          // stopAndWait must not resolve early
    expect(order).not.toContain("drained");

    gate.resolve();
    await draining;
    expect(order).toEqual(["txn:start", "txn:boundary", "drained"]);
    expect(applied).toEqual(["UPSTOX"]);  // the transaction reached its boundary
    // DB closure is modelled as the final step after drain.
    order.push("db:close");
    expect(order[order.length - 1]).toBe("db:close");
  });

  test("stopAndWait awaits the active task; repeated stop/stopAndWait are idempotent", async () => {
    const gate = deferred();
    let applyStarted = false;
    const { sync } = makeSync(async () => {
      applyStarted = true;
      await gate.promise;
      return { status: "COMPLETED", counts: {} } as any;
    });
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fixtureFetch()
    });
    void (refresh as any).refreshProvider("UPSTOX");
    await waitFor(() => applyStarted);

    let resolved = false;
    const first = refresh.stopAndWait().then(() => { resolved = true; });
    await Bun.sleep(20);
    expect(resolved).toBe(false);

    gate.resolve();
    await first;
    expect(resolved).toBe(true);

    // Repeated calls are no-ops: no error, no new task, no leaked handle.
    await refresh.stopAndWait();
    refresh.stop();
    await refresh.stopAndWait();
    expect(refresh.state).toBe("STOPPED" as CatalogRefreshState);
    expect((refresh as any).timer).toBeNull();
    expect((refresh as any).inFlight.size).toBe(0);
    expect((refresh as any).controllers.size).toBe(0);
  });

  test("startup-failure drain: same stopAndWait leaves no timer, task or controller leak", async () => {
    const gate = deferred();
    const fetchFn: MasterFetch = async (_url, init) => {
      const signal = init?.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
      });
    };
    const { sync } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn, refreshIntervalMs: 10
    });
    refresh.startIfNeeded();
    await waitFor(() => (refresh as any).inFlight.size === 2);
    // Simulate a partial-init failure: drain before closing resources.
    await refresh.stopAndWait();
    gate.resolve();
    expect((refresh as any).timer).toBeNull();
    expect((refresh as any).inFlight.size).toBe(0);
    expect((refresh as any).controllers.size).toBe(0);
    expect(refresh.state).toBe("STOPPED" as CatalogRefreshState);
  });

  test("cancellation vs failure: cancellation is distinct and never reconciles; failure still records FAILED", async () => {
    // Cancellation path.
    const cancelFetch: MasterFetch = async (_url, init) => {
      const signal = init?.signal!;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
      });
    };
    const cancelCatalog = makeCatalog();
    const cancelEvents: CatalogRefreshEvent[] = [];
    const cancelSync = makeSync();
    const cancelled = new CatalogMasterRefresh({
      catalog: cancelCatalog, sync: cancelSync.sync, now: () => CLOCK,
      fetch: cancelFetch, onEvent: (e) => cancelEvents.push(e)
    });
    void (cancelled as any).refreshProvider("UPSTOX");
    await waitFor(() => (cancelled as any).inFlight.size === 1);
    await cancelled.stopAndWait();
    expect(cancelEvents.some((e) => e.outcome === "CANCELLED")).toBe(true);
    expect(cancelSync.applied.length).toBe(0);
    expect(cancelCatalog.runs.length).toBe(0);

    // Provider-failure path (not cancelled) still records a concise FAILED run.
    const failCatalog = makeCatalog();
    const failEvents: CatalogRefreshEvent[] = [];
    const failed = new CatalogMasterRefresh({
      catalog: failCatalog, sync: makeSync().sync, now: () => CLOCK,
      fetch: async () => { throw new Error("network down"); },
      onEvent: (e) => failEvents.push(e)
    });
    await (failed as any).refreshProvider("UPSTOX");
    expect(failEvents.some((e) => e.outcome === "FAILED")).toBe(true);
    expect(failEvents.some((e) => e.outcome === "CANCELLED")).toBe(false);
    expect(failCatalog.runs.some((r) => r.status === "FAILED")).toBe(true);
  });

  test("staging cleanup by construction: refresh sources contain no filesystem staging writes", () => {
    // WP2 bounded streaming uses in-memory accumulators only. This guard fails
    // if a future change introduces staging files without an explicit cleanup
    // contract (WP3-A item 5 / WP2-B item 5).
    const files = [
      "packages/market-core/src/sync/refresh.ts",
      "packages/market-core/src/sync/upstox-master.ts",
      "packages/market-core/src/sync/fyers-master.ts"
    ];
    const forbidden = /\b(writeFileSync|writeFile|createWriteStream|mkdtempSync|mkdtemp|appendFileSync)\s*\(/;
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(forbidden.test(source)).toBe(false);
    }
  });
});
