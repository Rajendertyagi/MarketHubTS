import {
  catalogSyncBatchSchema,
  providerInstrumentMappingSchema,
  type CanonicalInstrument,
  type CatalogSyncBatch,
  type CatalogSyncResult,
  type InstrumentAlias,
  type ProviderInstrumentMapping,
  type SyncConflict,
  type SyncRunStatus
} from "@markethub/contracts";
import { computeIdentityKey, normalizeAliasValue, normalizeScope } from "../identity";
import type {
  CatalogRepository,
  CatalogRepositoryTx,
  CatalogSyncRunRecord,
  ProviderReconciliationDescriptor
} from "../types";
import {
  deriveIdentifiers, makeRunId, mergeInstrument, normalizeAlias, normalizeIdentifier,
  normalizeInstrument, normalizeMapping, nowIso
} from "./normalize";
import { tryResolveEnrichment } from "./resolve";
import {
  analyzeSharedDerivativeFields, DERIVATIVE_ATTRIBUTES_META_KEY
} from "./shared-fields";
import { serializeProviderCoverageScope } from "./scope";

export class SyncConflictError extends Error {
  constructor(public readonly conflicts: SyncConflict[]) {
    super("Sync conflicts");
    this.name = "SyncConflictError";
  }
}

interface AppliedBatch {
  conflicts: SyncConflict[];
  counts: CatalogSyncResult["counts"];
  finishedAt: string;
}

interface PreparedRun {
  batch: CatalogSyncBatch;
  runRecord: CatalogSyncRunRecord;
}

/**
 * Only ERROR conflicts fail a run. WARNING/INFO conflicts (for example shared
 * derivative field disagreements) are recorded but do not demote a committed
 * snapshot from COMPLETED to PARTIAL.
 */
function statusFromConflicts(conflicts: SyncConflict[]): SyncRunStatus {
  return conflicts.some((c) => c.severity === "ERROR") ? "FAILED" : "COMPLETED";
}

export class CatalogSyncService {
  constructor(private readonly repo: CatalogRepository) {}

  async applyBatch(rawBatch: CatalogSyncBatch): Promise<CatalogSyncResult> {
    const prepared = await this.prepareRun(rawBatch);
    if ("errorResult" in prepared) return prepared.errorResult;
    const { batch, runRecord } = prepared;
    const conflicts: SyncConflict[] = [];
    try {
      const applied = await this.repo.transaction((tx) => this.applyBatchInTx(tx, batch, runRecord, conflicts));
      return this.successResult(batch, runRecord, applied);
    } catch (e) {
      return this.handleFailure(e, batch, runRecord, conflicts);
    }
  }

  /**
   * The only public path that performs complete-provider-snapshot reconciliation.
   * One transaction covers the batch upserts, the transaction-scoped mapping
   * reconciliation and the same sync-run record update.
   */
  async applyCompleteProviderSnapshot(
    rawBatch: CatalogSyncBatch,
    reconciliation: ProviderReconciliationDescriptor
  ): Promise<CatalogSyncResult> {
    const prepared = await this.prepareRun(rawBatch);
    if ("errorResult" in prepared) return prepared.errorResult;
    const { batch, runRecord } = prepared;
    const conflicts: SyncConflict[] = [];
    // Deterministic scope: exact coverage tuples only, shared with the WP4B read path.
    runRecord.scopeJson = serializeProviderCoverageScope(reconciliation.coverage);
    try {
      const applied = await this.repo.transaction(async (tx) => {
        const result = await this.applyBatchInTx(tx, batch, runRecord, conflicts);
        const canReconcile =
          batch.provider === reconciliation.provider &&
          batch.completeness === "COMPLETE" &&
          !result.conflicts.some((c) => c.severity === "ERROR");
        if (canReconcile) {
          await tx.reconcileProviderMappings({
            provider: reconciliation.provider,
            coverage: reconciliation.coverage,
            activeNativeIdentifiers: reconciliation.activeNativeIdentifiers,
            ...(reconciliation.sourceVersion !== undefined ? { sourceVersion: reconciliation.sourceVersion } : {}),
            ...(reconciliation.sourceObservedAt !== undefined ? { sourceObservedAt: reconciliation.sourceObservedAt } : {}),
            now: reconciliation.now
          });
          await tx.updateSyncRun(runRecord.runId, {
            sourceVersion: reconciliation.sourceVersion ?? batch.sourceVersion,
            sourceObservedAt: reconciliation.sourceObservedAt ?? batch.sourceObservedAt,
            metadataJson: JSON.stringify({
              ...(batch.metadata ?? {}),
              reconciliation: {
                syncedAt: reconciliation.now,
                coverage: reconciliation.coverage
              }
            })
          });
        }
        return result;
      });
      return this.successResult(batch, runRecord, applied);
    } catch (e) {
      return this.handleFailure(e, batch, runRecord, conflicts);
    }
  }

