import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, TOOL_DESCRIPTORS, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

const SNAPSHOT = {
  revision: 5, capturedAtMs: 1000,
  items: [
    { canonicalId: "A", observations: {}, selected: { provider: "UPSTOX", value: { ltp: 100 } }, pinned: false, updatedAtMs: 1000 },
    { canonicalId: "B", observations: {}, selected: { provider: "UPSTOX", value: { ltp: 200 } }, pinned: false, updatedAtMs: 1000 }
  ],
  connections: []
};

const PROVIDERS = {
  UPSTOX: { id: "UPSTOX", enabled: true, authState: "AUTHENTICATED", streamingState: "STREAMING", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null },
  FYERS: { id: "FYERS", enabled: true, authState: "NOT_CONFIGURED", streamingState: "NOT_STARTED", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null }
};

const calls: string[] = [];
const services: McpServices = {
  getHealth: async () => ({ ok: true, value: HEALTH }),
  searchCatalog: async (req) => { calls.push(`search:${req.text}:${req.limit}`); return { ok: true, value: { instruments: [], nextCursor: null } }; },
  readEventFeed: async () => ({ ok: true, value: { events: [], nextCursor: null, resumeCursor: "r:0" } }),
  getProviderStatus: async () => ({ ok: true, value: PROVIDERS as never }),
  getLiveSnapshot: async () => ({ ok: true, value: SNAPSHOT as never }),
  getCachedCandles: async (req) => { calls.push(`cached:${req.canonicalId}:${req.fromMs}:${req.toMs}`); return { ok: true, value: { candles: [] } }; },
  getCoverage: async (req) => { calls.push(`coverage:${req.canonicalId}`); return { ok: true, value: { gaps: [], unavailableNotes: [] } }; },
  fetchHistorical: async (req) => { calls.push(`fetch:${req.canonicalId}:${req.fromMs}:${req.toMs}`); return { ok: true, value: { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] } }; },
  listSnapshots: async (filter) => { calls.push(`list:${filter.configId ?? ""}`); return { ok: true, value: { snapshots: [] } }; },
  listSnapshotsPage: async (req) => { calls.push(`page:${req.selector.kind}`); return { ok: true, value: { snapshots: [], nextCursor: null } }; },
  getSnapshot: async (id) => id === "missing" ? { ok: false, error: { category: "unavailable", message: "Snapshot not found" } } : { ok: true, value: { id, configId: null, capturedAt: "2026-01-01T00:00:00.000Z", provider: "UPSTOX", envelope: { strikes: [] }, provenance: {} } as never },
  captureSnapshot: async (req) => { calls.push(`capture:${req.underlyingCanonicalId}:${req.expiryDate}`); return { ok: true, value: { snapshot: null, error: "no provider available" } }; },
  startActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured in test" } }),
  completeActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured in test" } })
};

