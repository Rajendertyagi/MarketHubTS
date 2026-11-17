import { z } from "zod";
import type { AvailabilityState, Provenance } from "./market";
import type { ProviderId } from "./provider";
import type { LiveFreshnessState, SelectionMode, TimestampUnit } from "./live";

// --- Canonical component kinds (exactly three; index is an instrument type) ---
export const componentKindSchema = z.enum(["quote", "depth", "derivatives"]);
export type ComponentKind = z.infer<typeof componentKindSchema>;

/** A source timestamp kept verbatim, with its documented meaning/unit and trust state. */
export interface SourceTimestamp {
  raw: number | null;
  unit: TimestampUnit;
  meaning: string;
  normalizedMs: number | null;
  trusted: boolean;
}

/** Per-field age/provenance. Never used as a second provider-selection mechanism. */
export interface FieldTimestamp {
  source: SourceTimestamp | null;
  receivedAtMs: number;
}

/**
 * Explicit field presence. `set` contains only fields actually supplied by the
 * message; `clear` contains only fields the provider explicitly marks cleared or
 * unavailable. Omission from both means "no change" — never a clear, never zero.
 */
export interface FieldUpdate<T = unknown> {
  value: T;
  sourceTimestamp?: SourceTimestamp;
  receivedAtMs: number;
}

export interface ComponentUpdate<TFields extends string = string> {
  provider: ProviderId;
  canonicalId: string;
  component: ComponentKind;
  set: Partial<Record<TFields, FieldUpdate>>;
  clear?: TFields[];
  /** True only when the provider contract establishes a complete component snapshot. */
  complete?: boolean;
  provenance: Provenance;
  availability?: AvailabilityState;
  receivedAtMs: number;
}

// --- Quote fields ---
export const quoteFieldSchema = z.enum([
  "ltp",
  "previousClose",
  "close",
  "lastTradedTime",
  "lastTradedQuantity",
  "open",
  "high",
  "low",
  "volume",
  "averageTradePrice",
  "change",
  "changePercent",
  "ohlc"
]);
export type QuoteField = z.infer<typeof quoteFieldSchema>;

/** A single OHLC interval/bar. Its `close` is never LTP or previous-session close. */
export interface OhlcIntervalRecord {
  interval: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  timestamp: SourceTimestamp;
}

export interface QuoteValue {
  ltp?: number;
  /** Previous trading session's close — the unambiguous canonical field. */
  previousClose?: number;
  /** @deprecated Compatibility alias for previousClose during migration. */
  close?: number;
  lastTradedTime?: SourceTimestamp;
  lastTradedQuantity?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  averageTradePrice?: number;
  change?: number;
  changePercent?: number;
  ohlc?: OhlcIntervalRecord[];
}

// --- Depth fields ---
export interface DepthLevel {
  /** 1-based level index. */
  index: number;
  bidPrice?: number;
  bidSize?: number;
  bidOrders?: number;
  askPrice?: number;
  askSize?: number;
  askOrders?: number;
}

export interface DepthValue {
  /** Explicit level count: 1, 5 or 30. Missing levels are absent, not zero. */
  levelCount: number;
  levels: DepthLevel[];
}

// --- Derivatives fields ---
export interface GreeksValue {
  delta?: number;
  theta?: number;
  gamma?: number;
  vega?: number;
  rho?: number;
}

export interface DerivativesValue {
  oi?: number;
  iv?: number;
  greeks?: GreeksValue;
}

export type ComponentValue = QuoteValue | DepthValue | DerivativesValue;

// --- Retained observation for one (provider, instrument, component) ---
export interface ComponentObservation<T extends ComponentValue = ComponentValue> {
  provider: ProviderId;
  canonicalId: string;
  component: ComponentKind;
  value: Partial<T>;
  /** Per-field update/receipt timestamps for honest field age. */
  fieldTimestamps: Record<string, FieldTimestamp>;
  /** Component-level timestamp used for freshness and selection. */
  sourceTimestamp: SourceTimestamp | null;
  receivedAtMs: number;
  freshness: LiveFreshnessState;
  availability: AvailabilityState;
  provenance: Provenance;
}

export interface SelectedComponent<T extends ComponentValue = ComponentValue> {
  canonicalId: string;
  component: ComponentKind;
  provider: ProviderId | null;
  value: T | null;
  mode: SelectionMode;
  freshness: LiveFreshnessState;
  reason: string;
  observation: ComponentObservation<T> | null;
}

// --- Provider-neutral capability contracts ---
export const capabilityStatusSchema = z.enum(["SUPPORTED", "UNSUPPORTED", "LIMITED", "UNAVAILABLE"]);
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

export const quoteCapabilityRequestSchema = z.object({
  fields: z.array(quoteFieldSchema),
  optionalFields: z.array(quoteFieldSchema).optional()
});
export type QuoteCapabilityRequest = z.infer<typeof quoteCapabilityRequestSchema>;

export const depthCapabilityRequestSchema = z.object({
  levels: z.union([z.literal(1), z.literal(5), z.literal(30)])
});
export type DepthCapabilityRequest = z.infer<typeof depthCapabilityRequestSchema>;

export const derivativesMetricSchema = z.enum(["oi", "iv", "greeks"]);
export type DerivativesMetric = z.infer<typeof derivativesMetricSchema>;

export const derivativesCapabilityRequestSchema = z.object({
  metrics: z.array(derivativesMetricSchema)
});
export type DerivativesCapabilityRequest = z.infer<typeof derivativesCapabilityRequestSchema>;

export const capabilityRequestSchema = z.object({
  components: z.array(componentKindSchema),
  quote: quoteCapabilityRequestSchema.optional(),
  depth: depthCapabilityRequestSchema.optional(),
  derivatives: derivativesCapabilityRequestSchema.optional()
});
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;

export const capabilityResultSchema = z.object({
  component: componentKindSchema,
  provider: z.enum(["UPSTOX", "FYERS"]),
  status: capabilityStatusSchema,
  fields: z.array(z.string()).optional(),
  levels: z.number().int().positive().optional(),
  reason: z.string().optional(),
  /** True when account/plan entitlement has not been verified. */
  entitlementUnverified: z.boolean().optional()
});
export type CapabilityResult = z.infer<typeof capabilityResultSchema>;
