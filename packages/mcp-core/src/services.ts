import type { HealthStatus } from "@markethub/contracts";

/** Uniform result shape shared by all MCP service operations. */
export type McpResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { category: "validation" | "unavailable" | "provider" | "internal"; message: string } };

/**
 * The seam through which shared MCP registration reaches application capabilities.
 * M6-A intentionally exposes only `getHealth()`; further operations are added in
 * M6-B when a tool or resource actually needs them.
 */
export interface McpServices {
  getHealth(): Promise<McpResult<HealthStatus>>;
}
