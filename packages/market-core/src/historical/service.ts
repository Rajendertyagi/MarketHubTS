import {
  providerPolicySchema,
  type CandleGap, type CandleRangeNote, type CandleRangeRequest, type DataUnavailableReport,
  type HistoricalCandle, type HistoricalSyncConfig, type ProviderId, type RetentionSettings,
  type UnavailableReasonCode
} from "@markethub/contracts";
import { assessGaps } from "./gaps";

/** Structural seams — market-core never imports the database package. */
export interface CandleStore {
  getCandles(canonicalId: string, interval: HistoricalCandle["interval"], fromMs: number, toMs: number): HistoricalCandle[];
  getCoveredTimestamps(canonicalId: string, interval: HistoricalCandle["interval"], fromMs: number, toMs: number): number[];
  getRangeNotes(canonicalId: string, interval: HistoricalCandle["interval"], fromMs: number, toMs: number): CandleRangeNote[];
  upsertCandles(candles: HistoricalCandle[], options?: { refresh?: boolean }): { conflicts: number };
  addRangeNote(note: CandleRangeNote): void;
}

export interface RetentionReader {
  getRetention(): { valid: boolean; settings: RetentionSettings | null; error: string | null };
}

/** Outcome of a provider fetch: candles plus an explicit no-data signal. */
export interface HistoricalFetchOutcome {
  candles: HistoricalCandle[];
  /** Explicit provider `no_data` for the requested range — authoritative, permanent. */
  noData?: boolean;
}

/** Provider seam implemented by broker adapters; no apps/api imports. */
export interface HistoricalProvider {
  readonly id: ProviderId;
  fetchCandles(request: CandleRangeRequest): Promise<HistoricalFetchOutcome>;
}

export interface HistoricalServiceOptions {
  candles: CandleStore;
  settings: RetentionReader;
  providers: HistoricalProvider[];
  now?: () => number;
}

export interface CoverageStatus {
  gaps: CandleGap[];
  /** Authoritative permanent restrictions for the requested window. */
  unavailableNotes: CandleRangeNote[];
}

export interface HistoricalFetchResult {
  /** Provider-returned candles for this call (including any that conflicted
   * with stored values). `conflicts` reports how many were not applied; the
   * authoritative stored set is available via `getCached()`. */
  candles: HistoricalCandle[];
  gaps: CandleGap[];
  unavailable: DataUnavailableReport[];
  conflicts: number;
  providersTried: ProviderId[];
}

export interface RetentionCleanupResult {
  ran: boolean;
  reason: string | null;
  candlesDeleted: number;
  snapshotsDeleted: number;
}

