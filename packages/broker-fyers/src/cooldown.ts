import { parseRetryAfter, sanitizeError } from "@markethub/market-core";

/**
 * Runtime-only FYERS REST cooldown state. Instance-owned and discarded on
 * restart — never persisted. Shared by all FYERS REST adapters (regular
 * history, expired F&O, option chain) so a Data API throttle scopes to the
 * whole Data API category, while the repeated-limit daily block is a separate
 * account-level REST restriction applying across all REST categories.
 */
export interface FyersCooldownScope {
  notBeforeMs: number | null;
  unknownReset: boolean;
  reason: string | null;
}

export interface FyersRestCooldown {
  dataApi: FyersCooldownScope;
  accountBlock: FyersCooldownScope;
}

export function createFyersRestCooldown(): FyersRestCooldown {
  return {
    dataApi: { notBeforeMs: null, unknownReset: false, reason: null },
    accountBlock: { notBeforeMs: null, unknownReset: false, reason: null }
  };
}

export function snapshotFyersRestCooldown(state: FyersRestCooldown): FyersRestCooldown {
  return {
    dataApi: { ...state.dataApi },
    accountBlock: { ...state.accountBlock }
  };
}

/** Account block (all REST categories) takes precedence over a Data API throttle. */
export function fyersBlockReason(state: FyersRestCooldown, now: number): "ACCOUNT_BLOCK" | "DATA_API_COOLDOWN" | null {
  if (state.accountBlock.notBeforeMs !== null && now < state.accountBlock.notBeforeMs) return "ACCOUNT_BLOCK";
  if (state.dataApi.notBeforeMs !== null && now < state.dataApi.notBeforeMs) return "DATA_API_COOLDOWN";
  return null;
}

/** Apply a 429/503 throttle to the Data API category scope. */
export function applyFyersDataThrottle(
  state: FyersRestCooldown, retryAfter: string | null, status: number, now: number, detail: string
): void {
  const delay = parseRetryAfter(retryAfter, now);
  if (delay !== null && delay > 0) state.dataApi.notBeforeMs = now + delay;
  else state.dataApi.unknownReset = true; // advisory only, never blocks
  state.dataApi.reason = sanitizeError(detail);
}

/** Clear the Data API throttle after a successful request. */
export function clearFyersDataThrottle(state: FyersRestCooldown): void {
  state.dataApi.notBeforeMs = null;
  state.dataApi.unknownReset = false;
  state.dataApi.reason = null;
}

/**
 * Documented account block: >3 per-minute-limit breaches in a day blocks REST
 * requests for the rest of the day. Reset boundary and breach-counter
 * aggregation are Stage G verification items — never invented here.
 */
export function markFyersAccountBlock(state: FyersRestCooldown, resetAtMs: number | null, detail: string): void {
  if (resetAtMs !== null && Number.isFinite(resetAtMs)) {
    state.accountBlock.notBeforeMs = resetAtMs;
    state.accountBlock.unknownReset = false;
  } else {
    state.accountBlock.notBeforeMs = null;
    state.accountBlock.unknownReset = true; // advisory only; no invented reset boundary
  }
  state.accountBlock.reason = sanitizeError(detail);
}
