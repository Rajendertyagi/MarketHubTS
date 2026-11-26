/**
 * WP2-B focused coverage — bounded FYERS Symbol Master ingestion.
 *
 * Deterministic assertions only (no wall-clock / RSS thresholds):
 *  - the streaming path produces an import identical to the array-based
 *    importer on the baseline fixture (complete supported catalogue);
 *  - the legacy `sha256(JSON.stringify(files))` source-version contract is
 *    reproduced incrementally without a second full JSON string;
 *  - large four-segment sources process completely with a bounded parser
 *    buffer and exact `underFyTok` -> `fyToken` resolution;
 *  - malformed / truncated / oversized / cancelled sources fail closed with no
 *    reconciliation and no false removals;
 *  - duplicate / missing underlying mappings behave exactly as before;
 *  - provider isolation is preserved.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import {
  CatalogMasterRefresh, CatalogSyncService, buildFyersImport
} from "../../packages/market-core/src/index";
import type { CatalogRepository, CatalogSyncRunRecord, MasterFetch } from "../../packages/market-core/src/index";
import { FyersImportAccumulator } from "../../packages/market-core/src/sync/fyers-master";
import { getLastFyersStreamMetrics } from "../../packages/market-core/src/sync/refresh";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const CLOCK = new Date("2026-11-24T10:00:00.000Z");
const NOW = CLOCK.toISOString();
const OPTS = { now: NOW, sourceVersion: "wp2-fixture-v1" };

/**
 * Independent PRE-WP2 golden values, captured from commit `905ac1e` via
 * `git archive` and executed outside the working tree (see
 * `D:\Coding\OpenCode\user\tmp\opencode\wp2-golden\golden-fingerprints.ts`).
 * These are NOT derived from the current accumulator. The hash is a
 * key-order-independent SHA-256 over instruments, mappings, active native
 * identifiers and the import report.
 */
const GOLDEN_FYERS = {
  instruments: 9,
  mappings: 9,
  batchIdentifiers: 0,
  activeNativeIdentifiers: 8,
  invalidRows: 0,
  unresolvedUnderlyings: 0,
  duplicateIdentities: 0,
  mappingConflicts: 0,
  skippedOutOfScope: 2,
  inScopeOptions: 5,
  inScopeUnderlyings: 4,
  hash: "089e56e56ed605b5ff298e8b4aff6e5821d4739fd83abad2e06f4eefa4444af4"
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeCatalog(runs: CatalogSyncRunRecord[] = []): CatalogRepository {
  const stored = [...runs];
  return {
    listSyncRuns: async (q: { provider?: string; status?: string; limit?: number } = {}) =>
      stored
        .filter((r) => (!q.provider || r.provider === q.provider) && (!q.status || r.status === q.status))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, q.limit ?? 100),
    recordSyncRun: async (r: CatalogSyncRunRecord) => { stored.push(r); },
    runs: stored
  } as unknown as CatalogRepository & { runs: CatalogSyncRunRecord[] };
}

function makeSync() {
  const applied: string[] = [];
  const batches: any[] = [];
  const reconciliations: any[] = [];
  const sync = {
    applyCompleteProviderSnapshot: async (batch: any, reconciliation: any) => {
      applied.push(batch.provider ?? "unknown");
      batches.push(batch);
      reconciliations.push(reconciliation);
      return { status: "COMPLETED", counts: {} } as any;
    }
  };
  return { sync: sync as unknown as CatalogSyncService, applied, batches, reconciliations };
}

function runRecord(provider: string, finishedAt: string): CatalogSyncRunRecord {
  return {
    runId: `${provider}-${finishedAt}`, source: "test", provider, scopeJson: "{}", completeness: "COMPLETE",
    status: "COMPLETED", startedAt: finishedAt, finishedAt, countsJson: "{}", conflictsJson: "[]"
  };
}

/** Force the refresh owner past its freshness skip. */
function proceedingCatalog(base: CatalogRepository, provider: string): CatalogRepository {
  const catalog = Object.create(base) as CatalogRepository;
  (catalog as any).listSyncRuns = async (q: { provider?: string; status?: string; limit?: number } = {}) => {
    if (q.provider === provider && q.status === "COMPLETED") return [runRecord(provider, "2026-11-23T05:00:00.000Z")];
    return (base as any).listSyncRuns(q);
  };
  return catalog;
}

