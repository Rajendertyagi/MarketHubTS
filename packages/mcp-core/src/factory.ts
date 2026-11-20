import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import type { McpServices } from "./services";
import { registerTools } from "./tools";

/**
 * Pure registration function: builds a fresh McpServer per request/connection and
 * registers the shared tool set against the supplied services. No background work,
 * timers or process-level state — the SDK calls this once per HTTP request and once
 * per STDIO connection (plus a discarded discovery probe).
 */
export function createMcpServer(ctx: McpRequestContext, services: McpServices): McpServer {
  void ctx; // reserved for era-specific registration in later phases
  const server = new McpServer({ name: "markethubts", version: "0.1.0" });
  registerTools(server, services);
  return server;
}
