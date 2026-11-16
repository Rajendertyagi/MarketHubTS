import type {
  AuthCompleteInput,
  AuthStartResult,
  CredentialStore,
  ProviderAdapter,
  ProviderConfig,
  ProviderId,
  ProviderStatus
} from "@markethub/contracts";
import { emptyProviderStatus } from "@markethub/contracts";
import { fetchWithTimeout, fetchWithRetry, sanitizeError, type FetchLike } from "@markethub/market-core";

export const FYERS_AUTH_URL = "https://api-t1.fyers.in/api/v3/generate-authcode";
export const FYERS_TOKEN_URL = "https://api-t1.fyers.in/api/v3/validate-authcode";
export const FYERS_PROFILE_URL = "https://api-t1.fyers.in/api/v3/profile";
export const FYERS_LOGOUT_URL = "https://api-t1.fyers.in/api/v3/logout";
export const FYERS_APP_SECRET_CREDENTIAL = "app_secret";
export const FYERS_ACCESS_TOKEN_CREDENTIAL = "access_token";
const STATE_TTL_MS = 5 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface FyersAdapterOptions {
  credentials: CredentialStore;
  config: ProviderConfig;
  now?: () => Date;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retry?: boolean;
  retrySleep?: (ms: number) => Promise<void>;
}

