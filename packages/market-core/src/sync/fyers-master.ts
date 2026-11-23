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
import type { ProviderImportResult } from "./upstox-master";

/** Official FYERS Symbol Master JSON files (public HTTPS, no broker token). */
export const FYERS_MASTER_URLS = {
  NSE_FO: "https://public.fyers.in/sym_details/NSE_FO_sym_master.json",
  BSE_FO: "https://public.fyers.in/sym_details/BSE_FO_sym_master.json",
  NSE_CM: "https://public.fyers.in/sym_details/NSE_CM_sym_master.json",
  BSE_CM: "https://public.fyers.in/sym_details/BSE_CM_sym_master.json"
} as const;

export type FyersMasterSegment = keyof typeof FYERS_MASTER_URLS;
export const FYERS_SOURCE = "FYERS_SYMBOL_MASTER";

/** Exact scope tuples actually imported. `segment` is the source file segment. */
export const FYERS_COVERAGE: ProviderCoverageTuple[] = [
  { exchange: "NSE", segment: "NSE_FO", instrumentCategories: ["STOCK_OPTION", "INDEX_OPTION"] },
  { exchange: "BSE", segment: "BSE_FO", instrumentCategories: ["STOCK_OPTION", "INDEX_OPTION"] },
  { exchange: "NSE", segment: "NSE_CM", instrumentCategories: ["EQUITY", "INDEX"] },
  { exchange: "BSE", segment: "BSE_CM", instrumentCategories: ["EQUITY", "INDEX"] }
];

export interface FyersImportOptions {
  now: string;
  sourceVersion?: string;
  /**
   * Ignored. The FYERS source data date is derived from in-scope `lastUpdate`
   * values; a local fetch time must never be substituted for a source date.
   */
  sourceObservedAt?: string;
}

export type FyersMasterFiles = Partial<Record<FyersMasterSegment, unknown>>;

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
  const name = str(row.exchangeName);
  if (name === "NSE" || name === "BSE") return name;
  return undefined;
}

function rowsOf(file: unknown): Row[] {
  if (Array.isArray(file)) return file.filter((r): r is Row => !!r && typeof r === "object");
  if (file && typeof file === "object") {
    return Object.values(file as Record<string, unknown>).filter((r): r is Row => !!r && typeof r === "object");
  }
  return [];
}

function observedAtFrom(row: Row): string | undefined {
  const lastUpdate = str(row.lastUpdate);
  if (!lastUpdate || !/^\d{4}-\d{2}-\d{2}$/.test(lastUpdate)) return undefined;
  return `${lastUpdate}T00:00:00.000Z`;
}

/**
 * Convert the official FYERS Symbol Master JSON files into one validated
 * complete provider snapshot. Pure: no DB writes. Underlyings are resolved
 * strictly by `underFyTok` -> `fyToken`; `underSym` is never used as a fallback.
 */
