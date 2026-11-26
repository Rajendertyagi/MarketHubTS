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
 * Bounded, incremental builder for one FYERS Symbol Master snapshot.
 *
 * `addRow` accepts one parsed source row at a time (so a streaming fetch can
 * feed it without ever materialising the full decompressed text or the full
 * parsed object graph of all four segment files). Only rows that can
 * contribute to the supported catalogue are retained:
 *  - FO CE/PE option candidates (needed for the referenced-underlying set and
 *    for the final option contracts);
 *  - CM rows whose `fyToken` is referenced by an in-scope option (the
 *    referenced set is complete once both FO files have been ingested, because
 *    segments are always processed in `FYERS_MASTER_URLS` order: NSE_FO,
 *    BSE_FO, NSE_CM, BSE_CM).
 *
 * Row-local counters are accumulated immediately; the cross-row decisions are
 * finalised in `finish`, which replays the original three passes over the
 * retained candidates in encounter order. This preserves the exact
 * first-write-wins / duplicate / missing-underlying / report semantics of the
 * array-based importer while keeping the working set bounded by the in-scope
 * population rather than by the full source size. No temporary files are used.
 *
 * The retained in-scope candidate objects are the unavoidable import working
 * set: underlyings cannot be resolved until both FO files have been read, so
 * those rows must stay in memory until `finish()`. The `retained*` counters
 * below expose that population deterministically (row counts and a high-water
 * mark only — no allocation accounting, no RSS claim).
 */
export class FyersImportAccumulator {
  private readonly report = emptyImportReport("FYERS");
  private readonly referencedUnderlyings = new Set<string>();
  private readonly optionCandidates: Array<{ segment: FyersMasterSegment; row: Row }> = [];
  private readonly cashCandidates: Array<{ segment: FyersMasterSegment; row: Row }> = [];
  private peakRetainedCandidates = 0;

  /** In-scope FO option rows currently retained for `finish()`. */
  get retainedOptionCandidates(): number { return this.optionCandidates.length; }

  /** Referenced CM rows currently retained for `finish()`. */
  get retainedCashCandidates(): number { return this.cashCandidates.length; }

  /** Peak combined retained candidate rows seen during ingestion. */
  get maxRetainedCandidates(): number { return this.peakRetainedCandidates; }

  private noteRetained(): void {
    const retained = this.optionCandidates.length + this.cashCandidates.length;
    if (retained > this.peakRetainedCandidates) this.peakRetainedCandidates = retained;
  }

  /** Feed one parsed source row from the given segment file. */
  addRow(segment: FyersMasterSegment, raw: unknown): void {
    // `rowsOf` in the array-based importer filters non-object values before
    // counting them; mirror that exactly so `rowsSeen` and the report stay
    // byte-for-byte identical between the two paths.
    if (!raw || typeof raw !== "object") return;
    const row = raw as Row;
    this.report.rowsSeen++;

    if (segment === "NSE_FO" || segment === "BSE_FO") {
      const optType = str(row.optType);
      if (optType === "CE" || optType === "PE") {
        // Pass 0 of the original importer: every supported FO option contributes
        // its `underFyTok` to the referenced set, even if the row later fails
        // exchange/expiry/strike validation. Keep that behaviour exactly.
        const underFyTok = str(row.underFyTok);
        if (underFyTok) this.referencedUnderlyings.add(underFyTok);
        this.optionCandidates.push({ segment, row });
        this.noteRetained();
      } else {
        this.report.skippedOutOfScope++; // futures (XX) and other products
      }
      return;
    }

    // Cash/index segment. The referenced set is already complete here (both FO
    // files precede the CM files in FYERS_MASTER_URLS order), so unreferenced
    // CM rows are discarded exactly as the original pass 1 did. This keeps the
    // retained working set bounded by the referenced-underlying population.
    const fyToken = str(row.fyToken);
    if (!fyToken || !this.referencedUnderlyings.has(fyToken)) {
      this.report.skippedOutOfScope++; // unrelated CM universe is read but not imported
      return;
    }
    this.cashCandidates.push({ segment, row });
    this.noteRetained();
  }

  finish(options: FyersImportOptions): ProviderImportResult {
    const report = this.report;
    const instruments: CanonicalInstrument[] = [];
    const mappings: ProviderInstrumentMapping[] = [];
    const activeNativeIdentifiers = new Set<string>();
    const identityOwners = new Map<string, string>();
    const nativeOwners = new Map<string, string>();
    const underlyingIdByFyToken = new Map<string, string>();
    // Canonical-ID-keyed view of the in-scope underlyings, built once in pass 1.
    // First-write-wins deliberately mirrors the previous `instruments.find(...)`
    // scan, which returned the first instrument with a given canonical ID; duplicate
    // underlying rows resolving to the same canonical keep the first row's symbol
    // and category deterministically (WP1-B).
    const underlyingByCanonicalId = new Map<string, CanonicalInstrument>();
    // Per-file source dates are collected only from rows actually imported.
    const lastUpdateBySegment = new Map<FyersMasterSegment, string[]>();
    const recordSourceDate = (segment: FyersMasterSegment, row: Row): void => {
      const observed = observedAtFrom(row);
      if (!observed) return;
      const dates = lastUpdateBySegment.get(segment) ?? [];
      dates.push(observed);
      lastUpdateBySegment.set(segment, dates);
    };

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
    for (const { segment, row } of this.cashCandidates) {
      const fyToken = str(row.fyToken)!; // guaranteed non-empty by addRow
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
      if (!underlyingByCanonicalId.has(inst.canonicalId)) underlyingByCanonicalId.set(inst.canonicalId, inst);
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
      report.inScopeBySegment[segment] = (report.inScopeBySegment[segment] ?? 0) + 1;
    }

    // Pass 2: option contracts, resolved strictly through underFyTok.
    for (const { segment, row } of this.optionCandidates) {
      // CE/PE is guaranteed by addRow; re-narrow here for the typed identity key.
      const optType = str(row.optType);
      if (optType !== "CE" && optType !== "PE") { report.invalidRows++; continue; }
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
      const underlying = underlyingByCanonicalId.get(underlyingCanonicalId);
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
      report.inScopeBySegment[segment] = (report.inScopeBySegment[segment] ?? 0) + 1;
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
}

/**
 * Convert the official FYERS Symbol Master JSON files into one validated
 * complete provider snapshot. Pure: no DB writes. Underlyings are resolved
 * strictly by `underFyTok` -> `fyToken`; `underSym` is never used as a fallback.
 *
 * Retained for array-based callers (tests, dry-run, benchmarks). The streaming
 * refresh path feeds the same `FyersImportAccumulator` one row at a time, so
 * both paths share one importer implementation and cannot drift.
 */
export function buildFyersImport(files: FyersMasterFiles, options: FyersImportOptions): ProviderImportResult {
  const accumulator = new FyersImportAccumulator();
  for (const segment of Object.keys(FYERS_MASTER_URLS) as FyersMasterSegment[]) {
    const file = files[segment];
    if (file === undefined) continue;
    for (const row of rowsOf(file)) accumulator.addRow(segment, row);
  }
  return accumulator.finish(options);
}

/** Dry-run/validation only: returns counts and issues without DB writes. */
export function dryRunFyersMaster(files: FyersMasterFiles, options: FyersImportOptions): ProviderImportReport {
  return buildFyersImport(files, options).report;
}