export class HistoricalCandleService {
  private readonly now: () => number;
  constructor(private readonly options: HistoricalServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  getCached(request: CandleRangeRequest): HistoricalCandle[] {
    return this.options.candles.getCandles(request.canonicalId, request.interval, request.fromMs, request.toMs);
  }

  getCoverage(request: CandleRangeRequest): CandleGap[] {
    const covered = this.options.candles.getCoveredTimestamps(request.canonicalId, request.interval, request.fromMs, request.toMs);
    const notes = this.options.candles.getRangeNotes(request.canonicalId, request.interval, request.fromMs, request.toMs);
    return assessGaps(request, covered, notes);
  }

  /**
   * Full coverage status: candidate gaps PLUS authoritative unavailable
   * periods. Without the latter, "no candles and no gaps" would be ambiguous
   * between an unconfirmed gap and a known permanent restriction. Derived
   * entirely from stored notes — never fabricated.
   */
  getCoverageStatus(request: CandleRangeRequest): CoverageStatus {
    const notes = this.options.candles.getRangeNotes(request.canonicalId, request.interval, request.fromMs, request.toMs);
    return {
      gaps: this.getCoverage(request),
      unavailableNotes: notes.filter((n) => n.kind === "UNAVAILABLE")
    };
  }

  /**
   * On-demand retrieval. Takes an explicit request and NEVER reads or writes
   * historical_sync_configs. Successful candles may be cached; provider
   * restrictions are reported, never fabricated into candles.
   */
  async fetchOnDemand(request: CandleRangeRequest): Promise<HistoricalFetchResult> {
    const providers = this.selectProviders(request);
    const providersTried: ProviderId[] = [];
    const unavailable: DataUnavailableReport[] = [];
    let allCandles: HistoricalCandle[] = [];
    let conflicts = 0;

    for (const provider of providers) {
      // Authoritative UNAVAILABLE notes are permanent: do not retry the same
      // provider for a range it already reported as permanently unavailable
      // (no config/entitlement-change signal exists in M5). Alternate providers
      // are still tried, and an existing note is retained.
      const existingNotes = this.options.candles.getRangeNotes(
        request.canonicalId, request.interval, request.fromMs, request.toMs
      );
      if (existingNotes.some((n) => n.kind === "UNAVAILABLE" && n.provider === provider.id)) continue;

      providersTried.push(provider.id);
      try {
        const outcome = await provider.fetchCandles(request);
        if (outcome.candles.length > 0) {
          const result = this.options.candles.upsertCandles(outcome.candles);
          conflicts += result.conflicts;
          allCandles = allCandles.concat(outcome.candles);
        }
        if (outcome.noData) {
          // Explicit provider no_data is authoritative and permanent: record an
          // attributed UNAVAILABLE note, never fabricate candles, and allow an
          // alternate provider to fill the range.
          const report: DataUnavailableReport = {
            canonicalId: request.canonicalId, interval: request.interval,
            fromMs: request.fromMs, toMs: request.toMs, provider: provider.id,
            reasonCode: "NO_DATA", detail: "provider returned no_data for the requested range"
          };
          unavailable.push(report);
          this.options.candles.addRangeNote(this.toNote(request, provider.id, "NO_DATA", report.detail));
        }
      } catch (error) {
        const report = this.toUnavailable(request, provider.id, error);
        if (report) {
          unavailable.push(report);
          // Only permanent/request-specific reasons become authoritative notes.
          // REQUEST_ERROR (e.g. generic 422 invalid input) and transient
          // throttles are reported but never negatively cached.
          if (report.reasonCode !== "REQUEST_ERROR") {
            this.options.candles.addRangeNote(this.toNote(request, provider.id, report.reasonCode, report.detail));
          }
        }
        // Try the next configured provider for this range (alternate fill).
      }
    }

    const gaps = this.getCoverage(request);
    return { candles: allCandles, gaps, unavailable, conflicts, providersTried };
  }

  /** User-configured synchronization reads the saved config; on-demand does not. */
  async runSync(config: HistoricalSyncConfig): Promise<HistoricalFetchResult> {
    if (!config.enabled) {
      return { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] };
    }
    const defaultFrom = this.now() - 30 * 24 * 60 * 60 * 1000;
    const defaultTo = this.now();
    let fromMs = defaultFrom;
    let toMs = defaultTo;
    if (config.dateRangeJson) {
      try {
        const parsed = JSON.parse(config.dateRangeJson) as { from?: string; to?: string };
        const parsedFrom = typeof parsed.from === "string" ? Date.parse(parsed.from) : NaN;
        const parsedTo = typeof parsed.to === "string" ? Date.parse(parsed.to) : NaN;
        // Only accept finite, non-negative, ordered bounds. NaN/invalid values
        // must never propagate into provider requests or DB range queries.
        if (Number.isFinite(parsedFrom) && parsedFrom >= 0) fromMs = parsedFrom;
        if (Number.isFinite(parsedTo) && parsedTo >= 0) toMs = parsedTo;
        if (fromMs > toMs) { fromMs = defaultFrom; toMs = defaultTo; }
      } catch {
        // Invalid saved range: fall back to a bounded default, never an unbounded query.
        fromMs = defaultFrom;
        toMs = defaultTo;
      }
    }
    // Apply the saved provider preference defensively. Invalid/missing policy
    // means no preference — never a hardcoded priority. Alternate providers
    // are still tried by fetchOnDemand (prefer-then-fallback).
    let preferredProvider: ProviderId | undefined;
    if (config.providerPolicyJson) {
      try {
        const parsed = providerPolicySchema.safeParse(JSON.parse(config.providerPolicyJson));
        if (parsed.success) preferredProvider = parsed.data.preferredProvider;
      } catch {
        // Malformed policy: ignore, no preference.
      }
    }
    const request: CandleRangeRequest = {
      canonicalId: config.canonicalId, interval: config.interval, fromMs, toMs,
      ...(preferredProvider ? { provider: preferredProvider } : {})
    };
    return this.fetchOnDemand(request);
  }

  private selectProviders(request: CandleRangeRequest): HistoricalProvider[] {
    const all = this.options.providers;
    if (request.provider) {
      const preferred = all.filter((p) => p.id === request.provider);
      return preferred.length ? preferred.concat(all.filter((p) => p.id !== request.provider)) : all;
    }
    return all; // caller-supplied order; no hardcoded priority
  }

  private toUnavailable(request: CandleRangeRequest, provider: ProviderId, error: unknown): DataUnavailableReport {
    const raw = error instanceof Error ? error.message : String(error);
    const code = raw.toUpperCase();
    let reasonCode: DataUnavailableReport["reasonCode"];
    if (code.includes("ENTITLEMENT") || code.includes("403") || code.includes("PLUS")) reasonCode = "ENTITLEMENT";
    else if (code.includes("DATE_LIMIT") || code.includes("RANGE") || code.includes("INTERVAL")) reasonCode = "DATE_LIMIT";
    else if (code.includes("NO_DATA")) reasonCode = "NO_DATA";
    else reasonCode = "REQUEST_ERROR"; // reported, never persisted as a permanent note
    return {
      canonicalId: request.canonicalId, interval: request.interval,
      fromMs: request.fromMs, toMs: request.toMs, provider, reasonCode,
      detail: raw.slice(0, 300)
    };
  }

  private toNote(
    request: CandleRangeRequest, provider: ProviderId, reasonCode: UnavailableReasonCode, detail: string
  ): CandleRangeNote {
    const now = new Date(this.now()).toISOString();
    return {
      canonicalId: request.canonicalId, interval: request.interval, provider,
      rangeStartMs: request.fromMs, kind: "UNAVAILABLE", rangeEndMs: request.toMs,
      reasonCode, reasonJson: JSON.stringify({ detail }),
      requestedAtMs: this.now(), updatedAtMs: this.now()
    };
  }
}