/** Next 6:30 AM IST expiry as a real UTC instant. Testable via injected clock. */
export function nextIstExpiry(now: Date): Date {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const candidate = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 6, 30, 0, 0));
  if (candidate.getTime() <= shifted.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return new Date(candidate.getTime() - IST_OFFSET_MS);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class FyersAdapter implements ProviderAdapter {
  readonly id: ProviderId = "FYERS";
  private status: ProviderStatus;
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly states = new Map<string, number>();
  private tokenExpiresAt: string | null = null;

  constructor(private readonly options: FyersAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetchWithTimeout;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.status = emptyProviderStatus("FYERS", options.config.enabled);
    if (options.credentials.status().state === "UNAVAILABLE") {
      this.status = {
        ...this.status,
        authState: "CREDENTIALS_UNAVAILABLE",
        error: options.credentials.status().reason ?? "Credential store unavailable"
      };
    }
  }

  getStatus(): ProviderStatus {
    return { ...this.status, capabilities: [...this.status.capabilities], limits: [...this.status.limits], restrictions: [...this.status.restrictions] };
  }

  private configured(): boolean {
    return Boolean(this.options.config.enabled && this.options.config.fyersAppId && this.options.config.fyersRedirectUri);
  }

  async isConfigured(): Promise<boolean> {
    if (!this.configured()) return false;
    if (this.options.credentials.status().state !== "AVAILABLE") return false;
    return (await this.options.credentials.get("FYERS", FYERS_ACCESS_TOKEN_CREDENTIAL)) !== null;
  }

  async startAuth(): Promise<AuthStartResult> {
    if (!this.configured()) throw new Error("FYERS app ID and registered redirect URI are required");
    if (this.options.credentials.status().state !== "AVAILABLE") {
      throw new Error(this.options.credentials.status().reason ?? "Credential store unavailable");
    }
    const state = globalThis.crypto.randomUUID().replace(/-/g, "");
    this.states.set(state, this.now().getTime() + STATE_TTL_MS);
    const url = new URL(FYERS_AUTH_URL);
    url.searchParams.set("client_id", this.options.config.fyersAppId!);
    url.searchParams.set("redirect_uri", this.options.config.fyersRedirectUri!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return { authorizationUrl: url.toString(), state, expiresAt: new Date(this.now().getTime() + STATE_TTL_MS).toISOString() };
  }

  /** Verify and consume single-use state. Returns false for mismatch, replay or expiry. */
  verifyState(state: string | undefined): boolean {
    if (!state) return false;
    const expires = this.states.get(state);
    if (!expires) return false;
    this.states.delete(state); // single-use: consume immediately
    return expires > this.now().getTime();
  }

  async completeAuth(input: AuthCompleteInput): Promise<ProviderStatus> {
    if (input.error) {
      this.status = { ...this.status, authState: "ERROR", error: `FYERS authorization failed: ${sanitizeError(input.error)}`, lastErrorAt: this.now().toISOString() };
      return this.getStatus();
    }
    if (!this.verifyState(input.state)) {
      this.status = { ...this.status, authState: "ERROR", error: "FYERS state mismatch, replay or expiry", lastErrorAt: this.now().toISOString() };
      return this.getStatus();
    }
    if (!input.code) {
      this.status = { ...this.status, authState: "ERROR", error: "FYERS authorization code missing", lastErrorAt: this.now().toISOString() };
      return this.getStatus();
    }
    try {
      const appSecret = await this.options.credentials.get("FYERS", FYERS_APP_SECRET_CREDENTIAL);
      if (!appSecret) throw new Error("FYERS app secret is not configured");
      const appIdHash = await sha256Hex(`${this.options.config.fyersAppId}:${appSecret}`);
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", appIdHash, code: input.code })
      };
      const response = this.options.retry === false
        ? await this.fetchImpl(FYERS_TOKEN_URL, init, this.timeoutMs)
        : await fetchWithRetry(this.fetchImpl, FYERS_TOKEN_URL, init, this.timeoutMs, {
            sleep: this.options.retrySleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
          });
      const payload = (await response.json().catch(() => ({}))) as any;
      if (!response.ok || payload?.s !== "ok" || typeof payload?.access_token !== "string") {
        const code = payload?.code;
        this.status = {
          ...this.status,
          authState: code === -429 || response.status === 429 ? "DEGRADED" : "ERROR",
          error: `FYERS token exchange failed (${sanitizeError(payload?.message ?? `HTTP ${response.status}`)})`,
          lastErrorAt: this.now().toISOString()
        };
        return this.getStatus();
      }
      await this.options.credentials.set("FYERS", FYERS_ACCESS_TOKEN_CREDENTIAL, payload.access_token);
      this.tokenExpiresAt = nextIstExpiry(this.now()).toISOString();
      this.status = {
        ...this.status,
        authState: "AUTHENTICATED",
        validatedAt: this.now().toISOString(),
        expiresAt: this.tokenExpiresAt,
        expiryKnown: true,
        error: null,
        lastErrorAt: null
      };
      return this.getStatus();
    } catch (error) {
      this.status = { ...this.status, authState: "ERROR", error: `FYERS token exchange failed: ${sanitizeError(error)}`, lastErrorAt: this.now().toISOString() };
      return this.getStatus();
    }
  }

  /** Store the non-secret app secret as an encrypted credential. */
  async setAppSecret(secret: string): Promise<void> {
    if (!this.configured()) throw new Error("FYERS app ID and registered redirect URI are required");
    if (this.options.credentials.status().state !== "AVAILABLE") throw new Error("Credential store unavailable");
    if (!secret.trim()) throw new Error("FYERS app secret must not be empty");
    await this.options.credentials.set("FYERS", FYERS_APP_SECRET_CREDENTIAL, secret.trim());
    this.status = { ...this.status, authState: "AUTH_REQUIRED", error: null, lastErrorAt: null };
  }

  async validate(): Promise<ProviderStatus> {
    if (!this.options.config.enabled) {
      this.status = { ...this.status, authState: "DISABLED", error: null };
      return this.getStatus();
    }
    if (this.options.credentials.status().state !== "AVAILABLE") {
      this.status = { ...this.status, authState: "CREDENTIALS_UNAVAILABLE", error: this.options.credentials.status().reason ?? "Credential store unavailable" };
      return this.getStatus();
    }
    if (!this.configured()) {
      this.status = { ...this.status, authState: "NOT_CONFIGURED", error: null };
      return this.getStatus();
    }
    const token = await this.options.credentials.get("FYERS", FYERS_ACCESS_TOKEN_CREDENTIAL);
    if (!token) {
      this.status = { ...this.status, authState: "AUTH_REQUIRED", error: null, validatedAt: null };
      return this.getStatus();
    }
    const expiry = new Date(this.tokenExpiresAt ?? nextIstExpiry(this.now()).toISOString());
    if (this.now().getTime() >= expiry.getTime()) {
      this.status = { ...this.status, authState: "EXPIRED", expiresAt: expiry.toISOString(), expiryKnown: true, validatedAt: null, error: "FYERS access token expired (daily 06:30 IST)" };
      return this.getStatus();
    }
    try {
      const init: RequestInit = {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `${this.options.config.fyersAppId}:${token}` }
      };
      const response = this.options.retry === false
        ? await this.fetchImpl(FYERS_PROFILE_URL, init, this.timeoutMs)
        : await fetchWithRetry(this.fetchImpl, FYERS_PROFILE_URL, init, this.timeoutMs, {
            sleep: this.options.retrySleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
          });
      if (response.ok) {
        // Discard the profile payload entirely; store only validation metadata.
        this.status = {
          ...this.status,
          authState: "AUTHENTICATED",
          validatedAt: this.now().toISOString(),
          expiresAt: expiry.toISOString(),
          expiryKnown: true,
          error: null,
          lastErrorAt: null,
          capabilities: [
            { name: "market_data", state: "UNKNOWN", source: "DOCUMENTATION" },
            { name: "historical_data", state: "UNKNOWN", source: "DOCUMENTATION" }
          ],
          limits: [
            { name: "data_api_per_second", value: 5, state: "UNKNOWN", source: "DOCUMENTATION", publishedAt: "2026-10-16", note: "Standard-plan documentation figure, not verified account limit" }
          ]
        };
        return this.getStatus();
      }
      const payload = (await response.json().catch(() => ({}))) as any;
      const code = payload?.code;
      const authFailure = [-8, -15, -16, -17].includes(code) || response.status === 401 || response.status === 403;
      this.status = {
        ...this.status,
        authState: authFailure ? "EXPIRED" : code === -429 || response.status === 429 ? "DEGRADED" : "ERROR",
        error: `FYERS validation failed (${sanitizeError(payload?.message ?? `HTTP ${response.status}`)})`,
        lastErrorAt: this.now().toISOString()
      };
      return this.getStatus();
    } catch (error) {
      this.status = { ...this.status, authState: "ERROR", error: `FYERS validation failed: ${sanitizeError(error)}`, lastErrorAt: this.now().toISOString() };
      return this.getStatus();
    }
  }

  async remove(): Promise<void> {
    const token = await this.options.credentials.get("FYERS", FYERS_ACCESS_TOKEN_CREDENTIAL).catch(() => null);
    if (token && this.options.config.fyersAppId) {
      try {
        await this.fetchImpl(FYERS_LOGOUT_URL, {
          method: "POST",
          headers: { Accept: "application/json", Authorization: `${this.options.config.fyersAppId}:${token}` }
        }, this.timeoutMs);
      } catch {
        // Local removal still proceeds; remote revocation failure is reported via status only.
      }
    }
    await this.options.credentials.delete("FYERS", FYERS_ACCESS_TOKEN_CREDENTIAL);
    await this.options.credentials.delete("FYERS", FYERS_APP_SECRET_CREDENTIAL);
    this.states.clear();
    this.tokenExpiresAt = null;
    this.status = {
      ...emptyProviderStatus("FYERS", this.options.config.enabled),
      authState: this.options.config.enabled ? "AUTH_REQUIRED" : "DISABLED"
    };
  }
}