/** Serve the four fixture segment files by URL. */
function fixtureFetch(files: Record<string, unknown> = fyersFiles as any): MasterFetch {
  return async (url) => {
    if (url.includes("NSE_FO")) return Response.json(files.NSE_FO);
    if (url.includes("BSE_FO")) return Response.json(files.BSE_FO);
    if (url.includes("NSE_CM")) return Response.json(files.NSE_CM);
    if (url.includes("BSE_CM")) return Response.json(files.BSE_CM);
    throw new Error(`unexpected url: ${url}`);
  };
}

/** Serve each segment as a bounded chunk stream (realistic fetch backpressure). */
function chunkedFixtureFetch(files: Record<string, unknown>, chunkSize = 64 * 1024): MasterFetch {
  return async (url) => {
    const segment = ["NSE_FO", "BSE_FO", "NSE_CM", "BSE_CM"].find((s) => url.includes(s))!;
    const bytes = new TextEncoder().encode(JSON.stringify(files[segment]));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      }
    });
    return new Response(body);
  };
}

/** Compact, order-independent fingerprint of an importer result. */
function fingerprint(result: ReturnType<typeof buildFyersImport>) {
  return {
    instruments: result.batch.instruments.map((i) => JSON.stringify(i)).sort(),
    mappings: result.batch.mappings.map((m) => JSON.stringify(m)).sort(),
    activeNativeIdentifiers: [...result.reconciliation.activeNativeIdentifiers].sort(),
    report: result.report
  };
}

