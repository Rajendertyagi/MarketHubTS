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

  async fetchOptionChain(request: OptionChainRequest): Promise<OptionChainSnapshotEnvelope> {
    const blocked = fyersBlockReason(this.cooldown, this.now());
    if (blocked === "ACCOUNT_BLOCK") throw new Error("FYERS_ACCOUNT_BLOCK");
    if (blocked === "DATA_API_COOLDOWN") throw new Error("FYERS_DATA_API_COOLDOWN");
    const native = request.nativeIdentifier;
    if (!native) throw new Error("MISSING_NATIVE_IDENTIFIER");
    // FYERS selects the chain via the symbol (which encodes the underlying /
    // expiry); `request.expiryDate` is carried into the canonical envelope as
    // metadata. Whether a multi-expiry response must be narrowed to the
    // requested expiry is a Stage G verification item — no filtering is
    // invented here.
    const body: Record<string, string> = { symbol: native, greeks: "1", strikecount: "50", timestamp: "" };
    const response = await fetchWithRetry(
      (u, init, t) => this.fetchImpl(u, init, t),
      OPTION_CHAIN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: this.options.token },
        body: JSON.stringify(body)
      },
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
    const envelope = this.parseBody(payload, request);
    clearFyersDataThrottle(this.cooldown);
    return envelope;
  }

  private parseBody(payload: unknown, request: OptionChainRequest): OptionChainSnapshotEnvelope {
    if (!payload || typeof payload !== "object") throw new Error("MALFORMED_200");
    const obj = payload as { s?: unknown; code?: unknown; data?: { optionsChain?: unknown; expiryData?: unknown; indiavixData?: unknown; callOi?: unknown; putOi?: unknown } };
    if (obj.s !== "ok") throw new Error(`FYERS_ERROR_${String(obj.code ?? "unknown")}`);
    if (!obj.data || !Array.isArray(obj.data.optionsChain)) throw new Error("MALFORMED_200");
    const strikes: OptionChainStrike[] = [];
    let underlyingLtp: number | null = null;
    for (const row of obj.data.optionsChain) {
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
      expiryDate: request.expiryDate,
      capturedAt: new Date(this.now()).toISOString(),
      observationTimestamp: null, // no per-snapshot observation time in the response
      underlyingLtp,
      strikes,
      providerExtensions: {
        callOi: obj.data.callOi ?? null,
        putOi: obj.data.putOi ?? null,
        expiryData: obj.data.expiryData ?? null,
        indiavixData: obj.data.indiavixData ?? null
      }
    };
  }
}
