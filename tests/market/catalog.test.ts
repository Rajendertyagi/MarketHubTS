import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import { CatalogSyncService, computeIdentityKey, normalizeAliasValue, normalizeScope } from "../../packages/market-core/src/index";
import type { CanonicalInstrument, CatalogSyncBatch, InstrumentAlias } from "../../packages/contracts/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const tempDirs: string[] = [];
const handles: Array<{ close: () => void } | null> = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "markethub-m2-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "test.sqlite");
  const handle = openDatabase({ dbPath, migrate: true });
  handles.push(handle);
  const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
  const sync = new CatalogSyncService(repo);
  return { dir, dbPath, handle, repo, sync };
}

afterEach(() => {
  while (handles.length) {
    const h = handles.pop();
    try { closeDatabaseHandle(h ?? undefined); } catch {}
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) {
      try { removeTempDir(dir); } catch {}
    }
  }
});

function withIdentity<T extends Partial<CanonicalInstrument>>(inst: T): T & { identityKey: string; identityVersion: number } {
  const identityKey = computeIdentityKey({
    exchange: inst.exchange!,
    segment: inst.segment!,
    instrumentCategory: inst.instrumentCategory!,
    canonicalSymbol: inst.canonicalSymbol!,
    isin: inst.isin,
    exchangeSecurityId: inst.exchangeSecurityId,
    stableIdentifier: inst.stableIdentifier,
    ...(inst.derivative
      ? {
          derivative: {
            underlyingCanonicalId: inst.derivative.underlyingCanonicalId,
            expiryDate: inst.derivative.expiryDate,
            strike: inst.derivative.strike,
            optionType: inst.derivative.optionType
          }
        }
      : {})
  });
  return { ...inst, identityKey, identityVersion: inst.identityVersion ?? 1 } as any;
}

function equity(partial: Partial<CanonicalInstrument> & { exchange: "NSE" | "BSE"; segment: string; canonicalSymbol: string; displayName: string; isin?: string; exchangeSecurityId?: string }): CanonicalInstrument {
  const now = new Date().toISOString();
  return withIdentity({
    canonicalId: partial.canonicalId ?? crypto.randomUUID(),
    exchange: partial.exchange,
    segment: partial.segment,
    marketType: "CASH",
    instrumentCategory: "EQUITY",
    canonicalSymbol: partial.canonicalSymbol,
    displayName: partial.displayName,
    isin: partial.isin,
    exchangeSecurityId: partial.exchangeSecurityId,
    tradingStatus: partial.tradingStatus ?? "ACTIVE",
    lifecycleStatus: partial.lifecycleStatus ?? "ACTIVE",
    sourceMeta: partial.sourceMeta,
    provenance: partial.provenance,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    ...partial
  }) as CanonicalInstrument;
}

function indexInst(partial: Partial<CanonicalInstrument> & { exchange: "NSE" | "BSE"; segment: string; canonicalSymbol: string; displayName: string; stableIdentifier?: string; exchangeSecurityId?: string }): CanonicalInstrument {
  const now = new Date().toISOString();
  return withIdentity({
    canonicalId: partial.canonicalId ?? crypto.randomUUID(),
    exchange: partial.exchange,
    segment: partial.segment,
    marketType: "INDEX",
    instrumentCategory: "INDEX",
    canonicalSymbol: partial.canonicalSymbol,
    displayName: partial.displayName,
    stableIdentifier: partial.stableIdentifier,
    exchangeSecurityId: partial.exchangeSecurityId,
    tradingStatus: partial.tradingStatus ?? "ACTIVE",
    lifecycleStatus: partial.lifecycleStatus ?? "ACTIVE",
    cashIndexMembership: partial.cashIndexMembership,
    exchangeDerivativeEligibility: partial.exchangeDerivativeEligibility,
    productScope: partial.productScope,
    sourceMeta: partial.sourceMeta,
    provenance: partial.provenance,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    ...partial
  }) as CanonicalInstrument;
}

function derivative(partial: Partial<CanonicalInstrument> & { exchange: "NSE" | "BSE"; segment: string; instrumentCategory: "STOCK_FUTURE" | "STOCK_OPTION" | "INDEX_FUTURE" | "INDEX_OPTION"; canonicalSymbol: string; displayName: string; underlyingCanonicalId: string; derivative: NonNullable<CanonicalInstrument["derivative"]> }): CanonicalInstrument {
  const now = new Date().toISOString();
  return withIdentity({
    canonicalId: partial.canonicalId ?? crypto.randomUUID(),
    exchange: partial.exchange,
    segment: partial.segment,
    marketType: "DERIVATIVE",
    instrumentCategory: partial.instrumentCategory,
    canonicalSymbol: partial.canonicalSymbol,
    displayName: partial.displayName,
    underlyingCanonicalId: partial.underlyingCanonicalId,
    tradingStatus: partial.tradingStatus ?? "ACTIVE",
    lifecycleStatus: partial.lifecycleStatus ?? "ACTIVE",
    derivative: partial.derivative,
    sourceMeta: partial.sourceMeta,
    provenance: partial.provenance,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    ...partial
  }) as CanonicalInstrument;
}

function aliasOf(a: Partial<InstrumentAlias> & { canonicalId: string; alias: string; aliasType: string; source: string }): InstrumentAlias {
  const exchangeScope = normalizeScope(a.exchangeScope ?? a.exchange);
  const segmentScope = normalizeScope(a.segmentScope ?? a.segment);
  return {
    canonicalId: a.canonicalId,
    alias: a.alias,
    aliasNormalized: a.aliasNormalized ?? normalizeAliasValue(a.alias),
    aliasType: a.aliasType,
    source: a.source,
    exchange: a.exchange,
    segment: a.segment,
    exchangeScope,
    segmentScope,
    status: a.status ?? "ACTIVE",
    provenance: a.provenance,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
  } as InstrumentAlias;
}

