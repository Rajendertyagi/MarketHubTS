/**
 * India market calendar date helpers. NSE/BSE calendar dates are Asia/Kolkata
 * dates; stored candle timestamps remain absolute epoch milliseconds. IST has
 * a fixed +05:30 offset (no DST), so a fixed offset is sufficient and avoids
 * any Intl/timezone-database dependency.
 */

export const IST_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface IstCalendarParts {
  year: number;
  /** 0-based month (January = 0). */
  month: number;
  day: number;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
}

/** Calendar parts of the India-local date for an absolute epoch-ms timestamp. */
export function istCalendarParts(epochMs: number): IstCalendarParts {
  const shifted = new Date(epochMs + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay()
  };
}

/**
 * Epoch ms of 00:00:00 UTC for explicit calendar components (month is 0-based).
 * Uses setUTCFullYear instead of Date.UTC so four-digit years 0-99 are not
 * remapped to 1900+year. Month overflow (e.g. month 12) still rolls into the
 * following year, which is the desired behavior for next-month helpers.
 */
function utcMidnightMs(year: number, month: number, day: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

/** Epoch ms of 00:00:00 India-local time on the calendar date containing epochMs. */
export function istDayStartMs(epochMs: number): number {
  const p = istCalendarParts(epochMs);
  return utcMidnightMs(p.year, p.month, p.day) - IST_OFFSET_MS;
}

/** Epoch ms of 00:00:00 India-local time on Monday of the week containing epochMs. */
export function istWeekStartMs(epochMs: number): number {
  const dayStart = istDayStartMs(epochMs);
  const weekday = istCalendarParts(dayStart).weekday; // 0=Sun
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return dayStart + mondayOffset * DAY_MS;
}

/** Epoch ms of 00:00:00 India-local time on the 1st of the month containing epochMs. */
export function istMonthStartMs(epochMs: number): number {
  const p = istCalendarParts(epochMs);
  return utcMidnightMs(p.year, p.month, 1) - IST_OFFSET_MS;
}

/** Epoch ms of 00:00:00 India-local time on the 1st of the following month. */
export function nextIstMonthStartMs(epochMs: number): number {
  const p = istCalendarParts(epochMs);
  return utcMidnightMs(p.year, p.month + 1, 1) - IST_OFFSET_MS;
}

/** `YYYY-MM-DD` India-local calendar date for an absolute epoch-ms timestamp. */
export function istDateString(epochMs: number): string {
  const p = istCalendarParts(epochMs);
  const yyyy = String(p.year).padStart(4, "0");
  const mm = String(p.month + 1).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Number of days in a month (month is 1-based). Leap years follow the Gregorian rule. */
function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

/**
 * Epoch ms of 00:00:00 India-local time for a `YYYY-MM-DD` date string.
 * Rejects impossible calendar dates instead of letting Date normalize them
 * (e.g. 2025-02-29 -> 2025-03-01). Four-digit years 0-99 are handled by
 * setUTCFullYear, avoiding Date.UTC's 1900+ remapping for those years.
 */
export function parseIstDateOnly(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return NaN;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return NaN;
  const ms = utcMidnightMs(year, month - 1, day) - IST_OFFSET_MS;
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Inclusive India-local range for a date-only UI selection: local midnight at
 * the start date through the end of the selected final date (23:59:59.999 IST).
 */
export function parseIstDateRange(fromDate: string, toDate: string): { fromMs: number; toMs: number } | null {
  const fromMs = parseIstDateOnly(fromDate);
  const toStart = parseIstDateOnly(toDate);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toStart) || fromMs > toStart) return null;
  return { fromMs, toMs: toStart + DAY_MS - 1 };
}
