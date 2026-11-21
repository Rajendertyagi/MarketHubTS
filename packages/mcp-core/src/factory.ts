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
  // M6-D: initialize capabilities explicitly before register* runs. The SDK's
  // register helpers default listChanged to `true` when absent, so leaving these
  // unset would advertise false list-change support. resources.subscribe is
  // enabled only for modern HTTP (where the process-wide bridge is active);
  // legacy HTTP and all STDIO contexts must not claim live resource updates.
  const subscribe = ctx.era === "modern" && ctx.requestInfo !== undefined;
  const server = new McpServer(
    { name: "markethubts", version: "0.1.0" },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe },
        prompts: { listChanged: false }
      },
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
