import type {
  CredentialStore,
  ProviderAdapter,
  ProviderConfig,
  ProviderId,
  ProviderSettings,
  ProviderStatus
} from "@markethub/contracts";
import { emptyProviderStatus, VALIDATION_REQUIRED_ADVISORY, withoutValidationAdvisory } from "@markethub/contracts";
import { fetchWithTimeout, fetchWithRetry, sanitizeError, type FetchLike } from "@markethub/market-core";
import { UPSTOX_EXPIRY_SETTING, UPSTOX_TOKEN_CREDENTIAL, UPSTOX_VALIDATION_URL } from "./constants";

export { UPSTOX_VALIDATION_URL, UPSTOX_TOKEN_CREDENTIAL, UPSTOX_EXPIRY_SETTING } from "./constants";
export { UpstoxHistoricalAdapter } from "./historical";
export type { UpstoxHistoricalOptions, UpstoxCooldown } from "./historical";
export { UpstoxOptionChainAdapter } from "./option-chain";
export type { UpstoxOptionChainOptions } from "./option-chain";
export {
  UPSTOX_V3_LIMITS,
  UpstoxMarketDataStream,
  modeLimit,
  groupByMode
} from "./stream";
export type {
  UpstoxFeedMode,
  UpstoxSubscription,
  UpstoxStreamCallbacks,
  UpstoxStreamOptions,
  SdkStreamer,
  StreamerFactory
} from "./stream";
export { upstoxComponentUpdates, upstoxCapabilities } from "./components";

export interface UpstoxAdapterOptions {
  credentials: CredentialStore;
  config: ProviderConfig;
  settings?: ProviderSettings;
  now?: () => Date;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retry?: boolean;
  retrySleep?: (ms: number) => Promise<void>;
}

interface TokenValidation {
  ok: boolean;
  error?: string;
  rateLimited?: boolean;
  expired?: boolean;
}

