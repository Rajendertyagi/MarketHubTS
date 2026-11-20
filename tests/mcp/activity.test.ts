import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, CLIENT_INFO_META_KEY, type ServerContext } from "@modelcontextprotocol/server";
import { createMcpServer, withActivity, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

interface ActivityCall { kind: "start" | "complete"; toolName?: string; status?: string; transport?: string }

function makeServices(overrides: Partial<McpServices> = {}) {
  const calls: ActivityCall[] = [];
  const base: McpServices = {
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
    captureSnapshot: async () => ({ ok: true, value: { snapshot: null, error: "no provider available" } }),
    startActivity: async (req) => {
      calls.push({ kind: "start", toolName: req.toolName, transport: req.transport });
      return { ok: true, value: { id: "a1", operationId: req.operationId, startedAt: "2026-01-01T00:00:00.000Z" } };
    },
    completeActivity: async (req) => {
      calls.push({ kind: "complete", status: req.status });
      return { ok: true, value: { id: "a1", status: req.status, finishedAt: "2026-01-01T00:00:00.000Z", durationMs: 0 } };
    },
    ...overrides
  };
  return { services: base, calls };
}

async function connect(services: McpServices) {
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
  const client = new Client({ name: "activity-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  return { client, handler };
}

describe("M6-C activity recording", () => {
  test("factory construction and discovery create no activity rows", async () => {
    const { services, calls } = makeServices();
    const { client, handler } = await connect(services);
    try {
      await client.listTools();
      await client.listResources();
      await client.listPrompts();
      expect(calls).toHaveLength(0);
    } finally { await client.close(); await handler.close(); }
  });

  test("successful tool call records start + succeeded with HTTP transport", async () => {
    const { services, calls } = makeServices();
    const { client, handler } = await connect(services);
    try {
      await client.callTool({ name: "markethub_health", arguments: {} });
      expect(calls).toEqual([
        { kind: "start", toolName: "markethub_health", transport: "HTTP" },
        { kind: "complete", status: "succeeded" }
      ]);
    } finally { await client.close(); await handler.close(); }
  });

  test("isError:true tool result records failed", async () => {
    const { services, calls } = makeServices({
      getProviderStatus: async () => ({ ok: false, error: { category: "unavailable", message: "no registry" } })
    });
    const { client, handler } = await connect(services);
    try {
      const result = await client.callTool({ name: "provider_status", arguments: {} });
      expect(result.isError).toBe(true);
      expect(calls[1]).toEqual({ kind: "complete", status: "failed" });
    } finally { await client.close(); await handler.close(); }
  });

  test("business-level unavailable result returned normally stays succeeded", async () => {
    const { services, calls } = makeServices({
      captureSnapshot: async () => ({ ok: true, value: { snapshot: null, error: "no provider available" } })
    });
    const { client, handler } = await connect(services);
    try {
      const result = await client.callTool({ name: "option_chain_snapshot", arguments: { mode: "capture", underlyingCanonicalId: "A", expiryDate: "2026-03-26" } });
      expect(result.isError).not.toBe(true);
      expect(calls[1]).toEqual({ kind: "complete", status: "succeeded" });
    } finally { await client.close(); await handler.close(); }
  });

  test("thrown callback error records failed and is rethrown", async () => {
    const { services, calls } = makeServices({
      getLiveSnapshot: async () => { throw new Error("boom"); }
    });
    const { client, handler } = await connect(services);
    try {
      // The SDK converts a thrown callback error into an isError tool result.
      const result = await client.callTool({ name: "market_snapshot", arguments: {} });
      expect(result.isError).toBe(true);
      expect(calls[1]).toEqual({ kind: "complete", status: "failed" });
    } finally { await client.close(); await handler.close(); }
  });

  test("activity write failures never change the operation result", async () => {
    const diagnostics: unknown[] = [];
    const { services, calls } = makeServices({
      startActivity: async () => { throw new Error("db down"); },
      completeActivity: async () => { throw new Error("db down"); },
      onActivityError: (e) => diagnostics.push(e)
    });
    const { client, handler } = await connect(services);
    try {
      const result = await client.callTool({ name: "markethub_health", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(calls).toHaveLength(0); // no completion attempted when start failed
      expect(diagnostics.length).toBeGreaterThan(0);
    } finally { await client.close(); await handler.close(); }
  });

  test("SDK validation failures before callback create no activity rows", async () => {
    const { services, calls } = makeServices();
    const { client, handler } = await connect(services);
    try {
      // catalog_search requires a non-empty query; the SDK rejects before the
      // callback (either as a protocol error or an isError tool result).
      try {
        const result = await client.callTool({ name: "catalog_search", arguments: { query: "" } });
        expect(result.isError).toBe(true);
      } catch { /* protocol-level rejection is also valid */ }
      expect(calls).toHaveLength(0);
    } finally { await client.close(); await handler.close(); }
  });

  test("cancellation before completion records interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = { mcpReq: { signal: controller.signal, envelope: undefined } } as unknown as ServerContext;
    const { services, calls } = makeServices();
    await expect(withActivity({
      services, transport: "STDIO", toolName: "x", context: ctx, summary: {},
      operation: async () => { throw new Error("aborted"); }
    })).rejects.toThrow("aborted");
    expect(calls[1]).toEqual({ kind: "complete", status: "interrupted" });
  });

  test("STDIO transport and optional client metadata are handled explicitly", async () => {
    const ctx = {
      mcpReq: {
        signal: new AbortController().signal,
        envelope: { [CLIENT_INFO_META_KEY]: { name: "test-client", version: "1.2.3" } }
      }
    } as unknown as ServerContext;
    let startReq: { transport?: string; clientName?: string; clientVersion?: string } | undefined;
    const { services } = makeServices({
      startActivity: async (req) => {
        startReq = req;
        return { ok: true, value: { id: "a1", operationId: req.operationId, startedAt: "2026-01-01T00:00:00.000Z" } };
      }
    });
    await withActivity({ services, transport: "STDIO", toolName: "x", context: ctx, summary: {}, operation: async () => "ok" });
    expect(startReq?.transport).toBe("STDIO");
    expect(startReq?.clientName).toBe("test-client");
    expect(startReq?.clientVersion).toBe("1.2.3");

    const bareCtx = { mcpReq: { signal: new AbortController().signal } } as unknown as ServerContext;
    await withActivity({ services, transport: "STDIO", toolName: "x", context: bareCtx, summary: {}, operation: async () => "ok" });
    expect(startReq?.clientName).toBeUndefined();
    expect(startReq?.clientVersion).toBeUndefined();
  });

  test("all nine tools, seven resources and three prompts are recorded", async () => {
    const { services, calls } = makeServices();
    const { client, handler } = await connect(services);
    try {
      const tools = await client.listTools();
      for (const t of tools.tools) {
        const args = t.name === "historical_candles" ? { canonicalId: "A", interval: "1D", from: "2026-01-01", to: "2026-01-02", mode: "cached" }
          : t.name === "option_chain_snapshot" ? { mode: "list" }
          : t.name === "on_demand_retrieval" ? { kind: "historical", canonicalId: "A", interval: "1D", from: "2026-01-01", to: "2026-01-02" }
          : t.name === "catalog_search" ? { query: "NIFTY" }
          : t.name === "market_snapshot" ? {}
          : {};
        await client.callTool({ name: t.name, arguments: args });
      }
      const templates = await client.listResourceTemplates();
      for (const t of templates.resourceTemplates) {
        const uri = t.uriTemplate
          .replace("{?query,limit,cursor}", "?query=NIFTY&limit=25&cursor=first")
          .replace("{canonicalId}", "A").replace("{interval}", "1D")
          .replace("{?from,to}", "?from=2026-01-01&to=2026-01-02")
          .replace("{configId}", "cfg").replace("{?cursor}", "?cursor=first")
          .replace("{?after,limit}", "?after=first&limit=25");
        await client.readResource({ uri });
      }
      const staticResources = await client.listResources();
      for (const r of staticResources.resources) {
        try { await client.readResource({ uri: r.uri }); } catch { /* events/alerts is contract-only unavailable */ }
      }
      const prompts = await client.listPrompts();
      for (const p of prompts.prompts) {
        const args = p.name === "interpret_coverage_gaps" ? { canonicalId: "A", interval: "1D", from: "a", to: "b" } : {};
        await client.getPrompt({ name: p.name, arguments: args });
      }
      const starts = calls.filter((c) => c.kind === "start");
      expect(starts).toHaveLength(19);
    } finally { await client.close(); await handler.close(); }
  });
});
