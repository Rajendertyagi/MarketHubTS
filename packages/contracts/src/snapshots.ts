import { z } from "zod";
import { optionTypeSchema, type OptionType, provenanceSchema, type Provenance } from "./market";
import { providerIdSchema, type ProviderId } from "./provider-identity";

// --- Canonical snapshot envelope ---

export const captureModeSchema = z.enum(["MANUAL", "SCHEDULED", "BOTH"]);
export type CaptureMode = z.infer<typeof captureModeSchema>;

export interface OptionGreeks {
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
}

export interface OptionChainStrike {
  strike: number;
  optionType: OptionType;
  ltp?: number;
  oi?: number;
  volume?: number;
  bid?: number;
  ask?: number;
  iv?: number;
  greeks?: OptionGreeks;
}

export interface OptionChainSnapshotEnvelope {
  underlyingCanonicalId: string;
  expiryDate: string;
  /** Local capture time (ISO). Distinct from provider observation time. */
  capturedAt: string;
  /** Provider observation time (ISO) — nullable, never defaulted to capturedAt. */
  observationTimestamp: string | null;
  underlyingLtp: number | null;
  strikes: OptionChainStrike[];
  /** Provider-specific fields, attributed and never promoted to canonical implicitly. */
  providerExtensions: Record<string, unknown>;
}

export const optionChainSnapshotEnvelopeSchema = z.object({
  underlyingCanonicalId: z.string().min(1),
  expiryDate: z.string().min(1),
  capturedAt: z.string().datetime(),
  observationTimestamp: z.string().datetime().nullable(),
  underlyingLtp: z.number().finite().nullable(),
  strikes: z.array(z.object({
    strike: z.number().finite(),
    optionType: optionTypeSchema,
    ltp: z.number().finite().optional(),
    oi: z.number().int().nonnegative().optional(),
    volume: z.number().int().nonnegative().optional(),
    bid: z.number().finite().optional(),
    ask: z.number().finite().optional(),
    iv: z.number().finite().optional(),
    greeks: z.object({
      delta: z.number().finite().nullable().optional(),
      gamma: z.number().finite().nullable().optional(),
      theta: z.number().finite().nullable().optional(),
      vega: z.number().finite().nullable().optional(),
      rho: z.number().finite().nullable().optional()
    }).optional()
  })),
  providerExtensions: z.record(z.string(), z.unknown())
});

export interface OptionChainSnapshot {
  id: string;
  /** Null when the capture config was deleted — snapshots are retained. */
  configId: string | null;
  capturedAt: string;
  provider: ProviderId;
  envelope: OptionChainSnapshotEnvelope;
  provenance: Provenance;
}

export const optionChainSnapshotSchema = z.object({
  id: z.string().min(1),
  configId: z.string().nullable(),
  capturedAt: z.string(),
  provider: providerIdSchema,
  envelope: optionChainSnapshotEnvelopeSchema,
  provenance: provenanceSchema
});

// --- Capture configuration (WebUI-owned, independent of streaming selection) ---

export interface OptionChainCaptureConfig {
  id: string;
  underlyingCanonicalId: string;
  expiryDate: string;
  /** Validated JSON: strike range selection; null = all available strikes. */
  strikeRangeJson: string | null;
  captureEnabled: boolean;
  captureMode: CaptureMode;
  /** Validated JSON: cadence; no scheduler framework in M5. */
  scheduleJson: string | null;
  /** Streaming selection is independent of snapshot capture. */
  streamingEnabled: boolean;
  provider: ProviderId;
  createdAt: string;
  updatedAt: string;
}

export const optionChainCaptureRequestSchema = z.object({
  underlyingCanonicalId: z.string().min(1),
  expiryDate: z.string().min(1),
  provider: providerIdSchema.optional(),
  strikeRangeJson: z.string().nullable().optional(),
  nativeIdentifier: z.string().optional()
});

export const optionChainCaptureConfigSchema = z.object({
  id: z.string().min(1),
  underlyingCanonicalId: z.string().min(1),
  expiryDate: z.string().min(1),
  strikeRangeJson: z.string().nullable(),
  captureEnabled: z.boolean(),
  captureMode: captureModeSchema,
  scheduleJson: z.string().nullable(),
  streamingEnabled: z.boolean(),
  provider: providerIdSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});

/**
 * Discriminated selector for a bounded snapshot page partition (M6-B3).
 * No magic string: capture-config IDs accept any non-empty string, so "none"
 * is a valid real config ID and the null-config partition is a distinct kind.
 */
export type SnapshotPageSelector =
  | { kind: "config"; configId: string }
  | { kind: "null-config" };

// --- Retention (validated app_meta value, user-controlled) ---

export const retentionDataClassSchema = z.enum(["CANDLE", "SNAPSHOT", "ACTIVITY"]);
export type RetentionDataClass = z.infer<typeof retentionDataClassSchema>;

export const retentionSettingsSchema = z.object({
  version: z.literal(1),
  classes: z.object({
    CANDLE: z.object({ maxAgeDays: z.number().int().positive() }).optional(),
    SNAPSHOT: z.object({ maxAgeDays: z.number().int().positive() }).optional(),
    ACTIVITY: z.object({ maxAgeDays: z.number().int().positive() }).optional()
  })
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;

/**
 * Shared wire shape for a retention settings read. The two branches are
 * mutually exclusive: a valid persisted state (including a valid empty
 * `classes: {}`) carries settings and a null error; a missing, malformed or
 * schema-invalid state carries null settings and a non-empty error.
 */
export const retentionSettingsViewSchema = z.discriminatedUnion("valid", [
  z.object({
    settings: retentionSettingsSchema,
    valid: z.literal(true),
    error: z.null()
  }),
  z.object({
    settings: z.null(),
    valid: z.literal(false),
    error: z.string().min(1)
  })
]);
export type RetentionSettingsView = z.infer<typeof retentionSettingsViewSchema>;

/** Shared wire shape for a retention cleanup result. Zero is a real result, never a default. */
export const retentionCleanupResultSchema = z.object({
  ran: z.boolean(),
  reason: z.string().nullable(),
  candlesDeleted: z.number().int().nonnegative(),
  snapshotsDeleted: z.number().int().nonnegative(),
  activitiesDeleted: z.number().int().nonnegative()
});
export type RetentionCleanupResult = z.infer<typeof retentionCleanupResultSchema>;