  private async prepareRun(rawBatch: CatalogSyncBatch): Promise<PreparedRun | { errorResult: CatalogSyncResult }> {
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
      return { errorResult: result };
    }

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
    return { batch, runRecord };
  }

  /**
   * Single apply implementation shared by `applyBatch` and
   * `applyCompleteProviderSnapshot`. Runs entirely inside the supplied
   * transaction; `applyBatch` is never called unchanged inside another tx.
   */
  private async applyBatchInTx(
    tx: CatalogRepositoryTx,
    batch: CatalogSyncBatch,
    runRecord: CatalogSyncRunRecord,
    conflicts: SyncConflict[]
  ): Promise<AppliedBatch> {
    const startedAt = runRecord.startedAt;
    const runId = runRecord.runId;
    const sourceMetaPatches = new Map<string, Record<string, unknown>>();
    let instrumentsUpserted = 0;
    let mappingsUpserted = 0;
    let aliasesUpserted = 0;
    let identifiersUpserted = 0;

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

    // Phase 1: resolve cash underlyings first (existing identity match or symbol-to-ISIN enrichment),
    // independent of input array order. Derivatives are resolved in phase 3 after remapping.
    for (const inst of normalizedInstruments) {
      if (inst.derivative) continue;
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

    // Phase 2: remap incoming derivative underlying IDs to resolved canonical IDs and recompute
    // derivative identity keys so identity resolution and persistence use the resolved underlying.
    for (let i = 0; i < normalizedInstruments.length; i++) {
      const inst = normalizedInstruments[i]!;
      if (!inst.derivative) continue;
      const incomingUnderlying = inst.derivative.underlyingCanonicalId;
      const resolvedUnderlying = resolvedIdByIncomingCanonicalId.get(incomingUnderlying) ?? incomingUnderlying;
      if (resolvedUnderlying === incomingUnderlying) continue;
      const oldIdentityKey = inst.identityKey;
      const remapped: CanonicalInstrument = {
        ...inst,
        underlyingCanonicalId: resolvedUnderlying,
        derivative: { ...inst.derivative, underlyingCanonicalId: resolvedUnderlying }
      };
      remapped.identityKey = computeIdentityKey({
        exchange: remapped.exchange,
        segment: remapped.segment,
        instrumentCategory: remapped.instrumentCategory,
        canonicalSymbol: remapped.canonicalSymbol,
        isin: remapped.isin,
        exchangeSecurityId: remapped.exchangeSecurityId,
        stableIdentifier: remapped.stableIdentifier,
        derivative: {
          underlyingCanonicalId: resolvedUnderlying,
          expiryDate: remapped.derivative!.expiryDate,
          strike: remapped.derivative!.strike,
          strikeNormalized: remapped.derivative!.strikeNormalized,
          optionType: remapped.derivative!.optionType
        }
      });
      normalizedInstruments[i] = remapped;
      if (resolvedIdByIdentity.has(oldIdentityKey)) {
        resolvedIdByIdentity.delete(oldIdentityKey);
        resolvedIdByIdentity.set(remapped.identityKey, remapped.canonicalId);
      }
      const enrich = enrichmentByIdentity.get(oldIdentityKey);
      if (enrich) {
        enrichmentByIdentity.delete(oldIdentityKey);
        enrichmentByIdentity.set(remapped.identityKey, enrich);
      }
    }

    // Phase 3: resolve derivatives against their remapped identity keys (no enrichment for derivatives).
    for (const inst of normalizedInstruments) {
      if (!inst.derivative) continue;
      const existing = await tx.getInstrumentByIdentityKey(inst.identityKey);
      if (existing) {
        resolvedIdByIdentity.set(inst.identityKey, existing.canonicalId);
        resolvedIdByIncomingCanonicalId.set(inst.canonicalId, existing.canonicalId);
      } else {
        resolvedIdByIdentity.set(inst.identityKey, inst.canonicalId);
        resolvedIdByIncomingCanonicalId.set(inst.canonicalId, inst.canonicalId);
      }
    }

    // Final duplicate detection after all resolution/remapping. The pre-remap identityToInstrument
    // map cannot catch collisions created by underlying-ID remapping or enrichment convergence.
    const finalIdentityOwners = new Map<string, string>();
    const resolvedIdOwners = new Map<string, string>();
    for (const inst of normalizedInstruments) {
      const resolvedId = resolvedIdByIdentity.get(inst.identityKey) ?? inst.canonicalId;
      const priorIdentityOwner = finalIdentityOwners.get(inst.identityKey);
      if (priorIdentityOwner && priorIdentityOwner !== inst.canonicalId) {
        conflicts.push({
          type: "DUPLICATE_IDENTITY_IN_BATCH",
          severity: "ERROR",
          message: `Distinct incoming instruments resolve to the same final identity: ${inst.identityKey}`,
          identityKey: inst.identityKey,
          canonicalId: inst.canonicalId,
          details: { otherCanonicalId: priorIdentityOwner }
        });
      } else {
        finalIdentityOwners.set(inst.identityKey, inst.canonicalId);
      }
      const priorResolvedOwner = resolvedIdOwners.get(resolvedId);
      if (priorResolvedOwner && priorResolvedOwner !== inst.canonicalId) {
        conflicts.push({
          type: "DUPLICATE_IDENTITY_IN_BATCH",
          severity: "ERROR",
          message: `Distinct incoming instruments resolve to the same canonical instrument: ${resolvedId}`,
          canonicalId: inst.canonicalId,
          details: { resolvedCanonicalId: resolvedId, otherCanonicalId: priorResolvedOwner }
        });
      } else {
        resolvedIdOwners.set(resolvedId, inst.canonicalId);
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

    // Pre-resolve importing-provider mappings by canonical ID so shared-field
    // analysis can find the mapping(s) for each derivative during the upsert pass.
    const nativeIdsByCanonicalId = new Map<string, string[]>();
    if (batch.provider) {
      for (const m of batch.mappings) {
        if (m.provider !== batch.provider) continue;
        const target = await resolveCanonicalId(m.canonicalId);
        if (!target) continue;
        const list = nativeIdsByCanonicalId.get(target) ?? [];
        list.push(m.nativeIdentifier);
        nativeIdsByCanonicalId.set(target, list);
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

      // Shared derivative field rule (§4.2): compare populated shared attributes
      // against the existing canonical derivative before persisting. Only mappings
      // belonging to the importing provider are annotated.
      if (batch.provider && merged.derivative) {
        const incomingDerivative = merged.derivative;
        const nativeIds = nativeIdsByCanonicalId.get(merged.canonicalId) ?? [];
        for (const nativeIdentifier of nativeIds) {
          const existingMap = await tx.getMapping(batch.provider, nativeIdentifier);
          const analysis = analyzeSharedDerivativeFields({
            existing: existing?.derivative,
            incoming: incomingDerivative,
            lastRecorded: existingMap?.sourceMeta?.[DERIVATIVE_ATTRIBUTES_META_KEY] as Record<string, unknown> | undefined,
            provider: batch.provider,
            nativeIdentifier,
            canonicalId: merged.canonicalId,
            source: batch.source,
            preserveLifecycle: true
          });
          merged.derivative = analysis.canonicalDerivative;
          conflicts.push(...analysis.warnings);
          const key = `${batch.provider}\u0000${nativeIdentifier}`;
          sourceMetaPatches.set(key, {
            ...(sourceMetaPatches.get(key) ?? {}),
            [DERIVATIVE_ATTRIBUTES_META_KEY]: analysis.derivativeAttributes
          });
        }
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

    for (const m of batch.mappings) {
      const nm = normalizeMapping(m, startedAt);
      const patch = sourceMetaPatches.get(`${nm.provider}\u0000${nm.nativeIdentifier}`);
      if (patch) nm.sourceMeta = { ...(nm.sourceMeta ?? {}), ...patch };
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
      status: statusFromConflicts(conflicts),
      finishedAt,
      countsJson: JSON.stringify(counts),
      conflictsJson: JSON.stringify(conflicts)
    });
    return { conflicts, counts, finishedAt };
  }

  private successResult(batch: CatalogSyncBatch, runRecord: CatalogSyncRunRecord, applied: AppliedBatch): CatalogSyncResult {
    return {
      runId: runRecord.runId,
      status: statusFromConflicts(applied.conflicts),
      source: batch.source,
      completeness: batch.completeness,
      startedAt: runRecord.startedAt,
      finishedAt: applied.finishedAt,
      counts: applied.counts,
      conflicts: applied.conflicts
    };
  }

  private async handleFailure(
    e: unknown,
    batch: CatalogSyncBatch,
    runRecord: CatalogSyncRunRecord,
    conflicts: SyncConflict[]
  ): Promise<CatalogSyncResult> {
    if (e instanceof SyncConflictError) {
      const result: CatalogSyncResult = {
        runId: runRecord.runId,
        status: "FAILED",
        source: batch.source,
        completeness: batch.completeness,
        startedAt: runRecord.startedAt,
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
        runId: runRecord.runId,
        source: batch.source,
        provider: batch.provider,
        scopeJson: runRecord.scopeJson,
        completeness: batch.completeness,
        status: "FAILED",
        startedAt: runRecord.startedAt,
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
      runId: runRecord.runId,
      status: "FAILED",
      source: batch.source,
      completeness: batch.completeness,
      startedAt: runRecord.startedAt,
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
      runId: runRecord.runId,
      source: batch.source,
      provider: batch.provider,
      scopeJson: runRecord.scopeJson,
      completeness: batch.completeness,
      status: "FAILED",
      startedAt: runRecord.startedAt,
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

  private async recordRunBestEffort(run: CatalogSyncRunRecord): Promise<void> {
    try {
      if (this.repo.recordSyncRun) await this.repo.recordSyncRun(run);
    } catch {
      // best effort: catalog state integrity already preserved
    }
  }
}
