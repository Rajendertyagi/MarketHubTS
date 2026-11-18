import type {
  CandleGap, CandleRangeNote, CandleRangeRequest, GapBasis, HistoricalCandle
} from "@markethub/contracts";
import { intervalClass } from "@markethub/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isWeekend(ms: number): boolean {
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}

function startOfIsoWeek(ms: number): number {
  const day = startOfUtcDay(ms);
  const weekday = new Date(day).getUTCDay(); // 0=Sun
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return day + mondayOffset * DAY_MS;
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextBucket(ms: number, basis: GapBasis): number {
  if (basis === "WEEKLY_BUCKET") return ms + 7 * DAY_MS;
  if (basis === "MONTHLY_BUCKET") {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return ms + DAY_MS;
}

function bucketStart(ms: number, basis: GapBasis): number {
  if (basis === "WEEKLY_BUCKET") return startOfIsoWeek(ms);
  if (basis === "MONTHLY_BUCKET") return startOfMonth(ms);
  return startOfUtcDay(ms);
}

/**
 * Derive candidate gaps from actual stored candle timestamps. No exchange
 * calendar or session source exists in M5, so every result is approximate and
 * `confirmed: false`. Weekends are excluded for daily candidates; holidays
 * cannot be identified and are never asserted as missing.
 */
export function assessGaps(
  request: CandleRangeRequest,
  coveredTimestamps: number[],
  notes: CandleRangeNote[] = []
): CandleGap[] {
  const cls = intervalClass(request.interval);
  const basis: GapBasis = cls === "DAILY" ? "WEEKDAY_ONLY"
    : cls === "WEEKLY" ? "WEEKLY_BUCKET"
    : cls === "MONTHLY" ? "MONTHLY_BUCKET"
    : "SESSION_UNKNOWN";

  const covered = new Set(coveredTimestamps);
  const coveredBuckets = new Set(coveredTimestamps.map((ts) => bucketStart(ts, basis)));
  const unavailable = notes.filter((n) => n.kind === "UNAVAILABLE");

  const gaps: CandleGap[] = [];
  let cursor = bucketStart(request.fromMs, basis);
  const end = request.toMs;
  let guard = 0;
  while (cursor <= end && guard++ < 5000) {
    const bucketEnd = Math.min(nextBucket(cursor, basis) - 1, end);
    const isCandidate = !coveredBuckets.has(cursor) &&
      !(basis === "WEEKDAY_ONLY" && isWeekend(cursor)) &&
      !unavailable.some((n) => n.rangeStartMs <= bucketEnd && n.rangeEndMs >= cursor);
    if (isCandidate) {
      gaps.push({
        canonicalId: request.canonicalId,
        interval: request.interval,
        fromMs: Math.max(cursor, request.fromMs),
        toMs: bucketEnd,
        basis,
        confirmed: false,
        reason: basis === "SESSION_UNKNOWN"
          ? "no candle stored in this window; session status unverified"
          : basis === "WEEKDAY_ONLY"
            ? "no candle stored on this weekday; holiday/session status unknown (no calendar source)"
            : "no candle stored for this period bucket; status unverified"
      });
    }
    cursor = nextBucket(cursor, basis);
  }
  return gaps;
}

/** True when a provider response supplies no candles for a requested range. */
export function isEmptyCoverage(candles: HistoricalCandle[]): boolean {
  return candles.length === 0;
}