export function buildFyersImport(files: FyersMasterFiles, options: FyersImportOptions): ProviderImportResult {
  const report = emptyImportReport("FYERS");
  const instruments: CanonicalInstrument[] = [];
  const mappings: ProviderInstrumentMapping[] = [];
  const activeNativeIdentifiers = new Set<string>();
  const identityOwners = new Map<string, string>();
  const nativeOwners = new Map<string, string>();
  // Per-file source dates are collected only from rows actually imported.
  const lastUpdateBySegment = new Map<FyersMasterSegment, string[]>();
  const recordSourceDate = (segment: FyersMasterSegment, row: Row): void => {
    const observed = observedAtFrom(row);
    if (!observed) return;
    const dates = lastUpdateBySegment.get(segment) ?? [];
    dates.push(observed);
    lastUpdateBySegment.set(segment, dates);
  };

  const tagged: Array<{ segment: FyersMasterSegment; row: Row }> = [];
  for (const segment of Object.keys(FYERS_MASTER_URLS) as FyersMasterSegment[]) {
    const file = files[segment];
    if (file === undefined) continue;
    const rows = rowsOf(file);
    report.rowsSeen += rows.length;
    for (const row of rows) tagged.push({ segment, row });
  }

  const rowByFyToken = new Map<string, Row>();
  for (const { row } of tagged) {
    const token = str(row.fyToken);
    if (token) rowByFyToken.set(token, row);
  }

  const addInstrument = (inst: CanonicalInstrument, nativeIdentifier: string): void => {
    const priorIdentity = identityOwners.get(inst.identityKey);
    if (priorIdentity && priorIdentity !== nativeIdentifier) report.duplicateIdentities.push(inst.identityKey);
    else identityOwners.set(inst.identityKey, nativeIdentifier);
    const priorNative = nativeOwners.get(nativeIdentifier);
    if (priorNative && priorNative !== inst.canonicalId) report.mappingConflicts.push(nativeIdentifier);
    else nativeOwners.set(nativeIdentifier, inst.canonicalId);
    instruments.push(inst);
  };

  const isActive = (row: Row): boolean => num(row.tradeStatus) === 1;

  // Pass 1: only the CM underlyings actually referenced by in-scope option rows.
  const referencedUnderlyings = new Set<string>();
  for (const { segment, row } of tagged) {
    if (segment !== "NSE_FO" && segment !== "BSE_FO") continue;
    const optType = str(row.optType);
    if (optType !== "CE" && optType !== "PE") continue;
    const underFyTok = str(row.underFyTok);
    if (underFyTok) referencedUnderlyings.add(underFyTok);
  }

  const underlyingIdByFyToken = new Map<string, string>();
  for (const { segment, row } of tagged) {
    if (segment !== "NSE_CM" && segment !== "BSE_CM") continue;
    const fyToken = str(row.fyToken);
    if (!fyToken || !referencedUnderlyings.has(fyToken)) {
      report.skippedOutOfScope++; // unrelated CM universe is read but not imported
      continue;
    }
    const exchange = exchangeOf(row);
    const symTicker = str(row.symTicker);
    if (!exchange || !symTicker) { report.invalidRows++; continue; }
    const isIndex = symTicker.includes("-INDEX") || (str(row.exSymbol)?.includes("INDEX") ?? false);
    const category: InstrumentCategory = isIndex ? "INDEX" : "EQUITY";
    const canonicalSymbol = str(row.exSymbol) ?? symTicker.split(":")[1] ?? symTicker;
    const isin = str(row.isin);
    const exchangeSecurityId = str(row.exToken) !== undefined ? String(row.exToken) : undefined;
    const identityKey = computeIdentityKey({
      exchange,
      segment: category === "EQUITY" ? "CASH" : "INDEX",
      instrumentCategory: category,
      canonicalSymbol,
      isin,
      exchangeSecurityId,
      stableIdentifier: fyToken
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
      displayName: str(row.symDetails) ?? canonicalSymbol,
      ...(isin ? { isin } : {}),
      ...(exchangeSecurityId ? { exchangeSecurityId } : {}),
      stableIdentifier: fyToken,
      tradingStatus: isActive(row) ? "ACTIVE" : "INACTIVE",
      lifecycleStatus: "ACTIVE",
      sourceMeta: { fyToken, symTicker, provider_segment: segment },
      provenance: { source: FYERS_SOURCE, provider: "FYERS" }
    };
    addInstrument(inst, symTicker);
    recordSourceDate(segment, row);
    underlyingIdByFyToken.set(fyToken, inst.canonicalId);
    mappings.push({
      provider: "FYERS",
      nativeIdentifier: symTicker,
      canonicalId: inst.canonicalId,
      exchange,
      segment,
      nativeSymbol: symTicker,
      ...(exchangeSecurityId ? { nativeExchangeToken: exchangeSecurityId } : {}),
      status: isActive(row) ? "ACTIVE" : "INACTIVE",
      sourceMeta: { fyToken, exToken: exchangeSecurityId ?? null, symTicker, provider_segment: segment, tradeStatus: num(row.tradeStatus) ?? null }
    });
    if (isActive(row)) activeNativeIdentifiers.add(symTicker);
    report.inScopeUnderlyings++;
  }

  // Pass 2: option contracts, resolved strictly through underFyTok.
  for (const { segment, row } of tagged) {
    if (segment !== "NSE_FO" && segment !== "BSE_FO") continue;
    const optType = str(row.optType);
    if (optType !== "CE" && optType !== "PE") {
      report.skippedOutOfScope++; // futures (XX) and other products are not in scope
      continue;
    }
    const exchange = exchangeOf(row);
    const symTicker = str(row.symTicker);
    if (!exchange || !symTicker) { report.invalidRows++; continue; }
    const underFyTok = str(row.underFyTok);
    const underlyingCanonicalId = underFyTok ? underlyingIdByFyToken.get(underFyTok) : undefined;
    if (!underlyingCanonicalId) {
      report.unresolvedUnderlyings.push(underFyTok ?? symTicker);
      continue; // never guess from underSym
    }
    const expiry = parseIndiaExpiry(row.expiryDate);
    if (!expiry.ok) { report.invalidRows++; continue; }
    const strike = num(row.strikePrice);
    if (strike === undefined || strike <= 0) { report.invalidRows++; continue; }
    const underlying = instruments.find((i) => i.canonicalId === underlyingCanonicalId);
    const canonicalSymbol = underlying?.canonicalSymbol ?? str(row.exSymbol) ?? "OPTION";
    const category: InstrumentCategory = underlying?.instrumentCategory === "INDEX" ? "INDEX_OPTION" : "STOCK_OPTION";
    // Per-record source observation only; never fall back to a local fetch time.
    const contractObservedAt = observedAtFrom(row);

    const identityKey = computeIdentityKey({
      exchange,
      segment: "FO",
      instrumentCategory: category,
      canonicalSymbol,
      derivative: { underlyingCanonicalId, expiryDate: expiry.date, strike, optionType: optType }
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
      displayName: str(row.symDetails) ?? `${canonicalSymbol} ${strike} ${optType}`,
      underlyingCanonicalId,
      tradingStatus: isActive(row) ? "ACTIVE" : "INACTIVE",
      lifecycleStatus: "ACTIVE",
      derivative: {
        underlyingCanonicalId,
        expiryDate: expiry.date,
        strike,
        optionType: optType,
        ...(num(row.minLotSize) !== undefined ? { lotSize: num(row.minLotSize)! } : {}),
        ...(num(row.tickSize) !== undefined ? { tickSize: num(row.tickSize)! } : {}),
        ...(num(row.qtyFreeze) !== undefined ? { quantityFreeze: num(row.qtyFreeze)! } : {}),
        contractSource: FYERS_SOURCE,
        ...(contractObservedAt ? { contractObservedAt } : {})
      },
      sourceMeta: { fyToken: str(row.fyToken) ?? null, symTicker, provider_segment: segment },
      provenance: { source: FYERS_SOURCE, provider: "FYERS" }
    };
    addInstrument(inst, symTicker);
    recordSourceDate(segment, row);
    const exchangeSecurityId = str(row.exToken) !== undefined ? String(row.exToken) : undefined;
    mappings.push({
      provider: "FYERS",
      nativeIdentifier: symTicker, // option-chain `symbol` — never fyToken
      canonicalId: inst.canonicalId,
      exchange,
      segment,
      nativeSymbol: symTicker,
      ...(exchangeSecurityId ? { nativeExchangeToken: exchangeSecurityId } : {}),
      status: isActive(row) ? "ACTIVE" : "INACTIVE",
      sourceMeta: {
        fyToken: str(row.fyToken) ?? null,
        exToken: exchangeSecurityId ?? null,
        underFyTok: underFyTok ?? null,
        symTicker,
        optType,
        tradeStatus: num(row.tradeStatus) ?? null,
        expiryDateRaw: row.expiryDate ?? null
      }
    });
    if (isActive(row)) activeNativeIdentifiers.add(symTicker);
    report.inScopeOptions++;
  }

  // Source data date = oldest of the per-file newest in-scope lastUpdate dates.
  // A required file with no valid in-scope date leaves the snapshot date
  // unverified (undefined) — never substitute the local fetch time.
  const requiredSegments = Object.keys(FYERS_MASTER_URLS) as FyersMasterSegment[];
  const perFileNewest: string[] = [];
  for (const segment of requiredSegments) {
    const dates = lastUpdateBySegment.get(segment) ?? [];
    if (dates.length === 0) {
      perFileNewest.length = 0;
      break;
    }
    perFileNewest.push(dates.reduce((a, b) => (a > b ? a : b)));
  }
  const derivedDate = perFileNewest.length === requiredSegments.length
    ? perFileNewest.reduce((a, b) => (a < b ? a : b))
    : undefined;
  const observedAt = isoOrUndefined(derivedDate);
  if (observedAt) {
    for (const inst of instruments) {
      inst.provenance = {
        source: FYERS_SOURCE,
        provider: "FYERS",
        ...(inst.provenance ?? {}),
        sourceObservedAt: observedAt
      };
    }
  }

  const batch: CatalogSyncBatch = {
    source: FYERS_SOURCE,
    provider: "FYERS",
    scope: { source: FYERS_SOURCE, provider: "FYERS", universe: "NSE_BSE_STOCK_INDEX_OPTIONS" },
    completeness: "COMPLETE",
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(observedAt ? { sourceObservedAt: observedAt } : {}),
    instruments,
    mappings,
    aliases: [],
    identifiers: [],
    metadata: { coverage: FYERS_COVERAGE, counts: { options: report.inScopeOptions, underlyings: report.inScopeUnderlyings } }
  };
  const reconciliation: ProviderReconciliationDescriptor = {
    provider: "FYERS",
    coverage: FYERS_COVERAGE,
    activeNativeIdentifiers,
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(observedAt ? { sourceObservedAt: observedAt } : {}),
    now: options.now
  };
  return { batch, reconciliation, report };
}

/** Dry-run/validation only: returns counts and issues without DB writes. */
export function dryRunFyersMaster(files: FyersMasterFiles, options: FyersImportOptions): ProviderImportReport {
  return buildFyersImport(files, options).report;
}
