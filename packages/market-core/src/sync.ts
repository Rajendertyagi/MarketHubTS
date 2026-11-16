import {
  catalogSyncBatchSchema,
  canonicalInstrumentSchema,
  providerInstrumentMappingSchema,
  instrumentAliasSchema,
  instrumentIdentifierSchema,
  type CanonicalInstrument,
  type CatalogSyncBatch,
  type CatalogSyncResult,
  type InstrumentAlias,
  type InstrumentIdentifier,
  type ProviderInstrumentMapping,
  type SyncConflict
} from "@markethub/contracts";
import { computeIdentityKey, normalizeAliasValue, normalizeScope, normalizeStrike } from "./identity";
import type { CatalogRepository, CatalogRepositoryTx, CatalogSyncRunRecord } from "./types";

function nowIso() {
  return new Date().toISOString();
}

function makeRunId() {
  return crypto.randomUUID();
}

function normalizeDerivative(inst: CanonicalInstrument): CanonicalInstrument {
  if (!inst.derivative) return inst;
  const d: any = { ...inst.derivative };
  if (d.strike !== undefined || d.strikeNormalized !== undefined) {
    const norm = d.strikeNormalized ?? normalizeStrike(d.strike);
    d.strikeNormalized = norm;
    const n = Number(norm);
    d.strike = Number.isFinite(n) ? n : norm;
  }
  return { ...inst, derivative: d } as CanonicalInstrument;
}

function normalizeInstrument(input: CanonicalInstrument, now: string): CanonicalInstrument {
  const withDeriv = normalizeDerivative(input);
  const identityKey = computeIdentityKey({
    exchange: withDeriv.exchange,
    segment: withDeriv.segment,
    instrumentCategory: withDeriv.instrumentCategory,
    canonicalSymbol: withDeriv.canonicalSymbol,
    isin: withDeriv.isin,
    exchangeSecurityId: withDeriv.exchangeSecurityId,
    stableIdentifier: withDeriv.stableIdentifier,
    ...(withDeriv.derivative
      ? {
          derivative: {
            underlyingCanonicalId: withDeriv.derivative.underlyingCanonicalId,
            expiryDate: withDeriv.derivative.expiryDate,
            strike: withDeriv.derivative.strike,
            strikeNormalized: (withDeriv.derivative as any).strikeNormalized,
            optionType: withDeriv.derivative.optionType
          }
        }
      : {})
  });
  const canonicalId = withDeriv.canonicalId || crypto.randomUUID();
  return canonicalInstrumentSchema.parse({
    ...withDeriv,
    canonicalId,
    identityKey,
    identityVersion: withDeriv.identityVersion ?? 1,
    createdAt: withDeriv.createdAt ?? now,
    updatedAt: now
  });
}

function normalizeMapping(input: ProviderInstrumentMapping, now: string): ProviderInstrumentMapping {
  return providerInstrumentMappingSchema.parse({
    ...input,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  });
}

function normalizeAlias(input: InstrumentAlias, now: string): InstrumentAlias {
  const exchangeScope = normalizeScope(input.exchangeScope ?? input.exchange);
  const segmentScope = normalizeScope(input.segmentScope ?? input.segment);
  return instrumentAliasSchema.parse({
    ...input,
    aliasNormalized: normalizeAliasValue(input.alias),
    exchangeScope,
    segmentScope,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  });
}

function normalizeIdentifier(input: InstrumentIdentifier, now: string): InstrumentIdentifier {
  const exchangeScope = normalizeScope(input.exchangeScope ?? input.exchange);
  const segmentScope = normalizeScope(input.segmentScope ?? input.segment);
  return instrumentIdentifierSchema.parse({
    ...input,
    identifierNormalized: normalizeAliasValue(input.identifierNormalized || input.identifierValue),
    exchangeScope,
    segmentScope,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  });
}

