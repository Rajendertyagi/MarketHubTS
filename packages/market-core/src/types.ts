import type {
  CanonicalInstrument,
  CatalogSyncBatch,
  CatalogSyncResult,
  InstrumentAlias,
  InstrumentIdentifier,
  ProviderInstrumentMapping,
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
  /** Best-effort persistence outside a catalog transaction (e.g. failed run after rollback). Optional. */
  recordSyncRun?(run: CatalogSyncRunRecord): Promise<void>;
}

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
}

export type { SyncConflict };
