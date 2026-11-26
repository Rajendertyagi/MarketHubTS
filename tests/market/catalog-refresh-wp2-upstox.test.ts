/**
 * WP2-A focused coverage — bounded Upstox master ingestion.
 *
 * Deterministic assertions only (no wall-clock / RSS thresholds):
 *  - accumulator output is identical to the array-based importer;
 *  - the streaming path preserves complete NSE/BSE coverage and import output;
 *  - the retained parser buffer stays bounded far below the full source size;
 *  - malformed / truncated / oversized / cancelled sources fail closed with no
 *    reconciliation and no false removals;
 *  - provider isolation is preserved.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import {
  CatalogMasterRefresh, CatalogSyncService, buildUpstoxImport
} from "../../packages/market-core/src/index";
import type { CatalogRepository, CatalogSyncRunRecord, MasterFetch } from "../../packages/market-core/src/index";
import { UpstoxImportAccumulator } from "../../packages/market-core/src/sync/upstox-master";
import { getLastUpstoxStreamMetrics } from "../../packages/market-core/src/sync/refresh";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const CLOCK = new Date("2026-11-24T10:00:00.000Z");
const NOW = CLOCK.toISOString();
const OPTS = { now: NOW, sourceVersion: "wp2-fixture-v1", sourceObservedAt: NOW };

/**
 * Independent PRE-WP2 golden values, captured from commit `905ac1e` via
 * `git archive` and executed outside the working tree (see
 * `D:\Coding\OpenCode\user\tmp\opencode\wp2-golden\golden-fingerprints.ts`).
 * These are NOT derived from the current accumulator. The hash is a
 * key-order-independent SHA-256 over instruments, mappings, active native
 * identifiers and the import report.
 */
