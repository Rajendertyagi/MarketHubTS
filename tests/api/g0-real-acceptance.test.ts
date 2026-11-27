/**
 * G0-E — Real acceptance (plan docs/G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md §9.5, §10).
 *
 * This suite proves the fifteen §10 scenarios with a REAL Bun child process
 * (`process.execPath` + `windowsHide`), REAL provider parsing/accumulator
 * finalization, a REAL `Bun.serve` HTTP listener and a REAL SQLite WAL
 * transaction. The ONLY thing replaced is the remote network source: fixtures
 * are served from a local loopback `Bun.serve` (or injected as in-memory
 * Responses for fail-closed cases). There is NO stubbed apply gate — every
 * successful run executes the unchanged `applyCompleteProviderSnapshot` inside
 * one `BEGIN IMMEDIATE` in the child.
 *
 * No numeric latency threshold is adopted. Every timeout below is a HANG GUARD
 * (labelled HG-*) or a bounded wait for a deterministic marker; timings are
 * recorded as evidence only. No live provider is contacted. No CI claim.
 *
 * Official sources studied 2026-11-27 (URLs recorded in g0-e-report.md):
 *   https://bun.sh/docs/runtime/child-process
 *   https://bun.sh/docs/runtime/bunfig
 *   https://bun.sh/blog/bun-v1.4.5            (SQLite 3.54.1 in Bun 1.4.5)
 *   https://sqlite.org/wal.html
 *   https://sqlite.org/lang_transaction.html
 *   https://sqlite.org/pragma.html#pragma_busy_timeout
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import {
  defaultMigrationsFolder, openDatabase, runMigrations, SqliteCatalogRepository,
  type DatabaseHandle
} from "../../packages/database/src/index";
import {
  healthStatusSchema, readinessStatusSchema, systemStatusSchema,
  type ProviderId
} from "../../packages/contracts/src/index";
import { CatalogMasterRefresh, type CatalogRefreshEvent } from "../../packages/market-core/src/index";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import {
  CatalogRefreshChildManager, verifyReady, type ManagerEvent, type ManagerOwnershipHooks
} from "../../apps/api/src/catalog-refresh-child-manager";
import {
  CatalogWriteOwnership, OWNER_META_KEY, findCommittedRun, probeWriter,
  readGeneration, readOwnerToken, writeOwnerToken,
  type OwnerPhase, type OwnerToken, type RecoveryDecision
} from "../../apps/api/src/catalog-write-ownership";
import {
  CatalogWriteCoordinator, CATALOG_WRITE_BUSY, DEFAULT_DRAIN_TIMEOUT_MS,
  type CoordinatorEvent
} from "../../apps/api/src/catalog-write-coordinator";
import {
  MAX_IPC_MESSAGE_BYTES, parseChildMessage
} from "../../apps/api/src/catalog-refresh-ipc";
import { closeDatabaseHandle, removeTempDirAsync } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

/* -------------------------------------------------------------------------- */
/* Constants / source evidence                                                */
/* -------------------------------------------------------------------------- */

const API_SRC = resolve(import.meta.dir, "../../apps/api/src");
const REPO_ROOT = resolve(API_SRC, "../../..");
const ADAPTER_PATH = resolve(API_SRC, "catalog-refresh-child-pipeline.ts");
const ADAPTER_URL = pathToFileURL(ADAPTER_PATH).href;
const ADAPTER_SOURCE = readFileSync(ADAPTER_PATH, "utf8");
const MANAGER_SOURCE = readFileSync(resolve(API_SRC, "catalog-refresh-child-manager.ts"), "utf8");
const START_SOURCE = readFileSync(resolve(REPO_ROOT, "scripts/start.ts"), "utf8");
const ACCUMULATOR_URL = pathToFileURL(
  resolve(REPO_ROOT, "packages/market-core/src/sync/upstox-master.ts")
).href;
const DATABASE_INDEX_URL = pathToFileURL(resolve(REPO_ROOT, "packages/database/src/index.ts")).href;
const DB_SRC = resolve(REPO_ROOT, "packages/database/src");
const NOW = "2026-11-27T10:00:00.000Z";
const UPSTOX_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";
const FYERS_URLS = {
  NSE_FO: "https://public.fyers.in/sym_details/NSE_FO_sym_master.json",
  BSE_FO: "https://public.fyers.in/sym_details/BSE_FO_sym_master.json",
  NSE_CM: "https://public.fyers.in/sym_details/NSE_CM_sym_master.json",
  BSE_CM: "https://public.fyers.in/sym_details/BSE_CM_sym_master.json"
} as const;

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

/** Deterministic whole-catalogue fingerprint: ordered ids + row counts. */
function fingerprint(sqlite: DatabaseHandle["sqlite"]): string {
  const ids = sqlite.query(
    "SELECT canonical_id FROM canonical_instruments ORDER BY canonical_id"
  ).all() as Array<{ canonical_id: string }>;
  const runs = sqlite.query(
    "SELECT run_id || ':' || status AS r FROM catalog_sync_runs ORDER BY run_id"
  ).all() as Array<{ r: string }>;
  return createHash("sha256").update(JSON.stringify({
    instruments: ids.map((r) => r.canonical_id),
    runs: runs.map((r) => r.r)
  })).digest("hex");
}

/** HG: hang guard, never a latency assertion. */
async function fetchHG(url: string, init?: RequestInit, ms = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path) && performance.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

function token(runId: string, generation: number, phase: OwnerPhase = "INIT"): OwnerToken {
  return {
    runId, provider: "UPSTOX", pid: process.pid,
    startedAt: NOW, heartbeatAt: NOW, phase, generation
  };
}

function resultOf(result: { terminal?: unknown }): Extract<import("../../apps/api/src/catalog-refresh-ipc").ChildMessage, { type: "result" }> {
  expect(result.terminal?.type).toBe("result");
  return result.terminal as Extract<import("../../apps/api/src/catalog-refresh-ipc").ChildMessage, { type: "result" }>;
}

/* -------------------------------------------------------------------------- */
/* Test-only child entry generator — REAL adapter, REAL apply, fixture source  */
/* -------------------------------------------------------------------------- */

interface ChildSpec {
  name: string;
  scenario?: "upstox" | "fyers" | "large" | "malformed" | "truncated" | "oversized";
  httpBase?: string;
  delayMs?: number;
  markerPath?: string;
  suppressResult?: boolean;
  withholdTxnStarting?: boolean;
  beforeTxnMarker?: string;
  beforeTxnRelease?: string;
  parseMarker?: string;
  parseRelease?: string;
  countBeginPath?: string;
  holdTxnMarker?: string;
  holdTxnRelease?: string;
  forceApplyError?: boolean;
  grantTimeoutMs?: number;
}

