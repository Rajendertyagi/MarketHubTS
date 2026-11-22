import { z } from "zod";
import { provenanceSchema, type Provenance } from "./market";
import { providerIdSchema, type ProviderId } from "./provider-identity";

// --- Canonical candle intervals (provider-agnostic) ---

export const candleIntervalSchema = z.enum([
  "1m", "2m", "3m", "5m", "10m", "15m", "20m", "30m", "45m", "60m", "120m", "180m", "240m",
  "1D", "1W", "1M"
]);
export type CandleInterval = z.infer<typeof candleIntervalSchema>;

/** Interval class used for gap assessment. No exchange calendar is available in M5. */
export type IntervalClass = "DAILY" | "WEEKLY" | "MONTHLY" | "INTRADAY";

export function intervalClass(interval: CandleInterval): IntervalClass {
  if (interval === "1D") return "DAILY";
  if (interval === "1W") return "WEEKLY";
  if (interval === "1M") return "MONTHLY";
  return "INTRADAY";
}

// --- Canonical candle ---

export interface HistoricalCandle {
  canonicalId: string;
  interval: CandleInterval;
  /** Candle start time as epoch milliseconds (UTC). */
  tsMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Null when the provider did not supply volume — never fabricated. */
  volume: number | null;
  /** Null when the provider did not supply open interest — never fabricated. */
  oi: number | null;
  provider: ProviderId;
  provenance: Provenance;
  receivedAtMs: number;
}

export const historicalCandleSchema = z.object({
  canonicalId: z.string().min(1),
  interval: candleIntervalSchema,
  tsMs: z.number().int().nonnegative(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().int().nonnegative().nullable(),
  oi: z.number().int().nonnegative().nullable(),
  provider: providerIdSchema,
  provenance: provenanceSchema,
  receivedAtMs: z.number().int().nonnegative()
});

// --- Requests and results ---

export interface CandleRangeRequest {
  canonicalId: string;
  interval: CandleInterval;
  fromMs: number;
  toMs: number;
  /** Optional provider preference; no fixed priority is implied. */
  provider?: ProviderId;
  /** Adapter hint: provider-native identifier resolved from catalog mappings by the caller. */
  nativeIdentifier?: string;
  /** Adapter hint: request expired-contract history via the provider's distinct endpoint. */
  expired?: boolean;
}

export const candleRangeRequestSchema = z.object({
  canonicalId: z.string().min(1),
  interval: candleIntervalSchema,
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
  provider: providerIdSchema.optional(),
  nativeIdentifier: z.string().optional(),
  expired: z.boolean().optional()
});

/** Basis of a gap assessment. M5 never asserts confirmed missing candles. */
export const gapBasisSchema = z.enum(["WEEKDAY_ONLY", "WEEKLY_BUCKET", "MONTHLY_BUCKET", "SESSION_UNKNOWN", "CALENDAR_BACKED"]);
export type GapBasis = z.infer<typeof gapBasisSchema>;

export interface CandleGap {
  canonicalId: string;
  interval: CandleInterval;
  fromMs: number;
  toMs: number;
  basis: GapBasis;
  /** Always false in M5 — no verified calendar/session source. */
  confirmed: false;
  reason: string;
}

export const candleGapSchema = z.object({
  canonicalId: z.string().min(1),
  interval: candleIntervalSchema,
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
  basis: gapBasisSchema,
  confirmed: z.literal(false),
  reason: z.string()
});

/** Stable reason codes for authoritative (permanent/request-specific) unavailability notes. */
export const unavailableReasonCodeSchema = z.enum(["ENTITLEMENT", "DATE_LIMIT", "NO_DATA"]);
export type UnavailableReasonCode = z.infer<typeof unavailableReasonCodeSchema>;

export const rangeNoteKindSchema = z.enum(["UNAVAILABLE", "CONFLICT"]);
export type RangeNoteKind = z.infer<typeof rangeNoteKindSchema>;

export interface CandleRangeNote {
  canonicalId: string;
  interval: CandleInterval;
  provider: ProviderId;
  rangeStartMs: number;
  kind: RangeNoteKind;
  rangeEndMs: number;
  /** ENTITLEMENT/DATE_LIMIT/NO_DATA for UNAVAILABLE; null for CONFLICT. */
  reasonCode: UnavailableReasonCode | null;
  /** Sanitized detail / competing values. Never contains credentials or account data. */
  reasonJson: string;
  requestedAtMs: number;
  updatedAtMs: number;
}

/** Report-only reason: surfaced in status but never persisted as a permanent note. */
export type ReportReasonCode = UnavailableReasonCode | "REQUEST_ERROR";

export const candleRangeNoteSchema = z.object({
  canonicalId: z.string().min(1),
  interval: candleIntervalSchema,
  provider: providerIdSchema,
  rangeStartMs: z.number().int().nonnegative(),
  kind: rangeNoteKindSchema,
  rangeEndMs: z.number().int().nonnegative(),
  reasonCode: unavailableReasonCodeSchema.nullable(),
  reasonJson: z.string(),
  requestedAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative()
});

export interface DataUnavailableReport {
  canonicalId: string;
  interval: CandleInterval;
  fromMs: number;
  toMs: number;
  provider: ProviderId;
  reasonCode: ReportReasonCode;
  detail: string;
}

// --- Historical sync configuration (WebUI-owned, distinct from streaming subscriptions) ---

export interface HistoricalSyncConfig {
  id: string;
  canonicalId: string;
  interval: CandleInterval;
  enabled: boolean;
  /** Validated JSON: { from?: string; to?: string; backfill?: boolean } */
  dateRangeJson: string | null;
  /** Validated JSON: cadence description; no scheduler framework in M5. */
  scheduleJson: string | null;
  /** Validated JSON: provider preference policy (never a fixed priority). */
  providerPolicyJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Minimal, validated provider preference policy — never a fixed priority. */
export const providerPolicySchema = z.object({
  preferredProvider: providerIdSchema.optional()
});
export type ProviderPolicy = z.infer<typeof providerPolicySchema>;

export const historicalSyncConfigSchema = z.object({
  id: z.string().min(1),
  canonicalId: z.string().min(1),
  interval: candleIntervalSchema,
  enabled: z.boolean(),
  dateRangeJson: z.string().nullable(),
  scheduleJson: z.string().nullable(),
  providerPolicyJson: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