const GOLDEN_UPSTOX = {
  instruments: 8,
  mappings: 8,
  batchIdentifiers: 0,
  activeNativeIdentifiers: 8,
  invalidRows: 0,
  unresolvedUnderlyings: 0,
  duplicateIdentities: 0,
  mappingConflicts: 0,
  skippedOutOfScope: 3,
  inScopeOptions: 4,
  inScopeUnderlyings: 4,
  hash: "65d847cfeb4a9a03b31ce3be70337aafe62a8420d790612dff5308e6adaa9d5a"
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

async function gzipJson(value: unknown): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(JSON.stringify(value)));
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Compact, order-independent fingerprint of an importer result. */
function fingerprint(result: ReturnType<typeof buildUpstoxImport>) {
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
function normalizedHash(result: ReturnType<typeof buildUpstoxImport>): string {
  return createHash("sha256").update(stable({
    instruments: result.batch.instruments.map((i) => stable(i)).sort(),
    mappings: result.batch.mappings.map((m) => stable(m)).sort(),
    activeNativeIdentifiers: [...result.reconciliation.activeNativeIdentifiers].sort(),
    report: result.report
  }), "utf8").digest("hex");
}

/**
 * A representative Upstox-shaped row whose `name` carries every JSON escape
 * form: `\" \\ \/ \b \f \n \r \t \uXXXX`. `\/` and `\uXXXX` are injected
 * literally because `JSON.stringify` emits neither.
 */
function escapedSource(): { text: string; parsed: any[] } {
  const escapedNameJson = '"A\\"B\\\\C\\/D\\b\\f\\n\\r\\t\\u0041Z"';
  const rows = clone(upstoxRows);
  rows[0]!.name = "__ESCAPED_NAME__";
  const text = JSON.stringify(rows).replace('"name":"__ESCAPED_NAME__"', `"name":${escapedNameJson}`);
  return { text, parsed: JSON.parse(text) as any[] };
}

/** Build a large, valid NSE+BSE source with unique in-scope rows. */
function largeSource(pairs: number): any[] {
  const rows: any[] = [];
  for (let i = 0; i < pairs; i++) {
    const key = `NSE_EQ|WP2N${i}`;
    rows.push({
      segment: "NSE_EQ", name: `NSE SYN ${i}`, exchange: "NSE", isin: `INEWP2N${String(i).padStart(5, "0")}`,
      instrument_type: "EQ", instrument_key: key, exchange_token: String(100000 + i), tick_size: 0.05,
      trading_symbol: `NSYN${i}`, short_name: `NSYN${i}`
    });
    rows.push({
      segment: "NSE_FO", name: `NSE SYN ${i}`, exchange: "NSE", instrument_type: "OPTSTK", option_type: "CE",
      instrument_key: `NSE_FO|WP2N${i}-CE`, underlying_key: key, underlying_type: "EQ",
      expiry: "2026-12-29T15:00:00+05:30", strike_price: 100 + i, lot_size: 250, tick_size: 0.05,
      freeze_quantity: 10000, trading_symbol: `NSYN${i}26DEC${100 + i}CE`
    });
    const bkey = `BSE_EQ|WP2B${i}`;
    rows.push({
      segment: "BSE_EQ", name: `BSE SYN ${i}`, exchange: "BSE", isin: `INEWP2B${String(i).padStart(5, "0")}`,
      instrument_type: "EQ", instrument_key: bkey, exchange_token: String(200000 + i), tick_size: 0.05,
      trading_symbol: `BSYN${i}`, short_name: `BSYN${i}`
    });
    rows.push({
      segment: "BSE_FO", name: `BSE SYN ${i}`, exchange: "BSE", instrument_type: "OPTSTK", option_type: "PE",
      instrument_key: `BSE_FO|WP2B${i}-PE`, underlying_key: bkey, underlying_type: "EQ",
      expiry: "2026-12-29T15:00:00+05:30", strike_price: 200 + i, lot_size: 100, tick_size: 0.05,
      freeze_quantity: 5000, trading_symbol: `BSYN${i}26DEC${200 + i}PE`
    });
  }
  return rows;
}

describe("WP2-A Upstox bounded ingestion", () => {
  test("accumulator output is identical to the array-based importer (baseline fixture)", () => {
    const acc = new UpstoxImportAccumulator();
    for (const row of upstoxRows) acc.addRow(row);
    expect(fingerprint(acc.finish(OPTS))).toEqual(fingerprint(buildUpstoxImport(upstoxRows, OPTS)));
  });

  test("streaming path (plain JSON) produces the same import as the array path", async () => {
    const { sync, applied, batches, reconciliations } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK,
      fetch: async () => Response.json(upstoxRows)
    });
    await (refresh as any).refreshProvider("UPSTOX");

    expect(applied).toEqual(["UPSTOX"]);
    // Response.json has no Last-Modified header, so sourceObservedAt stays unknown.
    const expected = buildUpstoxImport(upstoxRows, { now: NOW, sourceVersion: OPTS.sourceVersion });
    expect(batches[0].instruments.map((i: any) => JSON.stringify(i)).sort())
      .toEqual(expected.batch.instruments.map((i) => JSON.stringify(i)).sort());
    expect(batches[0].mappings.map((m: any) => JSON.stringify(m)).sort())
      .toEqual(expected.batch.mappings.map((m) => JSON.stringify(m)).sort());
    expect([...reconciliations[0].activeNativeIdentifiers].sort())
      .toEqual([...expected.reconciliation.activeNativeIdentifiers].sort());
  });

  test("valid JSON escape sequences inside strings parse identically to JSON.parse", async () => {
    const { text, parsed } = escapedSource();
    expect(parsed[0].name).toBe('A"B\\C/D\b\f\n\r\tAZ');

    const { sync, applied, batches, reconciliations } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK,
      fetch: async () => new Response(text)
    });
    await (refresh as any).refreshProvider("UPSTOX");

    expect(applied).toEqual(["UPSTOX"]);
    const expected = buildUpstoxImport(parsed, { now: NOW, sourceVersion: OPTS.sourceVersion });
    expect(batches[0].instruments.map((i: any) => JSON.stringify(i)).sort())
      .toEqual(expected.batch.instruments.map((i) => JSON.stringify(i)).sort());
    expect(batches[0].mappings.map((m: any) => JSON.stringify(m)).sort())
      .toEqual(expected.batch.mappings.map((m) => JSON.stringify(m)).sort());
    expect([...reconciliations[0].activeNativeIdentifiers].sort())
      .toEqual([...expected.reconciliation.activeNativeIdentifiers].sort());
    // The decoded escape payload reaches the importer verbatim (displayName
    // is sourced from `name` for cash underlyings).
    const reliance = batches[0].instruments.find(
      (i: any) => i.stableIdentifier === "NSE_EQ|INE002A01018"
    );
    expect(reliance.displayName).toBe('A"B\\C/D\b\f\n\r\tAZ');
  });

  test("valid escapes survive arbitrary chunk boundaries", async () => {
    const { text, parsed } = escapedSource();
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      }
    });
    const { sync, applied, batches } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK,
      fetch: async () => new Response(body)
    });
    await (refresh as any).refreshProvider("UPSTOX");

    expect(applied).toEqual(["UPSTOX"]);
    const expected = buildUpstoxImport(parsed, { now: NOW, sourceVersion: OPTS.sourceVersion });
    expect(batches[0].instruments.map((i: any) => JSON.stringify(i)).sort())
      .toEqual(expected.batch.instruments.map((i) => JSON.stringify(i)).sort());
  });

  test("large gzipped NSE/BSE source: complete coverage, bounded parser buffer, no false removals", async () => {
    const pairs = 1500;
    const rows = largeSource(pairs);
    const gz = await gzipJson(rows);
    const decompressedBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    const { sync, applied, batches, reconciliations } = makeSync();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK,
      fetch: async () => new Response(gz as any, { headers: { "Content-Type": "application/gzip" } })
    });
    await (refresh as any).refreshProvider("UPSTOX");

    expect(applied).toEqual(["UPSTOX"]);
    const batch = batches[0];
    expect(batch.instruments.length).toBe(pairs * 4);
    expect(batch.mappings.length).toBe(pairs * 4);
    expect(reconciliations[0].activeNativeIdentifiers.size).toBe(pairs * 4);
    expect(batch.metadata.counts).toEqual({ options: pairs * 2, underlyings: pairs * 2 });

    // Deterministic §7.4.4 evidence: `maxParserBufferChars` is the *transient*
    // peak measured on buffer growth — a partial row plus one decompressed
    // chunk (~100 KB here), before compaction. It is bounded by one row plus
    // one stream chunk, never by the full source (which is > 1 MB here), and
    // does not grow with source size. The post-compaction retained fragment is
    // smaller still (one row).
    const metrics = getLastUpstoxStreamMetrics()!;
    expect(metrics).not.toBeNull();
    expect(metrics.rowsStreamed).toBe(pairs * 4);
    expect(metrics.maxDecompressedBytes).toBe(decompressedBytes);
    expect(metrics.maxParserBufferChars).toBeLessThan(256 * 1024);
    expect(metrics.maxParserBufferChars).toBeLessThan(decompressedBytes / 10);

    // Spot-check representative mappings from both exchanges (no false removals).
    const natives = new Set(batch.mappings.map((m: any) => m.nativeIdentifier));
    expect(natives.has("NSE_FO|WP2N0-CE")).toBe(true);
    expect(natives.has("NSE_FO|WP2N1499-CE")).toBe(true);
    expect(natives.has("BSE_FO|WP2B0-PE")).toBe(true);
    expect(natives.has("BSE_FO|WP2B1499-PE")).toBe(true);
  });

  test("truncated gzip fails closed: no reconciliation, no catalogue change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wp2a-trunc-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    try {
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const sync = new CatalogSyncService(repo);
      const seed = buildUpstoxImport(upstoxRows, OPTS);
      expect((await sync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation)).status).toBe("COMPLETED");
      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();

      const gz = await gzipJson(upstoxRows);
      const truncated = gz.slice(0, Math.floor(gz.length / 2));
      const events: string[] = [];
      const refresh = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "UPSTOX"), sync, now: () => CLOCK,
        fetch: async () => new Response(truncated as any),
        onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
      });
      await (refresh as any).refreshProvider("UPSTOX");

      expect(events).toContain("UPSTOX:FAILED");
      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      expect((await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))?.status).toBe("ACTIVE");
      const failed = (await repo.listSyncRuns({ provider: "UPSTOX", status: "FAILED" }))[0];
      expect(failed).toBeDefined();
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("malformed JSON, unexpected shape and trailing garbage fail closed", async () => {
    const bodies = [
      "not json at all",
      "{}",                       // object, not array
      '[{"segment":"NSE_FO"}] trailing',
      "[123]"                     // bare primitive element
    ];
    for (const body of bodies) {
      const { sync, applied } = makeSync();
      const events: string[] = [];
      const refresh = new CatalogMasterRefresh({
        catalog: makeCatalog(), sync, now: () => CLOCK,
        fetch: async () => new Response(body),
        onEvent: (e) => events.push(e.outcome)
      });
      await (refresh as any).refreshProvider("UPSTOX");
      expect(applied.length).toBe(0);
      expect(events).toContain("FAILED");
    }
  });

  test("trailing comma before ] is rejected by the parser (same chunk and across chunks)", async () => {
    const streamError = async (body: BodyInit): Promise<string> => {
      const acc = new UpstoxImportAccumulator();
      const refresh = new CatalogMasterRefresh({
        catalog: makeCatalog(), sync: makeSync().sync, now: () => CLOCK,
        fetch: async () => new Response(body)
      });
      try {
        await (refresh as any).streamUpstoxInto(acc, "https://example.invalid/complete.json", undefined);
        return "";
      } catch (e) {
        return String(e);
      }
    };

    // Same chunk: `[{"a":1},]`.
    expect(await streamError('[{"a":1},]')).toContain("trailing comma");
    // Chunk boundary: comma ends one chunk, `]` starts the next.
    const bytes = new TextEncoder().encode('[{"a":1},]');
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 9)); // '[{"a":1},'
        controller.enqueue(bytes.slice(9));    // ']'
        controller.close();
      }
    });
    expect(await streamError(split)).toContain("trailing comma");
  });

  test("unexpected HTTP 304 fails closed (caching is deferred)", async () => {
    const { sync, applied } = makeSync();
    const events: string[] = [];
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK,
      fetch: async () => new Response(null, { status: 304 }),
      onEvent: (e) => events.push(e.outcome)
    });
    await (refresh as any).refreshProvider("UPSTOX");
    expect(applied.length).toBe(0);
    expect(events).toContain("FAILED");
  });

  test("oversized row count fails closed before any import", async () => {
    const rows = new Array(1_000_001).fill("{}").join(",");
    const body = `[${rows}]`;
    const { sync, applied } = makeSync();
    const events: string[] = [];
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK,
      fetch: async () => new Response(body),
      onEvent: (e) => events.push(e.outcome)
    });
    await (refresh as any).refreshProvider("UPSTOX");
    expect(applied.length).toBe(0);
    expect(events).toContain("FAILED");
  });

  test("cancellation fails closed", async () => {
    const acc = new UpstoxImportAccumulator();
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync: makeSync().sync, now: () => CLOCK,
      // Ignore the signal at fetch so the in-loop cancellation check is exercised.
      fetch: async () => Response.json(upstoxRows)
    });
    const controller = new AbortController();
    controller.abort();
    let threw = false;
    try {
      await (refresh as any).streamUpstoxInto(
        acc, "https://example.invalid/complete.json.gz", controller.signal
      );
    } catch (e) {
      threw = true;
      expect(String(e)).toContain("cancelled");
    }
    expect(threw).toBe(true);
  });

  test("missing or empty required segments fail closed", async () => {
    const cases: unknown[][] = [
      [],                                                   // empty array
      upstoxRows.filter((r) => r.segment !== "BSE_FO")       // no BSE_FO
    ];
    for (const rows of cases) {
      const { sync, applied } = makeSync();
      const refresh = new CatalogMasterRefresh({
        catalog: makeCatalog(), sync, now: () => CLOCK, fetch: async () => Response.json(rows)
      });
      await (refresh as any).refreshProvider("UPSTOX");
      expect(applied.length).toBe(0);
    }
  });

  test("provider isolation: an Upstox streaming failure does not block FYERS", async () => {
    const { sync, applied } = makeSync();
    const events: string[] = [];
    const fetchFn: MasterFetch = async (url) => {
      if (url.includes("upstox")) return new Response("not json");
      if (url.includes("NSE_FO")) return Response.json(fyersFiles.NSE_FO);
      if (url.includes("BSE_FO")) return Response.json(fyersFiles.BSE_FO);
      if (url.includes("NSE_CM")) return Response.json(fyersFiles.NSE_CM);
      if (url.includes("BSE_CM")) return Response.json(fyersFiles.BSE_CM);
      throw new Error("unexpected url");
    };
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn,
      onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
    });
    await (refresh as any).refreshProvider("UPSTOX");
    await (refresh as any).refreshProvider("FYERS");

    expect(events).toContain("UPSTOX:FAILED");
    expect(events).toContain("FYERS:REFRESHED");
    expect(applied).toEqual(["FYERS"]);
  });

  test("a successful streaming refresh reconciles completely; a later malformed source does not remove records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wp2a-reconcile-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    try {
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const sync = new CatalogSyncService(repo);
      const seed = buildUpstoxImport(upstoxRows, OPTS);
      expect((await sync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation)).status).toBe("COMPLETED");

      // Complete streaming source with one option removed -> that mapping retires.
      const rows = clone(upstoxRows).filter((r: any) => r.instrument_key !== "NSE_FO|REL-CE-1");
      const refresh = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "UPSTOX"), sync, now: () => CLOCK,
        fetch: async () => Response.json(rows)
      });
      await (refresh as any).refreshProvider("UPSTOX");
      expect((await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))?.status).toBe("REMOVED");
      expect((await repo.getMapping("UPSTOX", "NSE_FO|NIFTY-PE-1"))?.status).toBe("ACTIVE");

      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();
      const bad = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "UPSTOX"), sync, now: () => CLOCK,
        fetch: async () => new Response("garbage")
      });
      await (bad as any).refreshProvider("UPSTOX");
      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      expect((await repo.getMapping("UPSTOX", "NSE_FO|NIFTY-PE-1"))?.status).toBe("ACTIVE");
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("current output matches the independent PRE-WP2 golden fingerprints", () => {
    const result = buildUpstoxImport(upstoxRows, OPTS);
    expect(result.batch.instruments.length).toBe(GOLDEN_UPSTOX.instruments);
    expect(result.batch.mappings.length).toBe(GOLDEN_UPSTOX.mappings);
    expect(result.batch.identifiers.length).toBe(GOLDEN_UPSTOX.batchIdentifiers);
    expect(result.reconciliation.activeNativeIdentifiers.size).toBe(GOLDEN_UPSTOX.activeNativeIdentifiers);
    expect(result.report.invalidRows).toBe(GOLDEN_UPSTOX.invalidRows);
    expect(result.report.unresolvedUnderlyings.length).toBe(GOLDEN_UPSTOX.unresolvedUnderlyings);
    expect(result.report.duplicateIdentities.length).toBe(GOLDEN_UPSTOX.duplicateIdentities);
    expect(result.report.mappingConflicts.length).toBe(GOLDEN_UPSTOX.mappingConflicts);
    expect(result.report.skippedOutOfScope).toBe(GOLDEN_UPSTOX.skippedOutOfScope);
    expect(result.report.inScopeOptions).toBe(GOLDEN_UPSTOX.inScopeOptions);
    expect(result.report.inScopeUnderlyings).toBe(GOLDEN_UPSTOX.inScopeUnderlyings);
    expect(normalizedHash(result)).toBe(GOLDEN_UPSTOX.hash);
  });

  test("missing, leading and repeated commas fail closed at the parser (same and split chunks)", async () => {
    const streamError = async (body: BodyInit): Promise<string> => {
      const acc = new UpstoxImportAccumulator();
      const refresh = new CatalogMasterRefresh({
        catalog: makeCatalog(), sync: makeSync().sync, now: () => CLOCK,
        fetch: async () => new Response(body)
      });
      try {
        await (refresh as any).streamUpstoxInto(acc, "https://example.invalid/complete.json", undefined);
        return "";
      } catch (e) {
        return String(e);
      }
    };

    // Same chunk.
    expect(await streamError('[{"a":1}{"b":2}]')).toContain("missing comma between elements");
    expect(await streamError('[,{"a":1}]')).toContain("leading comma");
    expect(await streamError('[{"a":1},,{"b":2}]')).toContain("repeated comma");

    // Across chunk boundaries: a separator must not hide at a chunk edge.
    const splitError = async (parts: string[]): Promise<string> => {
      const bytes = new TextEncoder().encode(parts.join(""));
      const cuts: number[] = [];
      let accLen = 0;
      for (const p of parts) { accLen += p.length; cuts.push(accLen); }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let from = 0;
          for (const cut of cuts) { controller.enqueue(bytes.slice(from, cut)); from = cut; }
          controller.close();
        }
      });
      return streamError(body);
    };
    expect(await splitError(['[{"a":1}', '{"b":2}]'])).toContain("missing comma between elements");
    expect(await splitError(['[', ',{"a":1}]'])).toContain("leading comma");
    expect(await splitError(['[{"a":1},', ',{"b":2}]'])).toContain("repeated comma");
  });

  test("missing/leading/repeated commas: FAILED, no reconciliation, no partial snapshot", async () => {
    const bodies = ['[{"a":1}{"b":2}]', '[,{"a":1}]', '[{"a":1},,{"b":2}]'];
    const dir = mkdtempSync(join(tmpdir(), "wp2a-sep-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    try {
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const realSync = new CatalogSyncService(repo);
      const seed = buildUpstoxImport(upstoxRows, OPTS);
      expect((await realSync.applyCompleteProviderSnapshot(seed.batch, seed.reconciliation)).status).toBe("COMPLETED");
      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();

      for (const body of bodies) {
        let applyCalls = 0;
        const spySync = {
          applyCompleteProviderSnapshot: (b: any, r: any) => {
            applyCalls++;
            return realSync.applyCompleteProviderSnapshot(b, r);
          }
        } as unknown as CatalogSyncService;
        const events: string[] = [];
        const refresh = new CatalogMasterRefresh({
          catalog: proceedingCatalog(repo, "UPSTOX"), sync: spySync, now: () => CLOCK,
          fetch: async () => new Response(body),
          onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
        });
        await (refresh as any).refreshProvider("UPSTOX");
        expect(events).toContain("UPSTOX:FAILED");
        expect(applyCalls).toBe(0); // no reconciliation
        expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before); // no partial snapshot
      }
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("unreferenced cash row missing all symbol fields is skipped, not counted invalid", async () => {
    const rows = clone(upstoxRows) as any[];
    rows.push({
      segment: "NSE_EQ", exchange: "NSE", instrument_key: "NSE_EQ|UNREFERENCED",
      isin: "INEUNREF0001", exchange_token: "999999", instrument_type: "EQ"
    });
    const acc = new UpstoxImportAccumulator();
    for (const row of rows) acc.addRow(row);
    const result = acc.finish(OPTS);
    const baseline = buildUpstoxImport(upstoxRows, OPTS);
    // Valid output is unchanged; only the out-of-scope counter moves.
    expect(result.batch.instruments.map((i) => JSON.stringify(i)).sort())
      .toEqual(baseline.batch.instruments.map((i) => JSON.stringify(i)).sort());
    expect(result.batch.mappings.map((m) => JSON.stringify(m)).sort())
      .toEqual(baseline.batch.mappings.map((m) => JSON.stringify(m)).sort());
    expect([...result.reconciliation.activeNativeIdentifiers].sort())
      .toEqual([...baseline.reconciliation.activeNativeIdentifiers].sort());
    expect(result.report.invalidRows).toBe(baseline.report.invalidRows);
    expect(result.report.skippedOutOfScope).toBe(baseline.report.skippedOutOfScope + 1);

    // End to end: the out-of-scope row must not fail the refresh.
    const { sync, applied, batches } = makeSync();
    const events: string[] = [];
    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: async () => Response.json(rows),
      onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
    });
    await (refresh as any).refreshProvider("UPSTOX");
    expect(applied).toEqual(["UPSTOX"]);
    expect(events).toContain("UPSTOX:REFRESHED");
    expect(batches[0].instruments.length).toBe(baseline.batch.instruments.length);
  });
});
