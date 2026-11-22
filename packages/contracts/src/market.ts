import { z } from "zod";
import { providerIdSchema, type ProviderId } from "./provider-identity";

// --- Classification / lifecycle ---
export const exchangeSchema = z.enum(["NSE", "BSE"]);
export type Exchange = z.infer<typeof exchangeSchema>;

export const segmentSchema = z.string().min(1).max(32);
export type Segment = z.infer<typeof segmentSchema>;

export const marketTypeSchema = z.enum(["CASH", "DERIVATIVE", "INDEX", "UNKNOWN"]);
export type MarketType = z.infer<typeof marketTypeSchema>;

export const instrumentCategorySchema = z.enum([
  "EQUITY",
  "INDEX",
  "STOCK_FUTURE",
  "STOCK_OPTION",
  "INDEX_FUTURE",
  "INDEX_OPTION"
]);
export type InstrumentCategory = z.infer<typeof instrumentCategorySchema>;

export const tradingStatusSchema = z.enum(["ACTIVE", "INACTIVE", "SUSPENDED", "EXPIRED", "UNKNOWN"]);
export type TradingStatus = z.infer<typeof tradingStatusSchema>;

export const instrumentLifecycleStatusSchema = z.enum(["ACTIVE", "INACTIVE", "EXPIRED", "DELISTED", "UNKNOWN"]);
export type InstrumentLifecycleStatus = z.infer<typeof instrumentLifecycleStatusSchema>;

export const optionTypeSchema = z.enum(["CE", "PE"]);
export type OptionType = z.infer<typeof optionTypeSchema>;

// Same schema instance as providerIdSchema — a compatibility alias, not a second enum.
export const providerSchema = providerIdSchema;
export type Provider = ProviderId;

// --- Provenance / freshness / availability ---
export const availabilityStateSchema = z.enum(["AVAILABLE", "UNAVAILABLE", "UNSUPPORTED", "UNKNOWN", "LIMITED"]);
export type AvailabilityState = z.infer<typeof availabilityStateSchema>;