export class UpstoxAdapter implements ProviderAdapter {
  readonly id: ProviderId = "UPSTOX";
  private status: ProviderStatus;
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: UpstoxAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetchWithTimeout;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.status = emptyProviderStatus("UPSTOX", options.config.enabled);
    if (options.credentials.status().state === "UNAVAILABLE") {
      this.status = {
        ...this.status,
        authState: "CREDENTIALS_UNAVAILABLE",
        error: options.credentials.status().reason ?? "Credential store unavailable",
        restrictions: ["Credential store unavailable — re-authentication required"]
      };
    }
  }

  /** Load persisted expiry metadata on startup. Never contacts the provider. */
  async initialize(): Promise<void> {
    const saved = this.options.settings ? await this.options.settings.get(UPSTOX_EXPIRY_SETTING) : null;
    if (saved) {
      this.options.config.upstoxTokenExpiresAt = saved;
      this.status = { ...this.status, expiresAt: saved, expiryKnown: true, restrictions: [] };
    }
    if (this.options.config.enabled && await this.isConfigured()) {
      // Credentials exist from a previous session; validation is required but startup stays offline-safe.
      this.status = {
        ...this.status,
        authState: "AUTH_REQUIRED",
        restrictions: [...this.status.restrictions, VALIDATION_REQUIRED_ADVISORY]
      };
    }
  }

  getStatus(): ProviderStatus {
    return { ...this.status, capabilities: [...this.status.capabilities], limits: [...this.status.limits], restrictions: [...this.status.restrictions] };
  }

  async isConfigured(): Promise<boolean> {
    if (!this.options.config.enabled) return false;
    if (this.options.credentials.status().state !== "AVAILABLE") return false;
    return (await this.options.credentials.get("UPSTOX", UPSTOX_TOKEN_CREDENTIAL)) !== null;
  }

  /** Validate a candidate token without touching stored credentials or status. */
  private async validateToken(token: string): Promise<TokenValidation> {
    try {
      const init: RequestInit = {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
      };
      const response = this.options.retry === false
        ? await this.fetchImpl(UPSTOX_VALIDATION_URL, init, this.timeoutMs)
        : await fetchWithRetry(this.fetchImpl, UPSTOX_VALIDATION_URL, init, this.timeoutMs, {
            sleep: this.options.retrySleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
          });

      if (response.status === 401 || response.status === 403) {
        return { ok: false, expired: true, error: "Analytics Token was rejected (invalid, revoked or expired)" };
      }
      if (response.status === 429) {
        return { ok: false, rateLimited: true, error: "Upstox rate limit reached" };
      }
      if (response.status !== 200) {
        return { ok: false, error: `Upstox validation failed with HTTP ${response.status}` };
      }
      // HTTP 200 alone is insufficient: validate the Market Status response shape.
      let payload: any;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, error: "Upstox validation returned a malformed response" };
      }
      if (!payload || payload.status !== "success" || typeof payload.data?.exchange !== "string" || typeof payload.data?.status !== "string") {
        return { ok: false, error: "Upstox validation returned an unexpected response shape" };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `Upstox validation failed: ${sanitizeError(error)}` };
    }
  }

  /** Validate a candidate before replacing a working token. Old token is preserved on any failure. */
  async setToken(token: string, expiresAt?: string): Promise<ProviderStatus> {
    if (!this.options.config.enabled) throw new Error("Upstox provider is disabled");
    if (this.options.credentials.status().state !== "AVAILABLE") {
      throw new Error(this.options.credentials.status().reason ?? "Credential store unavailable");
    }
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Analytics Token must not be empty");

    const validation = await this.validateToken(trimmed);
    if (!validation.ok) {
      this.status = {
        ...this.status,
        authState: validation.rateLimited ? "DEGRADED" : "ERROR",
        error: validation.error ?? "Token validation failed",
        lastErrorAt: this.now().toISOString(),
        restrictions: validation.rateLimited ? ["Rate limited — no automatic retry"] : this.status.restrictions
      };
      throw new Error(validation.error ?? "Token validation failed; existing token preserved");
    }

    await this.options.credentials.set("UPSTOX", UPSTOX_TOKEN_CREDENTIAL, trimmed);
    if (expiresAt) {
      this.options.config.upstoxTokenExpiresAt = expiresAt;
      await this.options.settings?.set(UPSTOX_EXPIRY_SETTING, expiresAt);
    } else {
      // A replacement token with no expiry must not inherit the previous token's metadata.
      delete this.options.config.upstoxTokenExpiresAt;
      await this.options.settings?.delete(UPSTOX_EXPIRY_SETTING);
    }
    this.status = {
      ...this.status,
      authState: "AUTHENTICATED",
      expiresAt: expiresAt ?? null,
      expiryKnown: Boolean(expiresAt),
      validatedAt: this.now().toISOString(),
      error: null,
      lastErrorAt: null,
      restrictions: expiresAt ? [] : ["Token expiry unknown — supply the expiry date shown in the Upstox dashboard"]
    };
    return this.getStatus();
  }

  async validate(): Promise<ProviderStatus> {
    if (!this.options.config.enabled) {
      this.status = { ...this.status, authState: "DISABLED", error: null };
      return this.getStatus();
    }
    if (this.options.credentials.status().state === "UNAVAILABLE") {
      this.status = { ...this.status, authState: "CREDENTIALS_UNAVAILABLE", error: this.options.credentials.status().reason ?? "Credential store unavailable" };
      return this.getStatus();
    }
    const token = await this.options.credentials.get("UPSTOX", UPSTOX_TOKEN_CREDENTIAL);
    if (!token) {
      this.status = { ...this.status, authState: "AUTH_REQUIRED", error: null, validatedAt: null };
      return this.getStatus();
    }
    const validation = await this.validateToken(token);
    if (!validation.ok) {
      this.status = {
        ...this.status,
        authState: validation.rateLimited ? "DEGRADED" : validation.expired ? "EXPIRED" : "ERROR",
        error: validation.error ?? "Validation failed",
        lastErrorAt: this.now().toISOString(),
        restrictions: validation.rateLimited ? ["Rate limited — no automatic retry"] : this.status.restrictions
      };
      return this.getStatus();
    }
    this.status = {
      ...this.status,
      authState: "AUTHENTICATED",
      validatedAt: this.now().toISOString(),
      error: null,
      lastErrorAt: null,
      restrictions: withoutValidationAdvisory(this.status.restrictions),
      capabilities: [
        { name: "market_quote", state: "UNKNOWN", source: "DOCUMENTATION" },
        { name: "historical_data", state: "UNKNOWN", source: "DOCUMENTATION" },
        { name: "option_chain", state: "UNKNOWN", source: "DOCUMENTATION" },
        { name: "market_information", state: "AVAILABLE", source: "API" }
      ],
      limits: [
        { name: "other_standard_apis_per_second", value: 50, state: "UNKNOWN", source: "DOCUMENTATION", publishedAt: "2026-11-16", note: "Documentation figure, not verified account limit" }
      ]
    };
    return this.getStatus();
  }

  async remove(): Promise<void> {
    await this.options.credentials.delete("UPSTOX", UPSTOX_TOKEN_CREDENTIAL);
    await this.options.settings?.delete(UPSTOX_EXPIRY_SETTING);
    this.status = {
      ...emptyProviderStatus("UPSTOX", this.options.config.enabled),
      authState: this.options.config.enabled ? "AUTH_REQUIRED" : "DISABLED"
    };
  }
}
