import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import {
  CatalogSyncService, buildUpstoxImport, buildFyersImport, dryRunUpstoxMaster, dryRunFyersMaster,
  parseIndiaExpiry, serializeProviderCoverageScope, UPSTOX_COVERAGE, FYERS_COVERAGE
} from "../../packages/market-core/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const NOW = "2026-11-24T06:00:00.000Z";
const OPTS = { now: NOW, sourceVersion: "fixture-v1", sourceObservedAt: NOW };

describe("WP4A provider master parsers", () => {
  test("Upstox BOD fixture: in-scope stock/index options and required underlyings only", () => {
    const { batch, reconciliation, report } = buildUpstoxImport(upstoxRows, OPTS);
    expect(report.rowsSeen).toBe(upstoxRows.length);
    expect(report.inScopeUnderlyings).toBe(4); // NSE EQ/INDEX + BSE EQ/INDEX
    expect(report.inScopeOptions).toBe(4); // NSE CE/PE + BSE CE/PE
    expect(report.skippedOutOfScope).toBe(3); // FUTSTK, currency, commodity
    expect(report.unresolvedUnderlyings).toEqual([]);
    expect(batch.completeness).toBe("COMPLETE");
    expect(batch.provider).toBe("UPSTOX");

    const ce = batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
    expect(ce.instrumentCategory).toBe("STOCK_OPTION");
    expect(ce.derivative?.expiryDate).toBe("2026-12-29");
    expect(ce.derivative?.strike).toBe(3000);
    expect(ce.derivative?.lotSize).toBe(250);
    expect(ce.derivative?.tickSize).toBe(0.05);
    expect(ce.derivative?.quantityFreeze).toBe(10000);

    const pe = batch.instruments.find((i) => i.derivative?.optionType === "PE")!;
    expect(pe.instrumentCategory).toBe("INDEX_OPTION");
    expect(pe.derivative?.expiryDate).toBe("2026-12-29");

    const ceMap = batch.mappings.find((m) => m.nativeIdentifier === "NSE_FO|REL-CE-1")!;
    expect(ceMap.nativeIdentifier).toBe("NSE_FO|REL-CE-1");
    expect(ceMap.segment).toBe("NSE_FO");
    expect(ceMap.status).toBe("ACTIVE");
    expect(reconciliation.activeNativeIdentifiers.has("NSE_FO|REL-CE-1")).toBe(true);
    expect(reconciliation.activeNativeIdentifiers.has("NSE_FO|REL-FUT-1")).toBe(false);

    // BSE scopes are represented with the correct exchange, provider segment and category.
    const bseStock = batch.instruments.find((i) => i.canonicalSymbol === "TCS" && i.derivative?.optionType === "CE")!;
    expect(bseStock.exchange).toBe("BSE");
    expect(bseStock.instrumentCategory).toBe("STOCK_OPTION");
    expect(bseStock.derivative?.expiryDate).toBe("2026-12-29");
    const bseIndex = batch.instruments.find((i) => i.canonicalSymbol === "SENSEX" && i.derivative?.optionType === "PE")!;
    expect(bseIndex.exchange).toBe("BSE");
    expect(bseIndex.instrumentCategory).toBe("INDEX_OPTION");
    const bseStockMap = batch.mappings.find((m) => m.nativeIdentifier === "BSE_FO|TCS-CE-1")!;
    expect(bseStockMap).toMatchObject({ provider: "UPSTOX", exchange: "BSE", segment: "BSE_FO", status: "ACTIVE" });
    const bseUnderlyingMap = batch.mappings.find((m) => m.nativeIdentifier === "BSE_EQ|INE467B01029")!;
    expect(bseUnderlyingMap).toMatchObject({ exchange: "BSE", segment: "BSE_EQ", status: "ACTIVE" });
    expect(reconciliation.activeNativeIdentifiers.has("BSE_FO|TCS-CE-1")).toBe(true);
    expect(reconciliation.coverage.some((t) => t.exchange === "BSE" && t.segment === "BSE_FO")).toBe(true);
  });

  test("FYERS fixture: symTicker native ID, fyToken metadata, epoch-seconds expiry, inactive status", () => {
    const { batch, reconciliation, report } = buildFyersImport(fyersFiles, OPTS);
    expect(report.inScopeUnderlyings).toBe(4); // NSE + BSE referenced underlyings only
    expect(report.inScopeOptions).toBe(5); // NSE CE/PE + inactive PE + BSE CE/PE
    expect(report.skippedOutOfScope).toBeGreaterThan(0); // unused CM row + FO future

    const ce = batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
    expect(ce.instrumentCategory).toBe("STOCK_OPTION");
    expect(ce.derivative?.expiryDate).toBe("2026-12-29");
    expect(ce.derivative?.lotSize).toBe(250);
    expect(ce.derivative?.quantityFreeze).toBe(10000);

    const ceMap = batch.mappings.find((m) => m.nativeIdentifier === "NSE:RELIANCE26DEC3000CE")!;
    expect(ceMap.nativeIdentifier).toBe("NSE:RELIANCE26DEC3000CE"); // option-chain symbol, not fyToken
    expect(ceMap.nativeIdentifier).not.toContain("1011270223158568");
    expect(ceMap.sourceMeta?.fyToken).toBe("1011270223158568");
    expect(ceMap.sourceMeta?.underFyTok).toBe("101000000015982");
    expect(ceMap.status).toBe("ACTIVE");

    const inactive = batch.mappings.find((m) => m.nativeIdentifier === "NSE:RELIANCE26DEC3100PE")!;
    expect(inactive.status).toBe("INACTIVE");
    expect(reconciliation.activeNativeIdentifiers.has("NSE:RELIANCE26DEC3100PE")).toBe(false);
    expect(reconciliation.activeNativeIdentifiers.has("NSE:RELIANCE26DEC3000CE")).toBe(true);

    // BSE CM/FO scopes parse with the correct exchange, segment and category.
    const bseStock = batch.instruments.find((i) => i.canonicalSymbol === "TCS" && i.derivative?.optionType === "CE")!;
    expect(bseStock.exchange).toBe("BSE");
    expect(bseStock.instrumentCategory).toBe("STOCK_OPTION");
    const bseIndex = batch.instruments.find((i) => i.canonicalSymbol === "SENSEX" && i.derivative?.optionType === "PE")!;
    expect(bseIndex.exchange).toBe("BSE");
    expect(bseIndex.instrumentCategory).toBe("INDEX_OPTION");
    const bseMap = batch.mappings.find((m) => m.nativeIdentifier === "BSE:TCS26DEC4000CE")!;
    expect(bseMap).toMatchObject({ provider: "FYERS", exchange: "BSE", segment: "BSE_FO", status: "ACTIVE" });
    expect(bseMap.nativeIdentifier).not.toContain("1011270223158600"); // symTicker, not fyToken
    expect(bseMap.sourceMeta?.fyToken).toBe("1011270223158600");
    expect(reconciliation.activeNativeIdentifiers.has("BSE:TCS26DEC4000CE")).toBe(true);
    expect(reconciliation.coverage.some((t) => t.exchange === "BSE" && t.segment === "BSE_CM")).toBe(true);
  });

  test("FYERS unresolved underFyTok is reported and never guessed from underSym", () => {
    const broken = {
      NSE_FO: {
        "NSE:XYZ26DEC100CE": {
          fyToken: "1", exToken: 1, exSymbol: "XYZ", symTicker: "NSE:XYZ26DEC100CE",
          exchangeName: "NSE", optType: "CE", underSym: "RELIANCE", underFyTok: "missing-token",
          expiryDate: "1798539000", strikePrice: 100, minLotSize: 1, tickSize: 0.05,
          qtyFreeze: "100", tradeStatus: 1, lastUpdate: "2026-11-23"
        }
      }
    };
    const { batch, report } = buildFyersImport(broken, OPTS);
    expect(report.unresolvedUnderlyings).toContain("missing-token");
    expect(batch.instruments.length).toBe(0);
    expect(batch.mappings.length).toBe(0);
  });

  test("India expiry conversion: seconds vs milliseconds, IST rollover, invalid inputs", () => {
    // Real FYERS sample: 1798539000 seconds -> 2026-12-29 IST (10:10 UTC).
    expect(parseIndiaExpiry("1798539000")).toEqual({ ok: true, date: "2026-12-29", epochMs: 1798539000000 });
    expect(parseIndiaExpiry(1798539000000)).toEqual({ ok: true, date: "2026-12-29", epochMs: 1798539000000 });
    // 18:30 UTC on 2026-12-29 is 00:00 IST on 2026-12-30 (date rollover).
    expect(parseIndiaExpiry("2026-12-29T18:30:00Z").ok).toBe(true);
    expect(parseIndiaExpiry("2026-12-29T18:30:00Z")).toMatchObject({ ok: true, date: "2026-12-30" });
    expect(parseIndiaExpiry("2026-12-29T23:59:00+05:30")).toMatchObject({ ok: true, date: "2026-12-29" });
    expect(parseIndiaExpiry("2026-12-29")).toMatchObject({ ok: true, date: "2026-12-29" });
    for (const bad of [0, -1, "0", "-5", "not-a-date", "2026-02-30", "", null, {}, Number.NaN, 1e17]) {
      expect(parseIndiaExpiry(bad).ok).toBe(false);
    }
  });

  test("deterministic scope serializer: stable key order, coverage only, no source metadata", () => {
    const a = serializeProviderCoverageScope(UPSTOX_COVERAGE);
    const b = serializeProviderCoverageScope([...UPSTOX_COVERAGE].reverse());
    expect(a).toBe(b);
    expect(a).toContain('"version":1');
    expect(a).toContain('"exchange":"NSE"');
    expect(a).not.toContain("UPSTOX");
    expect(a).not.toContain("sourceVersion");
    expect(a).not.toContain("syncedAt");
    expect(serializeProviderCoverageScope(FYERS_COVERAGE)).not.toBe(a);
  });

  test("dry-run reports counts and issues without DB writes", () => {
    const up = dryRunUpstoxMaster(upstoxRows, OPTS);
    const fy = dryRunFyersMaster(fyersFiles, OPTS);
    expect(up.inScopeOptions).toBe(4);
    expect(fy.inScopeOptions).toBe(5);
    expect(up.unresolvedUnderlyings).toEqual([]);
    expect(fy.duplicateIdentities).toEqual([]);
    expect(fy.mappingConflicts).toEqual([]);
  });

  test("cross-provider convergence: same stock option -> one canonical ID, two mappings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wp4a-conv-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    try {
      const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      const sync = new CatalogSyncService(repo);
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const fy = buildFyersImport(fyersFiles, OPTS);
      expect((await sync.applyBatch(up.batch)).status).toBe("COMPLETED");
      expect((await sync.applyBatch(fy.batch)).status).toBe("COMPLETED");

      const upOpt = up.batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
      const fyOpt = fy.batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
      expect(upOpt.identityKey).toBe(fyOpt.identityKey);
      expect(upOpt.canonicalId).toBe(fyOpt.canonicalId);

      const maps = await repo.listMappingsByCanonicalId(upOpt.canonicalId);
      expect(maps.map((m) => m.provider).sort()).toEqual(["FYERS", "UPSTOX"]);
      expect(maps.find((m) => m.provider === "UPSTOX")?.nativeIdentifier).toBe("NSE_FO|REL-CE-1");
      expect(maps.find((m) => m.provider === "FYERS")?.nativeIdentifier).toBe("NSE:RELIANCE26DEC3000CE");
      expect((await repo.listInstruments()).length).toBeLessThan(up.batch.instruments.length + fy.batch.instruments.length);
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });
});
