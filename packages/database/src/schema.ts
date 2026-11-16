import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export type AppMeta = typeof appMeta.$inferSelect;
export type NewAppMeta = typeof appMeta.$inferInsert;

export const canonicalInstruments = sqliteTable(
  "canonical_instruments",
  {
    canonicalId: text("canonical_id").primaryKey(),
    identityKey: text("identity_key").notNull(),
    identityVersion: integer("identity_version").notNull().default(1),
    exchange: text("exchange").notNull(),
    segment: text("segment").notNull(),
    marketType: text("market_type").notNull(),
    instrumentCategory: text("instrument_category").notNull(),
    canonicalSymbol: text("canonical_symbol").notNull(),
    displayName: text("display_name").notNull(),
    stableIdentifier: text("stable_identifier"),
    underlyingCanonicalId: text("underlying_canonical_id"),
    isin: text("isin"),
    exchangeSecurityId: text("exchange_security_id"),
    tradingStatus: text("trading_status").notNull(),
    lifecycleStatus: text("lifecycle_status").notNull(),
    derivativeJson: text("derivative_json"), // supplemental source-specific metadata only
    cashIndexMembershipJson: text("cash_index_membership_json"),
    exchangeDerivativeEligibilityJson: text("exchange_derivative_eligibility_json"),
    productScopeJson: text("product_scope_json"),
    sourceMetaJson: text("source_meta_json"),
    provenanceJson: text("provenance_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("canonical_instruments_identity_key_uq").on(t.identityKey),
    index("canonical_instruments_exchange_segment_idx").on(t.exchange, t.segment),
    index("canonical_instruments_category_idx").on(t.instrumentCategory),
    index("canonical_instruments_symbol_idx").on(t.canonicalSymbol),
    index("canonical_instruments_isin_idx").on(t.isin),
    index("canonical_instruments_exchange_security_id_idx").on(t.exchangeSecurityId),
    index("canonical_instruments_underlying_idx").on(t.underlyingCanonicalId)
  ]
);

export const derivativeContracts = sqliteTable(
  "derivative_contracts",
  {
    canonicalId: text("canonical_id")
      .primaryKey()
      .references(() => canonicalInstruments.canonicalId, { onDelete: "cascade", onUpdate: "cascade" }),
    exchange: text("exchange").notNull(),
    segment: text("segment").notNull(),
    derivativeClass: text("derivative_class").notNull(), // STOCK_FUTURE|STOCK_OPTION|INDEX_FUTURE|INDEX_OPTION
    underlyingCanonicalId: text("underlying_canonical_id")
      .notNull()
      .references(() => canonicalInstruments.canonicalId, { onDelete: "restrict", onUpdate: "cascade" }),
    expiryDate: text("expiry_date").notNull(), // YYYY-MM-DD
    strikeNormalized: text("strike_normalized"), // null for futures
    optionType: text("option_type"), // CE|PE or null for futures
    strikeKey: text("strike_key").notNull().default(""), // '' for futures, normalized strike for options
    optionTypeKey: text("option_type_key").notNull().default(""), // '' for futures
    lotSize: integer("lot_size"),
    tickSize: text("tick_size"), // stored as decimal text for exactness
    quantityFreeze: integer("quantity_freeze"),
    contractLifecycleStatus: text("contract_lifecycle_status"),
    contractSource: text("contract_source"),
    contractObservedAt: text("contract_observed_at"),
    supplementalMetaJson: text("supplemental_meta_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("derivative_contracts_identity_uq").on(
      t.exchange,
      t.segment,
      t.derivativeClass,
      t.underlyingCanonicalId,
      t.expiryDate,
      t.strikeKey,
      t.optionTypeKey
    ),
    index("derivative_contracts_underlying_idx").on(t.underlyingCanonicalId),
    index("derivative_contracts_expiry_idx").on(t.expiryDate),
    index("derivative_contracts_underlying_expiry_idx").on(t.underlyingCanonicalId, t.expiryDate),
    index("derivative_contracts_class_idx").on(t.derivativeClass),
    check(
      "derivative_contracts_future_shape_ck",
      sql`(
        (${t.derivativeClass} IN ('STOCK_FUTURE','INDEX_FUTURE') AND ${t.strikeNormalized} IS NULL AND ${t.optionType} IS NULL AND ${t.strikeKey} = '' AND ${t.optionTypeKey} = '')
        OR
        (${t.derivativeClass} IN ('STOCK_OPTION','INDEX_OPTION') AND ${t.strikeNormalized} IS NOT NULL AND ${t.optionType} IN ('CE','PE') AND ${t.strikeKey} <> '' AND ${t.optionTypeKey} IN ('CE','PE') AND CAST(${t.strikeNormalized} AS REAL) > 0)
      )`
    ),
    check("derivative_contracts_lot_size_ck", sql`(${t.lotSize} IS NULL OR ${t.lotSize} > 0)`),
    check("derivative_contracts_quantity_freeze_ck", sql`(${t.quantityFreeze} IS NULL OR ${t.quantityFreeze} > 0)`),
    check("derivative_contracts_tick_size_ck", sql`(${t.tickSize} IS NULL OR CAST(${t.tickSize} AS REAL) > 0)`)
  ]
);

export const providerInstrumentMappings = sqliteTable(
  "provider_instrument_mappings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    nativeIdentifier: text("native_identifier").notNull(),
    canonicalId: text("canonical_id")
      .notNull()
      .references(() => canonicalInstruments.canonicalId, { onDelete: "restrict", onUpdate: "cascade" }),
    exchange: text("exchange"),
    segment: text("segment"),
    nativeSymbol: text("native_symbol"),
    nativeExchangeToken: text("native_exchange_token"),
    status: text("status").notNull(),
    sourceMetaJson: text("source_meta_json"),
    provenanceJson: text("provenance_json"),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("provider_mappings_provider_native_uq").on(t.provider, t.nativeIdentifier),
    index("provider_mappings_canonical_idx").on(t.canonicalId),
    index("provider_mappings_provider_idx").on(t.provider)
  ]
);

