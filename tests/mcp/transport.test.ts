import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";
import { buildMcpAllowlists } from "../../apps/api/src/mcp-routes";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok",
  service: "markethub-api",
  timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0",
  checks: { api: "ok", database: "ok" }
});

const services: McpServices = {
  getHealth: async () => ({ ok: true, value: HEALTH })
};

function makeHandler() {
  return createMcpHandler((ctx) => createMcpServer(ctx, services));
}

/** Connect a modern-pinned client to a handler in-process (no socket). */
async function connect(handler: ReturnType<typeof createMcpHandler>) {
  const client = new Client(
    { name: "markethub-transport-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  await client.connect(transport);
  return client;
}

describe("mcp transport (in-process)", () => {
  test("modern-pinned client discovers and calls markethub_health", async () => {
    const handler = makeHandler();
    const client = await connect(handler);
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "markethub_health")).toBe(true);

      const result = await client.callTool({ name: "markethub_health", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(HEALTH);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("invalid Host and Origin are rejected by the SDK helpers", () => {
    resetConfigCache();
    const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: ":memory:", MARKETHUB_LAN: "false" } });
    const allowlists = buildMcpAllowlists(config);

    const badHost = hostHeaderValidationResponse(new Request("http://evil.example/mcp"), allowlists.allowedHostnames);
    expect(badHost?.status).toBe(403);

    const badOrigin = originValidationResponse(
      new Request("http://localhost/mcp", { headers: { Origin: "https://evil.example" } }),
      allowlists.allowedOrigins
    );
    expect(badOrigin?.status).toBe(403);

    // Loopback passes both checks (real HTTP always carries a Host header).
    const loopback = new Request("http://localhost/mcp", { headers: { Host: "localhost" } });
    expect(hostHeaderValidationResponse(loopback, allowlists.allowedHostnames)).toBeUndefined();
    const loopbackOrigin = new Request("http://localhost/mcp", {
      headers: { Host: "localhost", Origin: "http://localhost:5173" }
    });
    expect(originValidationResponse(loopbackOrigin, allowlists.allowedOrigins)).toBeUndefined();
  });

  test("handler.close() makes further requests fail", async () => {
    const handler = makeHandler();
    const client = await connect(handler);
    await client.close();
    await handler.close();
    let threw = false;
    try {
      await handler.fetch(new Request("http://test.local/mcp", { method: "POST" }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
