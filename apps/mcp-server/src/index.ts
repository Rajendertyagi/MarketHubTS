import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer, type McpServices } from "@markethub/mcp-core";
import { healthStatusSchema } from "@markethub/contracts";

const apiBase = process.env.MARKETHUB_API_URL ?? "http://localhost:3001";

/** STDIO reaches the canonical API through its existing local-API client pattern. */
const stdioServices: McpServices = {
  getHealth: async () => {
    try {
      const res = await fetch(`${apiBase}/health`);
      const json = await res.json();
      const parsed = healthStatusSchema.safeParse(json);
      if (!res.ok || !parsed.success) {
        return {
          ok: false,
          error: { category: "unavailable", message: `API health check failed (status ${res.status})` }
        };
      }
      return { ok: true, value: parsed.data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { category: "unavailable", message } };
    }
  }
};

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
