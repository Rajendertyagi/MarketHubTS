import type {
  OptionChainSnapshotEnvelope, OptionChainStrike, ProviderId
} from "@markethub/contracts";
import {
  fetchWithTimeout, fetchWithRetry, parseRetryAfter, sanitizeError,
  type FetchLike, type OptionChainProvider, type OptionChainRequest
} from "@markethub/market-core";

const API_BASE = "https://api.upstox.com";

export interface UpstoxOptionChainOptions {
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class UpstoxOptionChainAdapter implements OptionChainProvider {
  readonly id: ProviderId = "UPSTOX";
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cooldown: { notBeforeMs: number | null; unknownReset: boolean; reason: string | null } =
    { notBeforeMs: null, unknownReset: false, reason: null };

  constructor(private readonly options: UpstoxOptionChainOptions) {
    this.fetchImpl = options.fetchImpl ?? fetchWithTimeout;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.now = options.now ?? (() => Date.now());
  }

  getCooldown() { return { ...this.cooldown }; }

  async fetchOptionChain(request: OptionChainRequest): Promise<OptionChainSnapshotEnvelope> {
    if (this.cooldown.notBeforeMs !== null && this.now() < this.cooldown.notBeforeMs) {
      throw new Error("UPSTOX_OPTION_CHAIN_COOLDOWN");
    }
    const native = request.nativeIdentifier;
    if (!native) throw new Error("MISSING_NATIVE_IDENTIFIER");
    const url = `${API_BASE}/v2/option/chain?instrument_key=${encodeURIComponent(native)}&expiry_date=${encodeURIComponent(request.expiryDate)}`;
    const response = await fetchWithRetry(
      (u, init, t) => this.fetchImpl(u, init, t),
      url,
      { headers: { Accept: "application/json", Authorization: `Bearer ${this.options.token}` } },
      this.timeoutMs,
      { now: this.now }
    );
    if (response.status === 429 || response.status === 503) {
      const delay = parseRetryAfter(response.headers.get("retry-after"), this.now());
      if (delay !== null && delay > 0) this.cooldown.notBeforeMs = this.now() + delay;
      else this.cooldown.unknownReset = true;
      this.cooldown.reason = sanitizeError(`Upstox option chain ${response.status} throttle`);
      throw new Error(`TRANSIENT_THROTTLE_${response.status}`);
    }
    if (!response.ok) throw new Error(`UPSTOX_HTTP_${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("MALFORMED_200"); }
    const envelope = this.parseBody(body, request);
    this.cooldown.notBeforeMs = null;
    this.cooldown.unknownReset = false;
    this.cooldown.reason = null;
    return envelope;
  }

  private parseBody(body: unknown, request: OptionChainRequest): OptionChainSnapshotEnvelope {
    if (!body || typeof body !== "object") throw new Error("MALFORMED_200");
    const obj = body as { status?: unknown; data?: unknown };
    if (obj.status !== "success" || !Array.isArray(obj.data)) throw new Error("MALFORMED_200");
    const strikes: OptionChainStrike[] = [];
    let underlyingLtp: number | null = null;
    for (const row of obj.data) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const strike = num(r.strike_price);
      if (strike === null) continue;
      const spot = num(r.underlying_spot_price);
      if (spot !== null) underlyingLtp = spot;
      for (const side of ["call_options", "put_options"] as const) {
        const sideObj = r[side] as Record<string, unknown> | undefined;
        if (!sideObj || typeof sideObj !== "object") continue;
        const md = sideObj.market_data as Record<string, unknown> | undefined;
        const greeks = sideObj.option_greeks as Record<string, unknown> | undefined;
        const strikeRecord: OptionChainStrike = {
          strike,
          optionType: side === "call_options" ? "CE" : "PE"
        };
        if (md) {
          const ltp = num(md.ltp); if (ltp !== null) strikeRecord.ltp = ltp;
          const oi = num(md.oi); if (oi !== null) strikeRecord.oi = oi;
          const volume = num(md.volume); if (volume !== null) strikeRecord.volume = volume;
          const bid = num(md.bid_price); if (bid !== null) strikeRecord.bid = bid;
          const ask = num(md.ask_price); if (ask !== null) strikeRecord.ask = ask;
        }
        if (greeks) {
          const iv = num(greeks.iv); if (iv !== null) strikeRecord.iv = iv;
          strikeRecord.greeks = {
            delta: num(greeks.delta), gamma: num(greeks.gamma), theta: num(greeks.theta), vega: num(greeks.vega)
          };
        }
        strikes.push(strikeRecord);
      }
    }
    return {
      underlyingCanonicalId: request.underlyingCanonicalId,
      expiryDate: request.expiryDate,
      capturedAt: new Date(this.now()).toISOString(),
      observationTimestamp: null, // Upstox chain does not supply a per-snapshot observation time
      underlyingLtp,
      strikes,
      providerExtensions: {}
    };
  }
}
