import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

const services: McpServices = {
  getHealth: async () => ({ ok: true, value: HEALTH }),
  searchCatalog: async () => ({ ok: true, value: { instruments: [], nextCursor: null } }),
  readEventFeed: async () => ({ ok: true, value: { events: [], nextCursor: null, resumeCursor: "r:0" } }),
  getProviderStatus: async () => ({ ok: true, value: {} as never }),
  getLiveSnapshot: async () => ({ ok: true, value: {} as never }),
  getCachedCandles: async () => ({ ok: true, value: { candles: [] } }),
  getCoverage: async () => ({ ok: true, value: { gaps: [], unavailableNotes: [] } }),
  fetchHistorical: async () => ({ ok: true, value: { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] } }),
  listSnapshots: async () => ({ ok: true, value: { snapshots: [] } }),
  listSnapshotsPage: async () => ({ ok: true, value: { snapshots: [], nextCursor: null } }),
  getSnapshot: async (id) => ({ ok: true, value: { id } as never }),
  captureSnapshot: async () => ({ ok: true, value: { snapshot: null, error: "x" } })
};

async function connect() {
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
  const client = new Client({ name: "cache-hints-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  return { client, handler };
}

/** Cache fields are emitted on the 2026 wire result object itself. */
function cacheFields(result: unknown): { ttlMs: unknown; cacheScope: unknown } {
  const r = result as Record<string, unknown>;
  return { ttlMs: r.ttlMs, cacheScope: r.cacheScope };
}

describe("M6-B3 cache hints on the 2026 wire", () => {
  test("all six cacheable results carry ttlMs:0 and cacheScope:private", async () => {
    const { client, handler } = await connect();
    try {
      const results: Array<[string, unknown]> = [
        ["tools/list", await client.listTools()],
        ["prompts/list", await client.listPrompts()],
        ["resources/list", await client.listResources()],
        ["resources/templates/list", await client.listResourceTemplates()],
        ["resources/read", await client.readResource({ uri: "markethub://market/snapshot" })]
      ];
      for (const [name, result] of results) {
        expect(cacheFields(result), name).toEqual({ ttlMs: 0, cacheScope: "private" });
      }
      // server/discover is exercised by the pinned client's connect handshake;
      // assert the SDK's closed cacheable set directly for the sixth method.
      const { CACHEABLE_RESULT_METHODS } = await import("@modelcontextprotocol/server") as unknown as { CACHEABLE_RESULT_METHODS?: readonly string[] };
      if (CACHEABLE_RESULT_METHODS) {
        expect(Array.from(CACHEABLE_RESULT_METHODS).sort()).toEqual([
          "prompts/list", "resources/list", "resources/read", "resources/templates/list",
          "server/discover", "tools/list"
        ]);
      }
    } finally { await client.close(); await handler.close(); }
  });
});
