import { istDateString, parseIstDateOnly } from "@markethub/contracts";

/**
 * Provider expiry values are converted to an India-market (Asia/Kolkata)
 * `YYYY-MM-DD` calendar date. NSE/BSE expiries are India-local dates, so taking
 * the UTC date of an absolute timestamp can be wrong near midnight.
 */
export type ExpiryParseOutcome =
  | { ok: true; date: string; epochMs: number }
  | { ok: false; reason: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER = /^[+-]?\d+$/;

/**
 * Epoch seconds are ~1.7e9 for current market dates; epoch milliseconds are
 * ~1.7e12. A 1e11 threshold separates them for any plausible expiry date.
 */
const SECONDS_THRESHOLD = 1e11;
const MAX_SAFE_MS = 8.64e15;

function fromEpochNumber(value: number): ExpiryParseOutcome {
  if (!Number.isFinite(value)) return { ok: false, reason: "NON_FINITE_TIMESTAMP" };
  if (value <= 0) return { ok: false, reason: "NON_POSITIVE_TIMESTAMP" };
  const ms = value < SECONDS_THRESHOLD ? value * 1000 : value;
  if (!Number.isFinite(ms) || ms > MAX_SAFE_MS) return { ok: false, reason: "OUT_OF_RANGE_TIMESTAMP" };
  return { ok: true, date: istDateString(ms), epochMs: ms };
}

/**
 * Parse a provider expiry value into a validated India-market calendar date.
 * Accepts `YYYY-MM-DD`, epoch seconds/milliseconds (number or numeric string),
 * and ISO datetime strings. Invalid, zero, negative, out-of-range and impossible
 * calendar dates are rejected rather than normalized.
 */
export function parseIndiaExpiry(value: unknown): ExpiryParseOutcome {
  if (typeof value === "number") return fromEpochNumber(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, reason: "EMPTY_EXPIRY" };
    if (DATE_ONLY.test(trimmed)) {
      const ms = parseIstDateOnly(trimmed);
      if (!Number.isFinite(ms)) return { ok: false, reason: "INVALID_CALENDAR_DATE" };
      return { ok: true, date: trimmed, epochMs: ms };
    }
    if (INTEGER.test(trimmed)) return fromEpochNumber(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) return { ok: false, reason: "INVALID_TIMESTAMP" };
    return { ok: true, date: istDateString(parsed), epochMs: parsed };
  }
  return { ok: false, reason: "UNSUPPORTED_EXPIRY_TYPE" };
}