describe("M2 corrected catalog foundation", () => {
  test("clean install migration creates expected tables/indexes/constraints", () => {
    const { handle } = setup();
    const tables = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("app_meta");
    expect(names).toContain("canonical_instruments");
    expect(names).toContain("provider_instrument_mappings");
    expect(names).toContain("instrument_aliases");
    expect(names).toContain("catalog_sync_runs");
    const indexes = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as { name: string }[];
    const idx = indexes.map((i) => i.name);
    expect(idx).toContain("canonical_instruments_identity_key_uq");
    expect(idx).toContain("provider_mappings_provider_native_uq");
    expect(idx).toContain("instrument_aliases_uq");
    handle.close();
  });

  test("M1 database upgrades without losing app_meta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markethub-m1-up-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "m1.sqlite");
    const migDir = mkdtempSync(join(tmpdir(), "markethub-migs-"));
    tempDirs.push(migDir);
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(path.join(migDir, "meta"), { recursive: true });
    fs.copyFileSync(resolve("packages/database/drizzle/0000_tan_la_nuit.sql"), path.join(migDir, "0000_tan_la_nuit.sql"));
    fs.writeFileSync(path.join(migDir, "meta/_journal.json"), JSON.stringify({
      version: "7", dialect: "sqlite", entries: [{ idx: 0, version: "6", when: 1794799801089, tag: "0000_tan_la_nuit", breakpoints: true }]
    }, null, 2));
    fs.copyFileSync(resolve("packages/database/drizzle/meta/0000_snapshot.json"), path.join(migDir, "meta/0000_snapshot.json"));

    const h1 = openDatabase({ dbPath, migrate: true, migrationsFolder: migDir });
    h1.sqlite.exec("INSERT INTO app_meta (key, value, updated_at) VALUES ('schema_version','1', 1234567890)");
    h1.close();

    const h2 = openDatabase({ dbPath, migrate: true });
    handles.push(h2);
    const row = h2.sqlite.query("SELECT key, value FROM app_meta WHERE key='schema_version'").get() as any;
    expect(row?.value).toBe("1");
    const tables = h2.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_instruments'").get() as any;
    expect(tables?.name).toBe("canonical_instruments");
    h2.close();
  });

  test("cash-equity symbol/display-name change with same valid ISIN preserves canonical ID", async () => {
    const { sync, repo, handle } = setup();
    const inst = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "OLD", displayName: "Old Name", isin: "INE000A01010" });
    await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [inst], mappings: [], aliases: [] });
    const renamed = equity({ canonicalId: crypto.randomUUID(), exchange: "NSE", segment: "CASH", canonicalSymbol: "NEW", displayName: "New Name", isin: "INE000A01010" });
    const res = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [renamed], mappings: [], aliases: [] });
    expect(res.status).toBe("COMPLETED");
    const all = await repo.listInstruments();
    expect(all.length).toBe(1);
    expect(all[0]!.canonicalId).toBe(inst.canonicalId);
    expect(all[0]!.canonicalSymbol).toBe("NEW");
    expect(all[0]!.displayName).toBe("New Name");
    handle.close();
  });

  test("same ISIN listed on NSE and BSE remains distinct exchange-specific instruments", async () => {
    const { sync, repo, handle } = setup();
    const nse = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "ABC", displayName: "ABC NSE", isin: "INE999A01010" });
    const bse = equity({ exchange: "BSE", segment: "CASH", canonicalSymbol: "ABC", displayName: "ABC BSE", isin: "INE999A01010" });
    const res = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [nse, bse], mappings: [], aliases: [] });
    expect(res.status).toBe("COMPLETED");
    const all = await repo.listInstruments();
    expect(all.length).toBe(2);
    expect(new Set(all.map((i) => i.canonicalId)).size).toBe(2);
    expect(new Set(all.map((i) => i.identityKey)).size).toBe(2);
    handle.close();
  });

  test("same ticker on different exchanges does not collapse", async () => {
    const { sync, repo, handle } = setup();
    const nse = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "XYZ", displayName: "XYZ NSE" });
    const bse = equity({ exchange: "BSE", segment: "CASH", canonicalSymbol: "XYZ", displayName: "XYZ BSE" });
    const res = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [nse, bse], mappings: [], aliases: [] });
    expect(res.status).toBe("COMPLETED");
    expect((await repo.listInstruments()).length).toBe(2);
    handle.close();
  });

  test("index identity does not depend on broker token and separates catalogue/eligibility/scope concepts", async () => {
    const { sync, repo, handle } = setup();
    const idx = indexInst({
      exchange: "NSE", segment: "INDEX", canonicalSymbol: "NIFTY 50", displayName: "NIFTY 50", stableIdentifier: "NIFTY_50",
      cashIndexMembership: { member: true, source: "NSE", asOf: "2026-11-16T00:00:00.000Z" },
      exchangeDerivativeEligibility: [{ eligible: true, exchange: "NSE", product: "INDEX_FO", source: "NSE contract specs", asOf: "2026-11-16T00:00:00.000Z", status: "CURRENT" }],
      productScope: [{ supported: true, scope: "NSE_INDEX_FO_APPROVED", asOf: "2026-11-16T00:00:00.000Z" }]
    });
    const res = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [idx], mappings: [{ provider: "UPSTOX", nativeIdentifier: "NSE_INDEX|Nifty 50", canonicalId: idx.canonicalId, status: "ACTIVE", sourceMeta: { instrument_key: "NSE_INDEX|Nifty 50", exchange_token: "9999" } }], aliases: [] });
    expect(res.status).toBe("COMPLETED");
    const stored = await repo.getInstrumentByCanonicalId(idx.canonicalId);
    expect(stored?.cashIndexMembership?.member).toBe(true);
    expect(stored?.exchangeDerivativeEligibility?.[0]?.eligible).toBe(true);
    expect(stored?.productScope?.[0]?.supported).toBe(true);
    // identity stable regardless of mapping token
    expect(stored?.identityKey).toContain("INDEX");
    expect(stored?.identityKey).not.toContain("9999");
    handle.close();
  });

  test("derivative identities use underlying canonical ID and exact contract fields; distinct for expiry/strike/type/class", async () => {
    const { sync, repo, handle } = setup();
    const und = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "RELIANCE", displayName: "Reliance", isin: "INE002A01018" });
    const idx = indexInst({ exchange: "NSE", segment: "INDEX", canonicalSymbol: "NIFTY 50", displayName: "NIFTY 50", stableIdentifier: "NIFTY_50" });
    const sf1 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "RELIANCE", displayName: "REL FUT 1", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29" } });
    const sf2 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "RELIANCE", displayName: "REL FUT 2", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2027-01-26" } });
    const so1 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_OPTION", canonicalSymbol: "RELIANCE", displayName: "REL 3000 CE", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", strike: 3000, optionType: "CE" } });
    const so2 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_OPTION", canonicalSymbol: "RELIANCE", displayName: "REL 3000 PE", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", strike: 3000, optionType: "PE" } });
    const so3 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_OPTION", canonicalSymbol: "RELIANCE", displayName: "REL 3100 CE", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", strike: 3100, optionType: "CE" } });
    const if1 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "INDEX_FUTURE", canonicalSymbol: "NIFTY", displayName: "NIFTY FUT", underlyingCanonicalId: idx.canonicalId, derivative: { underlyingCanonicalId: idx.canonicalId, expiryDate: "2026-12-29" } });
    const io1 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "INDEX_OPTION", canonicalSymbol: "NIFTY", displayName: "NIFTY 25000 CE", underlyingCanonicalId: idx.canonicalId, derivative: { underlyingCanonicalId: idx.canonicalId, expiryDate: "2026-12-29", strike: 25000, optionType: "CE" } });
    const batch: CatalogSyncBatch = { source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [und, idx, sf1, sf2, so1, so2, so3, if1, io1], mappings: [], aliases: [] };
    const res = await sync.applyBatch(batch);
    expect(res.status).toBe("COMPLETED");
    const all = await repo.listInstruments();
    expect(all.length).toBe(9);
    expect(new Set(all.map((i) => i.identityKey)).size).toBe(9);
    handle.close();
  });

  test("lot/tick/freeze/mapping changes do not change contract identity", async () => {
    const { sync, repo, handle } = setup();
    const und = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "TCS", displayName: "TCS", isin: "INE467B01029" });
    const fut = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "TCS", displayName: "TCS FUT", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", lotSize: 100, tickSize: 0.05, quantityFreeze: 10000 } });
    await sync.applyBatch({ source: "s1", provider: "UPSTOX", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [und, fut], mappings: [{ provider: "UPSTOX", nativeIdentifier: "NSE_FO|1", canonicalId: fut.canonicalId, status: "ACTIVE" }], aliases: [] });
    const updated = derivative({ ...fut, derivative: { ...fut.derivative!, lotSize: 125, tickSize: 0.1, quantityFreeze: 12500 } });
    const res = await sync.applyBatch({ source: "s2", provider: "UPSTOX", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [updated], mappings: [{ provider: "UPSTOX", nativeIdentifier: "NSE_FO|1", canonicalId: fut.canonicalId, status: "ACTIVE", sourceMeta: { changed: true } }], aliases: [] });
    // WP4A: a populated shared derivative field is preserved on disagreement;
    // the provider-reported value is recorded as a WARNING, not last-wins.
    expect(res.status).toBe("COMPLETED");
    expect(res.conflicts.some((c) => c.type === "DERIVATIVE_SHARED_FIELD_CONFLICT" && (c.details as any)?.field === "lotSize")).toBe(true);
    const stored = await repo.getInstrumentByCanonicalId(fut.canonicalId);
    expect(stored?.canonicalId).toBe(fut.canonicalId);
    expect(stored?.identityKey).toBe(fut.identityKey);
    expect(stored?.derivative?.lotSize).toBe(100);
    handle.close();
  });

  test("ambiguous/conflicting identifiers reported, not guessed", async () => {
    const { sync, repo, handle } = setup();
    const a = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "AAA", displayName: "AAA", isin: "INE111A01011" });
    const b = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "BBB", displayName: "BBB", isin: "INE222A01022" });
    await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [a], mappings: [{ provider: "UPSTOX", nativeIdentifier: "K", canonicalId: a.canonicalId, status: "ACTIVE" }], aliases: [] });
    const bad = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [b], mappings: [{ provider: "UPSTOX", nativeIdentifier: "K", canonicalId: b.canonicalId, status: "ACTIVE" }], aliases: [] });
    expect(bad.status).toBe("FAILED");
    expect(bad.conflicts.some((c) => c.type === "AMBIGUOUS_MAPPING")).toBe(true);
    expect((await repo.getMapping("UPSTOX", "K"))?.canonicalId).toBe(a.canonicalId);
    handle.close();
  });

  test("provider mappings independent, cannot silently remap, preserve unstable tokens as metadata", async () => {
    const { sync, repo, handle } = setup();
    const inst = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "INFY", displayName: "Infosys", isin: "INE009A01021" });
    const res = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [inst], mappings: [
      { provider: "UPSTOX", nativeIdentifier: "NSE_EQ|INE009A01021", canonicalId: inst.canonicalId, status: "ACTIVE", nativeExchangeToken: "408065", sourceMeta: { exchange_token: "408065", instrument_key: "NSE_EQ|INE009A01021" } },
      { provider: "FYERS", nativeIdentifier: "NSE:INFY-EQ", canonicalId: inst.canonicalId, status: "ACTIVE", nativeExchangeToken: "101000000015982", sourceMeta: { fyToken: "101000000015982", exToken: "15982" } }
    ], aliases: [] });
    expect(res.status).toBe("COMPLETED");
    const maps = await repo.listMappingsByCanonicalId(inst.canonicalId);
    expect(maps.length).toBe(2);
    expect(maps.find((m) => m.provider === "UPSTOX")?.nativeExchangeToken).toBe("408065");
    expect(maps.find((m) => m.provider === "FYERS")?.nativeExchangeToken).toBe("101000000015982");
    // identity not based on tokens
    expect(inst.identityKey).not.toContain("408065");
    expect(inst.identityKey).not.toContain("15982");
    handle.close();
  });

  test("alias uniqueness with NULL/global context, normalization, ambiguity, and contextual resolution", async () => {
    const { sync, repo, handle } = setup();
    const a = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "ABC", displayName: "ABC NSE", isin: "INE123A01011" });
    const b = equity({ exchange: "BSE", segment: "CASH", canonicalSymbol: "ABC", displayName: "ABC BSE", isin: "INE123A01011" });
    await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [a, b], mappings: [], aliases: [] });

    // duplicate global alias for same instrument/type/source/scope must be constrained (upsert updates, not duplicate row)
    await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [], mappings: [], aliases: [
      aliasOf({ canonicalId: a.canonicalId, alias: "  abc  ", aliasType: "SYMBOL", source: "seed" }),
      aliasOf({ canonicalId: a.canonicalId, alias: "ABC", aliasType: "SYMBOL", source: "seed" })
    ] });
    const aAliases = await repo.listAliasesByCanonicalId(a.canonicalId);
    expect(aAliases.filter((x) => x.aliasType === "SYMBOL" && x.source === "seed").length).toBe(1);
    expect(aAliases[0]!.aliasNormalized).toBe("ABC");

    // same alias can point to multiple instruments (ambiguous) - allowed
    await sync.applyBatch({ source: "s3", scope: { source: "s3" }, completeness: "PARTIAL", instruments: [], mappings: [], aliases: [
      aliasOf({ canonicalId: b.canonicalId, alias: "ABC", aliasType: "SYMBOL", source: "seed" })
    ] });
    const all = await repo.findAlias("abc");
    expect(all.length).toBe(2);

    // contextual resolution includes exact-scope and global aliases, excludes other exact scopes
    await sync.applyBatch({ source: "s4", scope: { source: "s4" }, completeness: "PARTIAL", instruments: [], mappings: [], aliases: [
      aliasOf({ canonicalId: a.canonicalId, alias: "ABC", aliasType: "SYMBOL", source: "ctx", exchange: "NSE", segment: "CASH" }),
      aliasOf({ canonicalId: b.canonicalId, alias: "ABC", aliasType: "SYMBOL", source: "ctx", exchange: "BSE", segment: "CASH" })
    ] });
    const nseMatches = await repo.findAlias("ABC", "NSE", "CASH");
    expect(nseMatches.some((x) => x.canonicalId === a.canonicalId && x.source === "ctx" && x.exchangeScope === "NSE" && x.segmentScope === "CASH")).toBe(true);
    expect(nseMatches.some((x) => x.canonicalId === b.canonicalId && x.source === "ctx" && x.exchangeScope === "BSE")).toBe(false);
    expect(nseMatches.some((x) => x.exchangeScope === "*" && x.segmentScope === "*")).toBe(true);
    handle.close();
  });

  test("valid NSE/BSE derivative records and invalid combinations rejected", async () => {
    const { sync, repo, handle } = setup();
    const nseIdx = indexInst({ exchange: "NSE", segment: "INDEX", canonicalSymbol: "NIFTY 50", displayName: "NIFTY 50", stableIdentifier: "NIFTY_50" });
    const nseEq = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "RELIANCE", displayName: "Reliance", isin: "INE002A01018" });
    const bseIdx = indexInst({ exchange: "BSE", segment: "INDEX", canonicalSymbol: "SENSEX", displayName: "SENSEX", stableIdentifier: "SENSEX" });
    const nif = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "INDEX_FUTURE", canonicalSymbol: "NIFTY", displayName: "NIFTY FUT", underlyingCanonicalId: nseIdx.canonicalId, derivative: { underlyingCanonicalId: nseIdx.canonicalId, expiryDate: "2026-12-29", lotSize: 65, tickSize: 0.05, contractSource: "NSE", contractObservedAt: "2026-11-16T00:00:00.000Z" } });
    const nio = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "INDEX_OPTION", canonicalSymbol: "NIFTY", displayName: "NIFTY 25000 CE", underlyingCanonicalId: nseIdx.canonicalId, derivative: { underlyingCanonicalId: nseIdx.canonicalId, expiryDate: "2026-12-29", strike: 25000, optionType: "CE" } });
    const nsf = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "RELIANCE", displayName: "REL FUT", underlyingCanonicalId: nseEq.canonicalId, derivative: { underlyingCanonicalId: nseEq.canonicalId, expiryDate: "2026-12-29" } });
    const nso = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_OPTION", canonicalSymbol: "RELIANCE", displayName: "REL 3000 PE", underlyingCanonicalId: nseEq.canonicalId, derivative: { underlyingCanonicalId: nseEq.canonicalId, expiryDate: "2026-12-29", strike: 3000, optionType: "PE" } });
    const bsf = derivative({ exchange: "BSE", segment: "FO", instrumentCategory: "INDEX_FUTURE", canonicalSymbol: "SENSEX", displayName: "SENSEX FUT", underlyingCanonicalId: bseIdx.canonicalId, derivative: { underlyingCanonicalId: bseIdx.canonicalId, expiryDate: "2026-12-31" } });
    const bso = derivative({ exchange: "BSE", segment: "FO", instrumentCategory: "INDEX_OPTION", canonicalSymbol: "SENSEX", displayName: "SENSEX 80000 CE", underlyingCanonicalId: bseIdx.canonicalId, derivative: { underlyingCanonicalId: bseIdx.canonicalId, expiryDate: "2026-12-31", strike: 80000, optionType: "CE" } });
    const ok = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [nseIdx, nseEq, bseIdx, nif, nio, nsf, nso, bsf, bso], mappings: [], aliases: [] });
    expect(ok.status).toBe("COMPLETED");
    expect((await repo.listInstruments()).length).toBe(9);

    // invalid: future with strike/optionType, option missing strike/type, cash with derivative
    const now = new Date().toISOString();
    const badFuture: any = {
      canonicalId: crypto.randomUUID(), identityKey: "bad-fut", identityVersion: 1,
      exchange: "NSE", segment: "FO", marketType: "DERIVATIVE", instrumentCategory: "STOCK_FUTURE",
      canonicalSymbol: "X", displayName: "X", underlyingCanonicalId: nseEq.canonicalId,
      tradingStatus: "ACTIVE", lifecycleStatus: "ACTIVE", createdAt: now, updatedAt: now,
      derivative: { underlyingCanonicalId: nseEq.canonicalId, expiryDate: "2026-12-29", strike: 1, optionType: "CE" }
    };
    const badOption: any = {
      canonicalId: crypto.randomUUID(), identityKey: "bad-opt", identityVersion: 1,
      exchange: "NSE", segment: "FO", marketType: "DERIVATIVE", instrumentCategory: "STOCK_OPTION",
      canonicalSymbol: "Y", displayName: "Y", underlyingCanonicalId: nseEq.canonicalId,
      tradingStatus: "ACTIVE", lifecycleStatus: "ACTIVE", createdAt: now, updatedAt: now,
      derivative: { underlyingCanonicalId: nseEq.canonicalId, expiryDate: "2026-12-29" }
    };
    const badCash: any = {
      ...equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "Z", displayName: "Z", isin: "INE000Z01010" }),
      derivative: { underlyingCanonicalId: nseEq.canonicalId, expiryDate: "2026-12-29" }
    };
    for (const inst of [badFuture, badOption, badCash]) {
      const res = await sync.applyBatch({ source: "bad", scope: { source: "bad" }, completeness: "PARTIAL", instruments: [inst], mappings: [], aliases: [] });
      expect(res.status).toBe("FAILED");
    }
    handle.close();
  });

  test("cash-index catalogue membership does not imply F&O eligibility; product scope separate", async () => {
    const { sync, repo, handle } = setup();
    const idx = indexInst({
      exchange: "NSE", segment: "INDEX", canonicalSymbol: "NIFTY MIDCAP 150", displayName: "NIFTY MIDCAP 150", stableIdentifier: "NIFTY_MIDCAP_150",
      cashIndexMembership: { member: true, source: "NSE indices", asOf: "2026-11-16T00:00:00.000Z" },
      exchangeDerivativeEligibility: [{ eligible: false, exchange: "NSE", product: "INDEX_FO", source: "NSE contract specs", asOf: "2026-11-16T00:00:00.000Z", status: "NOT_ELIGIBLE" }],
      productScope: [{ supported: false, scope: "NSE_INDEX_FO_APPROVED", reason: "Not in approved index F&O scope", asOf: "2026-11-16T00:00:00.000Z" }]
    });
    await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [idx], mappings: [], aliases: [] });
    const stored = await repo.getInstrumentByCanonicalId(idx.canonicalId);
    expect(stored?.cashIndexMembership?.member).toBe(true);
    expect(stored?.exchangeDerivativeEligibility?.[0]?.eligible).toBe(false);
    expect(stored?.productScope?.[0]?.supported).toBe(false);
    handle.close();
  });

  test("sync safety: invalid/conflicting/partial batches preserve integrity and source isolation", async () => {
    const { sync, repo, handle } = setup();
    const a = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "KEEP", displayName: "Keep", isin: "INE333A01013" });
    const b = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "NEW", displayName: "New", isin: "INE444A01014" });
    await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [a], mappings: [
      { provider: "UPSTOX", nativeIdentifier: "U1", canonicalId: a.canonicalId, status: "ACTIVE" },
      { provider: "FYERS", nativeIdentifier: "F1", canonicalId: a.canonicalId, status: "ACTIVE" }
    ], aliases: [] });

    // invalid batch no partial writes
    const bad: any = { source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [{ canonicalId: "x", identityKey: "x", identityVersion: 1, exchange: "NSE", segment: "CASH", marketType: "CASH", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "X", displayName: "X" }], mappings: [], aliases: [] };
    expect((await sync.applyBatch(bad)).status).toBe("FAILED");
    expect((await repo.listInstruments()).length).toBe(1);

    // partial batch does not remove absent instruments or other source mappings
    const res = await sync.applyBatch({ source: "s2", provider: "UPSTOX", scope: { source: "s2", provider: "UPSTOX" }, completeness: "PARTIAL", instruments: [b], mappings: [{ provider: "UPSTOX", nativeIdentifier: "U2", canonicalId: b.canonicalId, status: "ACTIVE" }], aliases: [] });
    expect(res.status).toBe("COMPLETED");
    const all = await repo.listInstruments();
    expect(all.some((i) => i.canonicalId === a.canonicalId)).toBe(true);
    expect(all.some((i) => i.canonicalId === b.canonicalId)).toBe(true);
    expect((await repo.listMappingsByCanonicalId(a.canonicalId)).some((m) => m.provider === "FYERS" && m.nativeIdentifier === "F1")).toBe(true);

    // conflicting mapping preserves previous valid mapping
    const c = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "C", displayName: "C", isin: "INE555A01015" });
    const conflict = await sync.applyBatch({ source: "s3", scope: { source: "s3" }, completeness: "PARTIAL", instruments: [c], mappings: [{ provider: "UPSTOX", nativeIdentifier: "U1", canonicalId: c.canonicalId, status: "ACTIVE" }], aliases: [] });
    expect(conflict.status).toBe("FAILED");
    expect((await repo.getMapping("UPSTOX", "U1"))?.canonicalId).toBe(a.canonicalId);
    handle.close();
  });

  test("explicit lifecycle change only from authoritative batch input; sync run metadata recorded", async () => {
    const { sync, repo, handle } = setup();
    const und = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "X", displayName: "X", isin: "INE777A01017" });
    const fut = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "X", displayName: "X FUT", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-01-27", contractLifecycleStatus: "ACTIVE" } });
    await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [und, fut], mappings: [], aliases: [] });
    const expired = derivative({ ...fut, lifecycleStatus: "EXPIRED", tradingStatus: "INACTIVE", derivative: { ...fut.derivative!, contractLifecycleStatus: "EXPIRED" } });
    const res = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [expired], mappings: [], aliases: [] });
    expect(res.status).toBe("COMPLETED");
    const stored = await repo.getInstrumentByCanonicalId(fut.canonicalId);
    expect(stored?.lifecycleStatus).toBe("EXPIRED");
    expect(stored?.derivative?.contractLifecycleStatus).toBe("EXPIRED");
    const run = await repo.getSyncRun(res.runId);
    expect(run?.status).toBe("COMPLETED");
    expect(run?.source).toBe("s2");
    handle.close();
  });

  test("duplicate canonical identities in batch rejected safely", async () => {
    const { sync, repo, handle } = setup();
    const i1 = equity({ canonicalId: "id-1", exchange: "NSE", segment: "CASH", canonicalSymbol: "DUP", displayName: "Dup 1", isin: "INE888A01018" });
    const i2 = equity({ canonicalId: "id-2", exchange: "NSE", segment: "CASH", canonicalSymbol: "DUP2", displayName: "Dup 2", isin: "INE888A01018" });
    const res = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [i1, i2], mappings: [], aliases: [] });
    expect(res.status).toBe("FAILED");
    expect(res.conflicts.some((c) => c.type === "DUPLICATE_IDENTITY_IN_BATCH")).toBe(true);
    expect((await repo.listInstruments()).length).toBe(0);
    handle.close();
  });

  test("identifier enrichment: symbol-only to ISIN preserves canonical ID and records history", async () => {
    const { sync, repo, handle } = setup();
    const symOnly = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "ENRICHCO", displayName: "Enrich Co" });
    const r1 = await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [symOnly], mappings: [], aliases: [], identifiers: [] });
    expect(r1.status).toBe("COMPLETED");
    const before = await repo.getInstrumentByCanonicalId(symOnly.canonicalId);
    expect(before?.isin).toBeUndefined();

    const withIsin = equity({ canonicalId: crypto.randomUUID(), exchange: "NSE", segment: "CASH", canonicalSymbol: "ENRICHCO", displayName: "Enrich Co Ltd", isin: "INEENRICH0101" });
    const r2 = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [withIsin], mappings: [], aliases: [], identifiers: [] });
    expect(r2.status).toBe("COMPLETED");
    const all = await repo.listInstruments();
    expect(all.length).toBe(1);
    expect(all[0]!.canonicalId).toBe(symOnly.canonicalId);
    expect(all[0]!.isin).toBe("INEENRICH0101");
    expect(all[0]!.displayName).toBe("Enrich Co Ltd");

    const ids = await repo.listIdentifiersByCanonicalId(symOnly.canonicalId);
    expect(ids.some((i) => i.identifierType === "ISIN" && i.identifierNormalized === "INEENRICH0101" && i.status === "CURRENT")).toBe(true);
    expect(ids.some((i) => i.identifierType === "SYMBOL" && i.identifierNormalized === "ENRICHCO" && (i.status === "HISTORICAL" || i.status === "CURRENT" || i.status === "SUPERSEDED"))).toBe(true);
    // historical lookup by old symbol identifier remains resolvable
    const symHist = await repo.findIdentifiers({ identifierType: "SYMBOL", identifierNamespace: "NSE", identifierNormalized: "ENRICHCO", exchangeScope: "NSE", segmentScope: "CASH" });
    expect(symHist.some((i) => i.canonicalId === symOnly.canonicalId)).toBe(true);
    handle.close();
  });

  test("identifier enrichment: ambiguous identifier collisions are reported", async () => {
    const { sync, repo, handle } = setup();
    const a = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "DUPSYM", displayName: "A" });
    const b = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "DUPSYM", displayName: "B", exchangeSecurityId: "SEC-B" });
    // create two different instruments sharing same symbol in history context is tricky; create separately with different identity bases
    await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [a], mappings: [], aliases: [], identifiers: [] });
    // second instrument with same symbol but different stable basis (exchangeSecurityId) so distinct identity
    await sync.applyBatch({ source: "s1b", scope: { source: "s1b" }, completeness: "PARTIAL", instruments: [b], mappings: [], aliases: [], identifiers: [] });
    expect((await repo.listInstruments()).length).toBe(2);

    const enrich = equity({ canonicalId: crypto.randomUUID(), exchange: "NSE", segment: "CASH", canonicalSymbol: "DUPSYM", displayName: "Ambiguous", isin: "INEAMBIG0101" });
    const res = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [enrich], mappings: [], aliases: [], identifiers: [] });
    expect(res.status).toBe("FAILED");
    expect(res.conflicts.some((c) => c.type === "AMBIGUOUS_ENRICHMENT" || c.type === "IDENTIFIER_CONFLICT" || c.type === "AMBIGUOUS_IDENTITY")).toBe(true);
    // no merge happened
    expect((await repo.listInstruments()).length).toBe(2);
    handle.close();
  });

  test("derivative contracts: structured storage, exact strike normalization, unique identity, and lookups", async () => {
    const { sync, repo, handle } = setup();
    const und = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "UND", displayName: "Underlying", isin: "INEUND00001" });
    const opt1 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_OPTION", canonicalSymbol: "UND", displayName: "UND 25000.50 CE", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", strike: "25000.500", optionType: "CE", lotSize: 100, tickSize: 0.05, quantityFreeze: 5000 } as any });
    const opt2 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_OPTION", canonicalSymbol: "UND", displayName: "UND 25000.5 CE dup", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", strike: 25000.5, optionType: "CE" } as any });
    const fut = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "UND", displayName: "UND FUT", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", lotSize: 100 } });

    const r1 = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [und, opt1, fut], mappings: [], aliases: [], identifiers: [] });
    expect(r1.status).toBe("COMPLETED");

    const c1 = await repo.getDerivativeContract(opt1.canonicalId);
    expect(c1).not.toBeNull();
    expect(c1!.underlyingCanonicalId).toBe(und.canonicalId);
    expect(c1!.derivativeClass).toBe("STOCK_OPTION");
    expect(c1!.expiryDate).toBe("2026-12-29");
    expect(c1!.strikeNormalized).toBe("25000.5");
    expect(c1!.optionType).toBe("CE");
    expect(c1!.lotSize).toBe(100);
    expect(c1!.tickSize).toBe("0.05");
    expect(c1!.quantityFreeze).toBe(5000);

    const cf = await repo.getDerivativeContract(fut.canonicalId);
    expect(cf?.strikeNormalized == null).toBe(true);
    expect(cf?.optionType == null).toBe(true);

    // lookups by underlying/expiry
    const byUnd = await repo.findDerivativeContracts({ underlyingCanonicalId: und.canonicalId });
    expect(byUnd.length).toBe(2);
    const byExp = await repo.findDerivativeContracts({ underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29" });
    expect(byExp.length).toBe(2);
    const byClass = await repo.findDerivativeContracts({ underlyingCanonicalId: und.canonicalId, derivativeClass: "STOCK_OPTION" });
    expect(byClass.length).toBe(1);

    // duplicate contract identity (same contract fields, different canonical id) rejected by unique constraint/identity handling
    const dup = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [opt2], mappings: [], aliases: [], identifiers: [] });
    expect(dup.status === "FAILED" || (await repo.findDerivativeContracts({ underlyingCanonicalId: und.canonicalId, derivativeClass: "STOCK_OPTION" })).length === 1).toBe(true);

    // relational table exists and has expected columns/indexes
    const tables = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='derivative_contracts'").get() as any;
    expect(tables?.name).toBe("derivative_contracts");
    const idx = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name='derivative_contracts_identity_uq'").get() as any;
    expect(idx?.name).toBe("derivative_contracts_identity_uq");
    handle.close();
  });

  test("fresh migration and M1-to-current migration include identifier history and derivative contracts", async () => {
    const { handle } = setup();
    const tables = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("instrument_identifier_history");
    expect(names).toContain("derivative_contracts");
    handle.close();

    // M1 -> current
    const dir = mkdtempSync(join(tmpdir(), "markethub-m1-cur-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "m1.sqlite");
    const migDir = mkdtempSync(join(tmpdir(), "markethub-migs-cur-"));
    tempDirs.push(migDir);
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(path.join(migDir, "meta"), { recursive: true });
    fs.copyFileSync(resolve("packages/database/drizzle/0000_tan_la_nuit.sql"), path.join(migDir, "0000_tan_la_nuit.sql"));
    fs.writeFileSync(path.join(migDir, "meta/_journal.json"), JSON.stringify({
      version: "7", dialect: "sqlite", entries: [{ idx: 0, version: "6", when: 1794799801089, tag: "0000_tan_la_nuit", breakpoints: true }]
    }, null, 2));
    fs.copyFileSync(resolve("packages/database/drizzle/meta/0000_snapshot.json"), path.join(migDir, "meta/0000_snapshot.json"));

    const h1 = openDatabase({ dbPath, migrate: true, migrationsFolder: migDir });
    h1.sqlite.exec("INSERT INTO app_meta (key, value, updated_at) VALUES ('schema_version','1', 1234567890)");
    h1.close();

    const h2 = openDatabase({ dbPath, migrate: true });
    handles.push(h2);
    const row = h2.sqlite.query("SELECT key, value FROM app_meta WHERE key='schema_version'").get() as any;
    expect(row?.value).toBe("1");
    const t2 = h2.sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const n2 = t2.map((x) => x.name);
    expect(n2).toContain("instrument_identifier_history");
    expect(n2).toContain("derivative_contracts");
    h2.close();
  });




  test("symbol reuse: previously used symbol belonging to different security later is not auto-enriched", async () => {
    const { sync, repo, handle } = setup();
    // Security A initially uses symbol REUSE
    const a = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "REUSE", displayName: "Security A", isin: "INEAAAA01010" });
    const r1 = await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [a], mappings: [], aliases: [], identifiers: [] });
    expect(r1.status).toBe("COMPLETED");

    // Symbol REUSE becomes historical for A (e.g. renamed) and is later used by different security B (symbol-only)
    const aRenamed = equity({ ...a, canonicalSymbol: "ANEW", displayName: "Security A Renamed", isin: "INEAAAA01010" });
    const r2 = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [aRenamed], mappings: [], aliases: [], identifiers: [
      { canonicalId: a.canonicalId, identifierType: "SYMBOL", identifierNamespace: "NSE", identifierValue: "REUSE", identifierNormalized: "REUSE", exchange: "NSE", segment: "CASH", exchangeScope: "NSE", segmentScope: "CASH", source: "s2", status: "HISTORICAL", validTo: new Date().toISOString() }
    ] });
    expect(r2.status).toBe("COMPLETED");

    // Later, different security B arrives with same symbol REUSE (no ISIN yet) - must be distinct, not enriched into A
    const b = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "REUSE", displayName: "Security B" });
    const r3 = await sync.applyBatch({ source: "s3", scope: { source: "s3" }, completeness: "PARTIAL", instruments: [b], mappings: [], aliases: [], identifiers: [] });
    expect(r3.status).toBe("COMPLETED");
    const all = await repo.listInstruments();
    expect(all.length).toBe(2);
    const secA = all.find((i) => i.canonicalId === a.canonicalId)!;
    const secB = all.find((i) => i.canonicalId !== a.canonicalId)!;
    expect(secA.isin).toBe("INEAAAA01010");
    expect(secB.isin).toBeUndefined();
    expect(secB.canonicalSymbol).toBe("REUSE");

    // If B later gets an ISIN, enrichment must not use A's historical symbol to merge into A
    const bWithIsin = equity({ ...b, canonicalId: secB.canonicalId, isin: "INEBBBB01010", displayName: "Security B Ltd" });
    const r4 = await sync.applyBatch({ source: "s4", scope: { source: "s4" }, completeness: "PARTIAL", instruments: [bWithIsin], mappings: [], aliases: [], identifiers: [] });
    expect(r4.status).toBe("COMPLETED");
    const all2 = await repo.listInstruments();
    expect(all2.length).toBe(2);
    expect(all2.find((i) => i.canonicalId === a.canonicalId)?.isin).toBe("INEAAAA01010");
    expect(all2.find((i) => i.canonicalId === secB.canonicalId)?.isin).toBe("INEBBBB01010");
    handle.close();
  });

  test("authoritative current identifiers cannot identify two canonical instruments; aliases can remain ambiguous", async () => {
    const { sync, repo, handle } = setup();
    const a = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "A1", displayName: "A1", isin: "INEAUTH01010" });
    const b = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "B1", displayName: "B1", isin: "INEAUTH01010" });
    // same ISIN in same exchange/segment context => distinct identity keys? equity identity uses ISIN basis but also exchange/segment in key; same exchange/segment+ISIN means same identity key -> duplicate identity conflict, not two current owners
    const res = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [a, b], mappings: [], aliases: [], identifiers: [] });
    expect(res.status).toBe("FAILED");
    expect((await repo.listInstruments()).length).toBe(0);

    // but aliases can be ambiguous across instruments
    const x = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "X1", displayName: "X1", isin: "INEXXX01010" });
    const y = equity({ exchange: "BSE", segment: "CASH", canonicalSymbol: "Y1", displayName: "Y1", isin: "INEYYY01010" });
    await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "COMPLETE", instruments: [x, y], mappings: [], aliases: [
      { canonicalId: x.canonicalId, alias: "COMMON", aliasNormalized: "COMMON", aliasType: "SEARCH", source: "s2", exchangeScope: "*", segmentScope: "*", status: "ACTIVE" },
      { canonicalId: y.canonicalId, alias: "COMMON", aliasNormalized: "COMMON", aliasType: "SEARCH", source: "s2", exchangeScope: "*", segmentScope: "*", status: "ACTIVE" }
    ], identifiers: [] });
    const found = await repo.findAlias("COMMON");
    expect(found.length).toBe(2);
    handle.close();
  });

  test("exact strike normalization for string inputs and stable identity", async () => {
    const { sync, repo, handle } = setup();
    const und = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "STRK", displayName: "Strike Co", isin: "INESTRK01010" });
    const optStr = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_OPTION", canonicalSymbol: "STRK", displayName: "STRK 12345.6700 CE", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", strike: "12345.6700", optionType: "CE" } as any });
    const optStr2 = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_OPTION", canonicalSymbol: "STRK", displayName: "STRK 12345.67 CE", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29", strike: "12345.67", optionType: "CE" } as any });
    const r1 = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [und, optStr], mappings: [], aliases: [], identifiers: [] });
    expect(r1.status).toBe("COMPLETED");
    const c = await repo.getDerivativeContract(optStr.canonicalId);
    expect(c?.strikeNormalized).toBe("12345.67");
    // same normalized strike string means same contract identity (no duplicate created)
    const r2 = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [optStr2], mappings: [], aliases: [], identifiers: [] });
    expect((await repo.findDerivativeContracts({ underlyingCanonicalId: und.canonicalId, derivativeClass: "STOCK_OPTION" })).length).toBe(1);
    expect(r2.status === "COMPLETED" || r2.status === "FAILED").toBe(true);
    handle.close();
  });

  test("mappings/aliases/explicit identifiers resolve incoming canonical IDs to existing/enriched canonical IDs", async () => {
    const { sync, repo, handle } = setup();
    // existing instrument (symbol-only) will be enriched by ISIN in same batch context? create existing first
    const existing = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "MAPCO", displayName: "Map Co" });
    const r1 = await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [existing], mappings: [], aliases: [], identifiers: [] });
    expect(r1.status).toBe("COMPLETED");

    // incoming instrument has different canonicalId but enriches existing by ISIN; mapping/alias/identifier refer to incoming canonicalId
    const incomingDifferentId = equity({ canonicalId: crypto.randomUUID(), exchange: "NSE", segment: "CASH", canonicalSymbol: "MAPCO", displayName: "Map Co Ltd", isin: "INEMAPCO0101" });
    expect(incomingDifferentId.canonicalId).not.toBe(existing.canonicalId);
    const r2 = await sync.applyBatch({
      source: "s2",
      scope: { source: "s2" },
      completeness: "PARTIAL",
      instruments: [incomingDifferentId],
      mappings: [{ provider: "UPSTOX", nativeIdentifier: "NSE_EQ|MAPCO", canonicalId: incomingDifferentId.canonicalId, status: "ACTIVE" }],
      aliases: [aliasOf({ canonicalId: incomingDifferentId.canonicalId, alias: "Map Company", aliasType: "DISPLAY_NAME", source: "s2" })],
      identifiers: [{ canonicalId: incomingDifferentId.canonicalId, identifierType: "EXCHANGE_SECURITY_ID", identifierNamespace: "NSE", identifierValue: "MAPSEC", identifierNormalized: "MAPSEC", exchange: "NSE", segment: "CASH", exchangeScope: "NSE", segmentScope: "CASH", source: "s2", status: "CURRENT" }]
    });
    expect(r2.status).toBe("COMPLETED");
    const all = await repo.listInstruments();
    expect(all.length).toBe(1);
    expect(all[0]!.canonicalId).toBe(existing.canonicalId);
    expect(all[0]!.isin).toBe("INEMAPCO0101");
    expect((await repo.getMapping("UPSTOX", "NSE_EQ|MAPCO"))?.canonicalId).toBe(existing.canonicalId);
    const aliases = await repo.listAliasesByCanonicalId(existing.canonicalId);
    expect(aliases.some((a) => a.aliasNormalized === "MAP COMPANY")).toBe(true);
    const ids = await repo.listIdentifiersByCanonicalId(existing.canonicalId);
    expect(ids.some((i) => i.identifierType === "EXCHANGE_SECURITY_ID" && i.identifierNormalized === "MAPSEC" && i.status === "CURRENT")).toBe(true);
    handle.close();
  });

  test("alias lookup includes global scope alongside exact exchange/segment and excludes inactive aliases", async () => {
    const { sync, repo, handle } = setup();
    const a = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "AL1", displayName: "Alias One", isin: "INEALIAS0101" });
    const b = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "AL2", displayName: "Alias Two", isin: "INEALIAS0102" });
    await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [a, b], mappings: [], aliases: [
      aliasOf({ canonicalId: a.canonicalId, alias: "  Common  Name  ", aliasType: "SEARCH", source: "s", exchange: "NSE", segment: "CASH" }),
      aliasOf({ canonicalId: b.canonicalId, alias: "Common Name", aliasType: "SEARCH", source: "s" }), // global
      aliasOf({ canonicalId: b.canonicalId, alias: "Common Name", aliasType: "OTHER", source: "s", exchange: "NSE", segment: "CASH", status: "INACTIVE" })
    ], identifiers: [] });
    const found = await repo.findAlias("common name", "NSE", "CASH");
    expect(found.length).toBe(2);
    expect(found.some((x) => x.canonicalId === a.canonicalId && x.exchangeScope === "NSE")).toBe(true);
    expect(found.some((x) => x.canonicalId === b.canonicalId && x.exchangeScope === "*")).toBe(true);
    expect(found.some((x) => x.status !== "ACTIVE")).toBe(false);
    handle.close();
  });

  test("separate cash-index membership, exchange eligibility and product scope are preserved in batch parsing and SQLite round-trip", async () => {
    const { sync, repo, handle } = setup();
    const idx = indexInst({
      exchange: "NSE", segment: "INDEX", canonicalSymbol: "NIFTY TEST", displayName: "NIFTY TEST", stableIdentifier: "NIFTY_TEST",
      cashIndexMembership: { member: true, source: "NSE", asOf: "2026-11-16T00:00:00.000Z", notes: "cash" },
      exchangeDerivativeEligibility: [{ eligible: true, exchange: "NSE", product: "INDEX_FO", source: "NSE", asOf: "2026-11-16T00:00:00.000Z", status: "CURRENT" }],
      productScope: [{ supported: false, scope: "TEST_SCOPE", reason: "not enabled", asOf: "2026-11-16T00:00:00.000Z" }]
    });
    const batch = { source: "s", scope: { source: "s" }, completeness: "COMPLETE" as const, instruments: [idx], mappings: [], aliases: [], identifiers: [] };
    const parsed = (await import("../../packages/contracts/src/index")).catalogSyncBatchSchema.parse(batch);
    expect(parsed.instruments[0]!.cashIndexMembership?.member).toBe(true);
    expect(parsed.instruments[0]!.exchangeDerivativeEligibility?.[0]?.eligible).toBe(true);
    expect(parsed.instruments[0]!.productScope?.[0]?.supported).toBe(false);
    const res = await sync.applyBatch(parsed as any);
    expect(res.status).toBe("COMPLETED");
    const stored = await repo.getInstrumentByCanonicalId(idx.canonicalId);
    expect(stored?.cashIndexMembership).toEqual(idx.cashIndexMembership);
    expect(stored?.exchangeDerivativeEligibility).toEqual(idx.exchangeDerivativeEligibility);
    expect(stored?.productScope).toEqual(idx.productScope);
    handle.close();
  });

  test("order-independent sync: derivative listed before its new underlying succeeds", async () => {
    const { sync, repo, handle } = setup();
    const und = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "ORDUND", displayName: "Order Underlying", isin: "INEORDUND0101" });
    const idx = indexInst({ exchange: "NSE", segment: "INDEX", canonicalSymbol: "ORDIDX", displayName: "Order Index", stableIdentifier: "ORDIDX" });
    const fut = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "ORDUND", displayName: "ORDUND FUT", underlyingCanonicalId: und.canonicalId, derivative: { underlyingCanonicalId: und.canonicalId, expiryDate: "2026-12-29" } });
    const opt = derivative({ exchange: "NSE", segment: "FO", instrumentCategory: "INDEX_OPTION", canonicalSymbol: "ORDIDX", displayName: "ORDIDX 100 CE", underlyingCanonicalId: idx.canonicalId, derivative: { underlyingCanonicalId: idx.canonicalId, expiryDate: "2026-12-29", strike: 100, optionType: "CE" } });

    // derivative contracts deliberately BEFORE their new underlyings in the input array
    const res = await sync.applyBatch({ source: "s", scope: { source: "s" }, completeness: "COMPLETE", instruments: [fut, opt, und, idx], mappings: [], aliases: [], identifiers: [] });
    expect(res.status).toBe("COMPLETED");
    expect(res.conflicts.length).toBe(0);
    const all = await repo.listInstruments();
    expect(all.length).toBe(4);
    expect((await repo.getDerivativeContract(fut.canonicalId))?.underlyingCanonicalId).toBe(und.canonicalId);
    expect((await repo.getDerivativeContract(opt.canonicalId))?.underlyingCanonicalId).toBe(idx.canonicalId);
    handle.close();
  });

  test("concurrent catalog syncs are serialized on shared connection and a failed transaction does not roll back another", async () => {
    const { sync, repo, handle } = setup();
    const a = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "CONA", displayName: "Concurrent A", isin: "INECONA01010" });
    const b = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "CONB", displayName: "Concurrent B", isin: "INECONB01010" });
    const bad: any = { source: "bad", scope: { source: "bad" }, completeness: "PARTIAL", instruments: [{ canonicalId: "x", identityKey: "x", identityVersion: 1, exchange: "NSE", segment: "CASH", marketType: "CASH", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "X", displayName: "X" }], mappings: [], aliases: [], identifiers: [] };

    const [r1, r2, r3] = await Promise.all([
      sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [a], mappings: [], aliases: [], identifiers: [] }),
      sync.applyBatch(bad),
      sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "COMPLETE", instruments: [b], mappings: [], aliases: [], identifiers: [] })
    ]);
    expect(r1.status).toBe("COMPLETED");
    expect(r2.status).toBe("FAILED");
    expect(r3.status).toBe("COMPLETED");
    const all = await repo.listInstruments();
    expect(all.some((i) => i.canonicalId === a.canonicalId)).toBe(true);
    expect(all.some((i) => i.canonicalId === b.canonicalId)).toBe(true);
    expect(all.length).toBe(2);
    handle.close();
  });

  test("derivative underlying incoming canonical ID is remapped to enriched existing canonical ID", async () => {
    const { sync, repo, handle } = setup();
    // 1. symbol-only equity with canonical ID A
    const A = "underlying-A";
    const existing = equity({ canonicalId: A, exchange: "NSE", segment: "CASH", canonicalSymbol: "UNDREM", displayName: "Underlying Remap" });
    const r1 = await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [existing], mappings: [], aliases: [], identifiers: [] });
    expect(r1.status).toBe("COMPLETED");

    // 2. same equity with ISIN and a different incoming canonical ID B (enriches to A),
    //    plus a new derivative referencing B as underlying (deliberately listed first)
    const B = "underlying-B-incoming";
    const withIsin = equity({ canonicalId: B, exchange: "NSE", segment: "CASH", canonicalSymbol: "UNDREM", displayName: "Underlying Remap Ltd", isin: "INEUNDREM0101" });
    const derivId = "derivative-remap";
    const fut = derivative({
      canonicalId: derivId,
      exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE",
      canonicalSymbol: "UNDREM", displayName: "UNDREM FUT",
      underlyingCanonicalId: B,
      derivative: { underlyingCanonicalId: B, expiryDate: "2026-12-29" }
    });
    const r2 = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [fut, withIsin], mappings: [], aliases: [], identifiers: [] });
    expect(r2.status).toBe("COMPLETED");
    expect(r2.conflicts.length).toBe(0);

    const all = await repo.listInstruments();
    expect(all.length).toBe(2);
    expect(all.some((i) => i.canonicalId === B)).toBe(false);
    const storedFut = await repo.getInstrumentByCanonicalId(derivId);
    expect(storedFut?.underlyingCanonicalId).toBe(A);
    expect(storedFut?.derivative?.underlyingCanonicalId).toBe(A);
    expect(storedFut?.identityKey).toContain(normalizeAliasValue(A));
    expect(storedFut?.identityKey).not.toContain(normalizeAliasValue(B));
    const contract = await repo.getDerivativeContract(derivId);
    expect(contract?.underlyingCanonicalId).toBe(A);
    handle.close();
  });

  test("post-remap collision: converging derivative identities fail with DUPLICATE_IDENTITY_IN_BATCH and roll back atomically", async () => {
    const { sync, repo, handle } = setup();
    // existing symbol-only underlying A
    const A = "collide-A";
    const a = equity({ canonicalId: A, exchange: "NSE", segment: "CASH", canonicalSymbol: "COLLIDE", displayName: "Collide Underlying" });
    expect((await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [a], mappings: [], aliases: [], identifiers: [] })).status).toBe("COMPLETED");

    // two distinct incoming cash IDs B1/B2 both enrich to A; two derivatives referencing B1/B2
    // converge onto the same final derivative identity after remapping
    const B1 = "collide-B1", B2 = "collide-B2", D1 = "collide-D1", D2 = "collide-D2";
    const b1 = equity({ canonicalId: B1, exchange: "NSE", segment: "CASH", canonicalSymbol: "COLLIDE", displayName: "B1", isin: "INEB1X01010" });
    const b2 = equity({ canonicalId: B2, exchange: "NSE", segment: "CASH", canonicalSymbol: "COLLIDE", displayName: "B2", isin: "INEB2Y01010" });
    const d1 = derivative({ canonicalId: D1, exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "COLLIDE", displayName: "D1", underlyingCanonicalId: B1, derivative: { underlyingCanonicalId: B1, expiryDate: "2026-12-29" } });
    const d2 = derivative({ canonicalId: D2, exchange: "NSE", segment: "FO", instrumentCategory: "STOCK_FUTURE", canonicalSymbol: "COLLIDE", displayName: "D2", underlyingCanonicalId: B2, derivative: { underlyingCanonicalId: B2, expiryDate: "2026-12-29" } });

    const res = await sync.applyBatch({
      source: "s2", scope: { source: "s2" }, completeness: "PARTIAL",
      instruments: [d1, d2, b1, b2],
      mappings: [{ provider: "UPSTOX", nativeIdentifier: "COLLIDE-MAP", canonicalId: D1, status: "ACTIVE" }],
      aliases: [aliasOf({ canonicalId: D1, alias: "COLLIDE ALIAS", aliasType: "SEARCH", source: "s2" })],
      identifiers: [{ canonicalId: D1, identifierType: "EXCHANGE_SECURITY_ID", identifierNamespace: "NSE", identifierValue: "COLLIDESEC", identifierNormalized: "COLLIDESEC", exchange: "NSE", segment: "FO", exchangeScope: "NSE", segmentScope: "FO", source: "s2", status: "CURRENT" }]
    });
    expect(res.status).toBe("FAILED");
    expect(res.conflicts.some((c) => c.type === "DUPLICATE_IDENTITY_IN_BATCH" && c.severity === "ERROR")).toBe(true);

    // atomic rollback: only the pre-existing A remains; no mappings/aliases/identifiers/contracts from failed batch
    expect((await repo.listInstruments()).length).toBe(1);
    expect((await repo.listInstruments())[0]!.canonicalId).toBe(A);
    expect(await repo.getMapping("UPSTOX", "COLLIDE-MAP")).toBeNull();
    expect((await repo.findAlias("COLLIDE ALIAS")).length).toBe(0);
    expect((await repo.findIdentifiers({ identifierNormalized: "INEB1X01010" })).length).toBe(0);
    expect((await repo.findIdentifiers({ identifierNormalized: "INEB2Y01010" })).length).toBe(0);
    expect(await repo.getDerivativeContract(D1)).toBeNull();
    expect(await repo.getDerivativeContract(D2)).toBeNull();
    handle.close();
  });

  test("explicit identifier normalization is recomputed from identifierValue", async () => {
    const { sync, repo, handle } = setup();
    const inst = equity({ exchange: "NSE", segment: "CASH", canonicalSymbol: "NORM", displayName: "Norm", isin: "INENORM0101" });
    expect((await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [inst], mappings: [], aliases: [], identifiers: [] })).status).toBe("COMPLETED");

    // caller supplies a wrong pre-normalized value; it must be ignored in favour of the original value
    const res = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [], mappings: [], aliases: [], identifiers: [
      { canonicalId: inst.canonicalId, identifierType: "EXCHANGE_SECURITY_ID", identifierNamespace: "NSE", identifierValue: "sec999", identifierNormalized: "WRONGVALUE", exchange: "NSE", segment: "CASH", exchangeScope: "NSE", segmentScope: "CASH", source: "s2", status: "CURRENT" }
    ] });
    expect(res.status).toBe("COMPLETED");
    const byValue = await repo.findIdentifiers({ identifierNormalized: "SEC999" });
    expect(byValue.some((i) => i.identifierValue === "sec999" && i.identifierNormalized === "SEC999")).toBe(true);
    expect((await repo.findIdentifiers({ identifierNormalized: "WRONGVALUE" })).length).toBe(0);
    handle.close();
  });

  test("post-remap collision: multiple incoming cash records resolving to one canonical ID fail atomically", async () => {
    const { sync, repo, handle } = setup();
    const A = "cashconv-A";
    const a = equity({ canonicalId: A, exchange: "NSE", segment: "CASH", canonicalSymbol: "CASHCONV", displayName: "Cash Conv" });
    expect((await sync.applyBatch({ source: "s1", scope: { source: "s1" }, completeness: "COMPLETE", instruments: [a], mappings: [], aliases: [], identifiers: [] })).status).toBe("COMPLETED");

    const b1 = equity({ canonicalId: "cashconv-B1", exchange: "NSE", segment: "CASH", canonicalSymbol: "CASHCONV", displayName: "B1", isin: "INEC1X01010" });
    const b2 = equity({ canonicalId: "cashconv-B2", exchange: "NSE", segment: "CASH", canonicalSymbol: "CASHCONV", displayName: "B2", isin: "INEC2Y01010" });
    const res = await sync.applyBatch({ source: "s2", scope: { source: "s2" }, completeness: "PARTIAL", instruments: [b1, b2], mappings: [], aliases: [], identifiers: [] });
    expect(res.status).toBe("FAILED");
    expect(res.conflicts.some((c) => c.type === "DUPLICATE_IDENTITY_IN_BATCH" && c.severity === "ERROR")).toBe(true);
    const all = await repo.listInstruments();
    expect(all.length).toBe(1);
    expect(all[0]!.canonicalId).toBe(A);
    expect(all[0]!.isin).toBeUndefined();
    handle.close();
  });
});