/** Deterministic, key-order-independent canonical serialization (golden hash). */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(",")}}`;
}

/** SHA-256 over the canonical normalized output; compared to the PRE-WP2 golden. */
function normalizedHash(result: ReturnType<typeof buildFyersImport>): string {
  return createHash("sha256").update(stable({
    instruments: result.batch.instruments.map((i) => stable(i)).sort(),
    mappings: result.batch.mappings.map((m) => stable(m)).sort(),
    activeNativeIdentifiers: [...result.reconciliation.activeNativeIdentifiers].sort(),
    report: result.report
  }), "utf8").digest("hex");
}

/**
 * Legacy source-version contract: sha256(JSON.stringify(files)), where `files`
 * is built by `Object.fromEntries` in FYERS_MASTER_URLS order (NSE_FO, BSE_FO,
 * NSE_CM, BSE_CM) — not the fixture object's own insertion order.
 */
function legacyHash(files: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const segment of ["NSE_FO", "BSE_FO", "NSE_CM", "BSE_CM"]) ordered[segment] = files[segment];
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

/** Build a large, valid four-segment FYERS source with unique in-scope rows. */
function largeFyersFiles(pairs: number) {
  const NSE_FO: Record<string, unknown> = {};
  const BSE_FO: Record<string, unknown> = {};
  const NSE_CM: Record<string, unknown> = {};
  const BSE_CM: Record<string, unknown> = {};
  for (let i = 0; i < pairs; i++) {
    const n = String(i).padStart(6, "0");
    const nseUnder = `10100000${n}`;
    const bseUnder = `10200000${n}`;
    NSE_CM[`NSE:SYN${n}-EQ`] = {
      fyToken: nseUnder, exToken: 10000 + i, exSymbol: `NSYN${n}`, exSeries: "EQ",
      symTicker: `NSE:SYN${n}-EQ`, exchangeName: "NSE", optType: "XX", isin: `INEN${n}`,
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: `NSE Syn ${n}`
    };
    NSE_FO[`NSE:SYN${n}26DEC100CE`] = {
      fyToken: `20100000${n}`, exToken: 20000 + i, exSymbol: `NSYN${n}`,
      symTicker: `NSE:SYN${n}26DEC100CE`, exchangeName: "NSE", optType: "CE",
      underSym: `NSYN${n}`, underFyTok: nseUnder, expiryDate: "1798539000",
      strikePrice: 100 + i, minLotSize: 250, tickSize: 0.05, qtyFreeze: "10000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: `29 Dec 26 ${100 + i} CE`
    };
    BSE_CM[`BSE:SYN${n}-EQ`] = {
      fyToken: bseUnder, exToken: 30000 + i, exSymbol: `BSYN${n}`, exSeries: "EQ",
      symTicker: `BSE:SYN${n}-EQ`, exchangeName: "BSE", optType: "XX", isin: `INEB${n}`,
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: `BSE Syn ${n}`
    };
    BSE_FO[`BSE:SYN${n}26DEC200PE`] = {
      fyToken: `20200000${n}`, exToken: 40000 + i, exSymbol: `BSYN${n}`,
      symTicker: `BSE:SYN${n}26DEC200PE`, exchangeName: "BSE", optType: "PE",
      underSym: `BSYN${n}`, underFyTok: bseUnder, expiryDate: "1798539000",
      strikePrice: 200 + i, minLotSize: 100, tickSize: 0.05, qtyFreeze: "5000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: `29 Dec 26 ${200 + i} PE`
    };
  }
  return { NSE_FO, BSE_FO, NSE_CM, BSE_CM };
}

describe("WP2-B FYERS bounded ingestion", () => {
  test("streaming path produces an import identical to the array-based importer (baseline fixture)", async () => {
    const { sync, applied, batches, reconciliations } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fixtureFetch()
    });
    await (refresh as any).refreshProvider("FYERS");

    expect(applied).toEqual(["FYERS"]);
    const expected = buildFyersImport(fyersFiles, OPTS);
    expect(fingerprint({ batch: batches[0], reconciliation: reconciliations[0], report: expected.report } as any).instruments)
      .toEqual(fingerprint(expected).instruments);
    expect(batches[0].mappings.map((m: any) => JSON.stringify(m)).sort())
      .toEqual(expected.batch.mappings.map((m) => JSON.stringify(m)).sort());
    expect([...reconciliations[0].activeNativeIdentifiers].sort())
      .toEqual([...expected.reconciliation.activeNativeIdentifiers].sort());
    // Exact report equivalence (counts, unresolved, duplicates, conflicts).
    expect(batches[0].metadata.counts).toEqual(expected.batch.metadata.counts);
  });

  test("incremental hash reproduces the legacy sha256(JSON.stringify(files)) contract", async () => {
    const { sync, batches } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fixtureFetch()
    });
    await (refresh as any).refreshProvider("FYERS");
    expect(batches[0].sourceVersion).toBe(legacyHash(fyersFiles));
    expect(batches[0].sourceVersion).toMatch(/^[0-9a-f]{64}$/);
  });

  test("large four-segment source: complete coverage, bounded parser buffer, exact underlying resolution", async () => {
    const pairs = 1500;
    const files = largeFyersFiles(pairs);
    // The streaming path hashes/streams each segment body separately; the
    // outer JSON object's keys/braces/commas are not part of any body.
    const totalBytes = ["NSE_FO", "BSE_FO", "NSE_CM", "BSE_CM"]
      .reduce((sum, seg) => sum + Buffer.byteLength(JSON.stringify((files as any)[seg]), "utf8"), 0);
    const { sync, applied, batches, reconciliations } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: chunkedFixtureFetch(files)
    });
    await (refresh as any).refreshProvider("FYERS");

    expect(applied).toEqual(["FYERS"]);
    const batch = batches[0];
    expect(batch.instruments.length).toBe(pairs * 4);
    expect(batch.mappings.length).toBe(pairs * 4);
    expect(reconciliations[0].activeNativeIdentifiers.size).toBe(pairs * 4);
    expect(batch.metadata.counts).toEqual({ options: pairs * 2, underlyings: pairs * 2 });

    // Deterministic §7.4.4 evidence: the transient parser high-water mark is
    // bounded by one row plus one stream chunk, never by the full source.
    const metrics = getLastFyersStreamMetrics()!;
    expect(metrics).not.toBeNull();
    expect(metrics.rowsStreamed).toBe(pairs * 4);
    expect(metrics.totalBytes).toBe(totalBytes);
    expect(metrics.maxParserBufferChars).toBeLessThan(256 * 1024);
    expect(metrics.maxParserBufferChars).toBeLessThan(totalBytes / 10);

    // Deterministic evidence for the unavoidable retained working set: only
    // in-scope candidates are kept until finish(), and the high-water mark is
    // the full supported population (not the full source row count).
    expect(metrics.retainedOptionCandidates).toBe(pairs * 2);
    expect(metrics.retainedCashCandidates).toBe(pairs * 2);
    expect(metrics.maxRetainedCandidates).toBe(pairs * 4);

    // Exact underFyTok -> fyToken resolution: every option points at the
    // canonical ID of its own underlying, and no false removals occurred.
    const underById = new Map(batch.instruments.filter((i: any) => !i.derivative).map((i: any) => [i.canonicalId, i]));
    for (const o of batch.instruments.filter((i: any) => i.derivative)) {
      const u = underById.get(o.underlyingCanonicalId);
      expect(u).toBeDefined();
      expect(o.canonicalSymbol).toBe(u!.canonicalSymbol);
    }
    const natives = new Set(batch.mappings.map((m: any) => m.nativeIdentifier));
    expect(natives.has("NSE:SYN00000026DEC100CE")).toBe(true);
    expect(natives.has(`NSE:SYN${String(pairs - 1).padStart(6, "0")}26DEC100CE`)).toBe(true);
    expect(natives.has("BSE:SYN00000026DEC200PE")).toBe(true);
    expect(natives.has(`BSE:SYN${String(pairs - 1).padStart(6, "0")}26DEC200PE`)).toBe(true);
  });

  test("valid escapes and keys survive arbitrary chunk boundaries", async () => {
    const files = clone(fyersFiles) as any;
    files.NSE_FO["NSE:ESC\"KEY"] = {
      fyToken: "1011270223158599", exToken: 1599, exSymbol: "ESC",
      symTicker: "NSE:ESC26DEC100CE", exchangeName: "NSE", optType: "CE",
      underSym: "RELIANCE", underFyTok: "101000000015982", expiryDate: "1798539000",
      strikePrice: 100, minLotSize: 250, tickSize: 0.05, qtyFreeze: "10000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "escaped \"detail\""
    };
    // A ReadableStream is single-consumer: create a fresh one per segment URL,
    // each carrying only that segment's own JSON in 3-byte chunks.
    const chunkedBody = (segment: string) => {
      const bytes = new TextEncoder().encode(JSON.stringify(files[segment]));
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
          controller.close();
        }
      });
    };
    const { sync, applied, batches } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK,
      fetch: async (url) => new Response(chunkedBody(
        ["NSE_FO", "BSE_FO", "NSE_CM", "BSE_CM"].find((s) => url.includes(s))!
      ))
    });
    await (refresh as any).refreshProvider("FYERS");
    expect(applied).toEqual(["FYERS"]);
    expect(batches[0].sourceVersion).toBe(legacyHash(files));
    expect(batches[0].mappings.some((m: any) => m.nativeIdentifier === "NSE:ESC26DEC100CE")).toBe(true);
  });

  test("malformed JSON, unexpected shapes and trailing garbage fail closed", async () => {
    const bodies = [
      "not json at all",
      "[]",                                  // array, not keyed object
      '{"NSE_FO":{},} trailing',             // trailing comma + garbage
      '{"NSE_FO":{"k":123}}'                 // primitive pair value
    ];
    for (const body of bodies) {
      const { sync, applied } = makeSync();
      const events: string[] = [];
      const refresh = new CatalogMasterRefresh({
        catalog: makeCatalog(), sync, now: () => CLOCK,
        fetch: async () => new Response(body),
        onEvent: (e) => events.push(e.outcome)
      });
      await (refresh as any).refreshProvider("FYERS");
      expect(applied.length).toBe(0);
      expect(events).toContain("FAILED");
    }
  });

  test("string primitive pair value fails closed: no silent drop, no reconciliation", async () => {
    // Each fetch serves one segment file body. Here the NSE_FO body is a keyed
    // object whose single pair value is a string primitive, not a detail object.
    const badBody = '{"SYM":"bad"}';

    // Stream level: the parser must throw before emitting the pair, so the
    // accumulator never sees it (and cannot silently drop it from rowsSeen).
    const acc = new FyersImportAccumulator();
    const direct = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync: makeSync().sync, now: () => CLOCK,
      fetch: async () => new Response(badBody)
    });
    let threw = false;
    try {
      await (direct as any).streamFyersInto(acc, undefined);
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("unexpected primitive pair value");
    }
    expect(threw).toBe(true);
    expect(acc.report.rowsSeen).toBe(0);
    expect(acc.retainedOptionCandidates).toBe(0);
    expect(acc.retainedCashCandidates).toBe(0);

    // End to end: a seeded catalogue is untouched and no snapshot is applied.
    const dir = mkdtempSync(join(tmpdir(), "wp2b-strval-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    try {
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const sync = new CatalogSyncService(repo);
      const seed = buildFyersImport(fyersFiles, OPTS);
      expect((await sync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation)).status).toBe("COMPLETED");
      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();

      const { sync: stubSync, applied } = makeSync();
      const events: string[] = [];
      const refresh = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "FYERS"), sync: stubSync, now: () => CLOCK,
        fetch: async () => new Response(badBody),
        onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
      });
      await (refresh as any).refreshProvider("FYERS");

      expect(applied.length).toBe(0);
      expect(events).toContain("FYERS:FAILED");
      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      expect((await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE"))?.status).toBe("ACTIVE");
      expect((await repo.listSyncRuns({ provider: "FYERS", status: "FAILED" }))[0]).toBeDefined();
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("top-level array pair value fails closed", async () => {
    // NSE_FO body with a top-level array pair value (unexpected shape).
    const badBody = '{"SYM":[]}';
    const acc = new FyersImportAccumulator();
    const direct = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync: makeSync().sync, now: () => CLOCK,
      fetch: async () => new Response(badBody)
    });
    let threw = false;
    try {
      await (direct as any).streamFyersInto(acc, undefined);
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("unexpected array pair value");
    }
    expect(threw).toBe(true);
    expect(acc.report.rowsSeen).toBe(0);

    const { sync, applied } = makeSync();
    const events: string[] = [];
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK,
      fetch: async () => new Response(badBody),
      onEvent: (e) => events.push(e.outcome)
    });
    await (refresh as any).refreshProvider("FYERS");
    expect(applied.length).toBe(0);
    expect(events).toContain("FAILED");
  });

  test("truncated segment fails closed: no reconciliation, no catalogue change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wp2b-trunc-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    try {
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const sync = new CatalogSyncService(repo);
      const seed = buildFyersImport(fyersFiles, OPTS);
      expect((await sync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation)).status).toBe("COMPLETED");
      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();

      const text = JSON.stringify(fyersFiles.NSE_FO);
      const truncated = text.slice(0, Math.floor(text.length / 2));
      const events: string[] = [];
      const refresh = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "FYERS"), sync, now: () => CLOCK,
        fetch: async (url) => url.includes("NSE_FO")
          ? new Response(truncated)
          : fixtureFetch()(url),
        onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
      });
      await (refresh as any).refreshProvider("FYERS");

      expect(events).toContain("FYERS:FAILED");
      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      expect((await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE"))?.status).toBe("ACTIVE");
      const failed = (await repo.listSyncRuns({ provider: "FYERS", status: "FAILED" }))[0];
      expect(failed).toBeDefined();
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("oversized row fails closed before any import", async () => {
    const files = clone(fyersFiles) as any;
    files.NSE_FO["NSE:HUGE"] = {
      fyToken: "1011270223158999", exToken: 1599, exSymbol: "HUGE",
      symTicker: "NSE:HUGE26DEC100CE", exchangeName: "NSE", optType: "CE",
      underSym: "RELIANCE", underFyTok: "101000000015982", expiryDate: "1798539000",
      strikePrice: 100, minLotSize: 250, tickSize: 0.05, qtyFreeze: "10000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "x".repeat(4 * 1024 * 1024 + 16)
    };
    const { sync, applied } = makeSync();
    const events: string[] = [];
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fixtureFetch(files),
      onEvent: (e) => events.push(e.outcome)
    });
    await (refresh as any).refreshProvider("FYERS");
    expect(applied.length).toBe(0);
    expect(events).toContain("FAILED");
  });

  test("unexpected HTTP 304 and HTTP 500 fail closed (caching is deferred)", async () => {
    for (const status of [304, 500]) {
      const { sync, applied } = makeSync();
      const events: string[] = [];
      const refresh = new CatalogMasterRefresh({
        catalog: makeCatalog(), sync, now: () => CLOCK,
        fetch: async () => new Response(null, { status }),
        onEvent: (e) => events.push(e.outcome)
      });
      await (refresh as any).refreshProvider("FYERS");
      expect(applied.length).toBe(0);
      expect(events).toContain("FAILED");
    }
  });

  test("missing or empty required segments fail closed", async () => {
    const cases: Record<string, unknown>[] = [
      { ...fyersFiles, NSE_FO: {} } as any,                       // empty required segment
      { NSE_FO: fyersFiles.NSE_FO } as any                        // other segments absent
    ];
    for (const files of cases) {
      const { sync, applied } = makeSync();
      const refresh = new CatalogMasterRefresh({
        catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fixtureFetch(files)
      });
      await (refresh as any).refreshProvider("FYERS");
      expect(applied.length).toBe(0);
    }
  });

  test("duplicate underlying rows resolve deterministically (first-write-wins)", async () => {
    const files = clone(fyersFiles) as any;
    files.NSE_CM["NSE:RELIANCE-DUP-EQ"] = {
      fyToken: "101000000015983", exToken: 15983, exSymbol: "RELIANCEDUP", exSeries: "EQ",
      symTicker: "NSE:RELIANCE-DUP-EQ", exchangeName: "NSE", optType: "XX", isin: "INE002A01018",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "Reliance duplicate"
    };
    files.NSE_FO["NSE:RELIANCE26DEC3200CE"] = {
      fyToken: "1011270223158571", exToken: 158571, exSymbol: "RELIANCE",
      symTicker: "NSE:RELIANCE26DEC3200CE", exchangeName: "NSE", optType: "CE",
      underSym: "RELIANCE", underFyTok: "101000000015983", expiryDate: "1798539000",
      strikePrice: 3200, minLotSize: 250, tickSize: 0.05, qtyFreeze: "10000",
      tradeStatus: 1, lastUpdate: "2026-11-23", symDetails: "29 Dec 26 3200 CE"
    };
    // Feed the shared accumulator directly: the refresh owner's fail-closed
    // validation intentionally rejects duplicate identities, so compare the
    // importer output itself (exactly as the array-based WP1 test does).
    const acc = new FyersImportAccumulator();
    for (const seg of ["NSE_FO", "BSE_FO", "NSE_CM", "BSE_CM"] as const) {
      for (const row of Object.values(files[seg] as Record<string, unknown>)) acc.addRow(seg, row);
    }
    const result = acc.finish(OPTS);
    const expected = buildFyersImport(files, OPTS);
    expect(fingerprint(result)).toEqual(fingerprint(expected));
    const underlyings = result.batch.instruments.filter((i) => !i.derivative && i.isin === "INE002A01018");
    expect(underlyings.length).toBe(2);
    expect(underlyings[0]!.canonicalId).toBe(underlyings[1]!.canonicalId);
    const options = result.batch.instruments.filter((i) => i.derivative && i.underlyingCanonicalId === underlyings[0]!.canonicalId);
    for (const o of options) expect(o.canonicalSymbol).toBe("RELIANCE");
  });

  test("missing underFyTok mapping is reported and creates no malformed derivative", async () => {
    const files = clone(fyersFiles) as any;
    files.NSE_FO["NSE:RELIANCE26DEC3000CE"].underFyTok = "999999999999999";
    const acc = new FyersImportAccumulator();
    for (const seg of ["NSE_FO", "BSE_FO", "NSE_CM", "BSE_CM"] as const) {
      for (const row of Object.values(files[seg] as Record<string, unknown>)) acc.addRow(seg, row);
    }
    const result = acc.finish(OPTS);
    const expected = buildFyersImport(files, OPTS);
    expect(result.report.unresolvedUnderlyings).toContain("999999999999999");
    expect(result.batch.mappings.some((m) => m.nativeIdentifier === "NSE:RELIANCE26DEC3000CE")).toBe(false);
    expect(fingerprint(result)).toEqual(fingerprint(expected));
  });

  test("cancellation fails closed", async () => {
    const acc = new FyersImportAccumulator();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync: makeSync().sync, now: () => CLOCK, fetch: fixtureFetch()
    });
    const controller = new AbortController();
    controller.abort();
    let threw = false;
    try {
      await (refresh as any).streamFyersInto(acc, controller.signal);
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("cancelled");
    }
    expect(threw).toBe(true);
  });

  test("a successful streaming refresh reconciles completely; a later malformed source does not remove records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wp2b-reconcile-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    try {
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const sync = new CatalogSyncService(repo);
      const seed = buildFyersImport(fyersFiles, OPTS);
      expect((await sync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation)).status).toBe("COMPLETED");

      // Complete streaming source with one option removed -> that mapping retires.
      const files = clone(fyersFiles) as any;
      delete files.NSE_FO["NSE:RELIANCE26DEC3000CE"];
      const refresh = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "FYERS"), sync, now: () => CLOCK, fetch: fixtureFetch(files)
      });
      await (refresh as any).refreshProvider("FYERS");
      expect((await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE"))?.status).toBe("REMOVED");
      expect((await repo.getMapping("FYERS", "NSE:NIFTY26DEC25000PE"))?.status).toBe("ACTIVE");

      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();
      const bad = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "FYERS"), sync, now: () => CLOCK,
        fetch: async () => new Response("garbage")
      });
      await (bad as any).refreshProvider("FYERS");
      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      expect((await repo.getMapping("FYERS", "NSE:NIFTY26DEC25000PE"))?.status).toBe("ACTIVE");
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("provider isolation: a FYERS failure does not block Upstox", async () => {
    const { sync, applied } = makeSync();
    const events: string[] = [];
    const fetchFn: MasterFetch = async (url) => {
      if (url.includes("upstox")) return Response.json(upstoxRows);
      if (url.includes("NSE_FO")) return new Response("not json");
      throw new Error("unexpected url");
    };
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn,
      onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
    });
    await (refresh as any).refreshProvider("FYERS");
    await (refresh as any).refreshProvider("UPSTOX");

    expect(events).toContain("FYERS:FAILED");
    expect(events).toContain("UPSTOX:REFRESHED");
    expect(applied).toEqual(["UPSTOX"]);
  });

  test("current output matches the independent PRE-WP2 golden fingerprints", () => {
    const result = buildFyersImport(fyersFiles as any, OPTS);
    expect(result.batch.instruments.length).toBe(GOLDEN_FYERS.instruments);
    expect(result.batch.mappings.length).toBe(GOLDEN_FYERS.mappings);
    expect(result.batch.identifiers.length).toBe(GOLDEN_FYERS.batchIdentifiers);
    expect(result.reconciliation.activeNativeIdentifiers.size).toBe(GOLDEN_FYERS.activeNativeIdentifiers);
    expect(result.report.invalidRows).toBe(GOLDEN_FYERS.invalidRows);
    expect(result.report.unresolvedUnderlyings.length).toBe(GOLDEN_FYERS.unresolvedUnderlyings);
    expect(result.report.duplicateIdentities.length).toBe(GOLDEN_FYERS.duplicateIdentities);
    expect(result.report.mappingConflicts.length).toBe(GOLDEN_FYERS.mappingConflicts);
    expect(result.report.skippedOutOfScope).toBe(GOLDEN_FYERS.skippedOutOfScope);
    expect(result.report.inScopeOptions).toBe(GOLDEN_FYERS.inScopeOptions);
    expect(result.report.inScopeUnderlyings).toBe(GOLDEN_FYERS.inScopeUnderlyings);
    expect(normalizedHash(result)).toBe(GOLDEN_FYERS.hash);
  });
});
