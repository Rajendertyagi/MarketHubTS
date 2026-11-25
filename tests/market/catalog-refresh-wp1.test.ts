/**
 * WP1 regression coverage for catalog refresh remediation:
 *  - WP1-A: canonical-ID-scoped identifier supersession (no broad-scope query).
 *  - WP1-B: keyed derivative->underlying resolution in both importers.
 *
 * All assertions are deterministic (repository-boundary counters and exact
 * identifier/import state); none depend on wall-clock timing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import {
  CatalogSyncService, computeIdentityKey, normalizeAliasValue, normalizeScope,
  buildUpstoxImport, buildFyersImport
} from "../../packages/market-core/src/index";
import type {
  CanonicalInstrument, CatalogSyncBatch, InstrumentIdentifier, ProviderImportResult
} from "../../packages/contracts/src/index";
import type { CatalogRepository, CatalogRepositoryTx } from "../../packages/market-core/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const NOW = "2026-11-24T10:00:00.000Z";
const IMPORT_OPTS = { now: NOW, sourceVersion: "wp1-fixture-v1", sourceObservedAt: NOW };

const tempDirs: string[] = [];
const handles: Array<{ close: () => void } | null> = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wp1-catalog-"));
  tempDirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
  handles.push(handle);
  const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
  const sync = new CatalogSyncService(repo);
  return { dir, handle, repo, sync };
}

afterEach(() => {
  while (handles.length) {
    try { closeDatabaseHandle(handles.pop() ?? undefined); } catch { /* best effort */ }
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) { try { removeTempDir(dir); } catch { /* best effort */ } }
  }
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function equity(p: {
  canonicalId?: string;
  exchange: "NSE" | "BSE";
  segment: string;
  canonicalSymbol: string;
  displayName: string;
  isin?: string;
  exchangeSecurityId?: string;
  stableIdentifier?: string;
}): CanonicalInstrument {
  const identityKey = computeIdentityKey({
    exchange: p.exchange,
    segment: p.segment,
    instrumentCategory: "EQUITY",
    canonicalSymbol: p.canonicalSymbol,
    isin: p.isin,
    exchangeSecurityId: p.exchangeSecurityId,
    stableIdentifier: p.stableIdentifier
  });
  return {
    canonicalId: p.canonicalId ?? crypto.randomUUID(),
    identityKey,
    identityVersion: 1,
    exchange: p.exchange,
    segment: p.segment,
    marketType: "CASH",
    instrumentCategory: "EQUITY",
    canonicalSymbol: p.canonicalSymbol,
    displayName: p.displayName,
    ...(p.isin ? { isin: p.isin } : {}),
    ...(p.exchangeSecurityId ? { exchangeSecurityId: p.exchangeSecurityId } : {}),
    ...(p.stableIdentifier ? { stableIdentifier: p.stableIdentifier } : {}),
    tradingStatus: "ACTIVE",
    lifecycleStatus: "ACTIVE",
    provenance: { source: "WP1_TEST", provider: "UPSTOX" },
    createdAt: NOW,
    updatedAt: NOW
  } as CanonicalInstrument;
}

function makeBatch(instruments: CanonicalInstrument[], source: string): CatalogSyncBatch {
  return { source, scope: { source }, completeness: "COMPLETE", instruments, mappings: [], aliases: [], identifiers: [] };
}

function identifierKey(i: InstrumentIdentifier): string {
  return [
    i.identifierType, i.identifierNamespace, i.identifierNormalized, i.status,
    i.exchangeScope, i.segmentScope, i.source
  ].join("|");
}

interface TxSpy {
  findIdentifiers: number;
  findIdentifiersQueries: Array<Record<string, unknown>>;
  listIdentifiersByCanonicalId: number;
  listedCanonicalIds: string[];
}

/**
 * Wrap the repository's transaction boundary so every `findIdentifiers` and
 * `listIdentifiersByCanonicalId` call made by the apply path is counted and
 * recorded. All other tx methods are bound to the real transaction object.
 */
