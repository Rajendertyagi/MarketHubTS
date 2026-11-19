import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { McpServices } from "./services";

/**
 * Pure registration function: builds a fresh McpServer per request/connection and
 * registers the shared tool set against the supplied services. No background work,
 * timers or process-level state — the SDK calls this once per HTTP request and once
 * per STDIO connection (plus a discarded discovery probe).
 */
export function createMcpServer(ctx: McpRequestContext, services: McpServices): McpServer {
  void ctx; // reserved for era-specific registration in later phases
  const server = new McpServer({ name: "markethubts", version: "0.1.0" });

  server.registerTool(
    "markethub_health",
    {
      description: "Get MarketHubTS API and database health status via the local API.",
      inputSchema: z.object({})
    },
    async () => {
      const result = await services.getHealth();
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: result.error }, null, 2) }],
          isError: true
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.value, null, 2) }],
        structuredContent: result.value
      };
    }
  );

  return server;
}
