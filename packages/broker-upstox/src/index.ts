import type {
  CredentialStore,
  ProviderAdapter,
  ProviderConfig,
  ProviderId,
  ProviderStatus
} from "@markethub/contracts";
import { emptyProviderStatus } from "@markethub/contracts";
import { fetchWithTimeout, fetchWithRetry, sanitizeError, type FetchLike } from "@markethub/market-core";

export const UPSTOX_VALIDATION_URL = "https://api.upstox.com/v2/market/status/NSE";
export const UPSTOX_TOKEN_CREDENTIAL = "analytics_token";

export interface UpstoxAdapterOptions {
  credentials: CredentialStore;
  config: ProviderConfig;
  now?: () => Date;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retry?: boolean;
  retrySleep?: (ms: number) => Promise<void>;
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

  getStatus(): ProviderStatus {
    return { ...this.status, capabilities: [...this.status.capabilities], limits: [...this.status.limits], restrictions: [...this.status.restrictions] };
  }

  async isConfigured(): Promise<boolean> {
    if (!this.options.config.enabled) return false;
    if (this.options.credentials.status().state !== "AVAILABLE") return false;
    return (await this.options.credentials.get("UPSTOX", UPSTOX_TOKEN_CREDENTIAL)) !== null;
  }

  /** Store a user-supplied Analytics Token. Expiry is metadata only, never calculated. */
  async setToken(token: string, expiresAt?: string): Promise<ProviderStatus> {
    if (!this.options.config.enabled) throw new Error("Upstox provider is disabled");
    if (this.options.credentials.status().state !== "AVAILABLE") {
      throw new Error(this.options.credentials.status().reason ?? "Credential store unavailable");
    }
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Analytics Token must not be empty");
    await this.options.credentials.set("UPSTOX", UPSTOX_TOKEN_CREDENTIAL, trimmed);
    this.status = {
      ...this.status,
      authState: "AUTH_REQUIRED",
      expiresAt: expiresAt ?? null,
      expiryKnown: Boolean(expiresAt),
      validatedAt: null,
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
    if (this.options.credentials.status().state !== "AVAILABLE") {
      this.status = {
        ...this.status,
        authState: "CREDENTIALS_UNAVAILABLE",
        error: this.options.credentials.status().reason ?? "Credential store unavailable"
      };
      return this.getStatus();
    }
    const token = await this.options.credentials.get("UPSTOX", UPSTOX_TOKEN_CREDENTIAL);
    if (!token) {
      this.status = { ...this.status, authState: "AUTH_REQUIRED", error: null, validatedAt: null };
      return this.getStatus();
    }

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

      if (response.status === 200) {
        this.status = {
          ...this.status,
          authState: "AUTHENTICATED",
          validatedAt: this.now().toISOString(),
          error: null,
          lastErrorAt: null,
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

      if (response.status === 401 || response.status === 403) {
        this.status = {
          ...this.status,
          authState: "EXPIRED",
          validatedAt: null,
          error: "Analytics Token was rejected (invalid, revoked or expired)",
          lastErrorAt: this.now().toISOString()
        };
        return this.getStatus();
      }

      if (response.status === 429) {
        this.status = {
          ...this.status,
          authState: "DEGRADED",
          error: "Upstox rate limit reached",
          lastErrorAt: this.now().toISOString(),
          restrictions: ["Rate limited — reduce request frequency; no automatic retry"]
        };
        return this.getStatus();
      }

      this.status = {
        ...this.status,
        authState: "ERROR",
        error: `Upstox validation failed with HTTP ${response.status}`,
        lastErrorAt: this.now().toISOString()
      };
      return this.getStatus();
    } catch (error) {
      this.status = {
        ...this.status,
        authState: "ERROR",
        error: `Upstox validation failed: ${sanitizeError(error)}`,
        lastErrorAt: this.now().toISOString()
      };
      return this.getStatus();
    }
  }

  async remove(): Promise<void> {
    await this.options.credentials.delete("UPSTOX", UPSTOX_TOKEN_CREDENTIAL);
    this.status = {
      ...emptyProviderStatus("UPSTOX", this.options.config.enabled),
      authState: this.options.config.enabled ? "AUTH_REQUIRED" : "DISABLED"
    };
  }
}
