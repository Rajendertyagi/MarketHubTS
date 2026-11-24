import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import {
  CatalogSyncService, buildUpstoxImport, buildFyersImport, DERIVATIVE_SHARED_FIELD_CONFLICT,
  DERIVATIVE_ATTRIBUTES_META_KEY, serializeProviderCoverageScope, analyzeSharedDerivativeFields,
  SHARED_DERIVATIVE_FIELDS
} from "../../packages/market-core/src/index";
import type { CatalogRepository, CatalogRepositoryTx, CatalogSyncBatch } from "../../packages/market-core/src/index";
import type { DerivativeSpec } from "../../packages/contracts/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const NOW = "2026-11-24T06:00:00.000Z";
const OPTS = { now: NOW, sourceVersion: "fixture-v1", sourceObservedAt: NOW };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wp4a-recon-"));
  const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
  const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
  const sync = new CatalogSyncService(repo);
  return { dir, handle, repo, sync };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fyersWithLotSize(lotSize: number) {
  return fyersWithField("lotSize", lotSize);
}

/** Mutate the raw FYERS option row that drives a given shared derivative field. */
function fyersWithField(field: string, value: unknown) {
  const files = clone(fyersFiles) as any;
  const row = files.NSE_FO["NSE:RELIANCE26DEC3000CE"];
  if (field === "lotSize") row.minLotSize = value;
  else if (field === "tickSize") row.tickSize = value;
  else if (field === "quantityFreeze") row.qtyFreeze = String(value);
  else if (field === "contractObservedAt") row.lastUpdate = value; // YYYY-MM-DD
  // contractSource is provider-owned (FYERS_SYMBOL_MASTER); no raw field to mutate.
  return files;
}

