import { z } from "zod";

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

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional()
});

export type ApiError = z.infer<typeof apiErrorSchema>;
