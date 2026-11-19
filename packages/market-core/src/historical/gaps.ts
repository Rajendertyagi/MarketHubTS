import type {
  CandleGap, CandleRangeNote, CandleRangeRequest, GapBasis, HistoricalCandle
} from "@markethub/contracts";
import {
  DAY_MS, istCalendarParts, istDayStartMs, istMonthStartMs, istWeekStartMs,
  intervalClass, nextIstMonthStartMs
} from "@markethub/contracts";

function isWeekend(ms: number): boolean {
  const weekday = istCalendarParts(ms).weekday; // India-local calendar day
  return weekday === 0 || weekday === 6;
}

function nextBucket(ms: number, basis: GapBasis): number {
  if (basis === "WEEKLY_BUCKET") return ms + 7 * DAY_MS;
  if (basis === "MONTHLY_BUCKET") return nextIstMonthStartMs(ms);
  return ms + DAY_MS;
}

function bucketStart(ms: number, basis: GapBasis): number {
  if (basis === "WEEKLY_BUCKET") return istWeekStartMs(ms);
  if (basis === "MONTHLY_BUCKET") return istMonthStartMs(ms);
  return istDayStartMs(ms);
}

/**
 * Derive candidate gaps from actual stored candle timestamps. Calendar dates,
 * weekend status and period buckets use the India-local (Asia/Kolkata) market
 * calendar; stored timestamps remain absolute epoch milliseconds. No exchange
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
