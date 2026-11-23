import type {
  CanonicalInstrument,
  CatalogSyncBatch,
  Exchange,
  InstrumentCategory,
  ProviderInstrumentMapping
} from "@markethub/contracts";
import { computeIdentityKey } from "../identity";
import type { ProviderCoverageTuple, ProviderReconciliationDescriptor } from "../types";
import { canonicalIdFromIdentity, emptyImportReport, type ProviderImportReport } from "./import-report";
import { parseIndiaExpiry } from "./timestamps";

/** Official Upstox BOD JSON (gzip) — https://upstox.com/developer/api-documentation/instruments/ */
export const UPSTOX_MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";
export const UPSTOX_SOURCE = "UPSTOX_BOD_MASTER";

/** Exact scope tuples actually imported: NSE/BSE FO options + the EQ/INDEX underlyings they need. */
export const UPSTOX_COVERAGE: ProviderCoverageTuple[] = [
  { exchange: "NSE", segment: "NSE_FO", instrumentCategories: ["STOCK_OPTION", "INDEX_OPTION"] },
  { exchange: "BSE", segment: "BSE_FO", instrumentCategories: ["STOCK_OPTION", "INDEX_OPTION"] },
  { exchange: "NSE", segment: "NSE_EQ", instrumentCategories: ["EQUITY"] },
  { exchange: "NSE", segment: "NSE_INDEX", instrumentCategories: ["INDEX"] },
  { exchange: "BSE", segment: "BSE_EQ", instrumentCategories: ["EQUITY"] },
  { exchange: "BSE", segment: "BSE_INDEX", instrumentCategories: ["INDEX"] }
];

const CASH_SEGMENTS: Record<string, InstrumentCategory> = {
  NSE_EQ: "EQUITY", BSE_EQ: "EQUITY", NSE_INDEX: "INDEX", BSE_INDEX: "INDEX"
};
const FO_SEGMENTS = new Set(["NSE_FO", "BSE_FO"]);

export interface UpstoxImportOptions {
  now: string;
  sourceVersion?: string;
  sourceObservedAt?: string;
}

export interface ProviderImportResult {
  batch: CatalogSyncBatch;
  reconciliation: ProviderReconciliationDescriptor;
  report: ProviderImportReport;
}

type Row = Record<string, unknown>;

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function exchangeOf(row: Row): Exchange | undefined {
  const ex = str(row.exchange);
  return ex === "NSE" || ex === "BSE" ? ex : undefined;
}

/**
 * Convert official Upstox BOD JSON rows into one validated complete provider
 * snapshot. Pure: no DB writes. The returned report is the dry-run/validation
 * output (row counts, skipped rows, unresolved underlyings, duplicates).
 */
