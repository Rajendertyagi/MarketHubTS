import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { healthStatusSchema } from "@markethub/contracts";

const apiBase = process.env.MARKETHUB_API_URL ?? "http://localhost:3001";

serveStdio(() => {
  const server = new McpServer({ name: "markethubts", version: "0.1.0" });

  server.registerTool(
    "markethub_health",
    {
      description: "Get MarketHubTS API and database health status via the local API.",
      inputSchema: z.object({})
    },
    async () => {
      try {
        const res = await fetch(`${apiBase}/health`);
        const json = await res.json();
        const parsed = healthStatusSchema.safeParse(json);
        if (!res.ok || !parsed.success) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, status: res.status, body: json }, null, 2) }],
            isError: true
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(parsed.data, null, 2) }],
          structuredContent: parsed.data
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, apiBase }, null, 2) }],
          isError: true
        };
      }
    }
  );

  return server;
});

console.error(`MarketHubTS MCP server ready (stdio). API base: ${apiBase}`);