function spyOnTx(repo: SqliteCatalogRepository): { repo: CatalogRepository; spy: TxSpy } {
  const spy: TxSpy = {
    findIdentifiers: 0,
    findIdentifiersQueries: [],
    listIdentifiersByCanonicalId: 0,
    listedCanonicalIds: []
  };
  const wrapped = Object.create(repo) as CatalogRepository;
  (wrapped as any).transaction = async (fn: (tx: CatalogRepositoryTx) => Promise<unknown> | unknown) =>
    (repo as any).transaction((tx: CatalogRepositoryTx) => {
      const proxy = new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === "findIdentifiers") {
            return (query: Record<string, unknown>) => {
              spy.findIdentifiers++;
              spy.findIdentifiersQueries.push(query);
              return (value as (q: Record<string, unknown>) => unknown).call(target, query);
            };
          }
          if (prop === "listIdentifiersByCanonicalId") {
            return (canonicalId: string) => {
              spy.listIdentifiersByCanonicalId++;
              spy.listedCanonicalIds.push(canonicalId);
              return (value as (id: string) => unknown).call(target, canonicalId);
            };
          }
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        }
      });
      return fn(proxy as CatalogRepositoryTx);
    });
  return { repo: wrapped, spy };
}

function seedIdentifier(canonicalId: string, p: {
  identifierType: string;
  identifierNamespace: string;
  identifierValue: string;
  exchange: string;
  segment: string;
  status: string;
}): InstrumentIdentifier {
  return {
    canonicalId,
    identifierType: p.identifierType,
    identifierNamespace: p.identifierNamespace,
    identifierValue: p.identifierValue,
    identifierNormalized: normalizeAliasValue(p.identifierValue),
    exchange: p.exchange as InstrumentIdentifier["exchange"],
    segment: p.segment as InstrumentIdentifier["segment"],
    exchangeScope: normalizeScope(p.exchange),
    segmentScope: normalizeScope(p.segment),
    source: "wp1-seed",
    status: p.status as InstrumentIdentifier["status"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

/** Compact, relationship-oriented fingerprint of an importer result. */
function importFingerprint(result: ProviderImportResult) {
  const byId = new Map(result.batch.instruments.map((i) => [i.canonicalId, i]));
  const instruments = result.batch.instruments.map((i) => {
    const d = i.derivative;
    const underlying = i.underlyingCanonicalId
      ? (byId.get(i.underlyingCanonicalId)?.canonicalSymbol ?? "?")
      : "-";
    return [
      i.canonicalSymbol, i.exchange, i.segment, i.instrumentCategory, underlying,
      d
        ? `${d.expiryDate}/${d.strike}/${d.optionType}/${d.lotSize ?? "-"}/${d.tickSize ?? "-"}/${d.quantityFreeze ?? "-"}`
        : "-"
    ].join("|");
  }).sort();
  const mappings = result.batch.mappings
    .map((m) => `${m.nativeIdentifier}|${byId.get(m.canonicalId)?.canonicalSymbol ?? "?"}|${m.status}`)
    .sort();
  return { instruments, mappings, report: result.report };
}

describe("WP1-A canonical-scoped identifier supersession", () => {
  test("old current SYMBOL is superseded by a new normalized value only for its own canonical", async () => {
    const { handle, repo, sync } = setup();
    try {
      const target = equity({
        exchange: "NSE", segment: "CASH", canonicalSymbol: "OLDSYM", displayName: "Old", isin: "INEWP1A0001"
      });
      expect((await sync.applyBatch(makeBatch([target], "wp1a-s1"))).status).toBe("COMPLETED");

      // Same ISIN identity basis -> same identityKey -> resolves to the same canonical,
      // but a different canonicalSymbol yields a new normalized SYMBOL value.
      const renamed = equity({
        canonicalId: crypto.randomUUID(), exchange: "NSE", segment: "CASH",
        canonicalSymbol: "NEWSYM", displayName: "New", isin: "INEWP1A0001"
      });
      const { repo: spyRepo, spy } = spyOnTx(repo);
      const result = await new CatalogSyncService(spyRepo).applyBatch(makeBatch([renamed], "wp1a-s2"));
      expect(result.status).toBe("COMPLETED");

      // Deterministic assertion (a): zero broad-scope findIdentifiers calls.
      expect(spy.findIdentifiers).toBe(0);
      expect(spy.findIdentifiersQueries).toEqual([]);
      // Deterministic assertion (b): only the canonical under test was looked up.
      expect(spy.listIdentifiersByCanonicalId).toBeGreaterThan(0);
      expect(spy.listedCanonicalIds.every((id) => id === target.canonicalId)).toBe(true);

      const ids = await repo.listIdentifiersByCanonicalId(target.canonicalId);
      const symbols = ids.filter((i) => i.identifierType === "SYMBOL");
      expect(symbols.some((i) => i.identifierNormalized === "OLDSYM" && i.status === "SUPERSEDED")).toBe(true);
      expect(symbols.some((i) => i.identifierNormalized === "NEWSYM" && i.status === "CURRENT")).toBe(true);
    } finally {
      closeDatabaseHandle(handle);
    }
  });

  test("many unrelated canonicals sharing type/namespace/exchange/segment/SYMBOL scope are untouched", async () => {
    const { handle, repo, sync } = setup();
    try {
      const target = equity({
        exchange: "NSE", segment: "CASH", canonicalSymbol: "TARGETOLD", displayName: "Target", isin: "INEWP1T0001"
      });
      const unrelated = Array.from({ length: 25 }, (_, i) => equity({
        exchange: "NSE", segment: "CASH", canonicalSymbol: `UNREL${i}`, displayName: `Unrelated ${i}`,
        isin: `INEWP1U${String(i).padStart(4, "0")}`
      }));
      expect((await sync.applyBatch(makeBatch([target, ...unrelated], "wp1a-many-s1"))).status).toBe("COMPLETED");

      const before = new Map<string, string[]>();
      for (const u of unrelated) {
        before.set(u.canonicalId, (await repo.listIdentifiersByCanonicalId(u.canonicalId)).map(identifierKey).sort());
      }

      const renamed = equity({
        canonicalId: crypto.randomUUID(), exchange: "NSE", segment: "CASH",
        canonicalSymbol: "TARGETNEW", displayName: "Target", isin: "INEWP1T0001"
      });
      const { repo: spyRepo, spy } = spyOnTx(repo);
      expect((await new CatalogSyncService(spyRepo).applyBatch(makeBatch([renamed], "wp1a-many-s2"))).status).toBe("COMPLETED");

      expect(spy.findIdentifiers).toBe(0);
      expect(spy.listedCanonicalIds.every((id) => id === target.canonicalId)).toBe(true);

      // No unrelated identifier was materialized, mutated or deleted.
      for (const u of unrelated) {
        const after = (await repo.listIdentifiersByCanonicalId(u.canonicalId)).map(identifierKey).sort();
        expect(after).toEqual(before.get(u.canonicalId));
      }
      const targetIds = await repo.listIdentifiersByCanonicalId(target.canonicalId);
      expect(targetIds.some((i) => i.identifierType === "SYMBOL" && i.identifierNormalized === "TARGETOLD" && i.status === "SUPERSEDED")).toBe(true);
      expect(targetIds.some((i) => i.identifierType === "SYMBOL" && i.identifierNormalized === "TARGETNEW" && i.status === "CURRENT")).toBe(true);
    } finally {
      closeDatabaseHandle(handle);
    }
  });

  test("identifiers of other namespace/scope/type/status remain unchanged and history is intact", async () => {
    const { handle, repo, sync } = setup();
    try {
      const target = equity({
        exchange: "NSE", segment: "CASH", canonicalSymbol: "SCOPEOLD", displayName: "Scope", isin: "INEWP1S0001"
      });
      expect((await sync.applyBatch(makeBatch([target], "wp1a-scope-s1"))).status).toBe("COMPLETED");

      const seeds = [
        seedIdentifier(target.canonicalId, { identifierType: "SYMBOL", identifierNamespace: "BSE", identifierValue: "OTHERNS", exchange: "BSE", segment: "CASH", status: "CURRENT" }),
        seedIdentifier(target.canonicalId, { identifierType: "SYMBOL", identifierNamespace: "NSE", identifierValue: "OTHERSEG", exchange: "NSE", segment: "FO", status: "CURRENT" }),
        seedIdentifier(target.canonicalId, { identifierType: "ISIN", identifierNamespace: "BSE", identifierValue: "INEOTHER0001", exchange: "BSE", segment: "CASH", status: "CURRENT" }),
        seedIdentifier(target.canonicalId, { identifierType: "SYMBOL", identifierNamespace: "NSE", identifierValue: "HISTSYM", exchange: "NSE", segment: "CASH", status: "HISTORICAL" })
      ];
      await repo.transaction((tx) => Promise.all(seeds.map((s) => tx.upsertIdentifier(s))));
      const before = (await repo.listIdentifiersByCanonicalId(target.canonicalId)).map(identifierKey).sort();

      const renamed = equity({
        canonicalId: crypto.randomUUID(), exchange: "NSE", segment: "CASH",
        canonicalSymbol: "SCOPENEW", displayName: "Scope", isin: "INEWP1S0001"
      });
      const { repo: spyRepo, spy } = spyOnTx(repo);
      expect((await new CatalogSyncService(spyRepo).applyBatch(makeBatch([renamed], "wp1a-scope-s2"))).status).toBe("COMPLETED");
      expect(spy.findIdentifiers).toBe(0);

      const after = (await repo.listIdentifiersByCanonicalId(target.canonicalId)).map(identifierKey).sort();
      // Every seeded row survives with its original status/value/scope (no unrelated deletion).
      for (const s of seeds) expect(after).toContain(identifierKey(s));
      // Only the exact NSE/CASH/SYMBOL/CURRENT old value was superseded.
      expect(after).toContain("SYMBOL|NSE|SCOPEOLD|SUPERSEDED|NSE|CASH|wp1a-scope-s1");
      expect(after).toContain("SYMBOL|NSE|SCOPENEW|CURRENT|NSE|CASH|wp1a-scope-s2");
      expect(after.length).toBe(before.length + 1); // one new current row, no deletions
    } finally {
      closeDatabaseHandle(handle);
    }
  });
});

describe("WP1-B keyed importer lookups", () => {
  test("Upstox import preserves canonical instruments, relationships and specifications", () => {
    const fp = importFingerprint(buildUpstoxImport(upstoxRows, IMPORT_OPTS));
    expect(fp.instruments).toEqual([
      "NIFTY 50|NSE|FO|INDEX_OPTION|NIFTY 50|2026-12-29/25000/PE/75/0.05/5000",
      "NIFTY 50|NSE|INDEX|INDEX|-|-",
      "RELIANCE|NSE|CASH|EQUITY|-|-",
      "RELIANCE|NSE|FO|STOCK_OPTION|RELIANCE|2026-12-29/3000/CE/250/0.05/10000",
      "SENSEX|BSE|FO|INDEX_OPTION|SENSEX|2026-12-29/80000/PE/15/0.05/3000",
      "SENSEX|BSE|INDEX|INDEX|-|-",
      "TCS|BSE|CASH|EQUITY|-|-",
      "TCS|BSE|FO|STOCK_OPTION|TCS|2026-12-29/4000/CE/100/0.05/5000"
    ]);
    expect(fp.mappings).toEqual([
      "BSE_EQ|INE467B01029|TCS|ACTIVE",
      "BSE_FO|SENSEX-PE-1|SENSEX|ACTIVE",
      "BSE_FO|TCS-CE-1|TCS|ACTIVE",
      "BSE_INDEX|SENSEX|SENSEX|ACTIVE",
      "NSE_EQ|INE002A01018|RELIANCE|ACTIVE",
      "NSE_FO|NIFTY-PE-1|NIFTY 50|ACTIVE",
      "NSE_FO|REL-CE-1|RELIANCE|ACTIVE",
      "NSE_INDEX|Nifty 50|NIFTY 50|ACTIVE"
    ]);
    expect(fp.report.rowsSeen).toBe(11);
    expect(fp.report.inScopeOptions).toBe(4);
    expect(fp.report.inScopeUnderlyings).toBe(4);
    expect(fp.report.unresolvedUnderlyings).toEqual([]);
    expect(fp.report.duplicateIdentities).toEqual([]);
    expect(fp.report.mappingConflicts).toEqual([]);
  });

  test("FYERS import preserves canonical instruments, relationships and specifications", () => {
    const fp = importFingerprint(buildFyersImport(fyersFiles, IMPORT_OPTS));
    expect(fp.instruments).toEqual([
      "NIFTY|NSE|FO|INDEX_OPTION|NIFTY|2026-12-29/25000/PE/75/0.05/5000",
      "NIFTY|NSE|INDEX|INDEX|-|-",
      "RELIANCE|NSE|CASH|EQUITY|-|-",
      "RELIANCE|NSE|FO|STOCK_OPTION|RELIANCE|2026-12-29/3000/CE/250/0.05/10000",
      "RELIANCE|NSE|FO|STOCK_OPTION|RELIANCE|2026-12-29/3100/PE/250/0.05/10000",
      "SENSEX|BSE|FO|INDEX_OPTION|SENSEX|2026-12-29/80000/PE/15/0.05/3000",
      "SENSEX|BSE|INDEX|INDEX|-|-",
      "TCS|BSE|CASH|EQUITY|-|-",
      "TCS|BSE|FO|STOCK_OPTION|TCS|2026-12-29/4000/CE/100/0.05/5000"
    ]);
    expect(fp.mappings).toEqual([
      "BSE:SENSEX-INDEX|SENSEX|ACTIVE",
      "BSE:SENSEX26DEC80000PE|SENSEX|ACTIVE",
      "BSE:TCS-EQ|TCS|ACTIVE",
      "BSE:TCS26DEC4000CE|TCS|ACTIVE",
      "NSE:NIFTY26DEC25000PE|NIFTY|ACTIVE",
      "NSE:NIFTY50-INDEX|NIFTY|ACTIVE",
      "NSE:RELIANCE-EQ|RELIANCE|ACTIVE",
      "NSE:RELIANCE26DEC3000CE|RELIANCE|ACTIVE",
      "NSE:RELIANCE26DEC3100PE|RELIANCE|INACTIVE"
    ]);
    expect(fp.report.rowsSeen).toBe(11);
    expect(fp.report.inScopeOptions).toBe(5);
    expect(fp.report.inScopeUnderlyings).toBe(4);
    expect(fp.report.unresolvedUnderlyings).toEqual([]);
    expect(fp.report.duplicateIdentities).toEqual([]);
    expect(fp.report.mappingConflicts).toEqual([]);
  });

  test("Upstox duplicate underlying rows resolve deterministically (first-write-wins), no malformed derivative", () => {
    const rows = clone(upstoxRows) as any[];
    rows.push({
      segment: "NSE_EQ", name: "RELIANCE DUP", exchange: "NSE", isin: "INE002A01018",
      instrument_type: "EQ", instrument_key: "NSE_EQ|INE002A01018-DUP", lot_size: 1,
      freeze_quantity: 100000, exchange_token: "2886", tick_size: 0.05,
      trading_symbol: "RELIANCEDUP", short_name: "RELIANCEDUP"
    });
    rows.push({
      segment: "NSE_FO", name: "RELIANCE", exchange: "NSE", instrument_type: "OPTSTK", option_type: "CE",
      instrument_key: "NSE_FO|REL-CE-DUP", underlying_key: "NSE_EQ|INE002A01018-DUP", underlying_type: "EQ",
      expiry: "2026-12-29T15:00:00+05:30", strike_price: 3100, lot_size: 250, tick_size: 0.05,
      freeze_quantity: 10000, trading_symbol: "RELIANCE26DEC3100CE", exchange_token: "112"
    });

    const result = buildUpstoxImport(rows, IMPORT_OPTS);
    const underlyings = result.batch.instruments.filter((i) => !i.derivative && i.isin === "INE002A01018");
    expect(underlyings.length).toBe(2);
    expect(underlyings[0]!.canonicalId).toBe(underlyings[1]!.canonicalId);
    expect(result.report.duplicateIdentities).toContain(underlyings[0]!.identityKey);

    const options = result.batch.instruments.filter((i) => i.derivative && i.underlyingCanonicalId === underlyings[0]!.canonicalId);
    expect(options.length).toBe(2);
    for (const o of options) expect(o.canonicalSymbol).toBe("RELIANCE"); // first row's symbol, not RELIANCEDUP
    for (const o of result.batch.instruments.filter((i) => i.derivative)) {
      expect(result.batch.instruments.some((u) => !u.derivative && u.canonicalId === o.underlyingCanonicalId)).toBe(true);
      expect(o.derivative!.strike).toBeGreaterThan(0);
      expect(o.derivative!.expiryDate).toBeTruthy();
    }
    expect(result.report.unresolvedUnderlyings).toEqual([]);
  });

  test("Upstox missing underlying mapping is reported and creates no malformed derivative", () => {
    const rows = clone(upstoxRows) as any[];
    rows.find((r) => r.instrument_key === "NSE_FO|REL-CE-1")!.underlying_key = "NSE_EQ|DOES-NOT-EXIST";
    const result = buildUpstoxImport(rows, IMPORT_OPTS);
    expect(result.report.unresolvedUnderlyings).toContain("NSE_EQ|DOES-NOT-EXIST");
    expect(result.batch.mappings.some((m) => m.nativeIdentifier === "NSE_FO|REL-CE-1")).toBe(false);
    for (const o of result.batch.instruments.filter((i) => i.derivative)) {
      expect(result.batch.instruments.some((u) => !u.derivative && u.canonicalId === o.underlyingCanonicalId)).toBe(true);
    }
  });

  test("FYERS duplicate underlying rows resolve deterministically (first-write-wins)", () => {
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

    const result = buildFyersImport(files, IMPORT_OPTS);
    const underlyings = result.batch.instruments.filter((i) => !i.derivative && i.isin === "INE002A01018");
    expect(underlyings.length).toBe(2);
    expect(underlyings[0]!.canonicalId).toBe(underlyings[1]!.canonicalId);
    expect(result.report.duplicateIdentities).toContain(underlyings[0]!.identityKey);

    const options = result.batch.instruments.filter((i) => i.derivative && i.underlyingCanonicalId === underlyings[0]!.canonicalId);
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const o of options) expect(o.canonicalSymbol).toBe("RELIANCE"); // first row's symbol, not RELIANCEDUP
    expect(result.report.unresolvedUnderlyings).toEqual([]);
  });

  test("FYERS missing underFyTok mapping is reported and creates no malformed derivative", () => {
    const files = clone(fyersFiles) as any;
    files.NSE_FO["NSE:RELIANCE26DEC3000CE"].underFyTok = "999999999999999";
    const result = buildFyersImport(files, IMPORT_OPTS);
    expect(result.report.unresolvedUnderlyings).toContain("999999999999999");
    expect(result.batch.mappings.some((m) => m.nativeIdentifier === "NSE:RELIANCE26DEC3000CE")).toBe(false);
    for (const o of result.batch.instruments.filter((i) => i.derivative)) {
      expect(result.batch.instruments.some((u) => !u.derivative && u.canonicalId === o.underlyingCanonicalId)).toBe(true);
    }
  });
});
