import type {
  CandleRangeRequest, HistoricalCandle, ProviderId
} from "@markethub/contracts";
import {
  fetchWithTimeout, fetchWithRetry,
  type FetchLike, type HistoricalProvider, type HistoricalFetchOutcome
} from "@markethub/market-core";
import {
  applyFyersDataThrottle, clearFyersDataThrottle, createFyersRestCooldown, fyersBlockReason,
  markFyersAccountBlock, snapshotFyersRestCooldown,
  type FyersRestCooldown
} from "./cooldown";

const DATA_BASE = "https://api-t1.fyers.in/data";

export interface FyersHistoricalOptions {
  /** app_id:access_token */
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  /** Shared runtime cooldown state; defaults to a fresh instance-owned scope. */
  cooldown?: FyersRestCooldown;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Canonical interval -> FYERS resolution token. Official FYERS uses bare
 * minute numbers (1, 5, 60, 120, 240 …) and 1D/1W/1M, not canonical `1m`/`5m`
 * tokens. 180 minutes is supported only by the expired F&O endpoint.
 */
function mapFyersResolution(interval: string, expired: boolean): string | null {
  const minute = /^(\d+)m$/.exec(interval);
  if (minute) {
    const n = Number(minute[1]);
    const allowed = expired
      ? [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 120, 180, 240]
      : [1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 120, 240];
    return allowed.includes(n) ? String(n) : null;
  }
  if (interval === "1D" || interval === "1W" || interval === "1M") return interval;
  return null;
}

/** FYERS category-scoped cooldown (Data APIs) plus a separate account-level REST block. */
export type FyersCooldown = FyersRestCooldown;

export class FyersHistoricalAdapter implements HistoricalProvider {
  readonly id: ProviderId = "FYERS";
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cooldown: FyersRestCooldown;

  constructor(private readonly options: FyersHistoricalOptions) {
    this.fetchImpl = options.fetchImpl ?? fetchWithTimeout;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.now = options.now ?? (() => Date.now());
    this.cooldown = options.cooldown ?? createFyersRestCooldown();
  }

  getCooldown(): FyersCooldown {
    return snapshotFyersRestCooldown(this.cooldown);
  }

  async fetchCandles(request: CandleRangeRequest): Promise<HistoricalFetchOutcome> {
    const blocked = fyersBlockReason(this.cooldown, this.now());
    if (blocked === "ACCOUNT_BLOCK") throw new Error("FYERS_ACCOUNT_BLOCK");
    if (blocked === "DATA_API_COOLDOWN") throw new Error("FYERS_DATA_API_COOLDOWN");
    const native = request.nativeIdentifier;
    if (!native) throw new Error("MISSING_NATIVE_IDENTIFIER");

    const resolution = mapFyersResolution(request.interval, Boolean(request.expired));
    if (!resolution) throw new Error(`UNSUPPORTED_RESOLUTION:${request.interval}`);

    const path = request.expired ? "/history/fno/expired/historical-data" : "/history";
    const params = new URLSearchParams({
      symbol: native,
      resolution,
      date_format: "0", // epoch seconds
      range_from: String(Math.floor(request.fromMs / 1000)),
      range_to: String(Math.floor(request.toMs / 1000))
    });
    if (request.expired) {
      params.set("include_oi", "1");
      params.set("include_greeks", "0");
    } else {
      params.set("cont_flag", "1");
      params.set("oi_flag", "1");
    }

    // Official FYERS data endpoints are GET with query parameters (confirmed
    // in the official SDK: session.get(generateUrl(url, req))).
    const response = await fetchWithRetry(
      (u, init, t) => this.fetchImpl(u, init, t),
      `${DATA_BASE}${path}?${params.toString()}`,
      {
        method: "GET",
        headers: { Accept: "application/json", Authorization: this.options.token }
      },
      this.timeoutMs,
      { now: this.now }
    );

    if (response.status === 429 || response.status === 503) {
      applyFyersDataThrottle(
        this.cooldown, response.headers.get("retry-after"), response.status, this.now(),
        `FYERS Data API ${response.status} throttle`
      );
      throw new Error(`TRANSIENT_THROTTLE_${response.status}`);
    }
    if (!response.ok) {
      if (response.status === 403) throw new Error("ENTITLEMENT_REQUIRED");
      if (response.status === 422) throw new Error("REQUEST_SPECIFIC_422");
      throw new Error(`FYERS_HTTP_${response.status}`);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("MALFORMED_200"); }
    const result = this.parseBody(payload, request, Boolean(request.expired));
    clearFyersDataThrottle(this.cooldown);
    return result;
  }

  /** Documented account block: >3 per-minute breaches in a day blocks REST for the rest of the day. */
  markAccountBlock(resetAtMs: number | null, detail: string): void {
    markFyersAccountBlock(this.cooldown, resetAtMs, detail);
  }

  private parseBody(payload: unknown, request: CandleRangeRequest, expired: boolean): HistoricalFetchOutcome {
    if (!payload || typeof payload !== "object") throw new Error("MALFORMED_200");
    const obj = payload as { s?: unknown; code?: unknown; candles?: unknown; columns?: unknown; message?: unknown };
    if (obj.s === "no_data" && Array.isArray(obj.candles) && obj.candles.length === 0) {
      // Valid empty result AND an explicit, authoritative no_data signal for
      // the requested range — the service records a NO_DATA UNAVAILABLE note.
      return { candles: [], noData: true };
    }
    if (obj.s !== "ok" || !Array.isArray(obj.candles)) {
      throw new Error(`FYERS_ERROR_${String(obj.code ?? "unknown")}`);
    }
    const columns = expired && Array.isArray(obj.columns) ? obj.columns.map(String) : [];
    const candles: HistoricalCandle[] = [];
    for (const row of obj.candles) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const ts = num(row[0]);
      const open = num(row[1]), high = num(row[2]), low = num(row[3]), close = num(row[4]);
      if (ts === null || open === null || high === null || low === null || close === null) continue;
      const volume = num(row[5]);
      let oi: number | null = null;
      if (expired) {
        const idx = columns.indexOf("open_interest");
        if (idx >= 0) oi = num(row[idx]);
      } else {
        oi = row.length > 6 ? num(row[6]) : null; // oi_flag=1 appends OI
      }
      candles.push({
        canonicalId: request.canonicalId, interval: request.interval, tsMs: ts * 1000,
        open, high, low, close,
        volume: volume !== null && Number.isFinite(volume) ? volume : null,
        oi: oi !== null && Number.isFinite(oi) ? oi : null,
        provider: "FYERS",
        provenance: { source: "provider-feed", provider: "FYERS", receivedAt: new Date(this.now()).toISOString() },
        receivedAtMs: this.now()
      });
    }
    return { candles };
  }
}