function mergeInstrument(existing: CanonicalInstrument, incoming: CanonicalInstrument, now: string): CanonicalInstrument {
  const merged: any = {
    ...existing,
    ...incoming,
    canonicalId: existing.canonicalId,
    identityVersion: existing.identityVersion ?? incoming.identityVersion ?? 1,
    // preserve identity-critical fields from existing if incoming omitted them (stability)
    isin: incoming.isin ?? existing.isin,
    exchangeSecurityId: incoming.exchangeSecurityId ?? existing.exchangeSecurityId,
    stableIdentifier: incoming.stableIdentifier ?? existing.stableIdentifier,
    createdAt: existing.createdAt ?? incoming.createdAt ?? now,
    updatedAt: now,
    sourceMeta: { ...(existing.sourceMeta ?? {}), ...(incoming.sourceMeta ?? {}) },
    cashIndexMembership: incoming.cashIndexMembership ?? existing.cashIndexMembership,
    exchangeDerivativeEligibility: incoming.exchangeDerivativeEligibility ?? existing.exchangeDerivativeEligibility,
    productScope: incoming.productScope ?? existing.productScope,
    derivative: incoming.derivative ?? existing.derivative,
    provenance: incoming.provenance ?? existing.provenance
  };
  const recomputed = computeIdentityKey({
    exchange: merged.exchange,
    segment: merged.segment,
    instrumentCategory: merged.instrumentCategory,
    canonicalSymbol: merged.canonicalSymbol,
    isin: merged.isin,
    exchangeSecurityId: merged.exchangeSecurityId,
    stableIdentifier: merged.stableIdentifier,
    ...(merged.derivative
      ? {
          derivative: {
            underlyingCanonicalId: merged.derivative.underlyingCanonicalId,
            expiryDate: merged.derivative.expiryDate,
            strike: merged.derivative.strike,
            strikeNormalized: merged.derivative.strikeNormalized,
            optionType: merged.derivative.optionType
          }
        }
      : {})
  });
  merged.identityKey = recomputed;
  return canonicalInstrumentSchema.parse(merged);
}

function deriveIdentifiers(inst: CanonicalInstrument, source: string, now: string): InstrumentIdentifier[] {
  const out: InstrumentIdentifier[] = [];
  const base = {
    canonicalId: inst.canonicalId,
    exchange: inst.exchange,
    segment: inst.segment,
    exchangeScope: normalizeScope(inst.exchange),
    segmentScope: normalizeScope(inst.segment),
    source,
    status: "CURRENT" as const,
    createdAt: now,
    updatedAt: now
  };
  if (inst.isin) {
    out.push(normalizeIdentifier({ ...base, identifierType: "ISIN", identifierNamespace: inst.exchange, identifierValue: inst.isin, identifierNormalized: normalizeAliasValue(inst.isin) }, now));
  }
  if (inst.exchangeSecurityId) {
    out.push(normalizeIdentifier({ ...base, identifierType: "EXCHANGE_SECURITY_ID", identifierNamespace: inst.exchange, identifierValue: inst.exchangeSecurityId, identifierNormalized: normalizeAliasValue(inst.exchangeSecurityId) }, now));
  }
  if (inst.stableIdentifier) {
    out.push(normalizeIdentifier({ ...base, identifierType: "STABLE_ID", identifierNamespace: inst.exchange, identifierValue: inst.stableIdentifier, identifierNormalized: normalizeAliasValue(inst.stableIdentifier) }, now));
  }
  out.push(normalizeIdentifier({ ...base, identifierType: "SYMBOL", identifierNamespace: inst.exchange, identifierValue: inst.canonicalSymbol, identifierNormalized: normalizeAliasValue(inst.canonicalSymbol) }, now));
  return out;
}

