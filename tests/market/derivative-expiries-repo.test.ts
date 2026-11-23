import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import {
  FYERS_COVERAGE, FYERS_SOURCE, UPSTOX_COVERAGE, UPSTOX_SOURCE, serializeProviderCoverageScope
} from "../../packages/market-core/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const tempDirs: string[] = [];
const handles: Array<{ close: () => void } | null> = [];
const NOW = "2026-01-01T00:00:00.000Z";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "markethub-wp4b-"));
  tempDirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
  handles.push(handle);
  return { handle, repo: new SqliteCatalogRepository(handle.db, handle.sqlite) };
}

afterEach(() => {
  while (handles.length) {
    try { closeDatabaseHandle(handles.pop() ?? undefined); } catch {}
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) { try { removeTempDir(dir); } catch {} }
  }
});

function insertUnderlying(sqlite: Database, id: string, symbol: string): void {
  sqlite.query(`INSERT INTO canonical_instruments
    (canonical_id, identity_key, identity_version, exchange, segment, market_type, instrument_category,
     canonical_symbol, display_name, trading_status, lifecycle_status, created_at, updated_at)
    VALUES (?, ?, 1, 'NSE', 'CASH', 'CASH', 'EQUITY', ?, ?, 'ACTIVE', 'ACTIVE', ?, ?)`)
    .run(id, `key:${id}`, symbol, symbol, NOW, NOW);
}