export const instrumentAliases = sqliteTable(
  "instrument_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    canonicalId: text("canonical_id")
      .notNull()
      .references(() => canonicalInstruments.canonicalId, { onDelete: "cascade", onUpdate: "cascade" }),
    alias: text("alias").notNull(),
    aliasNormalized: text("alias_normalized").notNull(),
    aliasType: text("alias_type").notNull(),
    source: text("source").notNull(),
    exchange: text("exchange"),
    segment: text("segment"),
    exchangeScope: text("exchange_scope").notNull().default("*"),
    segmentScope: text("segment_scope").notNull().default("*"),
    status: text("status").notNull(),
    provenanceJson: text("provenance_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("instrument_aliases_uq").on(
      t.canonicalId,
      t.aliasNormalized,
      t.aliasType,
      t.source,
      t.exchangeScope,
      t.segmentScope
    ),
    index("instrument_aliases_alias_norm_idx").on(t.aliasNormalized),
    index("instrument_aliases_canonical_idx").on(t.canonicalId),
    index("instrument_aliases_scope_idx").on(t.exchangeScope, t.segmentScope)
  ]
);

export const instrumentIdentifierHistory = sqliteTable(
  "instrument_identifier_history",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    canonicalId: text("canonical_id")
      .notNull()
      .references(() => canonicalInstruments.canonicalId, { onDelete: "cascade", onUpdate: "cascade" }),
    identifierType: text("identifier_type").notNull(),
    identifierNamespace: text("identifier_namespace").notNull(),
    identifierValue: text("identifier_value").notNull(),
    identifierNormalized: text("identifier_normalized").notNull(),
    exchange: text("exchange"),
    segment: text("segment"),
    exchangeScope: text("exchange_scope").notNull().default("*"),
    segmentScope: text("segment_scope").notNull().default("*"),
    source: text("source").notNull(),
    provenanceJson: text("provenance_json"),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    status: text("status").notNull(), // CURRENT|HISTORICAL|SUPERSEDED|DISPUTED
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => [
    index("instrument_identifier_history_canonical_idx").on(t.canonicalId),
    index("instrument_identifier_history_lookup_idx").on(t.identifierType, t.identifierNamespace, t.identifierNormalized, t.exchangeScope, t.segmentScope),
    index("instrument_identifier_history_status_idx").on(t.status),
    index("instrument_identifier_history_value_idx").on(t.identifierNormalized),
    uniqueIndex("instrument_identifier_history_current_authoritative_uq")
      .on(t.identifierType, t.identifierNamespace, t.identifierNormalized, t.exchangeScope, t.segmentScope)
      .where(sql`${t.status} = 'CURRENT' AND ${t.identifierType} IN ('ISIN','EXCHANGE_SECURITY_ID','STABLE_ID')`)
  ]
);

export const catalogSyncRuns = sqliteTable(
  "catalog_sync_runs",
  {
    runId: text("run_id").primaryKey(),
    source: text("source").notNull(),
    provider: text("provider"),
    scopeJson: text("scope_json").notNull(),
    completeness: text("completeness").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    sourceVersion: text("source_version"),
    sourceObservedAt: text("source_observed_at"),
    countsJson: text("counts_json").notNull(),
    conflictsJson: text("conflicts_json").notNull(),
    error: text("error"),
    metadataJson: text("metadata_json")
  },
  (t) => [
    index("catalog_sync_runs_source_idx").on(t.source),
    index("catalog_sync_runs_status_idx").on(t.status),
    index("catalog_sync_runs_started_idx").on(t.startedAt)
  ]
);

export const providerSettings = sqliteTable(
  "provider_settings",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").notNull()
  }
);

export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    formatVersion: integer("format_version").notNull(),
    nonce: text("nonce").notNull(), // base64
    ciphertext: text("ciphertext").notNull(), // base64
    tag: text("tag").notNull(), // base64
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (t) => [uniqueIndex("provider_credentials_identity_uq").on(t.provider, t.name)]
);

export type CanonicalInstrumentRow = typeof canonicalInstruments.$inferSelect;
export type NewCanonicalInstrumentRow = typeof canonicalInstruments.$inferInsert;
export type DerivativeContractRow = typeof derivativeContracts.$inferSelect;
export type NewDerivativeContractRow = typeof derivativeContracts.$inferInsert;
export type ProviderMappingRow = typeof providerInstrumentMappings.$inferSelect;
export type NewProviderMappingRow = typeof providerInstrumentMappings.$inferInsert;
export type InstrumentAliasRow = typeof instrumentAliases.$inferSelect;
export type NewInstrumentAliasRow = typeof instrumentAliases.$inferInsert;
export type InstrumentIdentifierRow = typeof instrumentIdentifierHistory.$inferSelect;
export type NewInstrumentIdentifierRow = typeof instrumentIdentifierHistory.$inferInsert;
export type CatalogSyncRunRow = typeof catalogSyncRuns.$inferSelect;
export type NewCatalogSyncRunRow = typeof catalogSyncRuns.$inferInsert;
