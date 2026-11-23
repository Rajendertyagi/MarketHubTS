import type {
  CanonicalInstrument,
  CatalogSyncBatch,
  CatalogSyncResult,
  Exchange,
  InstrumentAlias,
  InstrumentCategory,
  InstrumentIdentifier,
  ProviderId,
  ProviderInstrumentMapping,
  SyncCompleteness,
  SyncConflict,
  SyncRunStatus
} from "@markethub/contracts";

export interface DerivativeContractRecord {
  canonicalId: string;
  exchange: string;
  segment: string;
  derivativeClass: string;
  underlyingCanonicalId: string;
  expiryDate: string;
  strikeNormalized?: string | null;
  optionType?: string | null;
  strikeKey: string;
  optionTypeKey: string;
  lotSize?: number | null;
  tickSize?: string | null;
  quantityFreeze?: number | null;
  contractLifecycleStatus?: string | null;
  contractSource?: string | null;
  contractObservedAt?: string | null;
  supplementalMetaJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogRepository {
  transaction<T>(fn: (tx: CatalogRepositoryTx) => Promise<T> | T): Promise<T>;
  getInstrumentByCanonicalId(canonicalId: string): Promise<CanonicalInstrument | null>;
  getInstrumentByIdentityKey(identityKey: string): Promise<CanonicalInstrument | null>;
  listInstruments(): Promise<CanonicalInstrument[]>;
  /**
   * Bounded, deterministic catalog search. Fetches at most `limit + 1` rows so
   * callers can detect a following page via lookahead; returns up to that many
   * rows in canonical_id ASC order. The extra row is discarded by the caller.
   */
  searchInstruments(query: { text: string; limit: number; afterCanonicalId?: string }): Promise<CanonicalInstrument[]>;
  getMapping(provider: string, nativeIdentifier: string): Promise<ProviderInstrumentMapping | null>;
  listMappingsByCanonicalId(canonicalId: string): Promise<ProviderInstrumentMapping[]>;
  listAliasesByCanonicalId(canonicalId: string): Promise<InstrumentAlias[]>;
  findAlias(alias: string, exchange?: string, segment?: string): Promise<InstrumentAlias[]>;
  listIdentifiersByCanonicalId(canonicalId: string): Promise<InstrumentIdentifier[]>;
  findIdentifiers(query: { identifierType?: string; identifierNamespace?: string; identifierNormalized?: string; exchangeScope?: string; segmentScope?: string; status?: string }): Promise<InstrumentIdentifier[]>;
  getDerivativeContract(canonicalId: string): Promise<DerivativeContractRecord | null>;
  findDerivativeContracts(query: { underlyingCanonicalId?: string; expiryDate?: string; derivativeClass?: string }): Promise<DerivativeContractRecord[]>;
  getSyncRun(runId: string): Promise<CatalogSyncRunRecord | null>;
  /**
   * Bounded, provider-aware expiry discovery. Returns distinct `YYYY-MM-DD`
   * expiry dates in ascending order for ACTIVE option mappings of the given
   * provider and underlying with `expiryDate >= today`. The hard limit is
   * applied in the database; callers must not use the unbounded
   * `findDerivativeContracts` path for this read model.
   */
  listDerivativeExpiries(query: {
    underlyingCanonicalId: string;
    provider: ProviderId;
    today: string;
    limit: number;
  }): Promise<string[]>;
  /**
   * Latest sync run for one exact provider/source/scope/status(/completeness)
   * tuple. `scopeJson` must be byte-for-byte equal to the value produced by
   * `serializeProviderCoverageScope` on the write path; no JSON parsing in SQL.
   * Ordered `finishedAt DESC, startedAt DESC, runId DESC` with `LIMIT 1`.
   */
  getLatestProviderSync(
    provider: ProviderId,
    source: string,
    scopeJson: string,
    statuses: SyncRunStatus[],
    completeness?: SyncCompleteness | SyncCompleteness[]
  ): Promise<CatalogSyncRunRecord | null>;
  /** Bounded, newest-first sync-run history used by the app-owned refresh owner. */
  listSyncRuns(query?: { provider?: string; status?: string; limit?: number }): Promise<CatalogSyncRunRecord[]>;
  /** Best-effort persistence outside a catalog transaction (e.g. failed run after rollback). Optional. */
  recordSyncRun?(run: CatalogSyncRunRecord): Promise<void>;
}

/** One exact provider scope tuple. `segment` is the provider's own segment value. */
export interface ProviderCoverageTuple {
  exchange: Exchange;
  segment: string;
  instrumentCategories: InstrumentCategory[];
}

/** Input for a complete-provider-snapshot reconciliation. */
export interface ProviderMappingReconciliationInput {
  provider: ProviderId;
  coverage: ProviderCoverageTuple[];
  activeNativeIdentifiers: ReadonlySet<string>;
  sourceVersion?: string;
  sourceObservedAt?: string;
  now: string;
}

export interface ProviderMappingReconciliationResult {
  examined: number;
  removedNativeIdentifiers: string[];
}

/** Public descriptor for `CatalogSyncService.applyCompleteProviderSnapshot`. */
export interface ProviderReconciliationDescriptor extends ProviderMappingReconciliationInput {}

export interface CatalogRepositoryTx {
  getInstrumentByCanonicalId(canonicalId: string): Promise<CanonicalInstrument | null>;
  getInstrumentByIdentityKey(identityKey: string): Promise<CanonicalInstrument | null>;
  upsertInstrument(instrument: CanonicalInstrument): Promise<{ created: boolean }>;
  upsertDerivativeContract(contract: DerivativeContractRecord): Promise<{ created: boolean }>;
  getMapping(provider: string, nativeIdentifier: string): Promise<ProviderInstrumentMapping | null>;
  upsertMapping(mapping: ProviderInstrumentMapping): Promise<{ created: boolean }>;
  upsertAlias(alias: InstrumentAlias): Promise<{ created: boolean }>;
  upsertIdentifier(identifier: InstrumentIdentifier): Promise<{ created: boolean }>;
  listIdentifiersByCanonicalId(canonicalId: string): Promise<InstrumentIdentifier[]>;
  findIdentifiers(query: { identifierType?: string; identifierNamespace?: string; identifierNormalized?: string; exchangeScope?: string; segmentScope?: string; status?: string }): Promise<InstrumentIdentifier[]>;
  createSyncRun(run: CatalogSyncRunRecord): Promise<void>;
  updateSyncRun(runId: string, patch: Partial<CatalogSyncRunRecord>): Promise<void>;
  /** Transaction-scoped complete-snapshot reconciliation. Never a standalone cleanup action. */
  reconcileProviderMappings(input: ProviderMappingReconciliationInput): Promise<ProviderMappingReconciliationResult>;
}

export interface CatalogSyncRunRecord {
  runId: string;
  source: string;
  provider?: string | undefined;
  scopeJson: string;
  completeness: string;
  status: SyncRunStatus;
  startedAt: string;
  finishedAt?: string | undefined;
  sourceVersion?: string | undefined;
  sourceObservedAt?: string | undefined;
  countsJson: string;
  conflictsJson: string;
  error?: string | undefined;
  metadataJson?: string | undefined;
}

export interface SyncService {
  applyBatch(batch: CatalogSyncBatch): Promise<CatalogSyncResult>;
  applyCompleteProviderSnapshot(batch: CatalogSyncBatch, reconciliation: ProviderReconciliationDescriptor): Promise<CatalogSyncResult>;
}

export type { SyncConflict };