async function tryResolveEnrichment(tx: CatalogRepositoryTx, incoming: CanonicalInstrument): Promise<{ canonicalId: string; existing: CanonicalInstrument } | { conflict: SyncConflict } | null> {
  // Minimal enrichment: symbol-only existing equity/index can be enriched with ISIN in same exchange/segment/category.
  // Never auto-enrich using expired/historical symbol alone; require current, contextually matching and unambiguous identifier.
  if (!incoming.isin) return null;
  if (incoming.instrumentCategory !== "EQUITY" && incoming.instrumentCategory !== "INDEX") return null;
  const symbolNorm = normalizeAliasValue(incoming.canonicalSymbol);
  const candidates = await tx.findIdentifiers({
    identifierType: "SYMBOL",
    identifierNamespace: incoming.exchange,
    identifierNormalized: symbolNorm,
    exchangeScope: normalizeScope(incoming.exchange),
    segmentScope: normalizeScope(incoming.segment),
    status: "CURRENT"
  });
  const uniqueCanonicalIds = [...new Set(candidates.map((c) => c.canonicalId))];
  if (uniqueCanonicalIds.length === 0) return null;
  if (uniqueCanonicalIds.length > 1) {
    return { conflict: { type: "AMBIGUOUS_ENRICHMENT", severity: "ERROR", message: "Multiple instruments match current symbol for ISIN enrichment", details: { symbol: incoming.canonicalSymbol, isin: incoming.isin } } };
  }
  const canonicalId = uniqueCanonicalIds[0]!;
  const existing = await tx.getInstrumentByCanonicalId(canonicalId);
  if (!existing) return null;
  if (existing.exchange !== incoming.exchange || existing.segment !== incoming.segment || existing.instrumentCategory !== incoming.instrumentCategory) {
    return { conflict: { type: "AMBIGUOUS_ENRICHMENT", severity: "ERROR", message: "Symbol match does not align with instrument context for enrichment", canonicalId } };
  }
  // detect symbol reuse/conflict: if existing already has a different current ISIN, do not enrich
  if (existing.isin && normalizeAliasValue(existing.isin) !== normalizeAliasValue(incoming.isin)) {
    return { conflict: { type: "IDENTIFIER_CONFLICT", severity: "ERROR", message: "Existing instrument has different ISIN; enrichment ambiguous", canonicalId, details: { existingIsin: existing.isin, incomingIsin: incoming.isin } } };
  }
  // ensure no other instrument already has this ISIN identity in same context (current or historical ownership conflict)
  const isinNorm = normalizeAliasValue(incoming.isin);
  const isinMatches = await tx.findIdentifiers({ identifierType: "ISIN", identifierNamespace: incoming.exchange, identifierNormalized: isinNorm, exchangeScope: normalizeScope(incoming.exchange), segmentScope: normalizeScope(incoming.segment) });
  const otherIsinOwners = [...new Set(isinMatches.map((m) => m.canonicalId))].filter((id) => id !== canonicalId);
  if (otherIsinOwners.length > 0) {
    return { conflict: { type: "IDENTIFIER_CONFLICT", severity: "ERROR", message: "ISIN already associated with different canonical instrument", canonicalId, details: { isin: incoming.isin, otherCanonicalIds: otherIsinOwners } } };
  }
  return { canonicalId, existing };
}

export class CatalogSyncService {
  constructor(private readonly repo: CatalogRepository) {}

