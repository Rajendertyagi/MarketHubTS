import type { Hono } from "hono";
import { mcpOperationListSchema } from "@markethub/contracts";
import { listMcpOperationDescriptors } from "@markethub/mcp-core";

/**
 * Read-only operation discovery for the WebUI Activity selector.
 *
 * The response is sourced exclusively from the registration-owned descriptor
 * accessor in `@markethub/mcp-core` and validated against the strict shared
 * contract before it is returned. No MCP SDK internals, input schemas,
 * annotations, handlers or operational configuration are read or exposed.
 * `Cache-Control: no-store` makes a browser reload observe the deployed
 * registration set without any polling.
 */
export function registerMcpOperationsRoutes(app: Hono): void {
  app.get("/api/mcp/operations", (c) => {
    const payload = mcpOperationListSchema.parse({ operations: listMcpOperationDescriptors() });
    c.header("Cache-Control", "no-store");
    return c.json(payload);
  });
}
