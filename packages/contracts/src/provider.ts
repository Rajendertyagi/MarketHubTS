import { z } from "zod";

// --- Provider identity and configuration (non-secret only) ---
export const providerIdSchema = z.enum(["UPSTOX", "FYERS"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const providerConfigSchema = z.object({
  enabled: z.boolean(),
  // FYERS non-secret settings. Secrets are never part of configuration.
  fyersAppId: z.string().min(1).optional(),
  fyersRedirectUri: z.string().url().optional(),
  // Optional user-supplied expiry metadata (Upstox Analytics Token dashboard date).
  upstoxTokenExpiresAt: z.string().datetime().optional()
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

// --- Credential store contract ---
export const credentialStoreStateSchema = z.enum(["AVAILABLE", "UNAVAILABLE"]);
export type CredentialStoreState = z.infer<typeof credentialStoreStateSchema>;

export interface CredentialStoreStatus {
  state: CredentialStoreState;
  reason?: string;
  keyPath?: string;
}

export interface CredentialStore {
  get(provider: ProviderId, name: string): Promise<string | null>;
  set(provider: ProviderId, name: string, value: string): Promise<void>;
  delete(provider: ProviderId, name: string): Promise<void>;
  status(): CredentialStoreStatus;
  /** Explicit, destructive reset: discards encrypted credential rows and creates a new key. */
  reset(): Promise<void>;
}

// --- Provider status model ---
export const providerAuthStateSchema = z.enum([
  "DISABLED",
  "NOT_CONFIGURED",
  "AUTH_REQUIRED",
  "AUTHENTICATED",
  "EXPIRED",
  "DEGRADED",
  "ERROR",
  "CREDENTIALS_UNAVAILABLE"
]);
export type ProviderAuthState = z.infer<typeof providerAuthStateSchema>;

// Streaming is deliberately not implemented in M3.
export const streamingStateSchema = z.literal("NOT_STARTED");
export type StreamingState = z.infer<typeof streamingStateSchema>;

export const capabilityStateSchema = z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const capabilitySourceSchema = z.enum(["API", "DOCUMENTATION", "USER", "UNKNOWN"]);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;

export interface ProviderCapability {
  name: string;
  state: CapabilityState;
  source: CapabilitySource;
  asOf?: string;
  note?: string;
}

export interface ProviderLimit {
  name: string;
  value: string | number | null;
  state: CapabilityState;
  source: CapabilitySource;
  publishedAt?: string;
  note?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  enabled: boolean;
  authState: ProviderAuthState;
  streamingState: StreamingState;
  validatedAt: string | null;
  expiresAt: string | null;
  expiryKnown: boolean;
  capabilities: ProviderCapability[];
  limits: ProviderLimit[];
  restrictions: string[];
  error: string | null;
  lastErrorAt: string | null;
}

export interface ProviderStatusMap {
  UPSTOX: ProviderStatus;
  FYERS: ProviderStatus;
}

// --- Authentication flow results ---
export interface AuthStartResult {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}

export interface AuthCompleteInput {
  code?: string;
  state?: string;
  error?: string;
}

// --- Minimal common adapter contract ---
export interface ProviderAdapter {
  readonly id: ProviderId;
  getStatus(): ProviderStatus;
  isConfigured(): Promise<boolean>;
  validate(): Promise<ProviderStatus>;
  remove(): Promise<void>;
  startAuth?(): Promise<AuthStartResult>;
  completeAuth?(input: AuthCompleteInput): Promise<ProviderStatus>;
}

export function emptyProviderStatus(id: ProviderId, enabled: boolean): ProviderStatus {
  return {
    id,
    enabled,
    authState: enabled ? "NOT_CONFIGURED" : "DISABLED",
    streamingState: "NOT_STARTED",
    validatedAt: null,
    expiresAt: null,
    expiryKnown: false,
    capabilities: [],
    limits: [],
    restrictions: [],
    error: null,
    lastErrorAt: null
  };
}
