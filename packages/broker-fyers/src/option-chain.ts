import type {
  OptionChainSnapshotEnvelope, OptionChainStrike, ProviderId
} from "@markethub/contracts";
import {
  fetchWithTimeout, fetchWithRetry,
  type FetchLike, type OptionChainProvider, type OptionChainRequest
} from "@markethub/market-core";
import {
  applyFyersDataThrottle, clearFyersDataThrottle, createFyersRestCooldown, fyersBlockReason,
  markFyersAccountBlock, snapshotFyersRestCooldown,
  type FyersRestCooldown
} from "./cooldown";

const OPTION_CHAIN_URL = "https://api-t1.fyers.in/data/options-chain-v3";

export interface FyersOptionChainOptions {
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

interface ExpiryEntry {
  date: string; // DD-MM-YYYY
  expiry: string; // provider epoch seconds
  flag?: number;
}

/** Strictly parse `expiryData`; null means malformed/incomplete metadata. */
function parseExpiryData(value: unknown): ExpiryEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ExpiryEntry[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    if (typeof r.date !== "string" || !/^\d{2}-\d{2}-\d{4}$/.test(r.date)) return null;
    if (typeof r.expiry !== "string" || !/^\d+$/.test(r.expiry)) return null;
    out.push({
      date: r.date,
      expiry: r.expiry,
      ...(typeof r.expiry_flag === "number" ? { flag: r.expiry_flag } : {})
    });
  }
  return out;
}

