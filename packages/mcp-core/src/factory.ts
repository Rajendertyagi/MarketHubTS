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
  // M6-C: requestInfo is set only for HTTP requests by the installed SDK;
  // serveStdio never sets it. No activity rows are created during construction.
  const transport = ctx.requestInfo ? "HTTP" : "STDIO";
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
  registerTools(server, services, transport);
  registerResources(server, services, transport);
  registerPrompts(server, services, transport);
  return server;
}
