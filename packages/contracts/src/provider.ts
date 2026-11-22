import { z } from "zod";
import { providerConnectionStateSchema, type ProviderConnectionState } from "./live";
import { providerIdSchema, type ProviderId } from "./provider-identity";

// --- Provider identity and configuration (non-secret only) ---
// Re-exported to preserve the existing public API of this module.
export { providerIdSchema, type ProviderId } from "./provider-identity";

export const providerConfigSchema = z.object({
  enabled: z.boolean(),
  // FYERS non-secret settings. Secrets are never part of configuration.
  fyersAppId: z.string().min(1).optional(),
  fyersRedirectUri: z.string().url().optional(),
  // Optional user-supplied expiry metadata (Upstox Analytics Token dashboard date).
  upstoxTokenExpiresAt: z.string().datetime().optional(),
  // Actual application listener, used to validate the FYERS loopback callback URI.
  apiPort: z.number().int().min(1).max(65535).optional(),
  apiSecure: z.boolean().optional()
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

/** Startup advisory shown when stored credentials still need validation. */
export const VALIDATION_REQUIRED_ADVISORY = "Stored credentials found; validation required";

/** Remove only the startup advisory, preserving other restrictions (e.g. expiry unknown). */
export function withoutValidationAdvisory(restrictions: string[]): string[] {
  return restrictions.filter((r) => r !== VALIDATION_REQUIRED_ADVISORY);
}

/** Durable non-secret settings (App ID, redirect URI, expiry metadata). Never secrets. */
export interface ProviderSettings {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<Record<string, string>>;
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

// Runtime streaming state is the single authoritative connection-state schema
// defined in live.ts. ProviderRegistry owns auth/status; the supervisor owns
// runtime connection state and writes it through MarketDataService.
export const streamingStateSchema = providerConnectionStateSchema;
export type StreamingState = ProviderConnectionState;

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

export const providerCapabilitySchema = z.object({
  name: z.string(),
  state: capabilityStateSchema,
  source: capabilitySourceSchema,
  asOf: z.string().optional(),
  note: z.string().optional()
});

export const providerLimitSchema = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.null()]),
  state: capabilityStateSchema,
  source: capabilitySourceSchema,
  publishedAt: z.string().optional(),
  note: z.string().optional()
});

export const providerStatusSchema = z.object({
  id: providerIdSchema,
  enabled: z.boolean(),
  authState: providerAuthStateSchema,
  streamingState: streamingStateSchema,
  validatedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  expiryKnown: z.boolean(),
  capabilities: z.array(providerCapabilitySchema),
  limits: z.array(providerLimitSchema),
  restrictions: z.array(z.string()),
  error: z.string().nullable(),
  lastErrorAt: z.string().nullable()
});

export const providerStatusMapSchema = z.object({
  UPSTOX: providerStatusSchema,
  FYERS: providerStatusSchema
});

/** Complete envelope returned by GET /api/providers/status. providers is null when no registry/auth map is available. */
export const providerStatusesResponseSchema = z.object({
  providers: providerStatusMapSchema.nullable(),
  localManagement: z.boolean(),
  note: z.string()
});
export type ProviderStatusesResponse = z.infer<typeof providerStatusesResponseSchema>;

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