/** Convert requested YYYY-MM-DD to the provider's DD-MM-YYYY expiry date. */
function toProviderDate(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export class FyersOptionChainAdapter implements OptionChainProvider {
  readonly id: ProviderId = "FYERS";
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cooldown: FyersRestCooldown;

  constructor(private readonly options: FyersOptionChainOptions) {
    this.fetchImpl = options.fetchImpl ?? fetchWithTimeout;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.now = options.now ?? (() => Date.now());
    this.cooldown = options.cooldown ?? createFyersRestCooldown();
  }

  getCooldown(): FyersRestCooldown { return snapshotFyersRestCooldown(this.cooldown); }

  /** Documented account block: >3 per-minute breaches in a day blocks REST for the rest of the day. */
  markAccountBlock(resetAtMs: number | null, detail: string): void {
    markFyersAccountBlock(this.cooldown, resetAtMs, detail);
  }

  private async get(timestamp: string, native: string): Promise<unknown> {
    const params = new URLSearchParams({
      symbol: native,
      strikecount: "50",
      greeks: "1",
      timestamp // "" for discovery, exact expiry epoch for selection
    });
    const response = await fetchWithRetry(
      (u, init, t) => this.fetchImpl(u, init, t),
      `${OPTION_CHAIN_URL}?${params.toString()}`,
      { method: "GET", headers: { Accept: "application/json", Authorization: this.options.token } },
      this.timeoutMs,
      { now: this.now }
    );
    if (response.status === 429 || response.status === 503) {
      applyFyersDataThrottle(
        this.cooldown, response.headers.get("retry-after"), response.status, this.now(),
        `FYERS option chain ${response.status} throttle`
      );
      throw new Error(`TRANSIENT_THROTTLE_${response.status}`);
    }
    if (!response.ok) throw new Error(`FYERS_HTTP_${response.status}`);
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("MALFORMED_200"); }
    if (!payload || typeof payload !== "object") throw new Error("MALFORMED_200");
    const obj = payload as { s?: unknown; code?: unknown };
    if (obj.s !== "ok") throw new Error(`FYERS_ERROR_${String(obj.code ?? "unknown")}`);
    return payload;
  }

  async fetchOptionChain(request: OptionChainRequest): Promise<OptionChainSnapshotEnvelope> {
    const blocked = fyersBlockReason(this.cooldown, this.now());
    if (blocked === "ACCOUNT_BLOCK") throw new Error("FYERS_ACCOUNT_BLOCK");
    if (blocked === "DATA_API_COOLDOWN") throw new Error("FYERS_DATA_API_COOLDOWN");
    const native = request.nativeIdentifier;
    if (!native) throw new Error("MISSING_NATIVE_IDENTIFIER");
    const providerDate = toProviderDate(request.expiryDate);
    if (!providerDate) throw new Error("INVALID_EXPIRY_DATE");

    // Request 1: discovery — returns available expiries (date DD-MM-YYYY, epoch expiry).
    const discovery = await this.get("", native) as { data?: { expiryData?: unknown } };
    const expiries = parseExpiryData(discovery.data?.expiryData);
    if (!expiries) throw new Error("EXPIRY_METADATA_INVALID");

    const matches = expiries.filter((e) => e.date === providerDate);
    if (matches.length === 0) throw new Error("EXPIRY_NOT_AVAILABLE");
    if (matches.length > 1) throw new Error("EXPIRY_AMBIGUOUS");
    const selected = matches[0]!;

    // Request 2: fetch the chain for the exact requested expiry timestamp.
    const selectedPayload = await this.get(selected.expiry, native) as {
      data?: { expiryData?: unknown; optionsChain?: unknown; callOi?: unknown; putOi?: unknown; indiavixData?: unknown }
    };
    const returnedExpiries = parseExpiryData(selectedPayload.data?.expiryData);
    if (!returnedExpiries) throw new Error("EXPIRY_METADATA_INVALID");
    const stillPresent = returnedExpiries.some((e) => e.expiry === selected.expiry);
    const flagged = returnedExpiries.filter((e) => e.flag === 1);
    const flagMismatch = flagged.length > 0 && !flagged.some((e) => e.expiry === selected.expiry);
    if (!stillPresent || flagMismatch) throw new Error("EXPIRY_MISMATCH");

    const envelope = this.parseBody(selectedPayload, request);
    clearFyersDataThrottle(this.cooldown);
    return envelope;
  }

  private parseBody(
    payload: { data?: { optionsChain?: unknown; expiryData?: unknown; indiavixData?: unknown; callOi?: unknown; putOi?: unknown } },
    request: OptionChainRequest
  ): OptionChainSnapshotEnvelope {
    const data = payload.data;
    if (!data || !Array.isArray(data.optionsChain)) throw new Error("MALFORMED_200");
    const strikes: OptionChainStrike[] = [];
    let underlyingLtp: number | null = null;
    for (const row of data.optionsChain) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const strike = num(r.strike_price);
      const optionType = r.option_type === "CE" || r.option_type === "PE" ? r.option_type : null;
      if (strike === null || strike === -1 || optionType === null) {
        if (strike === -1) underlyingLtp = num(r.ltp); // underlying entry
        continue;
      }
      const record: OptionChainStrike = { strike, optionType };
      const ltp = num(r.ltp); if (ltp !== null) record.ltp = ltp;
      const oi = num(r.oi); if (oi !== null) record.oi = oi;
      const volume = num(r.volume); if (volume !== null) record.volume = volume;
      const bid = num(r.bid); if (bid !== null) record.bid = bid;
      const ask = num(r.ask); if (ask !== null) record.ask = ask;
      const g = r.greeks as Record<string, unknown> | undefined;
      if (g && typeof g === "object") {
        const iv = num(g.iv); if (iv !== null) record.iv = iv;
        // Null Greeks are preserved as null — never zero-filled or copied.
        const greeks: NonNullable<OptionChainStrike["greeks"]> = {};
        for (const key of ["delta", "gamma", "theta", "vega"] as const) {
          if (key in g) {
            const v = num(g[key]);
            if (v !== null) greeks[key] = v;
            else greeks[key] = null; // explicit provider null preserved
          }
        }
        record.greeks = greeks;
      }
      strikes.push(record);
    }
    return {
      underlyingCanonicalId: request.underlyingCanonicalId,
      expiryDate: request.expiryDate, // verified against provider expiry metadata above
      capturedAt: new Date(this.now()).toISOString(),
      observationTimestamp: null, // no per-snapshot observation time in the response
      underlyingLtp,
      strikes,
      providerExtensions: {
        callOi: data.callOi ?? null,
        putOi: data.putOi ?? null,
        expiryData: data.expiryData ?? null,
        indiavixData: data.indiavixData ?? null
      }
    };
  }
}
