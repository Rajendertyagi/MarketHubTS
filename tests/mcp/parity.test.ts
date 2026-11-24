import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, TOOL_DESCRIPTORS, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

/**
 * M6-B4 parity closeout (M6_B_PLAN.md §7 / completion plan §4.4).
 *
 * This exercises the two real adapters — a real `createMcpHandler` HTTP path
 * behind a Bun listener, and the spawned STDIO process talking to a stub local
 * API — with the same pinned 2026-07-28 client. It asserts that the capability
 * inventory is identical (no capability silently dropped) and that the
 * discoverable-but-unavailable capabilities return an explicit `unavailable`
 * result on BOTH transports rather than being treated as parity by omission.
 */

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

const EXPECTED_TOOLS = TOOL_DESCRIPTORS.map((d) => d.name).sort();
const EXPECTED_STATIC_RESOURCES = ["markethub://market/snapshot", "markethub://events/alerts"].sort();
const EXPECTED_RESOURCE_TEMPLATES = [
  "markethub://catalog/instruments{?query,limit,cursor}",
  "markethub://historical/{canonicalId}/{interval}{?from,to}",
  "markethub://snapshots/config/{configId}{?cursor}",
  "markethub://snapshots/null-config{?cursor}",
  "markethub://events/live{?after,limit}"
].sort();
const EXPECTED_PROMPTS = ["explain_market_snapshot", "interpret_coverage_gaps", "how_to_capture_snapshot"].sort();

const UNAVAILABLE_TOOL_TEXT = "unavailable in M6 — no shared service";
const UNAVAILABLE_ALERTS_TEXT = "unavailable in M6 — alert events are an M7 dependency";

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

interface Transport {
  client: Client;
  close(): Promise<void>;
}

/** Real HTTP adapter: a Bun listener in front of the real createMcpHandler. */
async function startHttp(): Promise<Transport> {
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, makeServices()));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handler.fetch(req) });
  const client = new Client({ name: "b4-parity-http", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  } catch (error) {
    await server.stop(true);
    await handler.close();
    throw error;
  }
  return {
    client,
    async close() {
      await client.close();
      await handler.close();
      await server.stop(true);
    }
  };
}

/** Real STDIO adapter: the spawned mcp-server process + a stub local API. */
async function startStdio(): Promise<Transport> {
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json(HEALTH);
      if (path === "/api/catalog/search") return Response.json({ instruments: [], nextCursor: null });
      if (path === "/api/market/events") return Response.json({ events: [], nextCursor: null, resumeCursor: "r:0" });
      return Response.json({ error: "not_found", message: "not found" }, { status: 404 });
    }
  });
  let client: Client | null = null;
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["apps/mcp-server/src/index.ts"],
      cwd: process.cwd(),
      env: { ...process.env, MARKETHUB_API_URL: `http://127.0.0.1:${api.port}` } as Record<string, string>
    });
    client = new Client({ name: "b4-parity-stdio", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(transport);
    const connected = client;
    return {
      client: connected,
      async close() {
        await connected.close();
        await api.stop(true);
      }
    };
  } catch (error) {
    if (client) await client.close().catch(() => {});
    await api.stop(true);
    throw error;
  }
}

interface Inventory {
  tools: string[];
  resources: string[];
  templates: string[];
  prompts: string[];
}

async function inventory(client: Client): Promise<Inventory> {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
  const templates = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate).sort();
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  return { tools, resources, templates, prompts };
}

describe("M6-B4 HTTP/STDIO parity (real adapters, pinned 2026-07-28)", () => {
  let http: Transport;
  let stdio: Transport;

  beforeAll(async () => {
    http = await startHttp();
    stdio = await startStdio();
  });

  afterAll(async () => {
    if (stdio) await stdio.close();
    if (http) await http.close();
  });

  test("both transports negotiate 2026-07-28 and expose the identical capability inventory", async () => {
    expect(http.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(stdio.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

    const h = await inventory(http.client);
    const s = await inventory(stdio.client);

    // Each transport matches the shared registration source exactly.
    expect(h.tools).toEqual(EXPECTED_TOOLS);
    expect(s.tools).toEqual(EXPECTED_TOOLS);
    expect(h.resources).toEqual(EXPECTED_STATIC_RESOURCES);
    expect(s.resources).toEqual(EXPECTED_STATIC_RESOURCES);
    expect(h.templates).toEqual(EXPECTED_RESOURCE_TEMPLATES);
    expect(s.templates).toEqual(EXPECTED_RESOURCE_TEMPLATES);
    expect(h.prompts).toEqual(EXPECTED_PROMPTS);
    expect(s.prompts).toEqual(EXPECTED_PROMPTS);

    // No capability is silently dropped on either transport: the inventories
    // are equal, not merely a subset on STDIO.
    expect(s).toEqual(h);

    // The honest-unavailable capabilities are discoverable on BOTH transports.
    for (const inv of [h, s]) {
      expect(inv.tools).toContain("futures_chain");
      expect(inv.tools).toContain("market_information");
      expect(inv.resources).toContain("markethub://events/alerts");
      expect(inv.templates).toContain("markethub://events/live{?after,limit}");
    }
  });

  test("catalog_search and events/live are available over both transports with equivalent results", async () => {
    const catalogHttp = await http.client.callTool({ name: "catalog_search", arguments: { query: "NIFTY" } });
    const catalogStdio = await stdio.client.callTool({ name: "catalog_search", arguments: { query: "NIFTY" } });
    expect(catalogHttp.isError).not.toBe(true);
    expect(catalogStdio.isError).not.toBe(true);
    expect(catalogStdio.structuredContent).toEqual(catalogHttp.structuredContent);
    expect(catalogHttp.structuredContent).toEqual({ instruments: [], nextCursor: null });

    const feedHttp = await http.client.readResource({ uri: "markethub://events/live?after=first&limit=100" });
    const feedStdio = await stdio.client.readResource({ uri: "markethub://events/live?after=first&limit=100" });
    expect(feedHttp.contents[0]!.mimeType).toBe("application/json");
    expect(feedStdio.contents[0]!.mimeType).toBe("application/json");
    const bodyHttp = JSON.parse(feedHttp.contents[0]!.text) as { events: unknown[]; nextCursor: string | null; resumeCursor: string };
    const bodyStdio = JSON.parse(feedStdio.contents[0]!.text) as { events: unknown[]; nextCursor: string | null; resumeCursor: string };
    expect(bodyHttp.events).toEqual([]);
    expect(bodyHttp.nextCursor).toBeNull();
    expect(typeof bodyHttp.resumeCursor).toBe("string");
    expect(bodyStdio).toEqual(bodyHttp);
  });

  test("discoverable-but-unavailable capabilities return explicit unavailable on both transports", async () => {
    for (const t of [http, stdio]) {
      for (const name of ["futures_chain", "market_information"]) {
        const result = await t.client.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(UNAVAILABLE_TOOL_TEXT);
      }
      let alertsError: Error | null = null;
      try {
        await t.client.readResource({ uri: "markethub://events/alerts" });
      } catch (error) {
        alertsError = error as Error;
      }
      expect(alertsError).not.toBeNull();
      expect(alertsError!.message).toContain(UNAVAILABLE_ALERTS_TEXT);
    }
  });
});
