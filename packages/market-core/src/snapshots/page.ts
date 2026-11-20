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
/** ISO-8601 datetime with explicit timezone, matching the contract's z.string().datetime(). */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoDateTime(value: string): boolean {
  return ISO_DATETIME.test(value) && Number.isFinite(Date.parse(value));
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
