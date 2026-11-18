import type {
  ProviderAdapter,
  ProviderId,
  ProviderStatus,
  ProviderStatusMap
} from "@markethub/contracts";

/** Remove anything that looks like a credential from an error message. */
export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/(appIdHash|access_token|refresh_token|app_secret|authorization_code|code|token|secret)\s*[:=]\s*[^,\s}&"']+/gi, "$1=[redacted]")
    .replace(/[?&](code|state|access_token|token)=[^&\s"']+/gi, "?$1=[redacted]")
    .slice(0, 300);
}

export interface ProviderRegistryOptions {
  now?: () => Date;
}

/**
 * Holds independent provider adapters. Every operation is isolated per provider so a
 * failure in one never changes another provider's state or throws to the caller.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();
  private readonly now: () => Date;

  constructor(options: ProviderRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  getStatuses(): ProviderStatusMap {
    const upstox = this.adapters.get("UPSTOX")?.getStatus();
    const fyers = this.adapters.get("FYERS")?.getStatus();
    return {
      UPSTOX: upstox ?? {
        id: "UPSTOX",
        enabled: false,
        authState: "DISABLED",
        streamingState: "NOT_STARTED",
        validatedAt: null,
        expiresAt: null,
        expiryKnown: false,
        capabilities: [],
        limits: [],
        restrictions: [],
        error: null,
        lastErrorAt: null
      },
      FYERS: fyers ?? {
        id: "FYERS",
        enabled: false,
        authState: "DISABLED",
        streamingState: "NOT_STARTED",
        validatedAt: null,
        expiresAt: null,
        expiryKnown: false,
        capabilities: [],
        limits: [],
        restrictions: [],
        error: null,
        lastErrorAt: null
      }
    };
  }

  async validate(id: ProviderId): Promise<ProviderStatus> {
    const adapter = this.adapters.get(id);
    if (!adapter) return this.getStatuses()[id];
    try {
      return await adapter.validate();
    } catch (error) {
      const current = adapter.getStatus();
      const failed: ProviderStatus = {
        ...current,
        authState: "ERROR",
        error: sanitizeError(error),
        lastErrorAt: this.now().toISOString()
      };
      return failed;
    }
  }

  async validateAll(): Promise<ProviderStatusMap> {
    const [UPSTOX, FYERS] = await Promise.all([this.validate("UPSTOX"), this.validate("FYERS")]);
    return { UPSTOX, FYERS };
  }

  async remove(id: ProviderId): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) return;
    await adapter.remove();
  }
}

export type FetchLike = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Parse Retry-After as delta-seconds or HTTP-date. Returns delay in ms, or null when unusable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  const delay = timestamp - nowMs;
  return delay >= 0 ? delay : null;
}

/** Retry only transient failures (network errors, 429, 5xx). Bounded, jittered, no tight loops. */
export async function fetchWithRetry(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  options: RetryOptions = {}
): Promise<Response> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 3, 5));
  const base = Math.max(50, options.baseDelayMs ?? 250);
  const max = Math.max(base, options.maxDelayMs ?? 2000);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetcher(url, init, timeoutMs);
      if (response.status === 429 || response.status === 503) {
        const rawRetryAfter = response.headers.get("retry-after");
        // 429 always requires a usable Retry-After; 503 honours one when present
        // and otherwise keeps the existing bounded 5xx backoff behavior.
        if (response.status === 429 || rawRetryAfter !== null) {
          // Honour Retry-After (delta-seconds or HTTP-date). Zero, invalid,
          // expired or unsafe (over max) delays stop the sequence — never
          // sleep(0) into an immediate burst, never clamp a trustworthy delay.
          const delay = parseRetryAfter(rawRetryAfter, (options.now ?? Date.now)());
          if (delay === null || delay === 0 || delay > max || i === attempts - 1) return response;
          lastError = new Error(`transient_http_${response.status}`);
          await sleep(delay);
          continue;
        }
      }
      if (response.status >= 500) {
        lastError = new Error(`transient_http_${response.status}`);
        if (i === attempts - 1) return response;
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) throw error;
    }
    const backoff = Math.min(max, base * 2 ** i);
    const jitter = Math.floor(backoff * 0.25 * Math.random());
    await sleep(backoff + jitter);
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}

/** Fetch with a timeout. Provider adapters use this for REST calls. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
