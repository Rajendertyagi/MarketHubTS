import { z } from "zod";

export const checkStateSchema = z.enum(["ok", "error", "unknown", "degraded"]);
export type CheckState = z.infer<typeof checkStateSchema>;

export const healthStatusSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  timestamp: z.string(),
  version: z.string(),
  checks: z.object({
    api: z.literal("ok"),
    database: z.enum(["ok", "error", "unknown"])
  })
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const readinessStatusSchema = z.object({
  status: z.enum(["ok", "degraded", "error"]),
  service: z.string(),
  timestamp: z.string(),
  version: z.string(),
  ready: z.boolean(),
  checks: z.object({
    api: checkStateSchema,
    database: checkStateSchema,
    config: checkStateSchema
  }),
  details: z
    .object({
      databasePathConfigured: z.boolean().optional(),
      uptimeMs: z.number().optional(),
      environment: z.string().optional(),
      lan: z.boolean().optional(),
      host: z.string().optional(),
      port: z.number().optional()
    })
    .optional()
});

export type ReadinessStatus = z.infer<typeof readinessStatusSchema>;

export const systemStatusSchema = z.object({
  service: z.string(),
  version: z.string(),
  timestamp: z.string(),
  uptimeMs: z.number(),
  health: healthStatusSchema,
  readiness: readinessStatusSchema,
  /** M6-C: reports only whether the MCP HTTP handler is mounted, not runtime health. */
  mcp: z.object({
    httpHandlerMounted: z.boolean()
  })
});

export type SystemStatus = z.infer<typeof systemStatusSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.unknown().optional()
});

export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * G0-C — dependency-light write-coordination seam (plan §8.4).
 *
 * Additive interface only: no enum, schema value or selectable option is
 * introduced. `packages/database` consumes this interface via injection and
 * never imports the API-owned coordinator (no dependency inversion).
 */
export type WritePriority = "I" | "B" | "INTERNAL";

export interface WriteScope {
  readonly priority: WritePriority;
  readonly id: string;
}

export interface CatalogWriteGuard {
  /** `I`/`INTERNAL` throw when busy; `B` returns "SKIP" (never queues). */
  assertWritable(priority: WritePriority, scope?: WriteScope): void | "SKIP";
  acquireWriteScope(priority: WritePriority): WriteScope;
  releaseWriteScope(scope: WriteScope): void;
}

export * from "./market";
export * from "./provider";
export * from "./live";
export * from "./live-components";
export * from "./historical";
export * from "./snapshots";
export * from "./mcp-activity";
export * from "./mcp-operations";
export * from "./sanitize";
export * from "./market-dates";
