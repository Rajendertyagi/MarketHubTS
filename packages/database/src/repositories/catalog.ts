import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type {
  CanonicalInstrument,
  InstrumentAlias,
  InstrumentIdentifier,
  ProviderInstrumentMapping
} from "@markethub/contracts";
import { normalizeAliasValue, normalizeScope, normalizeStrike } from "@markethub/market-core";
import type {
  CatalogRepository,
  CatalogRepositoryTx,
  CatalogSyncRunRecord,
  DerivativeContractRecord
} from "@markethub/market-core";
import type { MarketHubDb } from "../index";
import {
  canonicalInstruments,
  catalogSyncRuns,
  derivativeContracts,
  instrumentAliases,
  instrumentIdentifierHistory,
  providerInstrumentMappings
} from "../schema";

function parseJson<T>(value: string | null): T | undefined {
  if (value == null) return undefined;
  return JSON.parse(value) as T;
}
function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function rowToInstrument(row: typeof canonicalInstruments.$inferSelect, deriv?: typeof derivativeContracts.$inferSelect | null): CanonicalInstrument {
  const base: any = {
    canonicalId: row.canonicalId,
    identityKey: row.identityKey,
    identityVersion: row.identityVersion,
    exchange: row.exchange,
    segment: row.segment,
    marketType: row.marketType,
    instrumentCategory: row.instrumentCategory,
    canonicalSymbol: row.canonicalSymbol,
    displayName: row.displayName,
    tradingStatus: row.tradingStatus,
    lifecycleStatus: row.lifecycleStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
  if (row.stableIdentifier != null) base.stableIdentifier = row.stableIdentifier;
  if (row.underlyingCanonicalId != null) base.underlyingCanonicalId = row.underlyingCanonicalId;
  if (row.isin != null) base.isin = row.isin;
  if (row.exchangeSecurityId != null) base.exchangeSecurityId = row.exchangeSecurityId;
  if (deriv) {
    // derivative_contracts is source of truth for core derivative fields
    if (row.underlyingCanonicalId != null && row.underlyingCanonicalId !== deriv.underlyingCanonicalId) {
      throw new Error(`Root and derivative underlyingCanonicalId mismatch for ${row.canonicalId}`);
    }
    base.underlyingCanonicalId = deriv.underlyingCanonicalId;
    const d: any = {
      underlyingCanonicalId: deriv.underlyingCanonicalId,
      expiryDate: deriv.expiryDate
    };
    if (deriv.strikeNormalized != null) {
      d.strikeNormalized = deriv.strikeNormalized;
      const n = Number(deriv.strikeNormalized);
      d.strike = Number.isFinite(n) ? n : deriv.strikeNormalized;
    }
    if (deriv.optionType != null) d.optionType = deriv.optionType;
    if (deriv.lotSize != null) d.lotSize = deriv.lotSize;
    if (deriv.tickSize != null) {
      const tn = Number(deriv.tickSize);
      d.tickSize = Number.isFinite(tn) ? tn : deriv.tickSize;
    }
    if (deriv.quantityFreeze != null) d.quantityFreeze = deriv.quantityFreeze;
    if (deriv.contractLifecycleStatus != null) d.contractLifecycleStatus = deriv.contractLifecycleStatus;
    if (deriv.contractSource != null) d.contractSource = deriv.contractSource;
    if (deriv.contractObservedAt != null) d.contractObservedAt = deriv.contractObservedAt;
    const supp = parseJson(deriv.supplementalMetaJson);
    if (supp !== undefined) d.supplementalMeta = supp;
    base.derivative = d;
  } else {
    // legacy fallback only when no derivative contract row exists
    const derivative = parseJson(row.derivativeJson);
    if (derivative !== undefined) base.derivative = derivative;
  }
  const cashIndexMembership = parseJson(row.cashIndexMembershipJson);
  if (cashIndexMembership !== undefined) base.cashIndexMembership = cashIndexMembership;
  const exchangeDerivativeEligibility = parseJson(row.exchangeDerivativeEligibilityJson);
  if (exchangeDerivativeEligibility !== undefined) base.exchangeDerivativeEligibility = exchangeDerivativeEligibility;
  const productScope = parseJson(row.productScopeJson);
  if (productScope !== undefined) base.productScope = productScope;
  const sourceMeta = parseJson(row.sourceMetaJson);
  if (sourceMeta !== undefined) base.sourceMeta = sourceMeta;
  const provenance = parseJson(row.provenanceJson);
  if (provenance !== undefined) base.provenance = provenance;
  return base as CanonicalInstrument;
}

function instrumentToRow(inst: CanonicalInstrument): typeof canonicalInstruments.$inferInsert {
  // derivative_contracts is source of truth for core derivative fields; keep only supplemental metadata in derivative_json
  let derivativeJson: string | null = null;
  if (inst.derivative?.supplementalMeta !== undefined) {
    derivativeJson = toJson({ supplementalMeta: inst.derivative.supplementalMeta });
  }
  const rootUnderlying = inst.underlyingCanonicalId ?? inst.derivative?.underlyingCanonicalId ?? null;
  if (inst.derivative && inst.underlyingCanonicalId && inst.derivative.underlyingCanonicalId !== inst.underlyingCanonicalId) {
    throw new Error(`Root and derivative underlyingCanonicalId mismatch for ${inst.canonicalId}`);
  }
  return {
    canonicalId: inst.canonicalId,
    identityKey: inst.identityKey,
    identityVersion: inst.identityVersion ?? 1,
    exchange: inst.exchange,
    segment: inst.segment,
    marketType: inst.marketType,
    instrumentCategory: inst.instrumentCategory,
    canonicalSymbol: inst.canonicalSymbol,
    displayName: inst.displayName,
    stableIdentifier: inst.stableIdentifier ?? null,
    underlyingCanonicalId: rootUnderlying,
    isin: inst.isin ?? null,
    exchangeSecurityId: inst.exchangeSecurityId ?? null,
    tradingStatus: inst.tradingStatus,
    lifecycleStatus: inst.lifecycleStatus,
    derivativeJson,
    cashIndexMembershipJson: toJson(inst.cashIndexMembership),
    exchangeDerivativeEligibilityJson: toJson(inst.exchangeDerivativeEligibility),
    productScopeJson: toJson(inst.productScope),
    sourceMetaJson: toJson(inst.sourceMeta),
    provenanceJson: toJson(inst.provenance),
    createdAt: inst.createdAt ?? new Date().toISOString(),
    updatedAt: inst.updatedAt ?? new Date().toISOString()
  };
}

function instrumentToDerivativeRow(inst: CanonicalInstrument): typeof derivativeContracts.$inferInsert | null {
  if (!inst.derivative) return null;
  const d = inst.derivative as any;
  if (inst.underlyingCanonicalId && d.underlyingCanonicalId !== inst.underlyingCanonicalId) {
    throw new Error(`Root and derivative underlyingCanonicalId mismatch for ${inst.canonicalId}`);
  }
  const strikeNormalized = d.strikeNormalized ?? (d.strike !== undefined ? normalizeStrike(d.strike) : null);
  const optionType = d.optionType ?? null;
  return {
    canonicalId: inst.canonicalId,
    exchange: inst.exchange,
    segment: inst.segment,
    derivativeClass: inst.instrumentCategory,
    underlyingCanonicalId: d.underlyingCanonicalId,
    expiryDate: d.expiryDate,
    strikeNormalized,
    optionType,
    strikeKey: strikeNormalized ?? "",
    optionTypeKey: optionType ?? "",
    lotSize: d.lotSize != null ? Math.trunc(Number(d.lotSize)) : null,
    tickSize: d.tickSize != null ? String(d.tickSize) : null,
    quantityFreeze: d.quantityFreeze != null ? Math.trunc(Number(d.quantityFreeze)) : null,
    contractLifecycleStatus: d.contractLifecycleStatus ?? null,
    contractSource: d.contractSource ?? null,
    contractObservedAt: d.contractObservedAt ?? null,
    supplementalMetaJson: toJson(d.supplementalMeta),
    createdAt: inst.createdAt ?? new Date().toISOString(),
    updatedAt: inst.updatedAt ?? new Date().toISOString()
  };
}

function rowToMapping(row: typeof providerInstrumentMappings.$inferSelect): ProviderInstrumentMapping {
  const base: any = {
    provider: row.provider,
    nativeIdentifier: row.nativeIdentifier,
    canonicalId: row.canonicalId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
  if (row.exchange != null) base.exchange = row.exchange;
  if (row.segment != null) base.segment = row.segment;
  if (row.nativeSymbol != null) base.nativeSymbol = row.nativeSymbol;
  if (row.nativeExchangeToken != null) base.nativeExchangeToken = row.nativeExchangeToken;
  const sourceMeta = parseJson(row.sourceMetaJson);
  if (sourceMeta !== undefined) base.sourceMeta = sourceMeta;
  const provenance = parseJson(row.provenanceJson);
  if (provenance !== undefined) base.provenance = provenance;
  if (row.validFrom != null) base.validFrom = row.validFrom;
  if (row.validTo != null) base.validTo = row.validTo;
  return base as ProviderInstrumentMapping;
}

function mappingToRow(m: ProviderInstrumentMapping): typeof providerInstrumentMappings.$inferInsert {
  return {
    provider: m.provider,
    nativeIdentifier: m.nativeIdentifier,
    canonicalId: m.canonicalId,
    exchange: m.exchange ?? null,
    segment: m.segment ?? null,
    nativeSymbol: m.nativeSymbol ?? null,
    nativeExchangeToken: m.nativeExchangeToken ?? null,
    status: m.status,
    sourceMetaJson: toJson(m.sourceMeta),
    provenanceJson: toJson(m.provenance),
    validFrom: m.validFrom ?? null,
    validTo: m.validTo ?? null,
    createdAt: m.createdAt ?? new Date().toISOString(),
    updatedAt: m.updatedAt ?? new Date().toISOString()
  };
}

function rowToAlias(row: typeof instrumentAliases.$inferSelect): InstrumentAlias {
  const base: any = {
    canonicalId: row.canonicalId,
    alias: row.alias,
    aliasNormalized: row.aliasNormalized,
    aliasType: row.aliasType,
    source: row.source,
    exchangeScope: row.exchangeScope,
    segmentScope: row.segmentScope,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
  if (row.exchange != null) base.exchange = row.exchange;
  if (row.segment != null) base.segment = row.segment;
  const provenance = parseJson(row.provenanceJson);
  if (provenance !== undefined) base.provenance = provenance;
  return base as InstrumentAlias;
}

function aliasToRow(a: InstrumentAlias): typeof instrumentAliases.$inferInsert {
  const exchangeScope = normalizeScope(a.exchangeScope ?? a.exchange);
  const segmentScope = normalizeScope(a.segmentScope ?? a.segment);
  return {
    canonicalId: a.canonicalId,
    alias: a.alias,
    aliasNormalized: normalizeAliasValue(a.alias),
    aliasType: a.aliasType,
    source: a.source,
    exchange: a.exchange ?? null,
    segment: a.segment ?? null,
    exchangeScope,
    segmentScope,
    status: a.status,
    provenanceJson: toJson(a.provenance),
    createdAt: a.createdAt ?? new Date().toISOString(),
    updatedAt: a.updatedAt ?? new Date().toISOString()
  };
}

function rowToIdentifier(row: typeof instrumentIdentifierHistory.$inferSelect): InstrumentIdentifier {
  const base: any = {
    canonicalId: row.canonicalId,
    identifierType: row.identifierType,
    identifierNamespace: row.identifierNamespace,
    identifierValue: row.identifierValue,
    identifierNormalized: row.identifierNormalized,
    exchangeScope: row.exchangeScope,
    segmentScope: row.segmentScope,
    source: row.source,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
  if (row.exchange != null) base.exchange = row.exchange;
  if (row.segment != null) base.segment = row.segment;
  const provenance = parseJson(row.provenanceJson);
  if (provenance !== undefined) base.provenance = provenance;
  if (row.validFrom != null) base.validFrom = row.validFrom;
  if (row.validTo != null) base.validTo = row.validTo;
  return base as InstrumentIdentifier;
}

function identifierToRow(i: InstrumentIdentifier): typeof instrumentIdentifierHistory.$inferInsert {
  const exchangeScope = normalizeScope(i.exchangeScope ?? i.exchange);
  const segmentScope = normalizeScope(i.segmentScope ?? i.segment);
  return {
    canonicalId: i.canonicalId,
    identifierType: i.identifierType,
    identifierNamespace: i.identifierNamespace,
    identifierValue: i.identifierValue,
    identifierNormalized: normalizeAliasValue(i.identifierValue),
    exchange: i.exchange ?? null,
    segment: i.segment ?? null,
    exchangeScope,
    segmentScope,
    source: i.source,
    provenanceJson: toJson(i.provenance),
    validFrom: i.validFrom ?? null,
    validTo: i.validTo ?? null,
    status: i.status,
    createdAt: i.createdAt ?? new Date().toISOString(),
    updatedAt: i.updatedAt ?? new Date().toISOString()
  };
}

function rowToSyncRun(row: typeof catalogSyncRuns.$inferSelect): CatalogSyncRunRecord {
  return {
    runId: row.runId,
    source: row.source,
    provider: row.provider ?? undefined,
    scopeJson: row.scopeJson,
    completeness: row.completeness,
    status: row.status as any,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    sourceVersion: row.sourceVersion ?? undefined,
    sourceObservedAt: row.sourceObservedAt ?? undefined,
    countsJson: row.countsJson,
    conflictsJson: row.conflictsJson,
    error: row.error ?? undefined,
    metadataJson: row.metadataJson ?? undefined
  };
}

function syncRunToRow(run: CatalogSyncRunRecord): typeof catalogSyncRuns.$inferInsert {
  return {
    runId: run.runId,
    source: run.source,
    provider: run.provider ?? null,
    scopeJson: run.scopeJson,
    completeness: run.completeness,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    sourceVersion: run.sourceVersion ?? null,
    sourceObservedAt: run.sourceObservedAt ?? null,
    countsJson: run.countsJson,
    conflictsJson: run.conflictsJson,
    error: run.error ?? null,
    metadataJson: run.metadataJson ?? null
  };
}

function rowToDerivativeContract(row: typeof derivativeContracts.$inferSelect): DerivativeContractRecord {
  return {
    canonicalId: row.canonicalId,
    exchange: row.exchange,
    segment: row.segment,
    derivativeClass: row.derivativeClass,
    underlyingCanonicalId: row.underlyingCanonicalId,
    expiryDate: row.expiryDate,
    strikeNormalized: row.strikeNormalized,
    optionType: row.optionType,
    strikeKey: row.strikeKey,
    optionTypeKey: row.optionTypeKey,
    lotSize: row.lotSize,
    tickSize: row.tickSize,
    quantityFreeze: row.quantityFreeze,
    contractLifecycleStatus: row.contractLifecycleStatus,
    contractSource: row.contractSource,
    contractObservedAt: row.contractObservedAt,
    supplementalMetaJson: row.supplementalMetaJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

class TxRepo implements CatalogRepositoryTx {
  constructor(private readonly db: MarketHubDb) {}

  async getInstrumentByCanonicalId(canonicalId: string): Promise<CanonicalInstrument | null> {
    const row = this.db.select().from(canonicalInstruments).where(eq(canonicalInstruments.canonicalId, canonicalId)).get();
    if (!row) return null;
    const deriv = this.db.select().from(derivativeContracts).where(eq(derivativeContracts.canonicalId, canonicalId)).get();
    return rowToInstrument(row, deriv ?? null);
  }
  async getInstrumentByIdentityKey(identityKey: string): Promise<CanonicalInstrument | null> {
    const row = this.db.select().from(canonicalInstruments).where(eq(canonicalInstruments.identityKey, identityKey)).get();
    if (!row) return null;
    const deriv = this.db.select().from(derivativeContracts).where(eq(derivativeContracts.canonicalId, row.canonicalId)).get();
    return rowToInstrument(row, deriv ?? null);
  }
  async upsertInstrument(instrument: CanonicalInstrument): Promise<{ created: boolean }> {
    const existing = this.db.select().from(canonicalInstruments).where(eq(canonicalInstruments.canonicalId, instrument.canonicalId)).get();
    const row = instrumentToRow(instrument);
    if (!existing) {
      this.db.insert(canonicalInstruments).values(row).run();
    } else {
      this.db.update(canonicalInstruments).set(row).where(eq(canonicalInstruments.canonicalId, instrument.canonicalId)).run();
    }
    const drow = instrumentToDerivativeRow(instrument);
    if (drow) {
      const dex = this.db.select().from(derivativeContracts).where(eq(derivativeContracts.canonicalId, instrument.canonicalId)).get();
      if (!dex) this.db.insert(derivativeContracts).values(drow).run();
      else this.db.update(derivativeContracts).set(drow).where(eq(derivativeContracts.canonicalId, instrument.canonicalId)).run();
    } else {
      this.db.delete(derivativeContracts).where(eq(derivativeContracts.canonicalId, instrument.canonicalId)).run();
    }
    return { created: !existing };
  }
  async upsertDerivativeContract(contract: DerivativeContractRecord): Promise<{ created: boolean }> {
    const existing = this.db.select().from(derivativeContracts).where(eq(derivativeContracts.canonicalId, contract.canonicalId)).get();
    if (!existing) {
      this.db.insert(derivativeContracts).values(contract as any).run();
      return { created: true };
    }
    this.db.update(derivativeContracts).set(contract as any).where(eq(derivativeContracts.canonicalId, contract.canonicalId)).run();
    return { created: false };
  }
  async getMapping(provider: string, nativeIdentifier: string): Promise<ProviderInstrumentMapping | null> {
    const row = this.db
      .select()
      .from(providerInstrumentMappings)
      .where(and(eq(providerInstrumentMappings.provider, provider), eq(providerInstrumentMappings.nativeIdentifier, nativeIdentifier)))
      .get();
    return row ? rowToMapping(row) : null;
  }
  async upsertMapping(mapping: ProviderInstrumentMapping): Promise<{ created: boolean }> {
    const existing = await this.getMapping(mapping.provider, mapping.nativeIdentifier);
    const row = mappingToRow(mapping);
    if (!existing) {
      this.db.insert(providerInstrumentMappings).values(row).run();
      return { created: true };
    }
    this.db
      .update(providerInstrumentMappings)
      .set(row)
      .where(and(eq(providerInstrumentMappings.provider, mapping.provider), eq(providerInstrumentMappings.nativeIdentifier, mapping.nativeIdentifier)))
      .run();
    return { created: false };
  }
  async upsertAlias(alias: InstrumentAlias): Promise<{ created: boolean }> {
    const row = aliasToRow(alias);
    const candidates = this.db
      .select()
      .from(instrumentAliases)
      .where(
        and(
          eq(instrumentAliases.canonicalId, row.canonicalId),
          eq(instrumentAliases.aliasNormalized, row.aliasNormalized),
          eq(instrumentAliases.aliasType, row.aliasType),
          eq(instrumentAliases.source, row.source)
        )
      )
      .all();
    const existing = candidates.find((c) => c.exchangeScope === row.exchangeScope && c.segmentScope === row.segmentScope);
    if (!existing) {
      this.db.insert(instrumentAliases).values(row).run();
      return { created: true };
    }
    this.db.update(instrumentAliases).set(row).where(eq(instrumentAliases.id, existing.id)).run();
    return { created: false };
  }
  async upsertIdentifier(identifier: InstrumentIdentifier): Promise<{ created: boolean }> {
    const row = identifierToRow(identifier);
    const authoritative = ["ISIN", "EXCHANGE_SECURITY_ID", "STABLE_ID"].includes(row.identifierType);
    if (authoritative && row.status === "CURRENT") {
      const existingCurrent = this.db
        .select()
        .from(instrumentIdentifierHistory)
        .where(
          and(
            eq(instrumentIdentifierHistory.identifierType, row.identifierType),
            eq(instrumentIdentifierHistory.identifierNamespace, row.identifierNamespace),
            eq(instrumentIdentifierHistory.identifierNormalized, row.identifierNormalized),
            eq(instrumentIdentifierHistory.exchangeScope as any, row.exchangeScope),
            eq(instrumentIdentifierHistory.segmentScope as any, row.segmentScope),
            eq(instrumentIdentifierHistory.status, row.status)
          ) as any
        )
        .get();
      if (existingCurrent) {
        if (existingCurrent.canonicalId !== row.canonicalId) {
          throw new Error(`CURRENT authoritative identifier already owned by different canonical instrument: ${row.identifierType}:${row.identifierNormalized}`);
        }
        this.db.update(instrumentIdentifierHistory).set({ ...row, id: existingCurrent.id, createdAt: existingCurrent.createdAt }).where(eq(instrumentIdentifierHistory.id, existingCurrent.id)).run();
        return { created: false };
      }
      this.db.insert(instrumentIdentifierHistory).values(row).run();
      return { created: true };
    }

    const candidates = this.db
      .select()
      .from(instrumentIdentifierHistory)
      .where(
        and(
          eq(instrumentIdentifierHistory.canonicalId, row.canonicalId),
          eq(instrumentIdentifierHistory.identifierType, row.identifierType),
          eq(instrumentIdentifierHistory.identifierNamespace, row.identifierNamespace),
          eq(instrumentIdentifierHistory.identifierNormalized, row.identifierNormalized),
          eq(instrumentIdentifierHistory.source, row.source)
        )
      )
      .all();
    const sameScope = candidates.filter((c) => c.exchangeScope === row.exchangeScope && c.segmentScope === row.segmentScope);
    const exact = sameScope.find((c) => c.status === row.status);
    const existing = exact ?? sameScope[0];
    if (!existing) {
      this.db.insert(instrumentIdentifierHistory).values(row).run();
      return { created: true };
    }
    this.db.update(instrumentIdentifierHistory).set({ ...row, id: existing.id, createdAt: existing.createdAt }).where(eq(instrumentIdentifierHistory.id, existing.id)).run();
    return { created: false };
  }
  async listIdentifiersByCanonicalId(canonicalId: string): Promise<InstrumentIdentifier[]> {
    return this.db.select().from(instrumentIdentifierHistory).where(eq(instrumentIdentifierHistory.canonicalId, canonicalId)).all().map(rowToIdentifier);
  }
  async findIdentifiers(query: { identifierType?: string; identifierNamespace?: string; identifierNormalized?: string; exchangeScope?: string; segmentScope?: string; status?: string }): Promise<InstrumentIdentifier[]> {
    const conds: SQL[] = [];
    if (query.identifierType) conds.push(eq(instrumentIdentifierHistory.identifierType, query.identifierType));
    if (query.identifierNamespace) conds.push(eq(instrumentIdentifierHistory.identifierNamespace, query.identifierNamespace));
    if (query.identifierNormalized) conds.push(eq(instrumentIdentifierHistory.identifierNormalized, query.identifierNormalized));
    if (query.exchangeScope) conds.push(eq(instrumentIdentifierHistory.exchangeScope, query.exchangeScope));
    if (query.segmentScope) conds.push(eq(instrumentIdentifierHistory.segmentScope, query.segmentScope));
    if (query.status) conds.push(eq(instrumentIdentifierHistory.status, query.status));
    const q = this.db.select().from(instrumentIdentifierHistory);
    const rows = conds.length ? q.where(and(...conds)).all() : q.all();
    return rows.map(rowToIdentifier);
  }
  async createSyncRun(run: CatalogSyncRunRecord): Promise<void> {
    this.db.insert(catalogSyncRuns).values(syncRunToRow(run)).run();
  }
  async updateSyncRun(runId: string, patch: Partial<CatalogSyncRunRecord>): Promise<void> {
    const existing = this.db.select().from(catalogSyncRuns).where(eq(catalogSyncRuns.runId, runId)).get();
    if (!existing) return;
    const merged: CatalogSyncRunRecord = { ...rowToSyncRun(existing), ...patch };
    this.db.update(catalogSyncRuns).set(syncRunToRow(merged)).where(eq(catalogSyncRuns.runId, runId)).run();
  }
}

export class SqliteCatalogRepository implements CatalogRepository {
  private txQueue: Promise<void> = Promise.resolve();

  constructor(private readonly db: MarketHubDb, private readonly sqlite: Database) {}

  async transaction<T>(fn: (tx: CatalogRepositoryTx) => Promise<T> | T): Promise<T> {
    const run = async () => {
      const txRepo = new TxRepo(this.db);
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(txRepo);
        this.sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        try { this.sqlite.exec("ROLLBACK"); } catch {}
        throw e;
      }
    };

    const queued = this.txQueue.then(run, run);
    this.txQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async getInstrumentByCanonicalId(canonicalId: string): Promise<CanonicalInstrument | null> {
    const row = this.db.select().from(canonicalInstruments).where(eq(canonicalInstruments.canonicalId, canonicalId)).get();
    if (!row) return null;
    const deriv = this.db.select().from(derivativeContracts).where(eq(derivativeContracts.canonicalId, canonicalId)).get();
    return rowToInstrument(row, deriv ?? null);
  }
  async getInstrumentByIdentityKey(identityKey: string): Promise<CanonicalInstrument | null> {
    const row = this.db.select().from(canonicalInstruments).where(eq(canonicalInstruments.identityKey, identityKey)).get();
    if (!row) return null;
    const deriv = this.db.select().from(derivativeContracts).where(eq(derivativeContracts.canonicalId, row.canonicalId)).get();
    return rowToInstrument(row, deriv ?? null);
  }
  async listInstruments(): Promise<CanonicalInstrument[]> {
    const rows = this.db.select().from(canonicalInstruments).all();
    return rows.map((r) => {
      const d = this.db.select().from(derivativeContracts).where(eq(derivativeContracts.canonicalId, r.canonicalId)).get();
      return rowToInstrument(r, d ?? null);
    });
  }
  async getMapping(provider: string, nativeIdentifier: string): Promise<ProviderInstrumentMapping | null> {
    const row = this.db
      .select()
      .from(providerInstrumentMappings)
      .where(and(eq(providerInstrumentMappings.provider, provider), eq(providerInstrumentMappings.nativeIdentifier, nativeIdentifier)))
      .get();
    return row ? rowToMapping(row) : null;
  }
  async listMappingsByCanonicalId(canonicalId: string): Promise<ProviderInstrumentMapping[]> {
    return this.db.select().from(providerInstrumentMappings).where(eq(providerInstrumentMappings.canonicalId, canonicalId)).all().map(rowToMapping);
  }
  async listAliasesByCanonicalId(canonicalId: string): Promise<InstrumentAlias[]> {
    return this.db.select().from(instrumentAliases).where(eq(instrumentAliases.canonicalId, canonicalId)).all().map(rowToAlias);
  }
  async findAlias(alias: string, exchange?: string, segment?: string): Promise<InstrumentAlias[]> {
    const aliasNormalized = normalizeAliasValue(alias);
    const conds: SQL[] = [eq(instrumentAliases.aliasNormalized, aliasNormalized), eq(instrumentAliases.status, "ACTIVE")];
    if (exchange !== undefined) {
      const ex = normalizeScope(exchange);
      conds.push(sql`(${instrumentAliases.exchangeScope} = ${ex} OR ${instrumentAliases.exchangeScope} = '*')`);
    }
    if (segment !== undefined) {
      const seg = normalizeScope(segment);
      conds.push(sql`(${instrumentAliases.segmentScope} = ${seg} OR ${instrumentAliases.segmentScope} = '*')`);
    }
    return this.db.select().from(instrumentAliases).where(and(...conds)).all().map(rowToAlias);
  }
  async listIdentifiersByCanonicalId(canonicalId: string): Promise<InstrumentIdentifier[]> {
    return this.db.select().from(instrumentIdentifierHistory).where(eq(instrumentIdentifierHistory.canonicalId, canonicalId)).all().map(rowToIdentifier);
  }
  async findIdentifiers(query: { identifierType?: string; identifierNamespace?: string; identifierNormalized?: string; exchangeScope?: string; segmentScope?: string; status?: string }): Promise<InstrumentIdentifier[]> {
    const conds: SQL[] = [];
    if (query.identifierType) conds.push(eq(instrumentIdentifierHistory.identifierType, query.identifierType));
    if (query.identifierNamespace) conds.push(eq(instrumentIdentifierHistory.identifierNamespace, query.identifierNamespace));
    if (query.identifierNormalized) conds.push(eq(instrumentIdentifierHistory.identifierNormalized, query.identifierNormalized));
    if (query.exchangeScope) conds.push(eq(instrumentIdentifierHistory.exchangeScope, query.exchangeScope));
    if (query.segmentScope) conds.push(eq(instrumentIdentifierHistory.segmentScope, query.segmentScope));
    if (query.status) conds.push(eq(instrumentIdentifierHistory.status, query.status));
    const q = this.db.select().from(instrumentIdentifierHistory);
    const rows = conds.length ? q.where(and(...conds)).all() : q.all();
    return rows.map(rowToIdentifier);
  }
  async getDerivativeContract(canonicalId: string): Promise<DerivativeContractRecord | null> {
    const row = this.db.select().from(derivativeContracts).where(eq(derivativeContracts.canonicalId, canonicalId)).get();
    return row ? rowToDerivativeContract(row) : null;
  }
  async findDerivativeContracts(query: { underlyingCanonicalId?: string; expiryDate?: string; derivativeClass?: string }): Promise<DerivativeContractRecord[]> {
    const conds: SQL[] = [];
    if (query.underlyingCanonicalId) conds.push(eq(derivativeContracts.underlyingCanonicalId, query.underlyingCanonicalId));
    if (query.expiryDate) conds.push(eq(derivativeContracts.expiryDate, query.expiryDate));
    if (query.derivativeClass) conds.push(eq(derivativeContracts.derivativeClass, query.derivativeClass));
    const q = this.db.select().from(derivativeContracts);
    const rows = conds.length ? q.where(and(...conds)).all() : q.all();
    return rows.map(rowToDerivativeContract);
  }
  async getSyncRun(runId: string): Promise<CatalogSyncRunRecord | null> {
    const row = this.db.select().from(catalogSyncRuns).where(eq(catalogSyncRuns.runId, runId)).get();
    return row ? rowToSyncRun(row) : null;
  }

  async recordSyncRun(run: CatalogSyncRunRecord): Promise<void> {
    const existing = this.db.select().from(catalogSyncRuns).where(eq(catalogSyncRuns.runId, run.runId)).get();
    if (!existing) this.db.insert(catalogSyncRuns).values(syncRunToRow(run)).run();
    else this.db.update(catalogSyncRuns).set(syncRunToRow(run)).where(eq(catalogSyncRuns.runId, run.runId)).run();
  }
}