export function buildUpstoxImport(rows: unknown, options: UpstoxImportOptions): ProviderImportResult {
  if (!Array.isArray(rows)) throw new Error("Upstox BOD master must be a JSON array");
  const report = emptyImportReport("UPSTOX");
  report.rowsSeen = rows.length;

  const instruments: CanonicalInstrument[] = [];
  const mappings: ProviderInstrumentMapping[] = [];
  const activeNativeIdentifiers = new Set<string>();
  const underlyingIdByInstrumentKey = new Map<string, string>();
  const identityOwners = new Map<string, string>();
  const nativeOwners = new Map<string, string>();
  const observedAt = isoOrUndefined(options.sourceObservedAt);

  const addInstrument = (inst: CanonicalInstrument, nativeIdentifier: string): void => {
    const priorIdentity = identityOwners.get(inst.identityKey);
    if (priorIdentity && priorIdentity !== nativeIdentifier) {
      report.duplicateIdentities.push(inst.identityKey);
    } else {
      identityOwners.set(inst.identityKey, nativeIdentifier);
    }
    const priorNative = nativeOwners.get(nativeIdentifier);
    if (priorNative && priorNative !== inst.canonicalId) {
      report.mappingConflicts.push(nativeIdentifier);
    } else {
      nativeOwners.set(nativeIdentifier, inst.canonicalId);
    }
    instruments.push(inst);
  };

  // Pass 1: cash/index underlyings. Only the EQ/INDEX segments are retained.
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") { report.invalidRows++; continue; }
    const row = raw as Row;
    const segment = str(row.segment);
    const category = segment ? CASH_SEGMENTS[segment] : undefined;
    if (!category) {
      // FO rows are handled in pass 2; other segments are out of scope.
      if (!segment || !FO_SEGMENTS.has(segment)) report.skippedOutOfScope++;
      continue;
    }
    const exchange = exchangeOf(row);
    const instrumentKey = str(row.instrument_key);
    if (!exchange || !instrumentKey) { report.invalidRows++; continue; }

    const canonicalSymbol = str(row.trading_symbol) ?? str(row.short_name) ?? str(row.name);
    if (!canonicalSymbol) { report.invalidRows++; continue; }
    const isin = str(row.isin);
    const exchangeSecurityId = str(row.exchange_token);
    const identityKey = computeIdentityKey({
      exchange,
      segment: category === "EQUITY" ? "CASH" : "INDEX",
      instrumentCategory: category,
      canonicalSymbol,
      isin,
      exchangeSecurityId,
      stableIdentifier: instrumentKey
    });
    const inst: CanonicalInstrument = {
      canonicalId: canonicalIdFromIdentity(identityKey),
      identityKey,
      identityVersion: 1,
      exchange,
      segment: category === "EQUITY" ? "CASH" : "INDEX",
      marketType: category === "EQUITY" ? "CASH" : "INDEX",
      instrumentCategory: category,
      canonicalSymbol,
      displayName: str(row.name) ?? canonicalSymbol,
      ...(isin ? { isin } : {}),
      ...(exchangeSecurityId ? { exchangeSecurityId } : {}),
      stableIdentifier: instrumentKey,
      tradingStatus: "ACTIVE",
      lifecycleStatus: "ACTIVE",
      sourceMeta: { instrument_key: instrumentKey, provider_segment: segment },
      provenance: { source: UPSTOX_SOURCE, provider: "UPSTOX", ...(observedAt ? { sourceObservedAt: observedAt } : {}) }
    };
    addInstrument(inst, instrumentKey);
    underlyingIdByInstrumentKey.set(instrumentKey, inst.canonicalId);
    mappings.push({
      provider: "UPSTOX",
      nativeIdentifier: instrumentKey,
      canonicalId: inst.canonicalId,
      exchange,
      segment,
      nativeSymbol: canonicalSymbol,
      ...(exchangeSecurityId ? { nativeExchangeToken: exchangeSecurityId } : {}),
      status: "ACTIVE",
      sourceMeta: { instrument_key: instrumentKey, exchange_token: exchangeSecurityId ?? null, provider_segment: segment }
    });
    activeNativeIdentifiers.add(instrumentKey);
    report.inScopeUnderlyings++;
  }

  // Pass 2: option contracts, resolved strictly through underlying_key.
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") { report.invalidRows++; continue; }
    const row = raw as Row;
    const segment = str(row.segment);
    if (!segment || !FO_SEGMENTS.has(segment)) continue;
    const exchange = exchangeOf(row);
    const instrumentKey = str(row.instrument_key);
    if (!exchange || !instrumentKey) { report.invalidRows++; continue; }

    const optionType = str(row.option_type) ?? str(row.instrument_type);
    if (optionType !== "CE" && optionType !== "PE") {
      report.skippedOutOfScope++; // futures and other FO products are not in scope
      continue;
    }
    const underlyingKey = str(row.underlying_key);
    const underlyingCanonicalId = underlyingKey ? underlyingIdByInstrumentKey.get(underlyingKey) : undefined;
    if (!underlyingCanonicalId) {
      report.unresolvedUnderlyings.push(underlyingKey ?? instrumentKey);
      continue; // never guess an underlying from a display name
    }
    const underlyingType = str(row.underlying_type);
    const isIndex = underlyingType === "INDEX" || (underlyingKey?.includes("_INDEX|") ?? false);
    const category: InstrumentCategory = isIndex ? "INDEX_OPTION" : "STOCK_OPTION";
    const expiry = parseIndiaExpiry(row.expiry);
    if (!expiry.ok) { report.invalidRows++; continue; }
    const strike = num(row.strike_price);
    if (strike === undefined || strike <= 0) { report.invalidRows++; continue; }
    const underlying = instruments.find((i) => i.canonicalId === underlyingCanonicalId);
    const canonicalSymbol = underlying?.canonicalSymbol ?? str(row.name) ?? "OPTION";

    const identityKey = computeIdentityKey({
      exchange,
      segment: "FO",
      instrumentCategory: category,
      canonicalSymbol,
      derivative: { underlyingCanonicalId, expiryDate: expiry.date, strike, optionType }
    });
    const inst: CanonicalInstrument = {
      canonicalId: canonicalIdFromIdentity(identityKey),
      identityKey,
      identityVersion: 1,
      exchange,
      segment: "FO",
      marketType: "DERIVATIVE",
      instrumentCategory: category,
      canonicalSymbol,
      displayName: `${canonicalSymbol} ${strike} ${optionType}`,
      underlyingCanonicalId,
      tradingStatus: "ACTIVE",
      lifecycleStatus: "ACTIVE",
      derivative: {
        underlyingCanonicalId,
        expiryDate: expiry.date,
        strike,
        optionType,
        ...(num(row.lot_size) !== undefined ? { lotSize: num(row.lot_size)! } : {}),
        ...(num(row.tick_size) !== undefined ? { tickSize: num(row.tick_size)! } : {}),
        ...(num(row.freeze_quantity) !== undefined ? { quantityFreeze: num(row.freeze_quantity)! } : {}),
        contractSource: UPSTOX_SOURCE,
        ...(observedAt ? { contractObservedAt: observedAt } : {})
      },
      sourceMeta: { instrument_key: instrumentKey, provider_segment: segment },
      provenance: { source: UPSTOX_SOURCE, provider: "UPSTOX", ...(observedAt ? { sourceObservedAt: observedAt } : {}) }
    };
    addInstrument(inst, instrumentKey);
    mappings.push({
      provider: "UPSTOX",
      nativeIdentifier: instrumentKey,
      canonicalId: inst.canonicalId,
      exchange,
      segment,
      nativeSymbol: str(row.trading_symbol) ?? canonicalSymbol,
      ...(str(row.exchange_token) ? { nativeExchangeToken: str(row.exchange_token)! } : {}),
      status: "ACTIVE",
      sourceMeta: {
        instrument_key: instrumentKey,
        underlying_key: underlyingKey ?? null,
        underlying_type: underlyingType ?? null,
        instrument_type: str(row.instrument_type) ?? null,
        option_type: optionType,
        expiry_raw: row.expiry ?? null
      }
    });
    activeNativeIdentifiers.add(instrumentKey);
    report.inScopeOptions++;
  }

  const batch: CatalogSyncBatch = {
    source: UPSTOX_SOURCE,
    provider: "UPSTOX",
    scope: { source: UPSTOX_SOURCE, provider: "UPSTOX", universe: "NSE_BSE_STOCK_INDEX_OPTIONS" },
    completeness: "COMPLETE",
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(observedAt ? { sourceObservedAt: observedAt } : {}),
    instruments,
    mappings,
    aliases: [],
    identifiers: [],
    metadata: { coverage: UPSTOX_COVERAGE, counts: { options: report.inScopeOptions, underlyings: report.inScopeUnderlyings } }
  };
  const reconciliation: ProviderReconciliationDescriptor = {
    provider: "UPSTOX",
    coverage: UPSTOX_COVERAGE,
    activeNativeIdentifiers,
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(observedAt ? { sourceObservedAt: observedAt } : {}),
    now: options.now
  };
  return { batch, reconciliation, report };
}

/** Dry-run/validation only: returns counts and issues without producing a batch or writing anything. */
export function dryRunUpstoxMaster(rows: unknown, options: UpstoxImportOptions): ProviderImportReport {
  return buildUpstoxImport(rows, options).report;
}
