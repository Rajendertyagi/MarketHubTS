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

/** Extract the JSON-RPC result from a JSON or SSE response. */
async function extractResult(res: Response): Promise<unknown> {
  const text = await res.clone().text();
  try {
    const json = JSON.parse(text);
    return json?.result ?? null;
  } catch {
    const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const json = JSON.parse(dataLines[i]!.slice(5).trim());
        if (json?.result) return json.result;
      } catch { /* keep scanning */ }
    }
    return null;
  }
}

/** Connect and capture the raw server/discover result from the handshake. */
async function connect() {
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
  let discoverResult: unknown = null;
  const client = new Client({ name: "cache-hints-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: async (url, init) => {
      const res = await handler.fetch(new Request(url, init));
      let isDiscover = false;
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        isDiscover = body?.method === "server/discover";
      } catch { /* ignore */ }
      if (!isDiscover) {
        const headers = new Headers(init?.headers);
        isDiscover = (headers.get("mcp-method") ?? "").toLowerCase() === "server/discover";
      }
      if (isDiscover) discoverResult = await extractResult(res);
      return res;
    }
  }));
  return { client, handler, getDiscoverResult: () => discoverResult };
}

/** Cache fields are emitted on the 2026 wire result object itself. */
function cacheFields(result: unknown): { ttlMs: unknown; cacheScope: unknown } {
  const r = result as Record<string, unknown>;
  return { ttlMs: r.ttlMs, cacheScope: r.cacheScope };
}

describe("M6-B3 cache hints on the 2026 wire", () => {
  test("all six cacheable results carry ttlMs:0 and cacheScope:private", async () => {
    const { client, handler, getDiscoverResult } = await connect();
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
      // Sixth method: assert the actual server/discover response captured during
      // the pinned client's connect handshake, not just the SDK constant set.
      const discover = getDiscoverResult();
      expect(discover, "server/discover result was not captured").not.toBeNull();
      expect(cacheFields(discover), "server/discover").toEqual({ ttlMs: 0, cacheScope: "private" });
    } finally { await client.close(); await handler.close(); }
  });
});