export const provenanceSchema = z.object({
  source: z.string().min(1),
  provider: providerSchema.optional(),
  sourceObservedAt: z.string().datetime().optional(),
  receivedAt: z.string().datetime().optional(),
  syncedAt: z.string().datetime().optional(),
  sourceVersion: z.string().optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
  notes: z.string().optional()
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const freshnessSchema = z.object({
  state: z.enum(["FRESH", "STALE", "UNKNOWN"]),
  asOf: z.string().datetime().optional(),
  ageMs: z.number().int().nonnegative().optional()
});
export type Freshness = z.infer<typeof freshnessSchema>;

// --- Eligibility / scope (separate concepts) ---
export const cashIndexMembershipSchema = z.object({
  member: z.boolean(),
  source: z.string().min(1).optional(),
  asOf: z.string().datetime().optional(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
  notes: z.string().optional()
});
export type CashIndexMembership = z.infer<typeof cashIndexMembershipSchema>;

export const exchangeDerivativeEligibilitySchema = z.object({
  eligible: z.boolean(),
  exchange: exchangeSchema,
  product: z.string().min(1).optional(), // e.g. INDEX_FO, STOCK_FO
  underlyingScope: z.string().min(1).optional(),
  source: z.string().min(1),
  asOf: z.string().datetime(),
  effectiveFrom: z.string().datetime().optional(),
  effectiveTo: z.string().datetime().optional(),
  status: z.string().min(1).optional(),
  notes: z.string().optional()
});
export type ExchangeDerivativeEligibility = z.infer<typeof exchangeDerivativeEligibilitySchema>;

export const marketHubProductScopeSchema = z.object({
  supported: z.boolean(),
  scope: z.string().min(1), // e.g. NSE_INDEX_FO_APPROVED, NSE_STOCK_FO, BSE_SENSEX_FO
  reason: z.string().optional(),
  asOf: z.string().datetime().optional(),
  notes: z.string().optional()
});
export type MarketHubProductScope = z.infer<typeof marketHubProductScopeSchema>;

// --- Canonical instrument ---
export const strikeInputSchema = z.union([z.string().min(1), z.number().positive()]);
export type StrikeInput = z.infer<typeof strikeInputSchema>;

export const derivativeSpecSchema = z.object({
  underlyingCanonicalId: z.string().min(1),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strike: strikeInputSchema.optional(),
  strikeNormalized: z.string().min(1).optional(),
  optionType: optionTypeSchema.optional(),
  lotSize: z.number().positive().optional(),
  tickSize: z.number().positive().optional(),
  quantityFreeze: z.number().positive().optional(),
  contractLifecycleStatus: instrumentLifecycleStatusSchema.optional(),
  contractSource: z.string().optional(),
  contractObservedAt: z.string().datetime().optional(),
  supplementalMeta: z.record(z.string(), z.unknown()).optional()
});
export type DerivativeSpec = z.infer<typeof derivativeSpecSchema>;

export const canonicalInstrumentSchema = z.object({
  canonicalId: z.string().min(1),
  identityKey: z.string().min(1),
  identityVersion: z.number().int().positive().default(1),
  exchange: exchangeSchema,
  segment: segmentSchema,
  marketType: marketTypeSchema,
  instrumentCategory: instrumentCategorySchema,
  canonicalSymbol: z.string().min(1),
  displayName: z.string().min(1),
  stableIdentifier: z.string().min(1).optional(), // exchange-recognized stable code/id when applicable
  underlyingCanonicalId: z.string().min(1).optional(),
  isin: z.string().min(1).optional(),
  exchangeSecurityId: z.string().min(1).optional(),
  tradingStatus: tradingStatusSchema.default("UNKNOWN"),
  lifecycleStatus: instrumentLifecycleStatusSchema.default("UNKNOWN"),
  derivative: derivativeSpecSchema.optional(),
  cashIndexMembership: cashIndexMembershipSchema.optional(),
  exchangeDerivativeEligibility: z.array(exchangeDerivativeEligibilitySchema).optional(),
  productScope: z.array(marketHubProductScopeSchema).optional(),
  sourceMeta: z.record(z.string(), z.unknown()).optional(),
  provenance: provenanceSchema.optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
}).superRefine((val, ctx) => {
  const isFuture = val.instrumentCategory === "STOCK_FUTURE" || val.instrumentCategory === "INDEX_FUTURE";
  const isOption = val.instrumentCategory === "STOCK_OPTION" || val.instrumentCategory === "INDEX_OPTION";
  const isDerivative = isFuture || isOption;
  const isCash = val.instrumentCategory === "EQUITY" || val.instrumentCategory === "INDEX";

  if (isCash && val.derivative) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Cash/index instrument must not have derivative spec", path: ["derivative"] });
  }
  if (isDerivative) {
    if (!val.derivative) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Derivative instrument requires derivative spec", path: ["derivative"] });
    } else {
      if (!val.underlyingCanonicalId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Derivative instrument requires underlyingCanonicalId", path: ["underlyingCanonicalId"] });
      }
      if (val.underlyingCanonicalId && val.derivative.underlyingCanonicalId !== val.underlyingCanonicalId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "underlyingCanonicalId mismatch", path: ["underlyingCanonicalId"] });
      }
      if (isFuture) {
        if (val.derivative.optionType !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Future must not have optionType", path: ["derivative", "optionType"] });
        if (val.derivative.strike !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Future must not have strike", path: ["derivative", "strike"] });
      }
      if (isOption) {
        if (val.derivative.optionType === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Option requires optionType", path: ["derivative", "optionType"] });
        if (val.derivative.strike === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Option requires positive strike", path: ["derivative", "strike"] });
      }
    }
  }
  if (val.instrumentCategory === "EQUITY" && val.marketType !== "CASH" && val.marketType !== "UNKNOWN") {
    // allow UNKNOWN for flexibility, but prefer CASH
  }
  if (val.instrumentCategory === "INDEX" && val.marketType !== "INDEX" && val.marketType !== "UNKNOWN") {
    // prefer INDEX
  }
});
export type CanonicalInstrument = z.infer<typeof canonicalInstrumentSchema>;

// --- Provider mappings ---
export const providerMappingStatusSchema = z.enum(["ACTIVE", "INACTIVE", "REMOVED", "UNKNOWN"]);
export type ProviderMappingStatus = z.infer<typeof providerMappingStatusSchema>;

export const providerInstrumentMappingSchema = z.object({
  provider: providerSchema,
  nativeIdentifier: z.string().min(1),
  canonicalId: z.string().min(1),
  exchange: exchangeSchema.optional(),
  segment: segmentSchema.optional(),
  nativeSymbol: z.string().optional(),
  nativeExchangeToken: z.string().optional(), // e.g. Upstox exchange_token / FYERS exToken (not canonical identity)
  status: providerMappingStatusSchema.default("ACTIVE"),
  sourceMeta: z.record(z.string(), z.unknown()).optional(),
  provenance: provenanceSchema.optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});
export type ProviderInstrumentMapping = z.infer<typeof providerInstrumentMappingSchema>;

// --- Aliases ---
export const aliasTypeSchema = z.string().min(1).max(64);
export type AliasType = z.infer<typeof aliasTypeSchema>;

export const instrumentAliasSchema = z.object({
  canonicalId: z.string().min(1),
  alias: z.string().min(1),
  aliasNormalized: z.string().min(1),
  aliasType: aliasTypeSchema,
  source: z.string().min(1),
  exchange: exchangeSchema.optional(),
  segment: segmentSchema.optional(),
  exchangeScope: z.string().min(1).default("*"),
  segmentScope: z.string().min(1).default("*"),
  status: z.enum(["ACTIVE", "INACTIVE", "UNKNOWN"]).default("ACTIVE"),
  provenance: provenanceSchema.optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});
export type InstrumentAlias = z.infer<typeof instrumentAliasSchema>;

// --- Identifier history (identity enrichment / lifecycle) ---
export const identifierStatusSchema = z.enum(["CURRENT", "HISTORICAL", "SUPERSEDED", "DISPUTED"]);
export type IdentifierStatus = z.infer<typeof identifierStatusSchema>;

export const instrumentIdentifierSchema = z.object({
  canonicalId: z.string().min(1),
  identifierType: z.string().min(1).max(64), // e.g. ISIN, EXCHANGE_SECURITY_ID, STABLE_ID, SYMBOL
  identifierNamespace: z.string().min(1).max(64), // e.g. NSE, BSE, CANONICAL, UPSTOX, FYERS
  identifierValue: z.string().min(1),
  identifierNormalized: z.string().min(1),
  exchange: exchangeSchema.optional(),
  segment: segmentSchema.optional(),
  exchangeScope: z.string().min(1).default("*"),
  segmentScope: z.string().min(1).default("*"),
  source: z.string().min(1),
  provenance: provenanceSchema.optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
  status: identifierStatusSchema.default("CURRENT"),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});
export type InstrumentIdentifier = z.infer<typeof instrumentIdentifierSchema>;

// --- Sync ---
export const syncCompletenessSchema = z.enum(["COMPLETE", "PARTIAL", "INCREMENTAL"]);
export type SyncCompleteness = z.infer<typeof syncCompletenessSchema>;

export const syncRunStatusSchema = z.enum(["RUNNING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
export type SyncRunStatus = z.infer<typeof syncRunStatusSchema>;

export const catalogSyncScopeSchema = z.object({
  source: z.string().min(1),
  provider: providerSchema.optional(),
  exchange: exchangeSchema.optional(),
  segment: segmentSchema.optional(),
  instrumentCategory: instrumentCategorySchema.optional(),
  universe: z.string().optional(),
  description: z.string().optional()
});
export type CatalogSyncScope = z.infer<typeof catalogSyncScopeSchema>;

export const catalogSyncBatchSchema = z.object({
  source: z.string().min(1),
  provider: providerSchema.optional(),
  scope: catalogSyncScopeSchema,
  completeness: syncCompletenessSchema,
  sourceVersion: z.string().optional(),
  sourceObservedAt: z.string().datetime().optional(),
  instruments: z.array(canonicalInstrumentSchema).default([]),
  mappings: z.array(providerInstrumentMappingSchema).default([]),
  aliases: z.array(instrumentAliasSchema).default([]),
  identifiers: z.array(instrumentIdentifierSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type CatalogSyncBatch = z.infer<typeof catalogSyncBatchSchema>;

export const syncConflictSchema = z.object({
  type: z.string().min(1),
  severity: z.enum(["INFO", "WARNING", "ERROR"]).default("ERROR"),
  message: z.string().min(1),
  canonicalId: z.string().optional(),
  identityKey: z.string().optional(),
  provider: providerSchema.optional(),
  nativeIdentifier: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional()
});
export type SyncConflict = z.infer<typeof syncConflictSchema>;

export const catalogSyncResultSchema = z.object({
  runId: z.string().min(1),
  status: syncRunStatusSchema,
  source: z.string().min(1),
  completeness: syncCompletenessSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  counts: z.object({
    instrumentsReceived: z.number().int().nonnegative(),
    instrumentsUpserted: z.number().int().nonnegative(),
    mappingsReceived: z.number().int().nonnegative(),
    mappingsUpserted: z.number().int().nonnegative(),
    aliasesReceived: z.number().int().nonnegative(),
    aliasesUpserted: z.number().int().nonnegative(),
    identifiersReceived: z.number().int().nonnegative(),
    identifiersUpserted: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative()
  }),
  conflicts: z.array(syncConflictSchema).default([]),
  error: z.string().optional()
});
export type CatalogSyncResult = z.infer<typeof catalogSyncResultSchema>;
