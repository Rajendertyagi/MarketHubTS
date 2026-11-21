import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

function makeServices(): McpServices {
  return {
    getHealth: async () => ({ ok: true, value: HEALTH }),
    searchCatalog: async () => ({ ok: true, value: { instruments: [], nextCursor: null } }),
    readEventFeed: async () => ({ ok: true, value: { events: [], nextCursor: null, resumeCursor: "r:0" } }),
    getProviderStatus: async () => ({ ok: true, value: {} as never }),
    getLiveSnapshot: async () => ({ ok: true, value: { revision: 0, capturedAtMs: 0, items: [], connections: [] } as never }),
    getCachedCandles: async () => ({ ok: true, value: { candles: [] } }),
    getCoverage: async () => ({ ok: true, value: { gaps: [], unavailableNotes: [] } }),
    fetchHistorical: async () => ({ ok: true, value: { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] } }),
    listSnapshots: async () => ({ ok: true, value: { snapshots: [] } }),
    listSnapshotsPage: async () => ({ ok: true, value: { snapshots: [], nextCursor: null } }),
    getSnapshot: async (id) => ({ ok: true, value: { id } as never }),
    captureSnapshot: async () => ({ ok: true, value: { snapshot: null, error: "no provider available" } }),
    startActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured" } }),
    completeActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured" } })
  };
}

describe("M6-E legacy compatibility (dual-era posture)", () => {
  test("2025-era HTTP client uses the stateless initialize path", async () => {
    const handler = createMcpHandler((ctx) => createMcpServer(ctx, makeServices()));
    const client = new Client({ name: "legacy-http", version: "1.0.0" }); // no pin -> legacy initialize
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
      }));
      expect(client.getProtocolEra()).toBe("legacy");
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "markethub_health")).toBe(true);
      const result = await client.callTool({ name: "markethub_health", arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await handler.close();
    }
  });

  test("2025-era STDIO client uses the legacy opening path", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req) => new URL(req.url).pathname === "/health" ? Response.json(HEALTH) : Response.json({ error: "not_found" }, { status: 404 })
    });
    let client: Client | null = null;
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["apps/mcp-server/src/index.ts"],
        cwd: process.cwd(),
        env: { ...process.env, MARKETHUB_API_URL: `http://127.0.0.1:${api.port}` } as Record<string, string>
      });
      client = new Client({ name: "legacy-stdio", version: "1.0.0" }); // no pin -> legacy initialize
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("legacy");
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "markethub_health")).toBe(true);
      await client.close();
      client = null;
    } finally {
      if (client) await client.close();
      await api.stop(true);
    }
  });

  test("modern pinned client on the same handler uses discover, not initialize", async () => {
    const handler = createMcpHandler((ctx) => createMcpServer(ctx, makeServices()));
    const client = new Client({ name: "modern-on-dual", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
      }));
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const discover = await client.getDiscoverResult();
      expect(discover.supportedVersions).toContain("2026-07-28");
    } finally {
      await client.close();
      await handler.close();
    }
  });
});