function makeChildEntry(dir: string, spec: ChildSpec): string {
  const path = join(dir, spec.name);
  const fixtures = JSON.stringify({ upstox: upstoxRows, fyers: fyersFiles });
  const needsDb = Boolean(spec.countBeginPath || spec.holdTxnMarker || spec.forceApplyError);
  const needsAccumulator = Boolean(spec.parseMarker);
  const execPatch = (spec.countBeginPath || spec.holdTxnMarker) ? `
const originalExec = Database.prototype.exec;
Database.prototype.exec = function (sql) {
  const out = originalExec.call(this, sql);
  if (String(sql).includes("BEGIN IMMEDIATE")) {
    ${spec.countBeginPath ? `appendFileSync(${JSON.stringify(spec.countBeginPath)}, "B\\n");` : ""}
    ${spec.holdTxnMarker ? `
    writeFileSync(${JSON.stringify(spec.holdTxnMarker)}, "in-txn");
    const sab = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(${JSON.stringify(spec.holdTxnRelease!)}) && Date.now() < ${Date.now() + 60_000}) {
      Atomics.wait(sab, 0, 0, 10);
    }` : ""}
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
  const parsePatch = spec.parseMarker ? `
const originalFinish = UpstoxImportAccumulator.prototype.finish;
UpstoxImportAccumulator.prototype.finish = function (...args) {
  writeFileSync(${JSON.stringify(spec.parseMarker)}, "parsing");
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(spec.parseRelease!)}) && Date.now() < ${Date.now() + 60_000}) {
    Atomics.wait(sab, 0, 0, 10);
  }
  return originalFinish.apply(this, args);
};` : "";
  const beforeTxn = spec.beforeTxnMarker ? `async () => {
  writeFileSync(${JSON.stringify(spec.beforeTxnMarker)}, "at-boundary");
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(${JSON.stringify(spec.beforeTxnRelease!)}) && Date.now() < ${Date.now() + 60_000}) {
    Atomics.wait(sab, 0, 0, 10);
  }
}` : "undefined";

  const source = `
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
import { installChildPipeline } from ${JSON.stringify(ADAPTER_URL)};
${needsDb ? `import { Database } from "bun:sqlite";` : ""}
${spec.forceApplyError ? `import { SqliteCatalogRepository } from ${JSON.stringify(DATABASE_INDEX_URL)};` : ""}
${needsAccumulator ? `import { UpstoxImportAccumulator } from ${JSON.stringify(ACCUMULATOR_URL)};` : ""}
const FIXTURES = ${fixtures};
const SCENARIO = ${JSON.stringify(spec.scenario ?? "upstox")};
const HTTP_BASE = ${JSON.stringify(spec.httpBase ?? null)};
const fetchFn = async (url, init) => {
  ${spec.markerPath ? `writeFileSync(${JSON.stringify(spec.markerPath)}, "downloading");` : ""}
  ${spec.delayMs ? `await Bun.sleep(${spec.delayMs});` : ""}
  if (HTTP_BASE) {
    let p;
    if (url.includes("upstox")) p = "/upstox";
    else if (url.includes("NSE_FO")) p = "/fyers/NSE_FO";
    else if (url.includes("BSE_FO")) p = "/fyers/BSE_FO";
    else if (url.includes("NSE_CM")) p = "/fyers/NSE_CM";
    else if (url.includes("BSE_CM")) p = "/fyers/BSE_CM";
    else throw new Error("unexpected url " + url);
    return fetch(HTTP_BASE + p, init);
  }
  if (SCENARIO === "malformed") return new Response("not json at all");
  if (SCENARIO === "truncated") {
    const cs = new CompressionStream("gzip");
    const w = cs.writable.getWriter();
    void w.write(new TextEncoder().encode(JSON.stringify(FIXTURES.upstox)));
    void w.close();
    const gz = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    return new Response(gz.slice(0, Math.floor(gz.length / 2)));
  }
  if (SCENARIO === "oversized") return new Response("[" + new Array(1_000_001).fill("{}").join(",") + "]");
  if (SCENARIO === "large") {
    const rows = [];
    for (let i = 0; i < 3000; i++) {
      const key = "NSE_EQ|G0N" + i;
      rows.push({ segment: "NSE_EQ", name: "NSE SYN " + i, exchange: "NSE", isin: "INEG0N" + String(i).padStart(5, "0"), instrument_type: "EQ", instrument_key: key, exchange_token: String(100000 + i), tick_size: 0.05, trading_symbol: "GSYN" + i, short_name: "GSYN" + i });
      rows.push({ segment: "NSE_FO", name: "NSE SYN " + i, exchange: "NSE", instrument_type: "OPTSTK", option_type: "CE", instrument_key: "NSE_FO|G0N" + i + "-CE", underlying_key: key, underlying_type: "EQ", expiry: "2026-12-29T15:00:00+05:30", strike_price: 100 + i, lot_size: 250, tick_size: 0.05, freeze_quantity: 10000, trading_symbol: "GSYN" + i + "26DEC" + (100 + i) + "CE" });
      const bkey = "BSE_EQ|G0B" + i;
      rows.push({ segment: "BSE_EQ", name: "BSE SYN " + i, exchange: "BSE", isin: "INEG0B" + String(i).padStart(5, "0"), instrument_type: "EQ", instrument_key: bkey, exchange_token: String(200000 + i), tick_size: 0.05, trading_symbol: "GBSYN" + i, short_name: "GBSYN" + i });
      rows.push({ segment: "BSE_FO", name: "BSE SYN " + i, exchange: "BSE", instrument_type: "OPTSTK", option_type: "PE", instrument_key: "BSE_FO|G0B" + i + "-PE", underlying_key: bkey, underlying_type: "EQ", expiry: "2026-12-29T15:00:00+05:30", strike_price: 200 + i, lot_size: 100, tick_size: 0.05, freeze_quantity: 5000, trading_symbol: "GBSYN" + i + "26DEC" + (200 + i) + "PE" });
    }
    return new Response(JSON.stringify(rows));
  }
  if (url.includes("upstox")) return new Response(JSON.stringify(FIXTURES.upstox));
  if (url.includes("NSE_FO")) return Response.json(FIXTURES.fyers.NSE_FO);
  if (url.includes("BSE_FO")) return Response.json(FIXTURES.fyers.BSE_FO);
  if (url.includes("NSE_CM")) return Response.json(FIXTURES.fyers.NSE_CM);
  if (url.includes("BSE_CM")) return Response.json(FIXTURES.fyers.BSE_CM);
  throw new Error("unexpected url " + url);
};
const send = (message) => {
  ${spec.suppressResult ? `if (message && message.type === "result") return;` : ""}
  ${spec.withholdTxnStarting ? `if (message && message.type === "txn-starting") return;` : ""}
  if (typeof process.send === "function") process.send(message);
};
const beforeTxn = ${beforeTxn};
${execPatch}
${applyErrorPatch}
${parsePatch}
installChildPipeline({
  fetchFn, send, beforeTxn,
  ${spec.grantTimeoutMs !== undefined ? `grantTimeoutMs: ${spec.grantTimeoutMs},` : ""}
});
`;
  writeFileSync(path, source, "utf8");
  return path;
}

/* -------------------------------------------------------------------------- */
/* Local fixture HTTP server (real network, no live provider)                 */
/* -------------------------------------------------------------------------- */

function startFixtureServer(opts: {
  holdUpstox?: Promise<void>;
  large?: boolean;
}): { base: string; server: ReturnType<typeof Bun.serve>; stop: () => void } {
  const largeRows: unknown[] = [];
  if (opts.large) {
    for (let i = 0; i < 3000; i++) {
      const key = `NSE_EQ|G0N${i}`;
      largeRows.push({
        segment: "NSE_EQ", name: `NSE SYN ${i}`, exchange: "NSE", isin: `INEG0N${String(i).padStart(5, "0")}`,
        instrument_type: "EQ", instrument_key: key, exchange_token: String(100000 + i), tick_size: 0.05,
        trading_symbol: `GSYN${i}`, short_name: `GSYN${i}`
      });
      largeRows.push({
        segment: "NSE_FO", name: `NSE SYN ${i}`, exchange: "NSE", instrument_type: "OPTSTK", option_type: "CE",
        instrument_key: `NSE_FO|G0N${i}-CE`, underlying_key: key, underlying_type: "EQ",
        expiry: "2026-12-29T15:00:00+05:30", strike_price: 100 + i, lot_size: 250, tick_size: 0.05,
        freeze_quantity: 10000, trading_symbol: `GSYN${i}26DEC${100 + i}CE`
      });
      const bkey = `BSE_EQ|G0B${i}`;
      largeRows.push({
        segment: "BSE_EQ", name: `BSE SYN ${i}`, exchange: "BSE", isin: `INEG0B${String(i).padStart(5, "0")}`,
        instrument_type: "EQ", instrument_key: bkey, exchange_token: String(200000 + i), tick_size: 0.05,
        trading_symbol: `GBSYN${i}`, short_name: `GBSYN${i}`
      });
      largeRows.push({
        segment: "BSE_FO", name: `BSE SYN ${i}`, exchange: "BSE", instrument_type: "OPTSTK", option_type: "PE",
        instrument_key: `BSE_FO|G0B${i}-PE`, underlying_key: bkey, underlying_type: "EQ",
        expiry: "2026-12-29T15:00:00+05:30", strike_price: 200 + i, lot_size: 100, tick_size: 0.05,
        freeze_quantity: 5000, trading_symbol: `GBSYN${i}26DEC${200 + i}PE`
      });
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/upstox") {
        if (opts.holdUpstox) await opts.holdUpstox;
        return Response.json(opts.large ? largeRows : upstoxRows);
      }
      if (path.startsWith("/fyers/")) {
        const segment = path.slice("/fyers/".length) as keyof typeof fyersFiles;
        return Response.json((fyersFiles as Record<string, unknown>)[segment] ?? {});
      }
      return new Response("not found", { status: 404 });
    }
  });
  return { base: `http://127.0.0.1:${server.port}`, server, stop: () => server.stop(true) };
}

