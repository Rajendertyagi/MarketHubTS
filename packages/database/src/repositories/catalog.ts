import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type {
  CanonicalInstrument,
  InstrumentAlias,
  InstrumentIdentifier,
  ProviderInstrumentMapping
} from "@markethub/contracts";
import { normalizeAliasValue, normalizeScope } from "@markethub/market-core";
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
import {
  aliasToRow, identifierToRow, instrumentToDerivativeRow, instrumentToRow,
  mappingToRow, rowToAlias, rowToDerivativeContract, rowToIdentifier,
  rowToInstrument, rowToMapping, rowToSyncRun, syncRunToRow
} from "./catalog-mappers";
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
  async searchInstruments(query: { text: string; limit: number; afterCanonicalId?: string }): Promise<CanonicalInstrument[]> {
    const text = query.text.trim();
    if (!text) return [];
    // Escape LIKE metacharacters so a literal '%' or '_' cannot broaden the search.
    const escaped = text.replace(/[\\%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const match = sql`(lower(${canonicalInstruments.canonicalSymbol}) like lower(${pattern}) escape '\\' or lower(${canonicalInstruments.displayName}) like lower(${pattern}) escape '\\' or lower(${canonicalInstruments.identityKey}) like lower(${pattern}) escape '\\')`;
    const conds: SQL[] = [match];
    if (query.afterCanonicalId !== undefined) {
      conds.push(sql`${canonicalInstruments.canonicalId} > ${query.afterCanonicalId}`);
    }
    // limit + 1 lookahead: the caller discards the extra row and derives nextCursor.
    const rows = this.db
      .select()
      .from(canonicalInstruments)
      .where(and(...conds))
      .orderBy(asc(canonicalInstruments.canonicalId))
      .limit(Math.max(1, query.limit) + 1)
      .all();
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
