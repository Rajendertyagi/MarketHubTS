/**
 * G0-B — real child-process refresh pipeline tests (Windows, real Bun.spawn +
 * IPC + real SQLite). Fixture-driven Upstox and FYERS runs exercise the full
 * download → parse → validate → apply path in the child, with golden counts,
 * source-version hashes, run-ID threading, fail-closed sources, serialized
 * provider isolation, the child diagnostic-write bypass and an IPC size bound.
 *
 * No live provider is contacted and no numeric latency threshold is adopted.
 * Timings are recorded as evidence only. The original
 * `catalog-refresh-wp3-g0.test.ts` is preserved unchanged as a regression.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultMigrationsFolder, openDatabase, runMigrations, SqliteCatalogRepository
} from "../../packages/database/src/index";
import {
  buildUpstoxImport, CatalogSyncService, SyncConflictError, CatalogMasterRefresh,
  type CatalogRefreshEvent
} from "../../packages/market-core/src/index";
import {
  CatalogRefreshChildManager, type ManagerEvent
} from "../../apps/api/src/catalog-refresh-child-manager";
import {
  MAX_IPC_MESSAGE_BYTES, parseChildMessage, type ChildMessage
} from "../../apps/api/src/catalog-refresh-ipc";
import { closeDatabaseHandle, removeTempDirAsync } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const API_SRC = resolve(import.meta.dir, "../../apps/api/src");
const REPO_ROOT = resolve(API_SRC, "../..");
const ADAPTER = resolve(API_SRC, "catalog-refresh-child-pipeline.ts");
const ADAPTER_URL = pathToFileURL(ADAPTER).href;
const ADAPTER_SOURCE = readFileSync(ADAPTER, "utf8");
const REFRESH_SOURCE = readFileSync(
  resolve(import.meta.dir, "../../packages/market-core/src/sync/refresh.ts"), "utf8"
);
const APPLY_SOURCE = readFileSync(
  resolve(import.meta.dir, "../../packages/market-core/src/sync/apply.ts"), "utf8"
);

const NOW = "2026-11-24T10:00:00.000Z";
const OPTS = { now: NOW, sourceVersion: "g0b-fixture-v1" };

type Scenario = "upstox-valid" | "fyers-valid" | "malformed" | "truncated" | "oversized" | "isolated" | "large";

/**
 * Test-only child entry: installs the REAL pipeline adapter with a fixture
 * fetch. The adapter, accumulators, validation and atomic apply are the exact
 * production modules; only the network source is replaced by local fixtures.
 */