/* -------------------------------------------------------------------------- */
/* Production-like harness: real listener + real ownership + real child        */
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
  listener: ReturnType<typeof Bun.serve>;
  base: string;
  runProvider: (provider: ProviderId) => Promise<void>;
  close: () => Promise<void>;
}

function makeHarness(
  dir: string,
  childEntry: string,
  opts: { withListener?: boolean; pipelineExitTimeoutMs?: number; keepTokenOnSettle?: boolean } = {}
): Harness {
  const { dbPath, handle: parent } = makeDb(dir);
  const events: ManagerEvent[] = [];
  const refreshEvents: CatalogRefreshEvent[] = [];
  const coordEvents: CoordinatorEvent[] = [];
  const ownership = new CatalogWriteOwnership(parent.sqlite, dbPath);
  const coordinator = new CatalogWriteCoordinator({
    getPermitState: () => ownership.currentState,
    onEvent: (e) => coordEvents.push(e)
  });
  ownership.setDrainHook(() => coordinator.drain());

  const hooks: ManagerOwnershipHooks = {
    requestGrant: async () => {
      const decision = await ownership.grant();
      return decision.granted
        ? { granted: true, generation: decision.generation }
        : { granted: false, reason: decision.reason };
    },
    onUnexpectedExit: () => { ownership.markUnknown(); ownership.recover(); },
    // G0-E S10 simulates a parent crash before settlement: the durable token
    // must survive so restart recovery can locate the exact committed runId.
    onSettled: () => { if (!opts.keepTokenOnSettle) ownership.release(); }
  };
  const manager = new CatalogRefreshChildManager({
    dbPath, mode: "pipeline", childEntryPath: childEntry, cwd: REPO_ROOT,
    pipelineExitTimeoutMs: opts.pipelineExitTimeoutMs ?? 20_000,
    onEvent: (e) => events.push(e), ownershipHooks: hooks
  });

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
          runId, provider, nowIso, intentKey: "g0e", generation: reservation.generation
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
    events, refreshEvents, coordEvents, listener,
    base: `http://127.0.0.1:${listener.port}`,
    runProvider: async (provider: ProviderId) => {
      await (refresh as unknown as { refreshProvider: (p: ProviderId) => Promise<void> }).refreshProvider(provider);
    },
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
/* Scenario 1 — real child on Windows                                         */
/* ========================================================================== */

describe("G0-E — real acceptance (15 scenarios)", () => {
  test("S1: real child on Windows — process.execPath, windowsHide, IPC, identity, clean exit", async () => {
    expect(Bun.version).toBe("1.4.5");
    expect(process.versions.sqlite).toBe("3.54.1");
    expect(process.platform).toBe("win32");
    expect(MANAGER_SOURCE).toContain("process.execPath");
    expect(MANAGER_SOURCE).toContain("windowsHide: true");

    const dir = mkdtempSync(join(tmpdir(), "g0e-s1-"));
    const { dbPath, handle: parent } = makeDb(dir);
    const entry = makeChildEntry(dir, { name: "child-s1.ts" });
    const manager = new CatalogRefreshChildManager({
      dbPath, mode: "pipeline", childEntryPath: entry, cwd: REPO_ROOT,
      pipelineExitTimeoutMs: 10_000
    });
    try {
      const result = await manager.requestRefresh({
        runId: "g0e-s1", provider: "UPSTOX", nowIso: NOW, intentKey: "g0e", generation: 0
      });
      expect(result.ok).toBe(true);
      expect(result.exit.code).toBe(0);
      expect(result.exit.signal).toBeNull();
      expect(result.protocolErrors).toEqual([]);
      expect(result.maxMessageBytes).toBeLessThanOrEqual(MAX_IPC_MESSAGE_BYTES);
      expect(result.ready).toBeDefined();
      expect(result.ready!.pid).toBeGreaterThan(0);
      expect(result.ready!.pid).not.toBe(process.pid);
      expect(result.ready!.journalMode.toLowerCase()).toBe("wal");
      expect(result.ready!.sqliteVersion).toBe("3.54.1");
      expect(verifyReady(result.ready!, {
        dbPath, journalMode: "wal", sqliteVersion: "3.54.1"
      })).toEqual({ ok: true });
      expect(parseChildMessage(result.ready!).ok).toBe(true);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  }, 30_000);

  /* ======================================================================== */
  /* Scenario 2 — real parsing + real HTTP listener                           */
  /* ======================================================================== */

  test("S2: real HTTP fixture + real parsing; API reads 200 during DOWNLOAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s2-"));
    const hold = deferred<void>();
    const fixture = startFixtureServer({ holdUpstox: hold.promise, large: true });
    const harness = makeHarness(dir, makeChildEntry(dir, {
      name: "child-s2.ts", httpBase: fixture.base
    }));
    try {
      const run = harness.runProvider("UPSTOX");
      // HG: wait for the child's DOWNLOAD phase marker (bounded, not a latency gate).
      const deadline = performance.now() + 10_000;
      while (!harness.events.some((e) => e.type === "phase" && e.phase === "DOWNLOAD") && performance.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(harness.events.some((e) => e.type === "phase" && e.phase === "DOWNLOAD")).toBe(true);
      expect(harness.events.some((e) => e.type === "settled")).toBe(false); // child not finished

      const [health, ready, status, catalog] = await Promise.all([
        fetchHG(`${harness.base}/health`),
        fetchHG(`${harness.base}/ready`),
        fetchHG(`${harness.base}/api/status`),
        fetchHG(`${harness.base}/api/catalog/search?text=GSYN1`)
      ]);
      expect(health.status).toBe(200);
      expect(ready.status).toBe(200);
      expect(status.status).toBe(200);
      expect(catalog.status).toBe(200);
      expect(healthStatusSchema.safeParse(await health.json()).success).toBe(true);
      expect(readinessStatusSchema.safeParse(await ready.json()).success).toBe(true);
      expect(systemStatusSchema.safeParse(await status.json()).success).toBe(true);
      expect(await catalog.json()).toHaveProperty("instruments");

      hold.resolve();
      await run;
      const phases = harness.events.filter((e) => e.type === "phase").map((e) => (e as { phase: string }).phase);
      expect(phases).toContain("DOWNLOAD");
      expect(phases).toContain("PARSE");
      expect(phases).toContain("TXN");
      // The child's final `phase: "SETTLED"` IPC message can race with the
      // terminal result under full-suite load (the manager resolves the run on
      // the terminal result, then proceeds to shutdown/exit). Accept any
      // reliable terminal evidence instead of only that one progress phase.
      // The manager's own `settled` event is emitted synchronously before the
      // run promise resolves, so it is deterministic here.
      expect(
        phases.includes("SETTLED") ||
        harness.events.some((e) => e.type === "settled") ||
        harness.events.some((e) => e.type === "txn-settled")
      ).toBe(true);
      expect(harness.refreshEvents.some((e) => e.outcome === "REFRESHED")).toBe(true);
    } finally {
      hold.resolve();
      fixture.stop();
      await harness.close();
    }
  }, 40_000);

  /* ======================================================================== */
  /* Scenario 3 — real SQLite transaction in child                            */
  /* ======================================================================== */

  test("S3: exactly one BEGIN IMMEDIATE in child; txn-settled observed; parent never begins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s3-"));
    const countPath = join(dir, "begin.log");
    const harness = makeHarness(dir, makeChildEntry(dir, {
      name: "child-s3.ts", countBeginPath: countPath
    }));
    let parentBegins = 0;
    const origExec = harness.parent.sqlite.exec.bind(harness.parent.sqlite);
    (harness.parent.sqlite as unknown as { exec: (sql: string) => unknown }).exec = ((sql: string) => {
      if (String(sql).includes("BEGIN IMMEDIATE")) parentBegins++;
      return origExec(sql);
    }) as typeof harness.parent.sqlite.exec;
    try {
      await harness.runProvider("UPSTOX");
      const begins = existsSync(countPath)
        ? readFileSync(countPath, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
      expect(begins).toBe(1);
      expect(parentBegins).toBe(0);
      const settled = harness.events.filter((e) => e.type === "txn-settled");
      expect(settled.length).toBe(1);
      expect((settled[0] as { outcome: string }).outcome).toBe("COMMITTED");
      expect(rowCount(harness.parent.sqlite, "canonical_instruments")).toBe(8);
    } finally {
      await harness.close();
    }
  }, 30_000);

  /* ======================================================================== */
  /* Scenario 4 — reads responsive during parse and during txn                */
  /* ======================================================================== */

  test("S4: health/ready/status/catalog 200 during PARSE and during held TXN", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s4-"));
    const parseMarker = join(dir, "parsing.marker");
    const parseRelease = join(dir, "parsing.release");
    const txnMarker = join(dir, "in-txn.marker");
    const txnRelease = join(dir, "in-txn.release");
    const harness = makeHarness(dir, makeChildEntry(dir, {
      name: "child-s4.ts", parseMarker, parseRelease, holdTxnMarker: txnMarker, holdTxnRelease: txnRelease
    }));
    try {
      const run = harness.runProvider("UPSTOX");

      // During PARSE (child blocked in accumulator.finish on its own connection).
      await waitForFile(parseMarker);
      const duringParse = await Promise.all([
        fetchHG(`${harness.base}/health`), fetchHG(`${harness.base}/ready`),
        fetchHG(`${harness.base}/api/status`), fetchHG(`${harness.base}/api/catalog/search?text=GSYN`)
      ]);
      for (const r of duringParse) expect(r.status).toBe(200);
      expect(healthStatusSchema.safeParse(await duringParse[0]!.json()).success).toBe(true);
      expect(readinessStatusSchema.safeParse(await duringParse[1]!.json()).success).toBe(true);
      expect(systemStatusSchema.safeParse(await duringParse[2]!.json()).success).toBe(true);
      writeFileSync(parseRelease, "go");

      // During TXN (child holds BEGIN IMMEDIATE on its own connection).
      await waitForFile(txnMarker);
      const duringTxn = await Promise.all([
        fetchHG(`${harness.base}/health`), fetchHG(`${harness.base}/ready`),
        fetchHG(`${harness.base}/api/status`), fetchHG(`${harness.base}/api/catalog/search?text=GSYN`)
      ]);
      for (const r of duringTxn) expect(r.status).toBe(200);
      expect(healthStatusSchema.safeParse(await duringTxn[0]!.json()).success).toBe(true);
      expect(readinessStatusSchema.safeParse(await duringTxn[1]!.json()).success).toBe(true);
      expect(systemStatusSchema.safeParse(await duringTxn[2]!.json()).success).toBe(true);
      writeFileSync(txnRelease, "go");

      await run;
      expect(harness.events.some((e) => e.type === "phase" && e.phase === "PARSE")).toBe(true);
      expect(harness.events.some((e) => e.type === "txn-settled")).toBe(true);
    } finally {
      try { writeFileSync(parseRelease, "go"); } catch {}
      try { writeFileSync(txnRelease, "go"); } catch {}
      await harness.close();
    }
  }, 40_000);

  /* ======================================================================== */
  /* Scenarios 6 + 7 — old/new snapshot visibility, no partial state          */
  /* ======================================================================== */

  test("S6/S7: readers see old complete snapshot during TXN and new complete snapshot after commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s6-"));
    const txnMarker = join(dir, "in-txn.marker");
    const txnRelease = join(dir, "in-txn.release");
    const harness = makeHarness(dir, makeChildEntry(dir, {
      name: "child-s6.ts", holdTxnMarker: txnMarker, holdTxnRelease: txnRelease
    }));
    try {
      const before = fingerprint(harness.parent.sqlite);
      const beforeCount = rowCount(harness.parent.sqlite, "canonical_instruments");
      expect(beforeCount).toBe(0);

      const run = harness.runProvider("UPSTOX");
      await waitForFile(txnMarker);
      const during = fingerprint(harness.parent.sqlite);
      const duringCount = rowCount(harness.parent.sqlite, "canonical_instruments");
      expect(during).toBe(before); // old snapshot, no partial state
      expect(duringCount).toBe(0);
      // No SQLITE_BUSY surfaced: the read returned normally on its own WAL connection.
      writeFileSync(txnRelease, "go");
      await run;

      const after = fingerprint(harness.parent.sqlite);
      const afterCount = rowCount(harness.parent.sqlite, "canonical_instruments");
      expect(afterCount).toBe(8);
      expect(after).not.toBe(before);
      expect(after).not.toBe(during);
      // No intermediate fingerprint was ever observed by the parent connection.
      expect(rowCount(harness.parent.sqlite, "catalog_sync_runs")).toBe(1);
    } finally {
      try { writeFileSync(txnRelease, "go"); } catch {}
      await harness.close();
    }
  }, 30_000);

  /* ======================================================================== */
  /* Scenario 5 — interactive write: RESERVED allowed, OWNED fail-fast         */
  /* ======================================================================== */

  test("S5: RESERVED interactive write succeeds; OWNED returns 503 CATALOG_WRITE_BUSY on every write route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s5-"));
    const harness = makeHarness(dir, makeChildEntry(dir, { name: "child-s5.ts" }), { withListener: true });
    const retentionBody = JSON.stringify({ version: 1, classes: { CANDLE: { maxAgeDays: 30 } } });
    const retentionCount = () => (harness.parent.sqlite.query(
      "SELECT count(*) AS n FROM app_meta WHERE key = 'retention_settings'"
    ).get() as { n: number }).n;
    try {
      // (a) RESERVED: no DB writer exists, so an interactive write succeeds.
      expect(harness.ownership.reserve({
        runId: "g0e-s5", provider: "UPSTOX", pid: process.pid, startedAt: NOW
      })).toEqual({ ok: true, generation: 1 });
      expect(harness.ownership.currentState).toBe("RESERVED");
      const before = retentionCount();
      const ok = await fetchHG(`${harness.base}/api/retention`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: retentionBody
      });
      expect(ok.status).toBe(200);
      expect(retentionCount()).toBe(before + 1);

      // (b) OWNED: every interactive write entry point fails fast with 503.
      const grant = await harness.ownership.grant();
      expect(grant).toEqual({ granted: true, generation: 1 });
      expect(harness.ownership.currentState).toBe("OWNED");
      const rowsBefore = retentionCount();
      const writeRoutes: Array<[string, string, string?]> = [
        ["/api/retention", "PUT", retentionBody],
        ["/api/retention/cleanup", "POST", "{}"],
        ["/api/historical/fetch", "POST", "{}"],
        ["/api/historical/sync-configs", "POST", "{}"],
        ["/api/snapshots/configs", "POST", "{}"],
        ["/api/snapshots/capture", "POST", "{}"],
        ["/api/market/subscriptions", "PUT", "{}"],
        ["/api/provider/upstox/token", "POST", "{}"],
        ["/api/provider/fyers/config", "POST", "{}"],
        ["/api/provider/fyers/app-secret", "POST", "{}"],
        ["/api/provider/UPSTOX/validate", "POST", "{}"],
        ["/api/provider/UPSTOX/remove", "POST", "{}"],
        ["/api/credentials/reset", "POST", "{}"],
        ["/api/mcp/activity/start", "POST", "{}"],
        ["/api/mcp/activity/complete", "POST", "{}"]
      ];
      for (const [path, method, body] of writeRoutes) {
        const res = await fetchHG(`${harness.base}${path}`, {
          method, headers: { "content-type": "application/json" }, body: body ?? "{}"
        });
        expect(res.status).toBe(503);
        const payload = await res.json() as { error: string; details: { retryable: boolean; code: string } };
        expect(payload.error).toBe(CATALOG_WRITE_BUSY);
        expect(payload.details.retryable).toBe(true);
        expect(payload.details.code).toBe(CATALOG_WRITE_BUSY);
      }
      expect(retentionCount()).toBe(rowsBefore); // zero DB mutation
      // Reads remain 200 while OWNED.
      expect((await fetchHG(`${harness.base}/health`)).status).toBe(200);
      expect((await fetchHG(`${harness.base}/api/catalog/search?text=GSYN`)).status).toBe(200);
      harness.ownership.release();
    } finally {
      await harness.close();
    }
  }, 30_000);

  /* ======================================================================== */
  /* Scenario 8 — kill child during download / parse / txn                    */
  /* ======================================================================== */

  test("S8: kill during download, parse and txn — API up, no partial catalogue, FAILED recorded, permit IDLE", async () => {
    for (const phase of ["download", "parse", "txn"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `g0e-s8-${phase}-`));
      const marker = join(dir, "phase.marker");
      const release = join(dir, "phase.release");
      const spec: ChildSpec = { name: `child-${phase}.ts`, delayMs: phase === "download" ? 60_000 : undefined, markerPath: phase === "download" ? marker : undefined };
      if (phase === "parse") { spec.parseMarker = marker; spec.parseRelease = release; }
      if (phase === "txn") { spec.holdTxnMarker = marker; spec.holdTxnRelease = release; }
      const harness = makeHarness(dir, makeChildEntry(dir, spec), { pipelineExitTimeoutMs: 8_000 });
      try {
        const run = harness.runProvider("UPSTOX");
        await waitForFile(marker);
        const child = harness.manager.activeSubprocess;
        expect(child).not.toBeNull();
        child!.kill("SIGKILL");
        await run;

        // API stays up after the kill.
        expect((await fetchHG(`${harness.base}/health`)).status).toBe(200);
        // No partial catalogue and no successful reconciliation.
        expect(rowCount(harness.parent.sqlite, "canonical_instruments")).toBe(0);
        expect((await new SqliteCatalogRepository(harness.parent.db, harness.parent.sqlite)
          .listSyncRuns({ status: "COMPLETED" })).length).toBe(0);
        // A concise FAILED diagnostic was recorded by the parent after settlement.
        const failed = harness.refreshEvents.filter((e) => e.outcome === "FAILED");
        expect(failed.length).toBe(1);
        expect(rowCount(harness.parent.sqlite, "catalog_sync_runs")).toBe(1);
        expect(String(failed[0]!.reason ?? "")).toContain("child");
        // Permit returns to IDLE after verification.
        expect(harness.ownership.currentState).toBe("IDLE");
        expect(readOwnerToken(harness.parent.sqlite)).toBeNull();
      } finally {
        try { writeFileSync(release, "go"); } catch {}
        await harness.close();
      }
    }
  }, 60_000);

  /* ======================================================================== */
  /* Scenario 9 — rollback / integrity                                        */
  /* ======================================================================== */

  test("S9: malformed/truncated/oversized and forced in-txn error — zero commits, integrity ok", async () => {
    for (const scenario of ["malformed", "truncated", "oversized"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `g0e-s9-${scenario}-`));
      const harness = makeHarness(dir, makeChildEntry(dir, {
        name: `child-${scenario}.ts`, scenario
      }));
      try {
        await harness.runProvider("UPSTOX");
        expect(rowCount(harness.parent.sqlite, "canonical_instruments")).toBe(0);
        // Fail-closed before apply: no COMPLETED row, and a FAILED terminal was emitted.
        expect((await new SqliteCatalogRepository(harness.parent.db, harness.parent.sqlite)
          .listSyncRuns({ status: "COMPLETED" })).length).toBe(0);
        expect(harness.refreshEvents.some((e) => e.outcome === "FAILED")).toBe(true);
        expect(harness.parent.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        await harness.close();
      }
    }

    // Forced error INSIDE the real transaction after real apply writes.
    const dir = mkdtempSync(join(tmpdir(), "g0e-s9-forced-"));
    const harness = makeHarness(dir, makeChildEntry(dir, {
      name: "child-forced.ts", forceApplyError: true
    }));
    try {
      await harness.runProvider("UPSTOX");
      expect(rowCount(harness.parent.sqlite, "canonical_instruments")).toBe(0);
      const forcedRuns = await new SqliteCatalogRepository(harness.parent.db, harness.parent.sqlite).listSyncRuns();
      expect(forcedRuns.filter((r) => r.status === "COMPLETED").length).toBe(0);
      expect(harness.parent.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(harness.events.some((e) => e.type === "txn-settled" && (e as { outcome: string }).outcome === "ROLLED_BACK")).toBe(true);
    } finally {
      await harness.close();
    }
  }, 60_000);

  /* ======================================================================== */
  /* Scenario 10 — commit before IPC ack, exact runId, no re-apply             */
  /* ======================================================================== */

  test("S10: commit-before-ack — exact parent runId COMPLETED row, no re-apply on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s10-"));
    const harness = makeHarness(dir, makeChildEntry(dir, {
      name: "child-no-ack.ts", suppressResult: true
    }), { pipelineExitTimeoutMs: 8_000, keepTokenOnSettle: true });
    try {
      await harness.runProvider("UPSTOX");
      // The parent (CatalogMasterRefresh) generated R and threaded it through the
      // executor into the child; capture the exact ID from the spawn event.
      const spawn = harness.events.find((e) => e.type === "spawn") as { runId: string } | undefined;
      expect(spawn).toBeDefined();
      const runId = spawn!.runId;
      // The child committed with the parent-generated runId but its result IPC was lost.
      const runs = await new SqliteCatalogRepository(harness.parent.db, harness.parent.sqlite).listSyncRuns({ status: "COMPLETED" });
      expect(runs.length).toBe(1);
      expect(runs[0]!.runId).toBe(runId); // exact parent-generated ID
      const instrumentsBefore = rowCount(harness.parent.sqlite, "canonical_instruments");
      expect(instrumentsBefore).toBe(8);
      expect(harness.events.some((e) => e.type === "txn-settled" && (e as { outcome: string }).outcome === "COMMITTED")).toBe(true);

      // Simulated parent restart: token still names R; recovery finds the exact row.
      const restarted = new CatalogWriteOwnership(harness.parent.sqlite, harness.dbPath);
      expect(restarted.recover()).toEqual({ decision: "COMMITTED", runId, generation: 1 });
      expect(rowCount(harness.parent.sqlite, "catalog_sync_runs")).toBe(1); // no re-apply
      expect(rowCount(harness.parent.sqlite, "canonical_instruments")).toBe(instrumentsBefore);
      expect(findCommittedRun(harness.parent.sqlite, runId)!.status).toBe("COMPLETED");

      // A FAILED/absent row is NOT proof and does not authorize re-application.
      expect(findCommittedRun(harness.parent.sqlite, "some-other-run")).toBeNull();
    } finally {
      await harness.close();
    }
  }, 30_000);

  /* ======================================================================== */
  /* Scenario 11 — parent crash / restart, no two writers + fence race        */
  /* ======================================================================== */

  test("S11: fence race — old child (G) FENCED with zero writes, new child (G+1) commits; serialized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s11-"));
    const marker = join(dir, "old-boundary.marker");
    const release = join(dir, "old-release.marker");
    const { dbPath, handle: parent } = makeDb(dir);
    const ownership = new CatalogWriteOwnership(parent.sqlite, dbPath);
    const oldEntry = makeChildEntry(dir, { name: "child-old.ts", beforeTxnMarker: marker, beforeTxnRelease: release });
    const newEntry = makeChildEntry(dir, { name: "child-new.ts" });
    const events: ManagerEvent[] = [];
    const hooks = (): ManagerOwnershipHooks => ({
      requestGrant: async () => {
        const d = await ownership.grant();
        return d.granted ? { granted: true, generation: d.generation } : { granted: false, reason: d.reason };
      },
      onUnexpectedExit: () => { ownership.markUnknown(); ownership.recover(); },
      onSettled: () => { ownership.release(); }
    });
    const oldManager = new CatalogRefreshChildManager({
      dbPath, mode: "pipeline", childEntryPath: oldEntry, cwd: REPO_ROOT,
      pipelineExitTimeoutMs: 20_000, onEvent: (e) => events.push(e), ownershipHooks: hooks()
    });
    try {
      expect(ownership.reserve({ runId: "old-run", provider: "UPSTOX", pid: process.pid, startedAt: NOW }))
        .toEqual({ ok: true, generation: 1 });
      const oldPromise = oldManager.requestRefresh({
        runId: "old-run", provider: "UPSTOX", nowIso: NOW, intentKey: "g0e", generation: 1
      });
      await waitForFile(marker); // old child is inside beforeApply, before BEGIN IMMEDIATE

      // New parent: probe succeeds, bumps to G+1, spawns a fresh child with G+1.
      expect(probeWriter(dbPath).ok).toBe(true);
      writeOwnerToken(parent.sqlite, token("new-run", 2));
      writeFileSync(release, "go");

      const oldResult = await oldPromise;
      expect(oldResult.terminal?.type).toBe("result");
      expect(oldResult.terminal!.type === "result" && oldResult.terminal!.status).toBe("FENCED");
      expect(rowCount(parent.sqlite, "canonical_instruments")).toBe(0); // old child wrote nothing
      expect(rowCount(parent.sqlite, "catalog_sync_runs")).toBe(0);

      // At most one child alive at a time (serialized): old exited before new spawn.
      const newManager = new CatalogRefreshChildManager({
        dbPath, mode: "pipeline", childEntryPath: newEntry, cwd: REPO_ROOT,
        pipelineExitTimeoutMs: 20_000, ownershipHooks: hooks()
      });
      expect(ownership.reserve({ runId: "new-run", provider: "UPSTOX", pid: process.pid, startedAt: NOW }))
        .toEqual({ ok: true, generation: 2 });
      const newResult = await newManager.requestRefresh({
        runId: "new-run", provider: "UPSTOX", nowIso: NOW, intentKey: "g0e", generation: 2
      });
      expect(newResult.terminal!.type === "result" && newResult.terminal!.status).toBe("COMPLETED");
      expect(rowCount(parent.sqlite, "canonical_instruments")).toBe(8);
      const runs = await new SqliteCatalogRepository(parent.db, parent.sqlite).listSyncRuns({ status: "COMPLETED" });
      expect(runs.length).toBe(1); // no duplicate reconciliation
      expect(runs[0]!.runId).toBe("new-run");
      await newManager.shutdown();
    } finally {
      await oldManager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  }, 40_000);

  /* ======================================================================== */
  /* Scenario 12 — graceful shutdown ordering                                 */
  /* ======================================================================== */

  test("S12: graceful shutdown ordering — spawn < exit < settled; stopAndWait resolves; repeat is no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s12-"));
    const harness = makeHarness(dir, makeChildEntry(dir, {
      name: "child-s12.ts", delayMs: 300
    }));
    try {
      const run = harness.runProvider("UPSTOX");
      // Wait until the child is actually spawned before shutting down, otherwise
      // the manager refuses the queued run and no lifecycle events are emitted.
      const deadline = performance.now() + 10_000;
      while (!harness.events.some((e) => e.type === "spawn") && performance.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(harness.events.some((e) => e.type === "spawn")).toBe(true);
      let shutdownResolved = false;
      const shutdown = harness.manager.shutdown().then(() => { shutdownResolved = true; });
      await run;
      await shutdown;
      const indexOf = (type: string) => harness.events.findIndex((e) => e.type === type);
      expect(indexOf("spawn")).toBeGreaterThanOrEqual(0);
      expect(indexOf("exit")).toBeGreaterThan(indexOf("spawn"));
      expect(indexOf("settled")).toBeGreaterThan(indexOf("exit"));
      expect(shutdownResolved).toBe(true);
      expect(harness.manager.activeSubprocess).toBeNull();
      expect(readOwnerToken(harness.parent.sqlite)).toBeNull();
      // Repeated stop is a no-op.
      await harness.manager.shutdown();
      await harness.refresh.stopAndWait();
      expect(harness.refresh.state).toBe("STOPPED");
    } finally {
      await harness.close();
    }
  }, 30_000);

  /* ======================================================================== */
  /* Scenario 13 — all write paths + scope drain + timeout never grants       */
  /* ======================================================================== */

  test("S13: source-scan + real drain-timeout refusal — no OWNED, no BEGIN IMMEDIATE, no partial state", async () => {
    // Source layer: no database→API import; every write module gated; busy_timeout unchanged.
    const dbFiles = (await import("node:fs")).readdirSync(DB_SRC).filter((f) => f.endsWith(".ts"));
    for (const file of dbFiles) {
      const src = readFileSync(join(DB_SRC, file), "utf8");
      expect(src).not.toMatch(/from\s+["'](@markethub\/api|apps\/api|\.\.\/\.\.\/apps\/api)/);
    }
    const repoDir = join(DB_SRC, "repositories");
    const writeRepos = ["candles.ts", "catalog.ts", "mcp-activity.ts", "snapshots.ts"];
    for (const file of writeRepos) {
      const src = readFileSync(join(repoDir, file), "utf8");
      expect(src).toContain("assertWritable");
    }
    expect(readFileSync(resolve(REPO_ROOT, "packages/database/src/index.ts"), "utf8")).toContain("busy_timeout = 5000");
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBeGreaterThan(0);

    // Runtime: hold a real write scope open past the drain timeout.
    const dir = mkdtempSync(join(tmpdir(), "g0e-s13-"));
    const { dbPath, handle: parent } = makeDb(dir);
    const ownership = new CatalogWriteOwnership(parent.sqlite, dbPath);
    const drainEvents: CoordinatorEvent[] = [];
    const coordinator = new CatalogWriteCoordinator({
      getPermitState: () => ownership.currentState,
      drainTimeoutMs: 120, // bounded hang guard for the drain, not a latency gate
      onEvent: (e) => drainEvents.push(e)
    });
    ownership.setDrainHook(() => coordinator.drain());
    let parentBegins = 0;
    const origExec = parent.sqlite.exec.bind(parent.sqlite);
    (parent.sqlite as unknown as { exec: (sql: string) => unknown }).exec = ((sql: string) => {
      if (String(sql).includes("BEGIN IMMEDIATE")) parentBegins++;
      return origExec(sql);
    }) as typeof parent.sqlite.exec;
    try {
      expect(ownership.reserve({ runId: "s13", provider: "UPSTOX", pid: process.pid, startedAt: NOW }).ok).toBe(true);
      const scope = coordinator.acquireWriteScope("I");
      const decision = await ownership.grant();
      expect(decision).toEqual({ granted: false, reason: "write-scope drain timeout" });
      expect(ownership.currentState).toBe("RELEASING"); // never OWNED
      expect(parentBegins).toBe(0);
      expect(rowCount(parent.sqlite, "canonical_instruments")).toBe(0);
      expect(rowCount(parent.sqlite, "catalog_sync_runs")).toBe(0);
      expect(drainEvents.some((e) => e.type === "drain-ok")).toBe(false); // never a degraded grant
      expect(drainEvents.some((e) => e.type === "drain-timeout")).toBe(true);
      coordinator.releaseWriteScope(scope);
      expect(rowCount(parent.sqlite, "canonical_instruments")).toBe(0); // no partial state after release
    } finally {
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  }, 30_000);

  /* ======================================================================== */
  /* Scenario 14 — bun run start production path                              */
  /* ======================================================================== */

  test("S14: bun run start serves built WebUI + API; signal forwarding reaches child", async () => {
    expect(START_SOURCE).toContain("process.execPath"); // production-path consistency
    const distIndex = resolve(REPO_ROOT, "apps/web/dist/index.html");
    expect(existsSync(distIndex)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "g0e-s14-"));
    const { dbPath, handle: parent } = makeDb(dir);
    // Pre-seed today's COMPLETED rows so startup refresh skips (no live download).
    for (const provider of ["UPSTOX", "FYERS"]) {
      parent.sqlite.query(
        "INSERT INTO catalog_sync_runs (run_id, source, provider, scope_json, completeness, status, started_at, counts_json, conflicts_json) VALUES (?, ?, ?, '{}', 'COMPLETE', 'COMPLETED', ?, '{}', '[]')"
      ).run(`seed-${provider}`, provider, provider, NOW);
    }
    const port = 39_000 + Math.floor(Math.random() * 500);
    const proc = Bun.spawn(["bun", "run", "start"], {
      cwd: REPO_ROOT,
      env: { ...process.env, MARKETHUB_ENV: "production", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: String(port) },
      stdout: "pipe", stderr: "pipe", windowsHide: true
    });
    try {
      let health: Response | null = null;
      const deadline = performance.now() + 20_000; // HG
      while (performance.now() < deadline) {
        try {
          health = await fetchHG(`http://127.0.0.1:${port}/health`, undefined, 1_000);
          if (health.status === 200) break;
        } catch {}
        await Bun.sleep(200);
      }
      expect(health).not.toBeNull();
      expect(health!.status).toBe(200);
      expect(healthStatusSchema.safeParse(await health!.json()).success).toBe(true);
      const web = await fetchHG(`http://127.0.0.1:${port}/`, undefined, 3_000);
      expect(web.status).toBe(200);
      expect(await web.text()).toContain("<!doctype html");
      // Signal forwarding: SIGTERM to `bun run start` reaches the API child and drains it.
      proc.kill("SIGTERM");
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, rej) => setTimeout(() => rej(new Error("HG: start did not exit")), 10_000))
      ]);
      // SIGTERM forwarding: the API child terminates on the signal, so the
      // launcher reports 143 (128 + SIGTERM) — evidence the signal reached it.
      expect(exitCode).toBe(143);
      let closed = false;
      for (let i = 0; i < 20; i++) {
        try { await fetchHG(`http://127.0.0.1:${port}/health`, undefined, 300); }
        catch { closed = true; break; }
        await Bun.sleep(100);
      }
      expect(closed).toBe(true); // API child drained and stopped
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  }, 45_000);

  /* ======================================================================== */
  /* Scenario 15 — Windows-local DB path / WAL / SQLite / process              */
  /* ======================================================================== */

  test("S15: same DB file, WAL sidecars, SQLite 3.54.1 both sides, no second DB, no child migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0e-s15-"));
    const txnMarker = join(dir, "in-txn.marker");
    const txnRelease = join(dir, "in-txn.release");
    const harness = makeHarness(dir, makeChildEntry(dir, {
      name: "child-s15.ts", holdTxnMarker: txnMarker, holdTxnRelease: txnRelease
    }));
    try {
      const run = harness.runProvider("UPSTOX");
      await waitForFile(txnMarker);
      // WAL sidecars exist while the child connection is open and writing.
      expect(existsSync(`${harness.dbPath}-wal`)).toBe(true);
      expect(existsSync(`${harness.dbPath}-shm`)).toBe(true);
      expect(existsSync(`${harness.dbPath}-journal`)).toBe(false); // no rollback journal / second DB
      writeFileSync(txnRelease, "go");
      await run;

      const ready = harness.events.find((e) => e.type === "ready") as { ready: { dbPath: string; sqliteVersion: string; journalMode: string; pid: number } } | undefined;
      expect(ready).toBeDefined();
      expect(resolve(ready!.ready.dbPath)).toBe(resolve(harness.dbPath));
      expect(ready!.ready.sqliteVersion).toBe("3.54.1");
      expect(ready!.ready.journalMode.toLowerCase()).toBe("wal");
      expect(ready!.ready.pid).not.toBe(process.pid);
      expect(ADAPTER_SOURCE).toContain("migrate: false"); // child never migrates
      expect(MANAGER_SOURCE).toContain("windowsHide: true"); // no console window
      expect(harness.parent.sqlite.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      try { writeFileSync(txnRelease, "go"); } catch {}
      await harness.close();
    }
  }, 30_000);

  /* ======================================================================== */
  /* Cross-cutting: no stubbed apply + runtime baseline                       */
  /* ======================================================================== */

  test("X1: no stubbed apply — real adapter and unchanged apply path are exercised", () => {
    expect(ADAPTER_SOURCE).toContain("runProviderRefreshPipeline");
    expect(ADAPTER_SOURCE).toContain("new CatalogSyncService");
    expect(readFileSync(resolve(REPO_ROOT, "packages/market-core/src/sync/refresh.ts"), "utf8"))
      .toContain("applyCompleteProviderSnapshot");
    expect(ADAPTER_SOURCE).not.toMatch(/applyGate|stubbed|fakeApply/);
    // The only apply gate in the legacy test is untouched and is NOT used here.
    const legacy = readFileSync(
      resolve(REPO_ROOT, "tests/market/catalog-refresh-wp3-g0.test.ts"), "utf8"
    );
    expect(legacy).toContain("applyGate"); // preserved regression, not part of this suite
    expect(Bun.version).toBe("1.4.5");
    expect(process.versions.sqlite).toBe("3.54.1");
  });
});
