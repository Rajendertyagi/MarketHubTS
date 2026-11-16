import type {
  CanonicalInstrument,
  InstrumentAlias,
  InstrumentIdentifier,
  ProviderInstrumentMapping
} from "@markethub/contracts";
import { normalizeAliasValue, normalizeScope, normalizeStrike } from "@markethub/market-core";
import type { CatalogSyncRunRecord, DerivativeContractRecord } from "@markethub/market-core";
import {
  canonicalInstruments,
  catalogSyncRuns,
  derivativeContracts,
  instrumentAliases,
  instrumentIdentifierHistory,
  providerInstrumentMappings
} from "../schema";
export function parseJson<T>(value: string | null): T | undefined {
  if (value == null) return undefined;
  return JSON.parse(value) as T;
}
export function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

export function rowToInstrument(row: typeof canonicalInstruments.$inferSelect, deriv?: typeof derivativeContracts.$inferSelect | null): CanonicalInstrument {
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

export function instrumentToRow(inst: CanonicalInstrument): typeof canonicalInstruments.$inferInsert {
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

export function instrumentToDerivativeRow(inst: CanonicalInstrument): typeof derivativeContracts.$inferInsert | null {
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

export function rowToMapping(row: typeof providerInstrumentMappings.$inferSelect): ProviderInstrumentMapping {
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

export function mappingToRow(m: ProviderInstrumentMapping): typeof providerInstrumentMappings.$inferInsert {
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

export function rowToAlias(row: typeof instrumentAliases.$inferSelect): InstrumentAlias {
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

export function aliasToRow(a: InstrumentAlias): typeof instrumentAliases.$inferInsert {
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

export function rowToIdentifier(row: typeof instrumentIdentifierHistory.$inferSelect): InstrumentIdentifier {
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

export function identifierToRow(i: InstrumentIdentifier): typeof instrumentIdentifierHistory.$inferInsert {
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

export function rowToSyncRun(row: typeof catalogSyncRuns.$inferSelect): CatalogSyncRunRecord {
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

export function syncRunToRow(run: CatalogSyncRunRecord): typeof catalogSyncRuns.$inferInsert {
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

export function rowToDerivativeContract(row: typeof derivativeContracts.$inferSelect): DerivativeContractRecord {
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
