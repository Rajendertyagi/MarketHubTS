import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok",
  service: "markethub-api",
  timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0",
  checks: { api: "ok", database: "ok" }
});

/**
 * Spawn the real STDIO process and connect a modern-pinned client. A tiny local
 * HTTP server stands in for the API health endpoint the STDIO tool calls — no
 * live providers, no external network.
 */
describe("mcp stdio modern (M6-A)", () => {
  test("modern-pinned client discovers and calls markethub_health over stdio", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/health"
          ? Response.json(HEALTH)
          : new Response("not found", { status: 404 })
    });

    let client: Client | null = null;
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["apps/mcp-server/src/index.ts"],
        cwd: process.cwd(),
        env: { ...process.env, MARKETHUB_API_URL: `http://127.0.0.1:${api.port}` } as Record<string, string>
      });
      client = new Client(
        { name: "markethub-stdio-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      );
      await client.connect(transport);

      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "markethub_health")).toBe(true);

      const result = await client.callTool({ name: "markethub_health", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(HEALTH);

      // Clean client + transport closure.
      await client.close();
      client = null;
    } finally {
      if (client) await client.close();
      await api.stop(true);
    }
  });
});
