import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "@markethub/mcp-core";
import { createStdioServices } from "./services";

const apiBase = process.env.MARKETHUB_API_URL ?? "http://localhost:3001";
const stdioServices = createStdioServices(apiBase);

const handle = serveStdio((ctx) => createMcpServer(ctx, stdioServices));

let closed = false;
const close = () => {
  if (closed) return;
  closed = true;
  void handle.close().catch(() => {});
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
if (process.stdin && typeof process.stdin.on === "function") {
  process.stdin.on("end", close);
  process.stdin.on("close", close);
}

console.error(`MarketHubTS MCP server ready (stdio). API base: ${apiBase}`);
