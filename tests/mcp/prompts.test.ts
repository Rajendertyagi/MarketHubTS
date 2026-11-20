import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

let serviceCalls = 0;
const services: McpServices = {
  getHealth: async () => { serviceCalls++; return { ok: true, value: HEALTH }; },
  searchCatalog: async () => { serviceCalls++; return { ok: true, value: { instruments: [], nextCursor: null } }; },
  readEventFeed: async () => { serviceCalls++; return { ok: true, value: { events: [], nextCursor: null, resumeCursor: "r:0" } }; },
  getProviderStatus: async () => { serviceCalls++; return { ok: true, value: {} as never }; },
  getLiveSnapshot: async () => { serviceCalls++; return { ok: true, value: {} as never }; },
  getCachedCandles: async () => { serviceCalls++; return { ok: true, value: { candles: [] } }; },
  getCoverage: async () => { serviceCalls++; return { ok: true, value: { gaps: [], unavailableNotes: [] } }; },
  fetchHistorical: async () => { serviceCalls++; return { ok: true, value: { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] } }; },
  listSnapshots: async () => { serviceCalls++; return { ok: true, value: { snapshots: [] } }; },
  listSnapshotsPage: async () => { serviceCalls++; return { ok: true, value: { snapshots: [], nextCursor: null } }; },
  getSnapshot: async (id) => { serviceCalls++; return { ok: true, value: { id } as never }; },
  captureSnapshot: async () => { serviceCalls++; return { ok: true, value: { snapshot: null, error: "x" } }; }
};

async function connect() {
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
  const client = new Client({ name: "prompts-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  return { client, handler };
}

describe("M6-B3 static prompts", () => {
  test("prompts are discovered in deterministic order", async () => {
    const { client, handler } = await connect();
    try {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual([
        "explain_market_snapshot", "interpret_coverage_gaps", "how_to_capture_snapshot"
      ]);
    } finally { await client.close(); await handler.close(); }
  });

  test("prompts/get returns text guidance and makes no service calls", async () => {
    const { client, handler } = await connect();
    try {
      serviceCalls = 0;
      const one = await client.getPrompt({ name: "explain_market_snapshot", arguments: { canonicalId: "NIFTY" } });
      expect(one.messages[0]!.content.type).toBe("text");
      expect((one.messages[0]!.content as { text: string }).text).toContain("NIFTY");

      const two = await client.getPrompt({
        name: "interpret_coverage_gaps",
        arguments: { canonicalId: "NIFTY", interval: "1D", from: "2026-01-01", to: "2026-02-01" }
      });
      expect((two.messages[0]!.content as { text: string }).text).toContain("coverage");

      const three = await client.getPrompt({ name: "how_to_capture_snapshot", arguments: {} });
      expect((three.messages[0]!.content as { text: string }).text).toContain("configId = null");

      expect(serviceCalls).toBe(0);
    } finally { await client.close(); await handler.close(); }
  });

  test("invalid prompt arguments are rejected", async () => {
    const { client, handler } = await connect();
    try {
      await expect(client.getPrompt({ name: "interpret_coverage_gaps", arguments: {} })).rejects.toThrow();
    } finally { await client.close(); await handler.close(); }
  });
});