function insertContract(sqlite: Database, opts: {
  canonicalId: string;
  underlyingCanonicalId: string;
  derivativeClass: "STOCK_OPTION" | "INDEX_OPTION" | "STOCK_FUTURE" | "INDEX_FUTURE";
  expiryDate: string;
  optionType?: "CE" | "PE";
}): void {
  const isOption = opts.derivativeClass === "STOCK_OPTION" || opts.derivativeClass === "INDEX_OPTION";
  // derivative_contracts.canonical_id has an FK to canonical_instruments.
  sqlite.query(`INSERT INTO canonical_instruments
    (canonical_id, identity_key, identity_version, exchange, segment, market_type, instrument_category,
     canonical_symbol, display_name, trading_status, lifecycle_status, created_at, updated_at)
    VALUES (?, ?, 1, 'NSE', 'FO', 'DERIVATIVE', ?, 'OPT', 'OPT', 'ACTIVE', 'ACTIVE', ?, ?)`)
    .run(opts.canonicalId, `key:${opts.canonicalId}`, opts.derivativeClass, NOW, NOW);
  sqlite.query(`INSERT INTO derivative_contracts
    (canonical_id, exchange, segment, derivative_class, underlying_canonical_id, expiry_date,
     strike_normalized, option_type, strike_key, option_type_key, created_at, updated_at)
    VALUES (?, 'NSE', 'FO', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      opts.canonicalId, opts.derivativeClass, opts.underlyingCanonicalId, opts.expiryDate,
      isOption ? "100" : null,
      isOption ? (opts.optionType ?? "CE") : null,
      isOption ? opts.canonicalId : "",
      isOption ? (opts.optionType ?? "CE") : "",
      NOW, NOW
    );
}

function insertMapping(sqlite: Database, opts: {
  provider: "UPSTOX" | "FYERS";
  nativeIdentifier: string;
  canonicalId: string;
  status: "ACTIVE" | "INACTIVE" | "REMOVED" | "UNKNOWN";
}): void {
  sqlite.query(`INSERT INTO provider_instrument_mappings
    (provider, native_identifier, canonical_id, exchange, segment, status, created_at, updated_at)
    VALUES (?, ?, ?, 'NSE', 'NSE_FO', ?, ?, ?)`)
    .run(opts.provider, opts.nativeIdentifier, opts.canonicalId, opts.status, NOW, NOW);
}

function insertRun(sqlite: Database, opts: {
  runId: string;
  provider: "UPSTOX" | "FYERS";
  source: string;
  scopeJson: string;
  completeness: "COMPLETE" | "PARTIAL" | "INCREMENTAL";
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "RUNNING" | "CANCELLED";
  startedAt: string;
  finishedAt?: string | null;
  sourceObservedAt?: string | null;
}): void {
  sqlite.query(`INSERT INTO catalog_sync_runs
    (run_id, source, provider, scope_json, completeness, status, started_at, finished_at,
     source_observed_at, counts_json, conflicts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]')`)
    .run(
      opts.runId, opts.source, opts.provider, opts.scopeJson, opts.completeness, opts.status,
      opts.startedAt, opts.finishedAt ?? null, opts.sourceObservedAt ?? null
    );
}

const UPSTOX_SCOPE = serializeProviderCoverageScope(UPSTOX_COVERAGE);
const FYERS_SCOPE = serializeProviderCoverageScope(FYERS_COVERAGE);

describe("WP4B repository: listDerivativeExpiries", () => {
  test("required filters, provider join, DISTINCT, ascending order and inclusive today boundary", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    insertUnderlying(s, "U1", "RELIANCE");
    insertUnderlying(s, "U2", "OTHER");

    // In-scope: today (inclusive), yesterday (excluded), later dates, duplicates.
    insertContract(s, { canonicalId: "C_TODAY", underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: "2026-11-24" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-C1", canonicalId: "C_TODAY", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_YESTERDAY", underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: "2026-11-23" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-C2", canonicalId: "C_YESTERDAY", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_DUP_A", underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: "2026-11-25" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-C3", canonicalId: "C_DUP_A", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_DUP_B", underlyingCanonicalId: "U1", derivativeClass: "INDEX_OPTION", expiryDate: "2026-11-25" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-C4", canonicalId: "C_DUP_B", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_LATE", underlyingCanonicalId: "U1", derivativeClass: "INDEX_OPTION", expiryDate: "2026-12-29" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-C5", canonicalId: "C_LATE", status: "ACTIVE" });

    // Excluded: future class, inactive mapping, other provider, other underlying.
    insertContract(s, { canonicalId: "C_FUT", underlyingCanonicalId: "U1", derivativeClass: "STOCK_FUTURE", expiryDate: "2027-01-27" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-C6", canonicalId: "C_FUT", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_INACTIVE", underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: "2027-02-24" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-C7", canonicalId: "C_INACTIVE", status: "INACTIVE" });
    insertContract(s, { canonicalId: "C_FYERS", underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: "2027-03-24" });
    insertMapping(s, { provider: "FYERS", nativeIdentifier: "F-C1", canonicalId: "C_FYERS", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_OTHER_UND", underlyingCanonicalId: "U2", derivativeClass: "STOCK_OPTION", expiryDate: "2026-11-26" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-C8", canonicalId: "C_OTHER_UND", status: "ACTIVE" });

    const expiries = await repo.listDerivativeExpiries({
      underlyingCanonicalId: "U1", provider: "UPSTOX", today: "2026-11-24", limit: 100
    });
    expect(expiries).toEqual(["2026-11-24", "2026-11-25", "2026-12-29"]);
  });

  test("provider isolation: a missing expiry is never borrowed from the other provider", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    insertUnderlying(s, "U1", "RELIANCE");
    insertContract(s, { canonicalId: "C_U", underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: "2026-11-25" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-1", canonicalId: "C_U", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_F", underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: "2026-12-29" });
    insertMapping(s, { provider: "FYERS", nativeIdentifier: "F-1", canonicalId: "C_F", status: "ACTIVE" });
    // Same underlying/expiry reported by both providers converges on one contract
    // but keeps two distinct mappings.
    insertContract(s, { canonicalId: "C_BOTH", underlyingCanonicalId: "U1", derivativeClass: "INDEX_OPTION", expiryDate: "2027-01-27" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-2", canonicalId: "C_BOTH", status: "ACTIVE" });
    insertMapping(s, { provider: "FYERS", nativeIdentifier: "F-2", canonicalId: "C_BOTH", status: "ACTIVE" });

    expect(await repo.listDerivativeExpiries({ underlyingCanonicalId: "U1", provider: "UPSTOX", today: "2026-11-24", limit: 100 }))
      .toEqual(["2026-11-25", "2027-01-27"]);
    expect(await repo.listDerivativeExpiries({ underlyingCanonicalId: "U1", provider: "FYERS", today: "2026-11-24", limit: 100 }))
      .toEqual(["2026-12-29", "2027-01-27"]);
  });

  test("only ACTIVE mappings qualify (INACTIVE, REMOVED, UNKNOWN excluded)", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    insertUnderlying(s, "U1", "RELIANCE");
    const statuses = ["ACTIVE", "INACTIVE", "REMOVED", "UNKNOWN"] as const;
    statuses.forEach((status, i) => {
      const id = `C_${status}`;
      insertContract(s, { canonicalId: id, underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: `2026-12-${String(10 + i).padStart(2, "0")}` });
      insertMapping(s, { provider: "UPSTOX", nativeIdentifier: `U-${status}`, canonicalId: id, status });
    });
    expect(await repo.listDerivativeExpiries({ underlyingCanonicalId: "U1", provider: "UPSTOX", today: "2026-11-24", limit: 100 }))
      .toEqual(["2026-12-10"]);
  });

  test("stock/index futures are excluded from the option expiry list", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    insertUnderlying(s, "U1", "RELIANCE");
    insertContract(s, { canonicalId: "C_OPT", underlyingCanonicalId: "U1", derivativeClass: "INDEX_OPTION", expiryDate: "2026-12-29" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-OPT", canonicalId: "C_OPT", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_SF", underlyingCanonicalId: "U1", derivativeClass: "STOCK_FUTURE", expiryDate: "2026-12-29" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-SF", canonicalId: "C_SF", status: "ACTIVE" });
    insertContract(s, { canonicalId: "C_IF", underlyingCanonicalId: "U1", derivativeClass: "INDEX_FUTURE", expiryDate: "2026-12-29" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-IF", canonicalId: "C_IF", status: "ACTIVE" });
    expect(await repo.listDerivativeExpiries({ underlyingCanonicalId: "U1", provider: "UPSTOX", today: "2026-11-24", limit: 100 }))
      .toEqual(["2026-12-29"]);
  });

  test("hard limit is enforced in the database even when a larger limit is requested", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    insertUnderlying(s, "U1", "RELIANCE");
    for (let i = 0; i < 105; i++) {
      const month = Math.floor(i / 28) + 1;
      const day = (i % 28) + 1;
      const id = `C_${i}`;
      const expiry = `2027-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      insertContract(s, { canonicalId: id, underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: expiry });
      insertMapping(s, { provider: "UPSTOX", nativeIdentifier: `U-${i}`, canonicalId: id, status: "ACTIVE" });
    }
    const capped = await repo.listDerivativeExpiries({ underlyingCanonicalId: "U1", provider: "UPSTOX", today: "2026-11-24", limit: 1000 });
    expect(capped.length).toBe(100);
    expect(capped[0]).toBe("2027-01-01");
    expect([...capped].sort()).toEqual(capped); // ascending
    const small = await repo.listDerivativeExpiries({ underlyingCanonicalId: "U1", provider: "UPSTOX", today: "2026-11-24", limit: 3 });
    expect(small).toEqual(["2027-01-01", "2027-01-02", "2027-01-03"]);
  });

  test("SQL inspection: DISTINCT, provider join, filters, ordering and LIMIT are applied in SQLite", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    insertUnderlying(s, "U1", "RELIANCE");
    insertContract(s, { canonicalId: "C1", underlyingCanonicalId: "U1", derivativeClass: "STOCK_OPTION", expiryDate: "2026-12-29" });
    insertMapping(s, { provider: "UPSTOX", nativeIdentifier: "U-1", canonicalId: "C1", status: "ACTIVE" });

    const captured: string[] = [];
    const originalPrepare = s.prepare.bind(s);
    (s as any).prepare = (sql: string, ...args: unknown[]) => {
      captured.push(sql);
      return (originalPrepare as any)(sql, ...args);
    };
    try {
      await repo.listDerivativeExpiries({ underlyingCanonicalId: "U1", provider: "UPSTOX", today: "2026-11-24", limit: 100 });
    } finally {
      (s as any).prepare = originalPrepare;
    }
    const sql = captured.join("\n").toLowerCase();
    expect(sql).toContain("select distinct");
    expect(sql).toContain("provider_instrument_mappings");
    expect(sql).toContain("inner join");
    expect(sql).toContain("derivative_class");
    expect(sql).toContain("status");
    expect(sql).toContain("underlying_canonical_id");
    expect(sql).toContain("expiry_date");
    expect(sql).toContain("order by");
    expect(sql).toContain("limit");
  });
});

describe("WP4B repository: getLatestProviderSync", () => {
  test("filters by provider, stable source and exact scopeJson (shared serializer on both paths)", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    const base = {
      completeness: "COMPLETE" as const, status: "COMPLETED" as const,
      startedAt: "2026-11-24T00:00:00.000Z", finishedAt: "2026-11-24T01:00:00.000Z",
      sourceObservedAt: "2026-11-24T00:00:00.000Z"
    };
    insertRun(s, { ...base, runId: "R_MATCH", provider: "UPSTOX", source: UPSTOX_SOURCE, scopeJson: UPSTOX_SCOPE });
    insertRun(s, { ...base, runId: "R_OTHER_PROVIDER", provider: "FYERS", source: UPSTOX_SOURCE, scopeJson: UPSTOX_SCOPE });
    insertRun(s, { ...base, runId: "R_OTHER_SOURCE", provider: "UPSTOX", source: "FYERS_SYMBOL_MASTER", scopeJson: UPSTOX_SCOPE });
    insertRun(s, { ...base, runId: "R_OTHER_SCOPE", provider: "UPSTOX", source: UPSTOX_SOURCE, scopeJson: FYERS_SCOPE });
    // A scope serialized with a different shape must not match (exact equality, no SQL JSON parsing).
    insertRun(s, { ...base, runId: "R_OLD_SHAPE", provider: "UPSTOX", source: UPSTOX_SOURCE, scopeJson: JSON.stringify({ source: UPSTOX_SOURCE }) });

    const found = await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, serializeProviderCoverageScope(UPSTOX_COVERAGE), ["COMPLETED"], "COMPLETE");
    expect(found?.runId).toBe("R_MATCH");
    expect(found?.sourceObservedAt).toBe("2026-11-24T00:00:00.000Z");
    expect(await repo.getLatestProviderSync("FYERS", FYERS_SOURCE, FYERS_SCOPE, ["COMPLETED"], "COMPLETE")).toBeNull();
  });

  test("status and completeness filtering: only COMPLETED + COMPLETE qualify", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    const common = { provider: "UPSTOX" as const, source: UPSTOX_SOURCE, scopeJson: UPSTOX_SCOPE, startedAt: "2026-11-24T00:00:00.000Z", finishedAt: "2026-11-24T01:00:00.000Z" };
    const later = { finishedAt: "2026-11-25T01:00:00.000Z" };
    insertRun(s, { ...common, runId: "R_OK", completeness: "COMPLETE", status: "COMPLETED" });
    // Later non-successful attempts must not replace the last successful run.
    insertRun(s, { ...common, ...later, runId: "R_PARTIAL_STATUS", completeness: "COMPLETE", status: "PARTIAL" });
    insertRun(s, { ...common, ...later, runId: "R_FAILED", completeness: "COMPLETE", status: "FAILED" });
    insertRun(s, { ...common, ...later, runId: "R_RUNNING", completeness: "COMPLETE", status: "RUNNING" });
    insertRun(s, { ...common, ...later, runId: "R_CANCELLED", completeness: "COMPLETE", status: "CANCELLED" });
    insertRun(s, { ...common, ...later, runId: "R_PARTIAL_COMP", completeness: "PARTIAL", status: "COMPLETED" });
    insertRun(s, { ...common, ...later, runId: "R_INCREMENTAL", completeness: "INCREMENTAL", status: "COMPLETED" });

    expect((await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, ["COMPLETED"], "COMPLETE"))?.runId).toBe("R_OK");
    // Explicitly including other statuses returns the later attempt (proving the
    // filter, not ordering, is what protects lastSuccessfulSyncAt in the route).
    expect((await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, ["COMPLETED", "FAILED", "RUNNING", "PARTIAL", "CANCELLED"], "COMPLETE"))?.runId).toBe("R_RUNNING");
    // Completeness PARTIAL/INCREMENTAL is not accepted as a successful snapshot:
    // the route asks only for COMPLETE, which excludes both of these runs.
    const nonComplete = await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, ["COMPLETED"], ["PARTIAL", "INCREMENTAL"]);
    expect(nonComplete?.completeness).toBe("PARTIAL");
    // Including PARTIAL would let a later partial run win — why the route asks only for COMPLETE.
    expect((await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, ["COMPLETED"], ["COMPLETE", "PARTIAL"]))?.runId).toBe("R_PARTIAL_COMP");
  });

  test("deterministic ordering finishedAt DESC, then startedAt DESC, then runId DESC, LIMIT 1", async () => {
    const { handle, repo } = setup();
    const s = handle.sqlite;
    const common = { provider: "UPSTOX" as const, source: UPSTOX_SOURCE, scopeJson: UPSTOX_SCOPE, completeness: "COMPLETE" as const, status: "COMPLETED" as const };
    // Same finishedAt: later startedAt wins.
    insertRun(s, { ...common, runId: "A", startedAt: "2026-11-24T00:00:00.000Z", finishedAt: "2026-11-24T02:00:00.000Z" });
    insertRun(s, { ...common, runId: "B", startedAt: "2026-11-24T01:00:00.000Z", finishedAt: "2026-11-24T02:00:00.000Z" });
    expect((await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, ["COMPLETED"], "COMPLETE"))?.runId).toBe("B");
    // Same finishedAt and startedAt: lexicographically larger runId wins.
    insertRun(s, { ...common, runId: "C", startedAt: "2026-11-24T01:00:00.000Z", finishedAt: "2026-11-24T02:00:00.000Z" });
    expect((await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, ["COMPLETED"], "COMPLETE"))?.runId).toBe("C");
    // A newer finishedAt wins regardless of runId.
    insertRun(s, { ...common, runId: "D", startedAt: "2026-11-23T00:00:00.000Z", finishedAt: "2026-11-25T02:00:00.000Z" });
    expect((await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, ["COMPLETED"], "COMPLETE"))?.runId).toBe("D");
  });

  test("empty status/completeness selectors return null rather than an unbounded query", async () => {
    const { handle, repo } = setup();
    insertRun(handle.sqlite, {
      runId: "R", provider: "UPSTOX", source: UPSTOX_SOURCE, scopeJson: UPSTOX_SCOPE,
      completeness: "COMPLETE", status: "COMPLETED", startedAt: "2026-11-24T00:00:00.000Z", finishedAt: "2026-11-24T01:00:00.000Z"
    });
    expect(await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, [], "COMPLETE")).toBeNull();
    expect(await repo.getLatestProviderSync("UPSTOX", UPSTOX_SOURCE, UPSTOX_SCOPE, ["COMPLETED"], [])).toBeNull();
  });
});
