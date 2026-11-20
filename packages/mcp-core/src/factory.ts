import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import type { McpServices } from "./services";
import { registerTools } from "./tools";
import { registerResources } from "./resources";
import { registerPrompts } from "./prompts";

/**
 * Pure registration function: builds a fresh McpServer per request/connection and
 * registers the shared tool/resource/prompt set against the supplied services.
 * No background work, timers or process-level state — the SDK calls this once
 * per HTTP request and once per STDIO connection (plus a discarded discovery probe).
 */
export function createMcpServer(ctx: McpRequestContext, services: McpServices): McpServer {
  void ctx; // reserved for era-specific registration in later phases
  const server = new McpServer(
    { name: "markethubts", version: "0.1.0" },
    {
      cacheHints: {
        "server/discover":          { ttlMs: 0, cacheScope: "private" },
        "tools/list":               { ttlMs: 0, cacheScope: "private" },
        "prompts/list":             { ttlMs: 0, cacheScope: "private" },
        "resources/list":           { ttlMs: 0, cacheScope: "private" },
        "resources/templates/list": { ttlMs: 0, cacheScope: "private" },
        "resources/read":           { ttlMs: 0, cacheScope: "private" }
      }
    }
  );
  registerTools(server, services);
  registerResources(server, services);
  registerPrompts(server);
  return server;
}