function makeChildEntry(dir: string, scenario: Scenario): string {
  const path = join(dir, `child-${scenario}.ts`);
  const fixtures = JSON.stringify({ upstox: upstoxRows, fyers: fyersFiles });
  const source = `
import { installChildPipeline } from ${JSON.stringify(ADAPTER_URL)};
const FIXTURES = ${fixtures};
const SCENARIO = ${JSON.stringify(scenario)};
const fetchFn = async (url) => {
  if (SCENARIO === "malformed") return new Response("not json at all");
  if (SCENARIO === "truncated") {
    const cs = new CompressionStream("gzip");
    const w = cs.writable.getWriter();
    void w.write(new TextEncoder().encode(JSON.stringify(FIXTURES.upstox)));
    void w.close();
    const gz = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    return new Response(gz.slice(0, Math.floor(gz.length / 2)));
  }
  if (SCENARIO === "oversized") {
    return new Response("[" + new Array(1_000_001).fill("{}").join(",") + "]");
  }
  if (SCENARIO === "large") {
    const rows = [];
    for (let i = 0; i < 500; i++) {
      const key = "NSE_EQ|G0N" + i;
      rows.push({ segment: "NSE_EQ", name: "NSE SYN " + i, exchange: "NSE", isin: "INEG0N" + String(i).padStart(5, "0"), instrument_type: "EQ", instrument_key: key, exchange_token: String(100000 + i), tick_size: 0.05, trading_symbol: "GSYN" + i, short_name: "GSYN" + i });
      rows.push({ segment: "NSE_FO", name: "NSE SYN " + i, exchange: "NSE", instrument_type: "OPTSTK", option_type: "CE", instrument_key: "NSE_FO|G0N" + i + "-CE", underlying_key: key, underlying_type: "EQ", expiry: "2026-12-29T15:00:00+05:30", strike_price: 100 + i, lot_size: 250, tick_size: 0.05, freeze_quantity: 10000, trading_symbol: "GSYN" + i + "26DEC" + (100 + i) + "CE" });
      const bkey = "BSE_EQ|G0B" + i;
      rows.push({ segment: "BSE_EQ", name: "BSE SYN " + i, exchange: "BSE", isin: "INEG0B" + String(i).padStart(5, "0"), instrument_type: "EQ", instrument_key: bkey, exchange_token: String(200000 + i), tick_size: 0.05, trading_symbol: "GBSYN" + i, short_name: "GBSYN" + i });
      rows.push({ segment: "BSE_FO", name: "BSE SYN " + i, exchange: "BSE", instrument_type: "OPTSTK", option_type: "PE", instrument_key: "BSE_FO|G0B" + i + "-PE", underlying_key: bkey, underlying_type: "EQ", expiry: "2026-12-29T15:00:00+05:30", strike_price: 200 + i, lot_size: 100, tick_size: 0.05, freeze_quantity: 5000, trading_symbol: "GBSYN" + i + "26DEC" + (200 + i) + "PE" });
    }
    return new Response(JSON.stringify(rows));
  }
  if (SCENARIO === "isolated" && url.includes("upstox")) return new Response("not json");
  if (url.includes("upstox")) return new Response(JSON.stringify(FIXTURES.upstox));
  if (url.includes("NSE_FO")) return Response.json(FIXTURES.fyers.NSE_FO);
  if (url.includes("BSE_FO")) return Response.json(FIXTURES.fyers.BSE_FO);
  if (url.includes("NSE_CM")) return Response.json(FIXTURES.fyers.NSE_CM);
  if (url.includes("BSE_CM")) return Response.json(FIXTURES.fyers.BSE_CM);
  throw new Error("unexpected url " + url);
};
installChildPipeline({ fetchFn });
`;
  writeFileSync(path, source, "utf8");
  return path;
}

/**
 * Test-only child entry that counts `BEGIN IMMEDIATE` executions on the child
 * connection by wrapping `Database.prototype.exec`. Direct evidence for the
 * "one atomic transaction per successful run" acceptance criterion.
 */
function makeCountingChildEntry(dir: string): { entry: string; countPath: string } {
  const entry = join(dir, "child-counting.ts");
  const countPath = join(dir, "begin-immediate.log");
  const source = `
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { installChildPipeline } from ${JSON.stringify(ADAPTER_URL)};
const COUNT_PATH = ${JSON.stringify(countPath)};
const originalExec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
  if (String(sql).includes("BEGIN IMMEDIATE")) appendFileSync(COUNT_PATH, "B\\n");
  return originalExec.call(this, sql);
};
const FIXTURES = ${JSON.stringify({ upstox: upstoxRows })};
const fetchFn = async (url) => {
  if (url.includes("upstox")) return new Response(JSON.stringify(FIXTURES.upstox));
  throw new Error("unexpected url " + url);
};
installChildPipeline({ fetchFn });
`;
  writeFileSync(entry, source, "utf8");
  return { entry, countPath };
}

/**
 * Test-only child entry that withholds `txn-starting` from the parent (so no
 * `txn-granted` is ever sent) and writes a marker when the child enters the
 * grant wait. This makes "cancel while blocked in beforeApply" deterministic:
 * the test waits for the marker, then cancels.
 */
function makeGrantBlockedChildEntry(
  dir: string, grantTimeoutMs: number
): { entry: string; markerPath: string } {
  const entry = join(dir, "child-grant-blocked.ts");
  const markerPath = join(dir, "grant-waiting.marker");
  const fixtures = JSON.stringify({ upstox: upstoxRows });
  const source = `
import { writeFileSync } from "node:fs";
import { installChildPipeline } from ${JSON.stringify(ADAPTER_URL)};
const MARKER_PATH = ${JSON.stringify(markerPath)};
const FIXTURES = ${fixtures};
const fetchFn = async (url) => {
  if (url.includes("upstox")) return new Response(JSON.stringify(FIXTURES.upstox));
  throw new Error("unexpected url " + url);
};
const send = (message) => {
  if (message && message.type === "txn-starting") {
    writeFileSync(MARKER_PATH, "waiting");
    return; // withhold the grant request so the child stays in beforeApply
  }
  if (typeof process.send === "function") process.send(message);
};
installChildPipeline({ fetchFn, send, grantTimeoutMs: ${grantTimeoutMs} });
`;
  writeFileSync(entry, source, "utf8");
  return { entry, markerPath };
}