describe("WP4A shared-field conflicts and status", () => {
  test("disagreeing shared field preserves canonical value, warns deterministically, annotates only importing provider", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const fy = buildFyersImport(fyersWithLotSize(260), OPTS);
      expect((await sync.applyBatch(up.batch)).status).toBe("COMPLETED");
      const result = await sync.applyBatch(fy.batch);

      expect(result.status).toBe("COMPLETED"); // warning-only is not PARTIAL
      const warnings = result.conflicts.filter((c) => c.type === DERIVATIVE_SHARED_FIELD_CONFLICT);
      const lotWarning = warnings.find((c) => (c.details as any)?.field === "lotSize")!;
      expect(lotWarning).toBeDefined();
      expect(lotWarning.severity).toBe("WARNING");
      expect(lotWarning.provider).toBe("FYERS");
      expect(lotWarning.nativeIdentifier).toBe("NSE:RELIANCE26DEC3000CE");
      expect((lotWarning.details as any).canonicalValue).toBe(250);
      expect((lotWarning.details as any).providerValue).toBe(260);
      expect(JSON.stringify(lotWarning)).not.toContain(NOW);

      const upOpt = up.batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
      const stored = await repo.getInstrumentByCanonicalId(upOpt.canonicalId);
      expect(stored?.derivative?.lotSize).toBe(250); // canonical preserved

      const fyMap = await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE");
      expect((fyMap?.sourceMeta?.[DERIVATIVE_ATTRIBUTES_META_KEY] as any).lotSize).toBe(260);
      const upMap = await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1");
      // The FYERS import annotates only its own mapping; UPSTOX keeps its own value.
      expect((upMap?.sourceMeta?.[DERIVATIVE_ATTRIBUTES_META_KEY] as any).lotSize).toBe(250);

      const run = await repo.getSyncRun(result.runId);
      expect(run?.status).toBe("COMPLETED"); // persisted status site
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("unchanged re-import emits no repeat warning; changed value emits one new warning", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      await sync.applyBatch(up.batch);
      const first = await sync.applyBatch(buildFyersImport(fyersWithLotSize(260), OPTS).batch);
      const second = await sync.applyBatch(buildFyersImport(fyersWithLotSize(260), OPTS).batch);
      const third = await sync.applyBatch(buildFyersImport(fyersWithLotSize(270), OPTS).batch);

      const lotWarnings = (r: typeof first) => r.conflicts.filter(
        (c) => c.type === DERIVATIVE_SHARED_FIELD_CONFLICT && (c.details as any)?.field === "lotSize"
      );
      expect(lotWarnings(first).length).toBe(1);
      expect(lotWarnings(second).length).toBe(0);
      expect(lotWarnings(third).length).toBe(1);
      expect((lotWarnings(third)[0]!.details as any).providerValue).toBe(270);
      expect((await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE"))?.sourceMeta?.[DERIVATIVE_ATTRIBUTES_META_KEY]).toMatchObject({ lotSize: 270 });
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("provider import never sets, clears or infers contractLifecycleStatus", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const target = up.batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
      const underlying = up.batch.instruments.find((i) => i.canonicalId === target.underlyingCanonicalId)!;
      const authoritative: CatalogSyncBatch = {
        source: "authoritative", scope: { source: "authoritative" }, completeness: "COMPLETE",
        instruments: [underlying, { ...target, derivative: { ...target.derivative!, contractLifecycleStatus: "ACTIVE" } }],
        mappings: [{ provider: "UPSTOX", nativeIdentifier: "NSE_FO|REL-CE-1", canonicalId: target.canonicalId, status: "ACTIVE" }],
        aliases: [], identifiers: []
      };
      expect((await sync.applyBatch(authoritative)).status).toBe("COMPLETED");
      const result = await sync.applyBatch(up.batch); // provider derivative omits lifecycle
      expect(result.status).toBe("COMPLETED");
      expect(result.conflicts.some((c) => (c.details as any)?.field === "contractLifecycleStatus")).toBe(false);
      expect((await repo.getInstrumentByCanonicalId(target.canonicalId))?.derivative?.contractLifecycleStatus).toBe("ACTIVE");
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("ERROR conflict still rolls back and returns FAILED", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const bad: CatalogSyncBatch = {
        source: "bad", scope: { source: "bad" }, completeness: "COMPLETE",
        instruments: [
          { canonicalId: "a", identityKey: "dup", identityVersion: 1, exchange: "NSE", segment: "CASH", marketType: "CASH", instrumentCategory: "EQUITY", canonicalSymbol: "DUP", displayName: "A", isin: "INEDUP01010", tradingStatus: "ACTIVE", lifecycleStatus: "ACTIVE" },
          { canonicalId: "b", identityKey: "dup", identityVersion: 1, exchange: "NSE", segment: "CASH", marketType: "CASH", instrumentCategory: "EQUITY", canonicalSymbol: "DUP", displayName: "B", isin: "INEDUP01010", tradingStatus: "ACTIVE", lifecycleStatus: "ACTIVE" }
        ],
        mappings: [], aliases: [], identifiers: []
      };
      const result = await sync.applyBatch(bad);
      expect(result.status).toBe("FAILED");
      expect(result.conflicts.some((c) => c.severity === "ERROR")).toBe(true);
      expect((await repo.listInstruments()).length).toBe(0);
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });
});

describe("WP4A shared-field coverage (all plan-enumerated fields)", () => {
  const cases = [
    { field: "lotSize", raw: 260, providerValue: 260, canonicalValue: 250 },
    { field: "tickSize", raw: 0.1, providerValue: 0.1, canonicalValue: 0.05 },
    { field: "quantityFreeze", raw: 12000, providerValue: 12000, canonicalValue: 10000 },
    { field: "contractSource", raw: undefined, providerValue: "FYERS_SYMBOL_MASTER", canonicalValue: "UPSTOX_BOD_MASTER" },
    { field: "contractObservedAt", raw: "2026-11-22", providerValue: "2026-11-22T00:00:00.000Z", canonicalValue: "2026-11-24T06:00:00.000Z" }
  ] as const;

  for (const c of cases) {
    test(`${c.field}: canonical preserved, deterministic WARNING, provider-only sourceMeta, no repeat`, async () => {
      const { dir, handle, repo, sync } = setup();
      try {
        const up = buildUpstoxImport(upstoxRows, OPTS);
        const fy = buildFyersImport(fyersWithField(c.field, c.raw), OPTS);
        expect((await sync.applyBatch(up.batch)).status).toBe("COMPLETED");

        const first = await sync.applyBatch(fy.batch);
        const warnings = first.conflicts.filter(
          (x) => x.type === DERIVATIVE_SHARED_FIELD_CONFLICT &&
            (x.details as any)?.field === c.field &&
            x.nativeIdentifier === "NSE:RELIANCE26DEC3000CE"
        );
        expect(warnings.length).toBe(1);
        const warning = warnings[0]!;
        expect(warning.severity).toBe("WARNING");
        expect(warning.provider).toBe("FYERS");
        expect(warning.nativeIdentifier).toBe("NSE:RELIANCE26DEC3000CE");
        expect((warning.details as any).canonicalValue).toBe(c.canonicalValue);
        expect((warning.details as any).providerValue).toBe(c.providerValue);
        expect((warning.details as any).source).toBe("FYERS_SYMBOL_MASTER");
        expect(warning.message).toBe(`Shared derivative field ${c.field} differs from canonical value`);

        const target = up.batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
        expect((await repo.getInstrumentByCanonicalId(target.canonicalId))?.derivative?.[c.field]).toBe(c.canonicalValue);

        const fyMap = await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE");
        expect((fyMap?.sourceMeta?.[DERIVATIVE_ATTRIBUTES_META_KEY] as any)[c.field]).toBe(c.providerValue);
        const upMap = await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1");
        expect((upMap?.sourceMeta?.[DERIVATIVE_ATTRIBUTES_META_KEY] as any)[c.field]).toBe(c.canonicalValue);

        const second = await sync.applyBatch(fy.batch);
        expect(second.conflicts.filter(
          (x) => x.type === DERIVATIVE_SHARED_FIELD_CONFLICT &&
            (x.details as any)?.field === c.field &&
            x.nativeIdentifier === "NSE:RELIANCE26DEC3000CE"
        ).length).toBe(0);
        expect(second.status).toBe("COMPLETED");
        expect((await repo.getSyncRun(second.runId))?.status).toBe("COMPLETED");
      } finally {
        closeDatabaseHandle(handle);
        removeTempDir(dir);
      }
    });
  }
});

describe("WP4A shared-field omission: incoming provider omits a populated canonical field", () => {
  const existingDerivative: DerivativeSpec = {
    underlyingCanonicalId: "cat:underlying",
    expiryDate: "2026-12-29",
    strike: 3000,
    optionType: "CE",
    lotSize: 250,
    tickSize: 0.05,
    quantityFreeze: 10000,
    contractSource: "UPSTOX_BOD_MASTER",
    contractObservedAt: "2026-11-24T06:00:00.000Z",
    contractLifecycleStatus: "ACTIVE"
  };
  const baseIncoming: DerivativeSpec = {
    underlyingCanonicalId: "cat:underlying",
    expiryDate: "2026-12-29",
    strike: 3000,
    optionType: "CE"
  };

  for (const field of SHARED_DERIVATIVE_FIELDS) {
    test(`${field}: canonical value preserved, no warning, no false provider value`, () => {
      const incoming = { ...baseIncoming } as Record<string, unknown>;
      delete incoming[field];
      const analysis = analyzeSharedDerivativeFields({
        existing: existingDerivative,
        incoming: incoming as DerivativeSpec,
        lastRecorded: undefined,
        provider: "FYERS",
        nativeIdentifier: "NSE:OMIT-TEST",
        canonicalId: "cat:test",
        source: "FYERS_SYMBOL_MASTER",
        preserveLifecycle: true
      });

      expect((analysis.canonicalDerivative as Record<string, unknown>)[field]).toBe(
        (existingDerivative as Record<string, unknown>)[field]
      );
      expect(analysis.warnings).toEqual([]);
      expect(analysis.derivativeAttributes[field]).toBeUndefined();
      // Lifecycle remains canonical-owned even when the incoming row omits it.
      expect(analysis.canonicalDerivative.contractLifecycleStatus).toBe("ACTIVE");
    });
  }

  test("end-to-end: FYERS omits lotSize after Upstox set it; canonical value survives with no warning", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      expect((await sync.applyBatch(up.batch)).status).toBe("COMPLETED");
      const target = up.batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
      expect((await repo.getInstrumentByCanonicalId(target.canonicalId))?.derivative?.lotSize).toBe(250);

      const files = clone(fyersFiles) as any;
      delete files.NSE_FO["NSE:RELIANCE26DEC3000CE"].minLotSize; // provider omits lotSize
      const fy = buildFyersImport(files, OPTS);
      const fyOpt = fy.batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
      expect(fyOpt.derivative?.lotSize).toBeUndefined(); // importer did not invent a value

      const result = await sync.applyBatch(fy.batch);
      expect(result.status).toBe("COMPLETED");
      expect(result.conflicts.filter(
        (c) => c.type === DERIVATIVE_SHARED_FIELD_CONFLICT && (c.details as any)?.field === "lotSize"
      )).toEqual([]);
      expect((await repo.getInstrumentByCanonicalId(target.canonicalId))?.derivative?.lotSize).toBe(250);
      const fyMap = await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE");
      expect((fyMap?.sourceMeta?.[DERIVATIVE_ATTRIBUTES_META_KEY] as any)?.lotSize).toBeUndefined();
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });
});

describe("WP4A complete-snapshot reconciliation", () => {
  test("only absent ACTIVE mappings in exact coverage become REMOVED; provenance merged", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const fy = buildFyersImport(fyersFiles, OPTS);
      await sync.applyBatch(fy.batch); // other provider must stay untouched
      const active = new Set(up.reconciliation.activeNativeIdentifiers);
      active.delete("NSE_FO|REL-CE-1"); // one in-scope option disappears from the snapshot

      const result = await sync.applyCompleteProviderSnapshot(up.batch, {
        ...up.reconciliation, activeNativeIdentifiers: active
      });
      expect(result.status).toBe("COMPLETED");
      expect(await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1")).toMatchObject({ status: "REMOVED", validTo: NOW });
      expect((await repo.getMapping("UPSTOX", "NSE_FO|NIFTY-PE-1"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE"))?.status).toBe("ACTIVE");

      const removed = (await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))!;
      expect(removed.provenance).toMatchObject({ sourceVersion: "fixture-v1", sourceObservedAt: NOW, syncedAt: NOW });
      expect((removed.sourceMeta as any).reconciliation).toMatchObject({ syncedAt: NOW, sourceVersion: "fixture-v1" });

      const run = await repo.getSyncRun(result.runId);
      expect(run?.scopeJson).toBe(serializeProviderCoverageScope(up.reconciliation.coverage));
      expect(run?.status).toBe("COMPLETED");
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("explicit INACTIVE, other scopes and ambiguous scope are untouched; canonical rows retained", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const batch = clone(up.batch) as CatalogSyncBatch;
      const target = batch.instruments.find((i) => i.canonicalSymbol === "RELIANCE" && i.derivative?.optionType === "CE")!;
      // Explicit inactive row in a covered scope.
      batch.mappings.push({
        provider: "UPSTOX", nativeIdentifier: "NSE_FO|EXPLICIT-INACTIVE", canonicalId: target.canonicalId,
        exchange: "NSE", segment: "NSE_FO", status: "INACTIVE"
      });
      // Out-of-scope mapping (currency segment) and ambiguous-scope mapping (no exchange/segment).
      batch.mappings.push({
        provider: "UPSTOX", nativeIdentifier: "NSE_CD|OUT-OF-SCOPE", canonicalId: target.canonicalId,
        exchange: "NSE", segment: "NSE_CD", status: "ACTIVE"
      });
      batch.mappings.push({
        provider: "UPSTOX", nativeIdentifier: "AMBIGUOUS-SCOPE", canonicalId: target.canonicalId, status: "ACTIVE"
      });
      const active = new Set(up.reconciliation.activeNativeIdentifiers);
      active.delete("NSE_FO|REL-CE-1");

      await sync.applyCompleteProviderSnapshot(batch, { ...up.reconciliation, activeNativeIdentifiers: active });
      expect((await repo.getMapping("UPSTOX", "NSE_FO|EXPLICIT-INACTIVE"))?.status).toBe("INACTIVE");
      expect((await repo.getMapping("UPSTOX", "NSE_CD|OUT-OF-SCOPE"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("UPSTOX", "AMBIGUOUS-SCOPE"))?.status).toBe("ACTIVE");
      expect((await repo.getInstrumentByCanonicalId(target.canonicalId))).not.toBeNull();
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("NSE FO-only coverage cannot remove BSE FO or NSE/BSE CM mappings; other provider untouched", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const fy = buildFyersImport(fyersFiles, OPTS);
      await sync.applyBatch(fy.batch); // seed FYERS NSE + BSE mappings
      await sync.applyBatch(up.batch); // seed UPSTOX NSE + BSE mappings

      // Declare only the NSE FO option tuple; every BSE and CM tuple is omitted.
      const nseOnlyCoverage = [{
        exchange: "NSE" as const,
        segment: "NSE_FO",
        instrumentCategories: ["STOCK_OPTION" as const, "INDEX_OPTION" as const]
      }];
      const result = await sync.applyCompleteProviderSnapshot(up.batch, {
        ...up.reconciliation,
        coverage: nseOnlyCoverage,
        activeNativeIdentifiers: new Set<string>() // would remove every in-declared-tuple mapping
      });
      expect(result.status).toBe("COMPLETED");

      // In-declared-tuple NSE FO mappings become REMOVED.
      expect((await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))?.status).toBe("REMOVED");
      expect((await repo.getMapping("UPSTOX", "NSE_FO|NIFTY-PE-1"))?.status).toBe("REMOVED");

      // BSE FO and all CM/underlying mappings are outside the declared tuples.
      expect((await repo.getMapping("UPSTOX", "BSE_FO|TCS-CE-1"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("UPSTOX", "BSE_FO|SENSEX-PE-1"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("UPSTOX", "NSE_EQ|INE002A01018"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("UPSTOX", "NSE_INDEX|Nifty 50"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("UPSTOX", "BSE_EQ|INE467B01029"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("UPSTOX", "BSE_INDEX|SENSEX"))?.status).toBe("ACTIVE");

      // The other provider is never affected, in either exchange.
      expect((await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("FYERS", "BSE:TCS26DEC4000CE"))?.status).toBe("ACTIVE");

      // Canonical rows are retained.
      expect((await repo.listInstruments()).length).toBeGreaterThan(0);
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("reconciliation runs only for COMPLETE matching-provider snapshots", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const active = new Set<string>(); // would remove everything if reconciliation ran
      const partial = clone(up.batch) as CatalogSyncBatch;
      partial.completeness = "PARTIAL";
      await sync.applyCompleteProviderSnapshot(partial, { ...up.reconciliation, activeNativeIdentifiers: active });
      expect((await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))?.status).toBe("ACTIVE");

      const incremental = clone(up.batch) as CatalogSyncBatch;
      incremental.completeness = "INCREMENTAL";
      await sync.applyCompleteProviderSnapshot(incremental, { ...up.reconciliation, activeNativeIdentifiers: active });
      expect((await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))?.status).toBe("ACTIVE");

      await sync.applyCompleteProviderSnapshot(up.batch, { ...up.reconciliation, provider: "FYERS", activeNativeIdentifiers: active });
      expect((await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))?.status).toBe("ACTIVE");
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("reconciliation failure rolls back the entire import transaction", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const failingRepo = Object.create(repo) as CatalogRepository;
      failingRepo.transaction = (fn) => repo.transaction((tx) => {
        const wrapped = new Proxy(tx, {
          get(target, prop) {
            if (prop === "reconcileProviderMappings") return async () => { throw new Error("reconcile boom"); };
            const value = (target as any)[prop];
            return typeof value === "function" ? value.bind(target) : value;
          }
        }) as CatalogRepositoryTx;
        return fn(wrapped);
      });
      const failingSync = new CatalogSyncService(failingRepo);
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const result = await failingSync.applyCompleteProviderSnapshot(up.batch, up.reconciliation);
      expect(result.status).toBe("FAILED");
      expect((await repo.listInstruments()).length).toBe(0);
      expect(await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1")).toBeNull();
      expect((await repo.listSyncRuns({ provider: "UPSTOX" })).some((r) => r.status === "COMPLETED")).toBe(false);
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("uses the shared tx-aware helper, not applyBatch called unchanged inside another transaction", async () => {
    const { dir, handle, repo } = setup();
    try {
      class SpySync extends CatalogSyncService {
        applyBatchCalls = 0;
        override async applyBatch(batch: CatalogSyncBatch) {
          this.applyBatchCalls++;
          return super.applyBatch(batch);
        }
      }
      const spy = new SpySync(repo);
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const result = await spy.applyCompleteProviderSnapshot(up.batch, up.reconciliation);
      expect(result.status).toBe("COMPLETED");
      expect(spy.applyBatchCalls).toBe(0);
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("idempotent complete snapshot: re-import creates no duplicate rows or warnings", async () => {
    const { dir, handle, repo, sync } = setup();
    try {
      const up = buildUpstoxImport(upstoxRows, OPTS);
      const fy = buildFyersImport(fyersWithLotSize(260), OPTS);
      const r1 = await sync.applyCompleteProviderSnapshot(up.batch, up.reconciliation);
      const r2 = await sync.applyCompleteProviderSnapshot(up.batch, up.reconciliation);
      const r3 = await sync.applyCompleteProviderSnapshot(fy.batch, fy.reconciliation);
      const r4 = await sync.applyCompleteProviderSnapshot(fy.batch, fy.reconciliation);
      expect([r1.status, r2.status, r3.status, r4.status]).toEqual(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED"]);
      expect(r4.conflicts.filter((c) => c.type === DERIVATIVE_SHARED_FIELD_CONFLICT).length).toBe(0);
      const all = await repo.listInstruments();
      expect(new Set(all.map((i) => i.canonicalId)).size).toBe(all.length);
      expect(new Set(all.map((i) => i.identityKey)).size).toBe(all.length);
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });
});
