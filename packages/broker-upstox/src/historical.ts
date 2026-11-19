import type {
  CandleRangeRequest, HistoricalCandle, ProviderId
} from "@markethub/contracts";
import { istDateString } from "@markethub/contracts";
import {
  fetchWithTimeout, fetchWithRetry, parseRetryAfter, sanitizeError,
  type FetchLike, type HistoricalProvider, type HistoricalFetchOutcome
} from "@markethub/market-core";

const API_BASE = "https://api.upstox.com";

export interface UpstoxHistoricalOptions {
  /** Bearer token (Analytics Token for V3; Plus entitlement for expired V2). */
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

/** Upstox enforces limits per API, per user — cooldowns are scoped to this adapter's API family. */
export interface UpstoxCooldown {
  notBeforeMs: number | null;
  unknownReset: boolean;
  reason: string | null;
}

function mapInterval(interval: string): { unit: string; value: string } | null {
  if (interval === "1D") return { unit: "days", value: "1" };
  if (interval === "1W") return { unit: "weeks", value: "1" };
  if (interval === "1M") return { unit: "months", value: "1" };
  const m = /^(\d+)m$/.exec(interval);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 300) return { unit: "minutes", value: String(n) };
  }
  const h = /^(\d+)h$/.exec(interval);
  if (h) {
    const n = Number(h[1]);
    if (n >= 1 && n <= 5) return { unit: "hours", value: String(n) };
  }
  return null;
}

/**
 * The expired-contract V2 endpoint uses single interval tokens, distinct from
 * the V3 active endpoint's {unit}/{value} form. Official documented values:
 * 1minute, 3minute, 5minute, 15minute, 30minute, day (week/month also listed
 * in the endpoint's error-code documentation). Unsupported intervals are
 * rejected rather than silently mapped to a wrong token.
 */
function mapExpiredInterval(interval: string): string | null {
  switch (interval) {
    case "1m": return "1minute";
    case "3m": return "3minute";
    case "5m": return "5minute";
    case "15m": return "15minute";
    case "30m": return "30minute";
    case "1D": return "day";
    case "1W": return "week";
    case "1M": return "month";
    default: return null;
  }
}

/** Date-only path params use the India-local exchange calendar date, not UTC. */
function datePart(ms: number): string {
  return istDateString(ms);
}

export class UpstoxHistoricalAdapter implements HistoricalProvider {
  readonly id: ProviderId = "UPSTOX";
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cooldown: UpstoxCooldown = { notBeforeMs: null, unknownReset: false, reason: null };

  constructor(private readonly options: UpstoxHistoricalOptions) {
    this.fetchImpl = options.fetchImpl ?? fetchWithTimeout;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.now = options.now ?? (() => Date.now());
  }

  getCooldown(): UpstoxCooldown { return { ...this.cooldown }; }

  async fetchCandles(request: CandleRangeRequest): Promise<HistoricalFetchOutcome> {
    const blocked = this.cooldown.notBeforeMs !== null && this.now() < this.cooldown.notBeforeMs;
    if (blocked) throw new Error("UPSTOX_HISTORICAL_COOLDOWN");

    const expiredToken = request.expired ? mapExpiredInterval(request.interval) : null;
    const mapped = request.expired ? null : mapInterval(request.interval);
    if (request.expired && !expiredToken) throw new Error(`UNSUPPORTED_EXPIRED_INTERVAL:${request.interval}`);
    if (!request.expired && !mapped) throw new Error(`UNSUPPORTED_INTERVAL:${request.interval}`);
    const native = request.nativeIdentifier;
    if (!native) throw new Error("MISSING_NATIVE_IDENTIFIER");

    const to = datePart(request.toMs);
    const from = datePart(request.fromMs);
    const url = request.expired
      ? `${API_BASE}/v2/expired-instruments/historical-candle/${encodeURIComponent(native)}/${expiredToken}/${to}/${from}`
      : `${API_BASE}/v3/historical-candle/${encodeURIComponent(native)}/${mapped!.unit}/${mapped!.value}/${to}/${from}`;

    const response = await fetchWithRetry(
      (u, init, t) => this.fetchImpl(u, init, t),
      url,
      { headers: { Accept: "application/json", Authorization: `Bearer ${this.options.token}` } },
      this.timeoutMs,
      { now: this.now }
    );

    if (response.status === 429 || response.status === 503) {
      this.applyThrottle(response.headers.get("retry-after"), response.status);
      throw new Error(`TRANSIENT_THROTTLE_${response.status}`);
    }
    if (!response.ok) {
      if (response.status === 403) throw new Error("ENTITLEMENT_REQUIRED");
      throw new Error(`UPSTOX_HTTP_${response.status}`);
    }

    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("MALFORMED_200"); }
    const candles = this.parseBody(body, request);
    this.cooldown.notBeforeMs = null;
    this.cooldown.unknownReset = false;
    this.cooldown.reason = null;
    return { candles };
  }

  private applyThrottle(retryAfter: string | null, status: number): void {
    const delay = parseRetryAfter(retryAfter, this.now());
    if (delay !== null && delay > 0) {
      this.cooldown.notBeforeMs = this.now() + delay;
      this.cooldown.unknownReset = false;
    } else {
      this.cooldown.notBeforeMs = null;
      this.cooldown.unknownReset = true; // advisory only, never blocks
    }
    this.cooldown.reason = sanitizeError(`Upstox ${status} throttle`);
  }

  private parseBody(body: unknown, request: CandleRangeRequest): HistoricalCandle[] {
    if (!body || typeof body !== "object") throw new Error("MALFORMED_200");
    const obj = body as { status?: unknown; data?: { candles?: unknown } };
    if (obj.status !== "success" || !obj.data || !Array.isArray(obj.data.candles)) throw new Error("MALFORMED_200");
    const out: HistoricalCandle[] = [];
    for (const row of obj.data.candles) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const ts = Date.parse(String(row[0]));
      const open = Number(row[1]), high = Number(row[2]), low = Number(row[3]), close = Number(row[4]);
      if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
      const volume = row[5] === null || row[5] === undefined ? null : Number(row[5]);
      const oi = row[6] === null || row[6] === undefined ? null : Number(row[6]);
      out.push({
        canonicalId: request.canonicalId, interval: request.interval, tsMs: ts,
        open, high, low, close,
        volume: volume !== null && Number.isFinite(volume) ? volume : null,
        oi: oi !== null && Number.isFinite(oi) ? oi : null,
        provider: "UPSTOX",
        provenance: { source: "provider-feed", provider: "UPSTOX", receivedAt: new Date(this.now()).toISOString() },
        receivedAtMs: this.now()
      });
    }
    return out;
  }
}
