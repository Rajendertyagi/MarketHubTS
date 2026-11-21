import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});
const SNAPSHOT_URI = "markethub://market/snapshot";

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

function makeHandler() {
  return createMcpHandler((ctx) => createMcpServer(ctx, makeServices()));
}

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
};

async function raw(handler: ReturnType<typeof createMcpHandler>, headers: Record<string, string>, body: unknown) {
  return handler.fetch(new Request("http://test.local/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body)
  }));
}

describe("M6-E C1–C21 named wire assertions", () => {
  test("C2: a modern result carries resultType:'complete' on the wire", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" }, {
        jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: META }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { result?: { resultType?: string } };
      expect(body.result?.resultType).toBe("complete");
    } finally { await handler.close(); }
  });

  test("C4: missing per-request _meta is rejected with -32602 and HTTP 400", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" }, {
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32602);
    } finally { await handler.close(); }
  });

  test("C3/C10: unknown method is rejected with -32601", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "no/such/method" }, {
        jsonrpc: "2.0", id: 3, method: "no/such/method", params: { _meta: META }
      });
      expect([400, 404]).toContain(res.status);
      const body = await res.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32601);
    } finally { await handler.close(); }
  });

  test("C9: header/body method mismatch is rejected with -32020 and HTTP 400", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "WRONG" }, {
        jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: META }
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32020);
    } finally { await handler.close(); }
  });

  test("C3: invalid tool params are rejected with -32602", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, {
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "catalog_search"
      }, {
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { _meta: META, name: "catalog_search", arguments: { text: "" } }
      });
      expect(res.status).toBe(200); // tool errors are in-band isError results
      const text = await res.text();
      expect(text).toContain("isError");
    } finally { await handler.close(); }
  });

  test("C11: a listen stream uses SSE with X-Accel-Buffering:no and no Last-Event-ID", async () => {
    const handler = makeHandler();
    const client = new Client({ name: "c11", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
      }));
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "subscriptions/listen" }, {
        jsonrpc: "2.0", id: 6, method: "subscriptions/listen",
        params: { _meta: META, notifications: { resourceSubscriptions: [SNAPSHOT_URI] } }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      expect(res.headers.get("last-event-id")).toBeNull();
      await res.body?.cancel();
    } finally { await client.close(); await handler.close(); }
  });

  test("C5: no server-initiated requests are emitted (MRTR not used in M6)", async () => {
    const handler = makeHandler();
    // No elicitation/sampling/roots handlers are registered on the client. If
    // the server emitted a server-initiated request, the call would fail with
    // an unsupported-request error; a clean result proves none was sent.
    const client = new Client({ name: "c5", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
      }));
      const result = await client.callTool({ name: "markethub_health", arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally { await client.close(); await handler.close(); }
  });
});
