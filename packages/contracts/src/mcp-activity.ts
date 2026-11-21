import { z } from "zod";
import { candleIntervalSchema } from "./historical";

/** MCP operation outcome recorded in the durable activity log. */
export const mcpActivityStatusSchema = z.enum(["started", "succeeded", "failed", "interrupted"]);
export type McpActivityStatus = z.infer<typeof mcpActivityStatusSchema>;

/** Transport that executed the operation. */
export const mcpActivityTransportSchema = z.enum(["HTTP", "STDIO"]);
export type McpActivityTransport = z.infer<typeof mcpActivityTransportSchema>;

/** Terminal statuses accepted by the complete operation. */
export const mcpActivityTerminalStatusSchema = z.enum(["succeeded", "failed", "interrupted"]);
export type McpActivityTerminalStatus = z.infer<typeof mcpActivityTerminalStatusSchema>;

/** Bounded, discriminated reference to a stored market-data result (never the payload). */
export const mcpActivityResultRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), snapshotId: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal("historical"),
    canonicalId: z.string().min(1).max(300),
    interval: candleIntervalSchema,
    fromMs: z.number().int().finite(),
    toMs: z.number().int().finite()
  })
]);
export type McpActivityResultRef = z.infer<typeof mcpActivityResultRefSchema>;

/**
 * Strict safe-summary field allow-list, derived from the real tool/resource/
 * prompt registration call sites in packages/mcp-core. Unknown keys are
 * rejected so arbitrary arguments can never be persisted as a summary.
 */
export const MCP_ACTIVITY_SUMMARY_KEYS = [
  "query", "limit", "canonicalId", "interval", "mode", "from", "to",
  "configId", "snapshotId", "underlyingCanonicalId", "expiryDate", "kind",
  "hasCursor"
] as const;

const summaryValue = z.union([z.string().max(200), z.number().finite(), z.boolean()]);

export const mcpActivitySummarySchema = z.object({
  query: summaryValue.optional(),
  limit: summaryValue.optional(),
  canonicalId: summaryValue.optional(),
  interval: summaryValue.optional(),
  mode: summaryValue.optional(),
  from: summaryValue.optional(),
  to: summaryValue.optional(),
  configId: summaryValue.optional(),
  snapshotId: summaryValue.optional(),
  underlyingCanonicalId: summaryValue.optional(),
  expiryDate: summaryValue.optional(),
  kind: summaryValue.optional(),
  hasCursor: summaryValue.optional()
}).strict().refine((value) => JSON.stringify(value).length <= 1000, { message: "summary too large" });
export type McpActivitySummary = z.infer<typeof mcpActivitySummarySchema>;

/**
 * Project a persisted (possibly legacy) summary JSON through the strict
 * allow-list: unknown keys and invalid values are dropped, and the result is
 * re-serialized. Returns "{}" when nothing survives or the input is malformed.
 * Used on the read path so records written before the strict schema cannot
 * expose arbitrary fields through LAN-readable views.
 */
export function projectSafeSummaryJson(raw: string | null): string {
  if (!raw) return "{}";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
    const source = parsed as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const key of MCP_ACTIVITY_SUMMARY_KEYS) {
      if (key in source) filtered[key] = source[key];
    }
    const validated = mcpActivitySummarySchema.safeParse(filtered);
    return validated.success ? JSON.stringify(validated.data) : "{}";
  } catch {
    return "{}";
  }
}

/** ISO timestamp used for optional client-supplied diagnostics only. */
const diagnosticTimestamp = z.string().datetime();

/** Start request. Unknown fields are rejected. */
export const mcpActivityStartRequestSchema = z.object({
  operationId: z.string().uuid(),
  toolName: z.string().min(1).max(200),
  transport: mcpActivityTransportSchema,
  clientName: z.string().min(1).max(120).optional(),
  clientVersion: z.string().min(1).max(120).optional(),
  clientStartedAt: diagnosticTimestamp.optional(),
  summaryJson: z.string().max(1000).optional()
    .refine((raw) => {
      if (raw === undefined) return true;
      try {
        return mcpActivitySummarySchema.safeParse(JSON.parse(raw)).success;
      } catch {
        return false;
      }
    }, { message: "summaryJson must be a bounded safe-summary JSON object" })
}).strict();
export type McpActivityStartRequest = z.infer<typeof mcpActivityStartRequestSchema>;

/** Start response envelope (STDIO validates this exactly). */
export const mcpActivityStartResultSchema = z.object({
  id: z.string().min(1),
  operationId: z.string().uuid(),
  startedAt: z.string().datetime()
}).strict();
export type McpActivityStartResult = z.infer<typeof mcpActivityStartResultSchema>;

/** Complete request. Unknown fields are rejected. */
export const mcpActivityCompleteRequestSchema = z.object({
  operationId: z.string().uuid(),
  status: mcpActivityTerminalStatusSchema,
  clientFinishedAt: diagnosticTimestamp.optional(),
  errorCategory: z.string().min(1).max(64).optional(),
  errorMessage: z.string().min(1).max(300).optional(),
  dataResultRef: mcpActivityResultRefSchema.optional()
}).strict();
export type McpActivityCompleteRequest = z.infer<typeof mcpActivityCompleteRequestSchema>;

/** Complete response envelope (STDIO validates this exactly). */
export const mcpActivityCompleteResultSchema = z.object({
  id: z.string().min(1),
  status: mcpActivityTerminalStatusSchema,
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative()
}).strict();
export type McpActivityCompleteResult = z.infer<typeof mcpActivityCompleteResultSchema>;

/** Safe view returned by the API — no raw args, tokens, payloads or client IPs. */
export const mcpActivityViewSchema = z.object({
  id: z.string().min(1),
  operationId: z.string().uuid(),
  toolName: z.string(),
  transport: mcpActivityTransportSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  clientStartedAt: z.string().datetime().nullable(),
  clientFinishedAt: z.string().datetime().nullable(),
  clientName: z.string().nullable(),
  clientVersion: z.string().nullable(),
  status: mcpActivityStatusSchema,
  errorCategory: z.string().nullable(),
  errorMessage: z.string().nullable(),
  summaryJson: z.string().nullable(),
  dataResultRef: mcpActivityResultRefSchema.nullable()
});
export type McpActivityView = z.infer<typeof mcpActivityViewSchema>;

/** Bounded paginated list envelope. */
export const mcpActivityListSchema = z.object({
  records: z.array(mcpActivityViewSchema),
  nextCursor: z.string().nullable()
});
export type McpActivityList = z.infer<typeof mcpActivityListSchema>;

/** Supported list filters (also fingerprinted into the page cursor). */
export const mcpActivityFiltersSchema = z.object({
  toolName: z.string().min(1).max(200).optional(),
  transport: mcpActivityTransportSchema.optional(),
  status: mcpActivityStatusSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
}).strict();
export type McpActivityFilters = z.infer<typeof mcpActivityFiltersSchema>;
