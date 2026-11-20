import type { OptionChainSnapshot, SnapshotPageSelector } from "@markethub/contracts";

export type { SnapshotPageSelector } from "@markethub/contracts";

/** Outcome of a bounded newest-first snapshot page read. */
export type SnapshotPageResult =
  | { ok: true; snapshots: OptionChainSnapshot[]; nextCursor: string | null }
  | { ok: false; reason: "unknown_config" | "invalid_cursor"; message: string };

interface CursorPayload {
  /** capturedAt ISO string of the last returned row (keyset boundary). */
  c: string;
  /** id of the last returned row (stable tie-break). */
  i: string;
  /** Full selector the cursor is bound to. */
  s: SnapshotPageSelector;
}

const CURSOR_PREFIX = "v1.";
const MAX_CURSOR_LENGTH = 4096;
/** ISO-8601 datetime with explicit timezone and captured calendar components. */
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Strict ISO-8601 validation: Date.parse alone normalizes impossible calendar
 * dates (e.g. 2026-02-31 -> Mar 3, 2025-02-29 -> Mar 1), so validate each
 * component — including month length and leap years — before accepting.
 */
function isIsoDateTime(value: string): boolean {
  const m = ISO_DATETIME.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > daysInMonth) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const zone = m[7]!;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** Encode a self-contained, versioned, opaque keyset cursor. */
export function encodeSnapshotCursor(payload: CursorPayload): string {
  const json = JSON.stringify({ c: payload.c, i: payload.i, s: payload.s });
  return CURSOR_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

/**
 * Decode and validate a cursor against the requested selector.
 * Returns null for any malformed, wrong-version or selector-mismatched cursor;
 * callers must map that to a validation error, never an empty success.
 */
export function decodeSnapshotCursor(
  raw: string,
  selector: SnapshotPageSelector
): { capturedAt: string; id: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  if (!raw.startsWith(CURSOR_PREFIX)) return null;
  const encoded = raw.slice(CURSOR_PREFIX.length);
  if (encoded.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.c !== "string" || !isIsoDateTime(obj.c)) return null;
  if (typeof obj.i !== "string" || obj.i.length === 0) return null;
  if (!isSelector(obj.s) || !selectorsEqual(obj.s, selector)) return null;
  return { capturedAt: obj.c, id: obj.i };
}

function isSelector(value: unknown): value is SnapshotPageSelector {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "null-config") return true;
  if (v.kind === "config") return typeof v.configId === "string" && v.configId.length > 0;
  return false;
}

function selectorsEqual(a: SnapshotPageSelector, b: SnapshotPageSelector): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "config" && b.kind === "config" ? a.configId === b.configId : true;
}