async function connect() {
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
  const client = new Client({ name: "tools-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  return { client, handler };
}

describe("M6-B2 shared tools", () => {
  test("tool descriptors match the actual MCP tools/list metadata", async () => {
    const { client, handler } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(TOOL_DESCRIPTORS.length);
      for (const descriptor of TOOL_DESCRIPTORS) {
        const listed = tools.find((t) => t.name === descriptor.name);
        expect(listed).toBeDefined();
        expect(listed!.description).toBe(descriptor.description);
        // Tools carry no title today — no MCP-visible metadata was added.
        expect((listed as Record<string, unknown>).title).toBeUndefined();
      }
    } finally { await client.close(); await handler.close(); }
  });

  test("all nine tools are registered with correct annotations", async () => {
    const { client, handler } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "markethub_health", "catalog_search", "provider_status", "market_snapshot",
      "historical_candles", "option_chain_snapshot", "on_demand_retrieval",
      "futures_chain", "market_information"
    ]);
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["markethub_health", "catalog_search", "provider_status", "market_snapshot", "futures_chain", "market_information"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of ["historical_candles", "option_chain_snapshot", "on_demand_retrieval"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(false);
    }
    for (const t of tools) {
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.openWorldHint).toBe(false);
    }
    await client.close(); await handler.close();
  });

  test("health, catalog, provider and snapshot tools return structuredContent", async () => {
    const { client, handler } = await connect();
    const health = await client.callTool({ name: "markethub_health", arguments: {} });
    expect(health.isError).not.toBe(true);
    expect(health.structuredContent).toEqual(HEALTH);

    const catalog = await client.callTool({ name: "catalog_search", arguments: { query: "NIFTY" } });
    expect(catalog.isError).not.toBe(true);
    expect(catalog.structuredContent).toEqual({ instruments: [], nextCursor: null });

    const providers = await client.callTool({ name: "provider_status", arguments: {} });
    expect(providers.isError).not.toBe(true);

    const snapshot = await client.callTool({ name: "market_snapshot", arguments: {} });
    expect(snapshot.isError).not.toBe(true);
    await client.close(); await handler.close();
  });

  test("market_snapshot canonicalId filter preserves other fields", async () => {
    const { client, handler } = await connect();
    const result = await client.callTool({ name: "market_snapshot", arguments: { canonicalId: "A" } });
    expect(result.isError).not.toBe(true);
    const value = result.structuredContent as typeof SNAPSHOT;
    expect(value.items.map((i) => i.canonicalId)).toEqual(["A"]);
    expect(value.revision).toBe(5);
    expect(value.capturedAtMs).toBe(1000);
    expect(value.connections).toEqual([]);
    await client.close(); await handler.close();
  });

  test("historical_candles parses ISO ranges and rejects invalid/reversed ranges", async () => {
    const { client, handler } = await connect();
    const ok = await client.callTool({ name: "historical_candles", arguments: {
      canonicalId: "A", interval: "1D", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", mode: "cached"
    } });
    expect(ok.isError).not.toBe(true);
    expect(calls.some((c) => c.startsWith("cached:A:"))).toBe(true);

    const bad = await client.callTool({ name: "historical_candles", arguments: {
      canonicalId: "A", interval: "1D", from: "not-a-date", to: "2026-01-02T00:00:00Z", mode: "cached"
    } });
    expect(bad.isError).toBe(true);

    const reversed = await client.callTool({ name: "historical_candles", arguments: {
      canonicalId: "A", interval: "1D", from: "2026-01-03T00:00:00Z", to: "2026-01-02T00:00:00Z", mode: "cached"
    } });
    expect(reversed.isError).toBe(true);
    await client.close(); await handler.close();
  });

  test("option_chain_snapshot modes build correct service requests", async () => {
    const { client, handler } = await connect();
    const list = await client.callTool({ name: "option_chain_snapshot", arguments: { mode: "list", configId: "cfg-1" } });
    expect(list.isError).not.toBe(true);
    expect(calls.some((c) => c === "list:cfg-1")).toBe(true);

    const get = await client.callTool({ name: "option_chain_snapshot", arguments: { mode: "get", snapshotId: "snap-1" } });
    expect(get.isError).not.toBe(true);

    const missing = await client.callTool({ name: "option_chain_snapshot", arguments: { mode: "get", snapshotId: "missing" } });
    expect(missing.isError).toBe(true);

    const capture = await client.callTool({ name: "option_chain_snapshot", arguments: {
      mode: "capture", underlyingCanonicalId: "A", expiryDate: "2026-03-26"
    } });
    expect(capture.isError).not.toBe(true);
    expect(calls.some((c) => c === "capture:A:2026-03-26")).toBe(true);

    const badRange = await client.callTool({ name: "option_chain_snapshot", arguments: {
      mode: "list", fromMs: 200, toMs: 100
    } });
    expect(badRange.isError).toBe(true);
    await client.close(); await handler.close();
  });

  test("on_demand_retrieval dispatches both kinds and maps null capture to unavailable", async () => {
    const { client, handler } = await connect();
    const historical = await client.callTool({ name: "on_demand_retrieval", arguments: {
      kind: "historical", canonicalId: "A", interval: "1D", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z"
    } });
    expect(historical.isError).not.toBe(true);
    expect((historical.structuredContent as { status: string }).status).toBe("ok");

    const capture = await client.callTool({ name: "on_demand_retrieval", arguments: {
      kind: "option_chain", canonicalId: "A", expiryDate: "2026-03-26"
    } });
    expect(capture.isError).not.toBe(true);
    const value = capture.structuredContent as { status: string; error?: { message: string } };
    expect(value.status).toBe("unavailable");
    expect(value.error?.message).toBe("no provider available");
    await client.close(); await handler.close();
  });

  test("unavailable tools return explicit isError", async () => {
    const { client, handler } = await connect();
    for (const name of ["futures_chain", "market_information"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("unavailable in M6 — no shared service");
    }
    await client.close(); await handler.close();
  });

  test("invalid inputs return isError", async () => {
    const { client, handler } = await connect();
    const emptyQuery = await client.callTool({ name: "catalog_search", arguments: { query: "" } });
    expect(emptyQuery.isError).toBe(true);
    const badMode = await client.callTool({ name: "option_chain_snapshot", arguments: { mode: "bogus" } });
    expect(badMode.isError).toBe(true);
    await client.close(); await handler.close();
  });
});