  async applyBatch(rawBatch: CatalogSyncBatch): Promise<CatalogSyncResult> {
    const startedAt = nowIso();
    const runId = makeRunId();
    let batch: CatalogSyncBatch;
    try {
      batch = catalogSyncBatchSchema.parse(rawBatch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const result: CatalogSyncResult = {
        runId,
        status: "FAILED",
        source: rawBatch?.source ?? "unknown",
        completeness: rawBatch?.completeness ?? "PARTIAL",
        startedAt,
        finishedAt: nowIso(),
        counts: { instrumentsReceived: 0, instrumentsUpserted: 0, mappingsReceived: 0, mappingsUpserted: 0, aliasesReceived: 0, aliasesUpserted: 0, identifiersReceived: 0, identifiersUpserted: 0, conflicts: 1 },
        conflicts: [{ type: "INVALID_BATCH", severity: "ERROR", message: msg }],
        error: msg
      };
      await this.recordRunBestEffort({
        runId,
        source: result.source,
        scopeJson: JSON.stringify(rawBatch?.scope ?? { source: result.source }),
        completeness: result.completeness,
        status: "FAILED",
        startedAt,
        finishedAt: result.finishedAt,
        countsJson: JSON.stringify(result.counts),
        conflictsJson: JSON.stringify(result.conflicts),
        error: result.error
      });
      return result;
    }

    const conflicts: SyncConflict[] = [];
    let instrumentsUpserted = 0;
    let mappingsUpserted = 0;
    let aliasesUpserted = 0;
    let identifiersUpserted = 0;

    const runRecord: CatalogSyncRunRecord = {
      runId,
      source: batch.source,
      provider: batch.provider,
      scopeJson: JSON.stringify(batch.scope),
      completeness: batch.completeness,
      status: "RUNNING",
      startedAt,
      sourceVersion: batch.sourceVersion,
      sourceObservedAt: batch.sourceObservedAt,
      countsJson: JSON.stringify({ instrumentsReceived: batch.instruments.length, instrumentsUpserted: 0, mappingsReceived: batch.mappings.length, mappingsUpserted: 0, aliasesReceived: batch.aliases.length, aliasesUpserted: 0, identifiersReceived: batch.identifiers.length, identifiersUpserted: 0, conflicts: 0 }),
      conflictsJson: "[]",
      metadataJson: batch.metadata ? JSON.stringify(batch.metadata) : undefined
    };

    try {
      await this.repo.transaction(async (tx) => {
        await tx.createSyncRun(runRecord);

        const normalizedInstruments: CanonicalInstrument[] = [];
        const identityToInstrument = new Map<string, CanonicalInstrument>();
        for (const inst of batch.instruments) {
          const n = normalizeInstrument(inst, startedAt);
          const existingInBatch = identityToInstrument.get(n.identityKey);
          if (existingInBatch && existingInBatch.canonicalId !== n.canonicalId) {
            conflicts.push({ type: "DUPLICATE_IDENTITY_IN_BATCH", severity: "ERROR", message: `Duplicate identity key in batch: ${n.identityKey}`, identityKey: n.identityKey, canonicalId: n.canonicalId });
            continue;
          }
          identityToInstrument.set(n.identityKey, n);
          normalizedInstruments.push(n);
        }

        const resolvedIdByIdentity = new Map<string, string>();
        const resolvedIdByIncomingCanonicalId = new Map<string, string>();
        const enrichmentByIdentity = new Map<string, { canonicalId: string; existing: CanonicalInstrument }>();
        for (const inst of normalizedInstruments) {
          const existing = await tx.getInstrumentByIdentityKey(inst.identityKey);
          if (existing) {
            resolvedIdByIdentity.set(inst.identityKey, existing.canonicalId);
            resolvedIdByIncomingCanonicalId.set(inst.canonicalId, existing.canonicalId);
            continue;
          }
          const enrich = await tryResolveEnrichment(tx, inst);
          if (enrich && "conflict" in enrich) {
            conflicts.push(enrich.conflict);
            continue;
          }
          if (enrich && "canonicalId" in enrich) {
            resolvedIdByIdentity.set(inst.identityKey, enrich.canonicalId);
            resolvedIdByIncomingCanonicalId.set(inst.canonicalId, enrich.canonicalId);
            enrichmentByIdentity.set(inst.identityKey, enrich);
          } else {
            resolvedIdByIdentity.set(inst.identityKey, inst.canonicalId);
            resolvedIdByIncomingCanonicalId.set(inst.canonicalId, inst.canonicalId);
          }
        }

        const mergedInstruments: CanonicalInstrument[] = [];
        // Persist cash underlyings before derivatives so derivative_contracts FK references resolve
        // regardless of input array order. Identity resolution above is order-independent.
        const orderedForUpsert = [...normalizedInstruments].sort((a, b) => (a.derivative ? 1 : 0) - (b.derivative ? 1 : 0));
        for (const inst of orderedForUpsert) {
          const canonicalId = resolvedIdByIdentity.get(inst.identityKey);
          if (!canonicalId) continue; // had conflict
          const existingByKey = await tx.getInstrumentByIdentityKey(inst.identityKey);
          const enrichment = enrichmentByIdentity.get(inst.identityKey);
          const existing = existingByKey ?? enrichment?.existing ?? (await tx.getInstrumentByCanonicalId(canonicalId));
          if (existingByKey && existingByKey.canonicalId !== canonicalId) {
            conflicts.push({ type: "AMBIGUOUS_IDENTITY", severity: "ERROR", message: `Identity key resolves to different canonical id`, identityKey: inst.identityKey, canonicalId: existingByKey.canonicalId });
            continue;
          }
          let merged: CanonicalInstrument;
          if (existing) {
            // if enrichment, allow identity to evolve to stronger basis but keep canonicalId
            const incomingForMerge = { ...inst, canonicalId: existing.canonicalId };
            merged = mergeInstrument(existing, incomingForMerge as CanonicalInstrument, startedAt);
            // if enrichment changed identity key, ensure no collision
            if (merged.identityKey !== existing.identityKey) {
              const colliding = await tx.getInstrumentByIdentityKey(merged.identityKey);
              if (colliding && colliding.canonicalId !== existing.canonicalId) {
                conflicts.push({ type: "AMBIGUOUS_IDENTITY", severity: "ERROR", message: "Enriched identity collides with different canonical instrument", identityKey: merged.identityKey, canonicalId: existing.canonicalId });
                continue;
              }
            }
          } else {
            merged = { ...inst, canonicalId, updatedAt: startedAt, createdAt: inst.createdAt ?? startedAt };
          }

          await tx.upsertInstrument(merged);
          instrumentsUpserted++;
          mergedInstruments.push(merged);

          // identifier history: derived + explicit
          const derived = deriveIdentifiers(merged, batch.source, startedAt);
          // supersede previous CURRENT identifiers of same type/namespace/scope for this canonical when value changes
          for (const id of derived) {
            if (id.status === "CURRENT") {
              const currents = await tx.findIdentifiers({
                identifierType: id.identifierType,
                identifierNamespace: id.identifierNamespace,
                exchangeScope: id.exchangeScope,
                segmentScope: id.segmentScope,
                status: "CURRENT"
              });
              for (const cur of currents) {
                if (cur.canonicalId === merged.canonicalId && cur.identifierNormalized !== id.identifierNormalized) {
                  await tx.upsertIdentifier({ ...cur, status: "SUPERSEDED", validTo: cur.validTo ?? startedAt, updatedAt: startedAt });
                  identifiersUpserted++;
                }
              }
            }
            await tx.upsertIdentifier(id);
            identifiersUpserted++;
          }
          // if enrichment happened, mark previous symbol as historical for this canonical (preserve history)
          if (enrichment && existing && !existing.isin && merged.isin) {
            const oldSymNorm = normalizeAliasValue(existing.canonicalSymbol);
            if (oldSymNorm !== normalizeAliasValue(merged.canonicalSymbol)) {
              const oldSym = normalizeIdentifier({
                canonicalId: existing.canonicalId,
                identifierType: "SYMBOL",
                identifierNamespace: existing.exchange,
                identifierValue: existing.canonicalSymbol,
                identifierNormalized: oldSymNorm,
                exchange: existing.exchange,
                segment: existing.segment,
                exchangeScope: normalizeScope(existing.exchange),
                segmentScope: normalizeScope(existing.segment),
                source: batch.source,
                status: "HISTORICAL",
                validTo: startedAt,
                createdAt: startedAt,
                updatedAt: startedAt
              }, startedAt);
              await tx.upsertIdentifier(oldSym);
              identifiersUpserted++;
            }
          }
        }

        // Two-phase: all instruments (including new underlyings) are now persisted, so derivative
        // compatibility can be validated independent of input array order. Any ERROR conflict rolls
        // back the whole transaction below, preserving atomicity.
        for (const merged of mergedInstruments) {
          if (!merged.derivative) continue;
          const underlying = await tx.getInstrumentByCanonicalId(merged.derivative.underlyingCanonicalId);
          if (!underlying) {
            conflicts.push({ type: "DERIVATIVE_UNDERLYING_MISSING", severity: "ERROR", message: "Derivative underlying canonical instrument not found", canonicalId: merged.canonicalId, details: { underlyingCanonicalId: merged.derivative.underlyingCanonicalId } });
            continue;
          }
          if (underlying.exchange !== merged.exchange) {
            conflicts.push({ type: "DERIVATIVE_UNDERLYING_INCOMPATIBLE", severity: "ERROR", message: "Derivative and underlying exchange must match", canonicalId: merged.canonicalId, details: { exchange: merged.exchange, underlyingExchange: underlying.exchange } });
            continue;
          }
          const isStockDeriv = merged.instrumentCategory === "STOCK_FUTURE" || merged.instrumentCategory === "STOCK_OPTION";
          const isIndexDeriv = merged.instrumentCategory === "INDEX_FUTURE" || merged.instrumentCategory === "INDEX_OPTION";
          if (isStockDeriv && underlying.instrumentCategory !== "EQUITY") {
            conflicts.push({ type: "DERIVATIVE_UNDERLYING_INCOMPATIBLE", severity: "ERROR", message: "Stock derivative underlying must be an exchange-specific cash equity", canonicalId: merged.canonicalId, details: { underlyingCategory: underlying.instrumentCategory } });
            continue;
          }
          if (isIndexDeriv && underlying.instrumentCategory !== "INDEX") {
            conflicts.push({ type: "DERIVATIVE_UNDERLYING_INCOMPATIBLE", severity: "ERROR", message: "Index derivative underlying must be an exchange-specific cash index", canonicalId: merged.canonicalId, details: { underlyingCategory: underlying.instrumentCategory } });
            continue;
          }
        }

        const resolveCanonicalId = async (candidateId: string): Promise<string | null> => {
          const byIncoming = resolvedIdByIncomingCanonicalId.get(candidateId);
          if (byIncoming) return byIncoming;
          const byId = await tx.getInstrumentByCanonicalId(candidateId);
          if (byId) return byId.canonicalId;
          const byKey = await tx.getInstrumentByIdentityKey(candidateId);
          if (byKey) return byKey.canonicalId;
          return null;
        };

        for (const m of batch.mappings) {
          const nm = normalizeMapping(m, startedAt);
          const existingMap = await tx.getMapping(nm.provider, nm.nativeIdentifier);
          const targetCanonicalId = await resolveCanonicalId(nm.canonicalId);
          if (!targetCanonicalId) {
            conflicts.push({ type: "MAPPING_UNKNOWN_CANONICAL", severity: "ERROR", message: `Mapping refers to unknown canonical instrument`, provider: nm.provider, nativeIdentifier: nm.nativeIdentifier, canonicalId: nm.canonicalId });
            continue;
          }
          if (existingMap && existingMap.canonicalId !== targetCanonicalId) {
            conflicts.push({ type: "AMBIGUOUS_MAPPING", severity: "ERROR", message: `Provider native identifier already mapped to different canonical instrument`, provider: nm.provider, nativeIdentifier: nm.nativeIdentifier, canonicalId: targetCanonicalId, details: { existingCanonicalId: existingMap.canonicalId } });
            continue;
          }
          const merged: ProviderInstrumentMapping = existingMap
            ? providerInstrumentMappingSchema.parse({
                ...existingMap,
                ...nm,
                canonicalId: targetCanonicalId,
                createdAt: existingMap.createdAt ?? nm.createdAt ?? startedAt,
                updatedAt: startedAt,
                sourceMeta: { ...(existingMap.sourceMeta ?? {}), ...(nm.sourceMeta ?? {}) }
              })
            : { ...nm, canonicalId: targetCanonicalId, createdAt: nm.createdAt ?? startedAt, updatedAt: startedAt };
          await tx.upsertMapping(merged);
          mappingsUpserted++;
        }

        for (const a of batch.aliases) {
          const na = normalizeAlias(a, startedAt);
          const targetCanonicalId = await resolveCanonicalId(na.canonicalId);
          if (!targetCanonicalId) {
            conflicts.push({ type: "ALIAS_UNKNOWN_CANONICAL", severity: "ERROR", message: `Alias refers to unknown canonical instrument`, canonicalId: na.canonicalId, details: { alias: na.alias } });
            continue;
          }
          const merged: InstrumentAlias = { ...na, canonicalId: targetCanonicalId, updatedAt: startedAt, createdAt: na.createdAt ?? startedAt };
          await tx.upsertAlias(merged);
          aliasesUpserted++;
        }

        for (const id of batch.identifiers) {
          const nid = normalizeIdentifier(id, startedAt);
          const targetCanonicalId = await resolveCanonicalId(nid.canonicalId);
          if (!targetCanonicalId) {
            conflicts.push({ type: "IDENTIFIER_UNKNOWN_CANONICAL", severity: "ERROR", message: `Identifier refers to unknown canonical instrument`, canonicalId: nid.canonicalId, details: { identifierType: nid.identifierType, identifierValue: nid.identifierValue } });
            continue;
          }
          await tx.upsertIdentifier({ ...nid, canonicalId: targetCanonicalId, updatedAt: startedAt, createdAt: nid.createdAt ?? startedAt });
          identifiersUpserted++;
        }

        const hasErrors = conflicts.some((c) => c.severity === "ERROR");
        if (hasErrors) {
          throw new SyncConflictError(conflicts);
        }

        const finishedAt = nowIso();
        const counts = {
          instrumentsReceived: batch.instruments.length,
          instrumentsUpserted,
          mappingsReceived: batch.mappings.length,
          mappingsUpserted,
          aliasesReceived: batch.aliases.length,
          aliasesUpserted,
          identifiersReceived: batch.identifiers.length,
          identifiersUpserted,
          conflicts: conflicts.length
        };
        await tx.updateSyncRun(runId, {
          status: conflicts.length ? "PARTIAL" : "COMPLETED",
          finishedAt,
          countsJson: JSON.stringify(counts),
          conflictsJson: JSON.stringify(conflicts)
        });
      });

      const finishedAt = nowIso();
      return {
        runId,
        status: conflicts.length ? "PARTIAL" : "COMPLETED",
        source: batch.source,
        completeness: batch.completeness,
        startedAt,
        finishedAt,
        counts: {
          instrumentsReceived: batch.instruments.length,
          instrumentsUpserted,
          mappingsReceived: batch.mappings.length,
          mappingsUpserted,
          aliasesReceived: batch.aliases.length,
          aliasesUpserted,
          identifiersReceived: batch.identifiers.length,
          identifiersUpserted,
          conflicts: conflicts.length
        },
        conflicts
      };
    } catch (e) {
      if (e instanceof SyncConflictError) {
        const result: CatalogSyncResult = {
          runId,
          status: "FAILED",
          source: batch.source,
          completeness: batch.completeness,
          startedAt,
          finishedAt: nowIso(),
          counts: {
            instrumentsReceived: batch.instruments.length,
            instrumentsUpserted: 0,
            mappingsReceived: batch.mappings.length,
            mappingsUpserted: 0,
            aliasesReceived: batch.aliases.length,
            aliasesUpserted: 0,
            identifiersReceived: batch.identifiers.length,
            identifiersUpserted: 0,
            conflicts: e.conflicts.length
          },
          conflicts: e.conflicts,
          error: "Sync failed due to conflicts; transaction rolled back"
        };
        await this.recordRunBestEffort({
          runId,
          source: batch.source,
          provider: batch.provider,
          scopeJson: JSON.stringify(batch.scope),
          completeness: batch.completeness,
          status: "FAILED",
          startedAt,
          finishedAt: result.finishedAt,
          sourceVersion: batch.sourceVersion,
          sourceObservedAt: batch.sourceObservedAt,
          countsJson: JSON.stringify(result.counts),
          conflictsJson: JSON.stringify(result.conflicts),
          error: result.error,
          metadataJson: batch.metadata ? JSON.stringify(batch.metadata) : undefined
        });
        return result;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const result: CatalogSyncResult = {
        runId,
        status: "FAILED",
        source: batch.source,
        completeness: batch.completeness,
        startedAt,
        finishedAt: nowIso(),
        counts: {
          instrumentsReceived: batch.instruments.length,
          instrumentsUpserted: 0,
          mappingsReceived: batch.mappings.length,
          mappingsUpserted: 0,
          aliasesReceived: batch.aliases.length,
          aliasesUpserted: 0,
          identifiersReceived: batch.identifiers.length,
          identifiersUpserted: 0,
          conflicts: conflicts.length
        },
        conflicts,
        error: msg
      };
      await this.recordRunBestEffort({
        runId,
        source: batch.source,
        provider: batch.provider,
        scopeJson: JSON.stringify(batch.scope),
        completeness: batch.completeness,
        status: "FAILED",
        startedAt,
        finishedAt: result.finishedAt,
        sourceVersion: batch.sourceVersion,
        sourceObservedAt: batch.sourceObservedAt,
        countsJson: JSON.stringify(result.counts),
        conflictsJson: JSON.stringify(result.conflicts),
        error: result.error,
        metadataJson: batch.metadata ? JSON.stringify(batch.metadata) : undefined
      });
      return result;
    }
  }

  private async recordRunBestEffort(run: CatalogSyncRunRecord): Promise<void> {
    try {
      if (this.repo.recordSyncRun) await this.repo.recordSyncRun(run);
    } catch {
      // best effort: catalog state integrity already preserved
    }
  }
}

export class SyncConflictError extends Error {
  constructor(public readonly conflicts: SyncConflict[]) {
    super("Sync conflicts");
    this.name = "SyncConflictError";
  }
}