function makeManager(
  dbPath: string, childEntryPath: string, onEvent?: (event: ManagerEvent) => void
): CatalogRefreshChildManager {
  return new CatalogRefreshChildManager({
    dbPath, mode: "pipeline", childEntryPath, cwd: REPO_ROOT,
    pipelineExitTimeoutMs: 30_000, onEvent
  });
}

function resultOf(result: { terminal?: ChildMessage }): Extract<ChildMessage, { type: "result" }> {
  expect(result.terminal?.type).toBe("result");
  return result.terminal as Extract<ChildMessage, { type: "result" }>;
}

describe("G0-B — child refresh pipeline", () => {
  test("verified runtime baseline: Bun 1.4.5, SQLite 3.54.1", () => {
    expect(Bun.version).toBe("1.4.5");
    expect(process.versions.sqlite).toBe("3.54.1");
  });

  test("fixture-driven Upstox child run: golden counts, sourceVersion, run-ID threading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0b-upstox-"));
    const dbPath = join(dir, "test.sqlite");
    const parent = openDatabase({ dbPath });
    runMigrations(parent.db, defaultMigrationsFolder);
    const manager = makeManager(dbPath, makeChildEntry(dir, "upstox-valid"));
    const runId = "g0b-upstox-run-0001";
    try {
      const result = await manager.requestRefresh({
        runId, provider: "UPSTOX", nowIso: NOW, intentKey: "g0b", generation: 0
      });
      expect(result.ok).toBe(true);
      expect(result.exit.code).toBe(0);
      expect(result.protocolErrors).toEqual([]);
      expect(result.maxMessageBytes).toBeLessThanOrEqual(MAX_IPC_MESSAGE_BYTES);
      const terminal = resultOf(result);
      expect(terminal.status).toBe("COMPLETED");
      expect(terminal.counts.instrumentsUpserted).toBe(8);
      expect(terminal.counts.mappingsUpserted).toBe(8);
      expect(terminal.counts.conflicts).toBe(0);
      expect(terminal.sourceVersion).toBe(
        createHash("sha256").update(JSON.stringify(upstoxRows)).digest("hex")
      );

      const repo = new SqliteCatalogRepository(parent.db, parent.sqlite);
      expect((await repo.listInstruments()).length).toBe(8);
      const runs = await repo.listSyncRuns({ provider: "UPSTOX", status: "COMPLETED" });
      expect(runs.length).toBe(1);
      // Run-ID threading: the parent-generated ID is the committed row's run_id.
      expect(runs[0]!.runId).toBe(runId);
      expect(runs[0]!.sourceVersion).toBe(terminal.sourceVersion);
      expect(existsSync(`${dbPath}-journal`)).toBe(false);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("fixture-driven FYERS child run: golden counts, sourceVersion, run-ID threading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0b-fyers-"));
    const dbPath = join(dir, "test.sqlite");
    const parent = openDatabase({ dbPath });
    runMigrations(parent.db, defaultMigrationsFolder);
    const manager = makeManager(dbPath, makeChildEntry(dir, "fyers-valid"));
    const runId = "g0b-fyers-run-0002";
    try {
      const result = await manager.requestRefresh({
        runId, provider: "FYERS", nowIso: NOW, intentKey: "g0b", generation: 0
      });
      expect(result.ok).toBe(true);
      expect(result.maxMessageBytes).toBeLessThanOrEqual(MAX_IPC_MESSAGE_BYTES);
      const terminal = resultOf(result);
      expect(terminal.status).toBe("COMPLETED");
      expect(terminal.counts.instrumentsUpserted).toBe(9);
      expect(terminal.counts.mappingsUpserted).toBe(9);
      expect(terminal.counts.conflicts).toBe(0);
      // FYERS legacy source-version contract: sha256(JSON.stringify(files)) in
      // FYERS_MASTER_URLS order (NSE_FO, BSE_FO, NSE_CM, BSE_CM).
      const files = {
        NSE_FO: fyersFiles.NSE_FO, BSE_FO: fyersFiles.BSE_FO,
        NSE_CM: fyersFiles.NSE_CM, BSE_CM: fyersFiles.BSE_CM
      };
      expect(terminal.sourceVersion).toBe(
        createHash("sha256").update(JSON.stringify(files)).digest("hex")
      );

      const repo = new SqliteCatalogRepository(parent.db, parent.sqlite);
      expect((await repo.listInstruments()).length).toBe(9);
      const runs = await repo.listSyncRuns({ provider: "FYERS", status: "COMPLETED" });
      expect(runs.length).toBe(1);
      expect(runs[0]!.runId).toBe(runId);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("exactly one BEGIN IMMEDIATE per successful child run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0b-txn-count-"));
    const dbPath = join(dir, "test.sqlite");
    const parent = openDatabase({ dbPath });
    runMigrations(parent.db, defaultMigrationsFolder);
    const { entry, countPath } = makeCountingChildEntry(dir);
    const manager = makeManager(dbPath, entry);
    try {
      const result = await manager.requestRefresh({
        runId: "g0b-txn-count-run", provider: "UPSTOX", nowIso: NOW, intentKey: "g0b", generation: 0
      });
      expect(resultOf(result).status).toBe("COMPLETED");
      const begins = existsSync(countPath)
        ? readFileSync(countPath, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
      expect(begins).toBe(1);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("malformed, truncated and oversized sources fail closed with zero apply and zero diagnostic rows", async () => {
    for (const scenario of ["malformed", "truncated", "oversized"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `g0b-${scenario}-`));
      const dbPath = join(dir, "test.sqlite");
      const parent = openDatabase({ dbPath });
      runMigrations(parent.db, defaultMigrationsFolder);
      const manager = makeManager(dbPath, makeChildEntry(dir, scenario));
      try {
        const result = await manager.requestRefresh({
          runId: `g0b-${scenario}-run`, provider: "UPSTOX", nowIso: NOW, intentKey: "g0b", generation: 0
        });
        expect(result.ok).toBe(true); // clean child exit, structured failure
        const terminal = resultOf(result);
        expect(terminal.status).toBe("FAILED");
        expect(terminal.error).toBeDefined();
        expect(terminal.error!.length).toBeLessThanOrEqual(300);

        const repo = new SqliteCatalogRepository(parent.db, parent.sqlite);
        expect((await repo.listInstruments()).length).toBe(0);
        // Child diagnostic-write bypass: no autocommit FAILED row and no
        // COMPLETED row — the child wrote nothing outside the atomic apply.
        expect((await repo.listSyncRuns()).length).toBe(0);
      } finally {
        await manager.shutdown();
        closeDatabaseHandle(parent);
        await removeTempDirAsync(dir);
      }
    }
  });

  test("provider isolation: a failed Upstox child does not prevent the serialized FYERS child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0b-isolated-"));
    const dbPath = join(dir, "test.sqlite");
    const parent = openDatabase({ dbPath });
    runMigrations(parent.db, defaultMigrationsFolder);
    const events: ManagerEvent[] = [];
    const manager = makeManager(dbPath, makeChildEntry(dir, "isolated"), (event) => events.push(event));
    try {
      const [upstox, fyers] = await Promise.all([
        manager.requestRefresh({ runId: "g0b-iso-up", provider: "UPSTOX", nowIso: NOW, intentKey: "g0b", generation: 0 }),
        manager.requestRefresh({ runId: "g0b-iso-fy", provider: "FYERS", nowIso: NOW, intentKey: "g0b", generation: 0 })
      ]);
      expect(resultOf(upstox).status).toBe("FAILED");
      expect(resultOf(fyers).status).toBe("COMPLETED");

      const spawnIndexes = events.flatMap((event, index) => event.type === "spawn" ? [index] : []);
      const exitIndexes = events.flatMap((event, index) => event.type === "exit" ? [index] : []);
      expect(spawnIndexes.length).toBe(2);
      expect(exitIndexes.length).toBe(2);
      // Serialized, not concurrent: the second child spawns only after the first exits.
      expect(spawnIndexes[1]!).toBeGreaterThan(exitIndexes[0]!);

      const repo = new SqliteCatalogRepository(parent.db, parent.sqlite);
      const completed = await repo.listSyncRuns({ status: "COMPLETED" });
      expect(completed.length).toBe(1);
      expect(completed[0]!.runId).toBe("g0b-iso-fy");
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("child diagnostic-write bypass: source-scan and all three apply failure paths", async () => {
    // Source layer: the child adapter never calls recordSyncRun and constructs
    // the service in child mode; apply.ts gates the recorder on that flag.
    expect(ADAPTER_SOURCE).not.toMatch(/\.recordSyncRun\s*\(/);
    expect(ADAPTER_SOURCE).toContain("disableDiagnosticRunRecording: true");
    expect(APPLY_SOURCE).toContain("if (this.options.disableDiagnosticRunRecording) return;");

    const seed = buildUpstoxImport(upstoxRows, OPTS);
    const recorded: unknown[] = [];
    const genericRepo = {
      transaction: async () => { throw new Error("boom"); },
      recordSyncRun: async (run: unknown) => { recorded.push(run); }
    } as any;
    const conflictRepo = {
      transaction: async () => {
        throw new SyncConflictError([{ type: "TEST", severity: "ERROR", message: "conflict" }]);
      },
      recordSyncRun: async (run: unknown) => { recorded.push(run); }
    } as any;

    // Path 1 (invalid batch / prepareRun), path 2 (SyncConflictError) and
    // path 3 (generic error) must all be silent in child mode.
    const childSync = new CatalogSyncService(genericRepo, { disableDiagnosticRunRecording: true });
    await childSync.applyCompleteProviderSnapshot({} as any, seed.reconciliation);
    await childSync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation);
    const childConflictSync = new CatalogSyncService(conflictRepo, { disableDiagnosticRunRecording: true });
    await childConflictSync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation);
    expect(recorded.length).toBe(0);

    // Control: the same failure path in normal (parent) mode still records.
    const parentSync = new CatalogSyncService(genericRepo);
    await parentSync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation);
    expect(recorded.length).toBe(1);
  });

  test("IPC payload bound and no staging-file writes", () => {
    expect(MAX_IPC_MESSAGE_BYTES).toBeLessThanOrEqual(8192);
    expect(parseChildMessage({
      type: "result", runId: "r", status: "COMPLETED", counts: { instrumentsUpserted: 8 }
    }).ok).toBe(true);
    for (const source of [ADAPTER_SOURCE, REFRESH_SOURCE]) {
      expect(source).not.toMatch(/writeFileSync|createWriteStream|Bun\.write|appendFileSync/);
    }
    expect(ADAPTER_SOURCE).toContain("migrate: false");
    expect(REFRESH_SOURCE).toContain("runProviderRefreshPipeline");
  });

  test("parent reads stay responsive while the child parses a large source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0b-large-"));
    const dbPath = join(dir, "test.sqlite");
    const parent = openDatabase({ dbPath });
    runMigrations(parent.db, defaultMigrationsFolder);
    const eventLog: Array<{ at: number; event: ManagerEvent }> = [];
    const manager = makeManager(dbPath, makeChildEntry(dir, "large"), (event) => {
      eventLog.push({ at: performance.now(), event });
    });
    try {
      const runPromise = manager.requestRefresh({
        runId: "g0b-large-run", provider: "UPSTOX", nowIso: NOW, intentKey: "g0b", generation: 0
      });
      // Parent-side read on its own WAL connection while the child parses.
      const readStart = performance.now();
      const before = (parent.sqlite.query("SELECT count(*) AS n FROM catalog_sync_runs").get() as { n: number }).n;
      const readAt = performance.now();
      const result = await runPromise;
      expect(resultOf(result).status).toBe("COMPLETED");

      const after = (parent.sqlite.query("SELECT count(*) AS n FROM catalog_sync_runs").get() as { n: number }).n;
      expect(before).toBe(0); // read saw the pre-commit snapshot
      expect(after).toBe(1);  // child committed afterwards
      const terminalAt = eventLog.find(
        (entry) => entry.event.type === "message" && entry.event.messageType === "result"
      )?.at;
      expect(terminalAt).toBeDefined();
      // Deterministic ordering (evidence, not a latency threshold): the parent
      // read completed before the child's terminal result was observed.
      expect(readAt).toBeLessThan(terminalAt!);
      // Evidence recorded for the report: readMs and child wall time are
      // intentionally not asserted against any threshold.
      void readStart;
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  }, 30_000);

  test("cancel during AWAIT_TXN_GRANT rejects the grant waiter and settles promptly as cancelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0b-grant-cancel-"));
    const dbPath = join(dir, "test.sqlite");
    const parent = openDatabase({ dbPath });
    runMigrations(parent.db, defaultMigrationsFolder);
    const grantTimeoutMs = 5_000;
    const { entry, markerPath } = makeGrantBlockedChildEntry(dir, grantTimeoutMs);
    const manager = makeManager(dbPath, entry);
    try {
      const runPromise = manager.requestRefresh({
        runId: "g0b-grant-cancel-run", provider: "UPSTOX", nowIso: NOW, intentKey: "g0b", generation: 0
      });
      // Deterministic: the marker is written synchronously when waitForGrant
      // is entered, before the pipeline awaits the grant promise.
      const markerDeadline = performance.now() + 5_000;
      while (!existsSync(markerPath) && performance.now() < markerDeadline) {
        await Bun.sleep(10);
      }
      expect(existsSync(markerPath)).toBe(true);

      const cancelAt = performance.now();
      expect(manager.cancel("g0b-grant-cancel-run", "test cancel")).toBe(true);
      const result = await runPromise;
      const elapsedMs = performance.now() - cancelAt;

      expect(result.ok).toBe(true);
      expect(result.terminal?.type).toBe("cancelled");
      expect(result.exit.code).toBe(0);
      // Prompt cancellation: the grant waiter was rejected on cancel rather
      // than left to expire at grantTimeoutMs (the old 30s default). This is an
      // ordering assertion against the configured timeout, not a latency gate.
      expect(elapsedMs).toBeLessThan(grantTimeoutMs);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  }, 15_000);

  test("executor failure persists a parent FAILED diagnostic for both applyAttempted values", async () => {
    async function runScenario(applyAttempted: boolean): Promise<{
      recorded: unknown[]; events: CatalogRefreshEvent[];
    }> {
      const recorded: unknown[] = [];
      const events: CatalogRefreshEvent[] = [];
      let resolveDone!: () => void;
      const done = new Promise<void>((res) => { resolveDone = res; });
      const catalog = {
        listSyncRuns: async () => [],
        recordSyncRun: async (run: unknown) => { recorded.push(run); }
      } as any;
      const refresh = new CatalogMasterRefresh({
        catalog,
        sync: {} as any, // the executor path never touches the in-process sync
        now: () => new Date(NOW),
        onEvent: (event) => {
          events.push(event);
          if (events.filter((e) => e.outcome === "FAILED").length === 2) resolveDone();
        },
        executor: async () => ({
          status: "FAILED",
          counts: {},
          error: "executor apply failure",
          cancelled: false,
          applyAttempted
        })
      });
      refresh.startIfNeeded();
      await done;
      await refresh.stopAndWait();
      return { recorded, events };
    }

    // G0 integration fix #6: the child runs with diagnostic recording disabled,
    // so the parent is the SOLE recorder. applyAttempted=true means the atomic
    // apply rolled back — it is NOT a recorded failure or a commit proof — so
    // the parent still persists exactly one FAILED row per provider.
    const attempted = await runScenario(true);
    expect(attempted.events.filter((e) => e.outcome === "FAILED").length).toBe(2);
    expect(attempted.recorded.length).toBe(2);
    expect(attempted.recorded.every((r) => (r as { status: string }).status === "FAILED")).toBe(true);

    // Control: a pipeline-time failure (apply not attempted) also records one
    // parent diagnostic per provider.
    const notAttempted = await runScenario(false);
    expect(notAttempted.events.filter((e) => e.outcome === "FAILED").length).toBe(2);
    expect(notAttempted.recorded.length).toBe(2);
  });
});
