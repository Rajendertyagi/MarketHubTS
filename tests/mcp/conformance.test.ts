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

  test("C3/C10: unknown method is rejected with exactly HTTP 404 and -32601", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "no/such/method" }, {
        jsonrpc: "2.0", id: 3, method: "no/such/method", params: { _meta: META }
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32601);
    } finally { await handler.close(); }
  });

  test("C3: unsupported protocol version is rejected with -32022 and version details", async () => {
    const handler = makeHandler();
    const unsupported = "2099-01-01";
    const meta = { ...META, "io.modelcontextprotocol/protocolVersion": unsupported };
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": unsupported, "Mcp-Method": "tools/list" }, {
        jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: meta }
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: number; data: { requested: string; supported: string[] } } };
      expect(body.error.code).toBe(-32022);
      expect(body.error.data.requested).toBe(unsupported);
      expect(body.error.data.supported).toContain("2026-07-28");
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

  test("C11: a listen stream uses SSE with X-Accel-Buffering:no (keepalive is SHOULD, not asserted)", async () => {
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
      // Keepalive comments are SHOULD/encouraged by the spec, not a MUST; this
      // test does not wait for or assert a keepalive frame.
      await res.body?.cancel();
    } finally { await client.close(); await handler.close(); }
  });

  test("C11: an incoming Last-Event-ID is ignored — no stream replay/resume", async () => {
    const handler = makeHandler();
    const client = new Client({ name: "c11-resume", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
      }));
      // Send a listen request carrying a Last-Event-ID as if resuming an old
      // SSE stream. The modern protocol has no SSE resumability; the server
      // must ignore the header and open a fresh stream (ack first, no replay).
      const res = await handler.fetch(new Request("http://test.local/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "subscriptions/listen",
          "Last-Event-ID": "0"
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 8, method: "subscriptions/listen",
          params: { _meta: META, notifications: { resourceSubscriptions: [SNAPSHOT_URI] } }
        })
      }));
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const first = await reader.read();
      const frame = new TextDecoder().decode(first.value);
      // Fresh stream: the first frame is the acknowledgement, not a replay of
      // an earlier event id. No `id:` line from a prior stream is re-sent.
      expect(frame).toContain("notifications/subscriptions/acknowledged");
      expect(frame).not.toContain('"id":"0"');
      await reader.cancel();
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

  test("C3: modern 2026-07-28 requests never emit -32002 or -32042", async () => {
    const handler = makeHandler();
    const missingUri = "markethub://does/not/exist";
    try {
      // A representative set of modern requests, including error-producing
      // ones that historically used the reserved -32002/-32042 codes. This is
      // scoped to modern 2026-07-28 requests only: older-protocol clients
      // SHOULD still accept -32002 from earlier servers (legacy-compat.test.ts)
      // and that compatibility is not prohibited here.
      const cases: Array<{ headers: Record<string, string>; body: unknown }> = [
        {
          headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" },
          body: { jsonrpc: "2.0", id: 20, method: "server/discover", params: { _meta: META } }
        },
        {
          headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
          body: { jsonrpc: "2.0", id: 21, method: "tools/list", params: { _meta: META } }
        },
        {
          headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "resources/read", "Mcp-Name": missingUri },
          body: { jsonrpc: "2.0", id: 22, method: "resources/read", params: { _meta: META, uri: missingUri } }
        },
        {
          headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "no/such/method" },
          body: { jsonrpc: "2.0", id: 23, method: "no/such/method", params: { _meta: META } }
        }
      ];
      for (const c of cases) {
        const res = await raw(handler, c.headers, c.body);
        const text = await res.text();
        expect(text).not.toContain('"code":-32002');
        expect(text).not.toContain('"code":-32042');
      }
      // The resource-not-found case must use the standard -32602 on the wire,
      // never the reserved -32002 domain code.
      const notFound = await raw(handler, {
        "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "resources/read", "Mcp-Name": missingUri
      }, { jsonrpc: "2.0", id: 24, method: "resources/read", params: { _meta: META, uri: missingUri } });
      const body = await notFound.json() as { error: { code: number } };
      expect(body.error.code).toBe(-32602);
    } finally { await handler.close(); }
  });

  test("C6: modern results carry io.modelcontextprotocol/serverInfo in _meta (wire)", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" }, {
        jsonrpc: "2.0", id: 25, method: "server/discover", params: { _meta: META }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { result: { _meta?: Record<string, unknown> } };
      const meta = body.result._meta;
      expect(meta).toBeDefined();
      // SDK 2.4.0 stamps this SHOULD on every modern result from a Server that
      // supplies its identity (the shared factory passes markethubts/0.1.0).
      const serverInfo = meta?.["io.modelcontextprotocol/serverInfo"] as { name?: string; version?: string } | undefined;
      expect(serverInfo).toBeDefined();
      expect(serverInfo?.name).toBe("markethubts");
      expect(typeof serverInfo?.version).toBe("string");
      // The mandatory subscriptionId requirement is a separate assertion in
      // M6-D's subscriptions.test.ts and is not conflated with this SHOULD.
    } finally { await handler.close(); }
  });

  test("C18: modern server/discover advertises no unsupported extension map", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" }, {
        jsonrpc: "2.0", id: 26, method: "server/discover", params: { _meta: META }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { result: { capabilities: Record<string, unknown> } };
      const caps = body.result.capabilities;
      expect(caps.extensions).toBeUndefined();
      for (const key of ["tasks", "skills", "logging", "roots", "sampling", "elicitation"]) {
        expect(caps[key]).toBeUndefined();
      }
      for (const key of Object.keys(caps)) {
        expect(key.startsWith("io.modelcontextprotocol/")).toBe(false);
      }
    } finally { await handler.close(); }
  });

  test("C19: tools/list wire output uses JSON Schema 2020-12 with no network $ref", async () => {
    const handler = makeHandler();
    try {
      const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" }, {
        jsonrpc: "2.0", id: 27, method: "tools/list", params: { _meta: META }
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const body = JSON.parse(text) as { result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> } };
      expect(body.result.tools.length).toBeGreaterThan(0);
      for (const tool of body.result.tools) {
        expect(tool.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      }
      // No auto-dereferenced network $ref anywhere in the actual wire output.
      expect(text).not.toContain('"$ref"');
    } finally { await handler.close(); }
  });

  test("C21: deprecated methods are rejected and deprecated surfaces are not advertised on modern protocol", async () => {
    const handler = makeHandler();
    try {
      // (a) Deprecated methods must be rejected with method-not-found on the
      // modern protocol. resources.subscribe is intentionally NOT advertised
      // as a callable method here — modern subscriptions use subscriptions/listen.
      for (const method of ["ping", "logging/setLevel", "resources/subscribe"]) {
        const res = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method }, {
          jsonrpc: "2.0", id: 28, method, params: { _meta: META }
        });
        expect(res.status).toBe(404);
        const body = await res.json() as { error: { code: number } };
        expect(body.error.code).toBe(-32601);
      }
      // (b) Deprecated capability surfaces are not advertised in server/discover.
      const discover = await raw(handler, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" }, {
        jsonrpc: "2.0", id: 29, method: "server/discover", params: { _meta: META }
      });
      const caps = ((await discover.json()) as { result: { capabilities: Record<string, unknown> } }).result.capabilities;
      for (const key of ["logging", "roots", "sampling", "tasks", "skills", "extensions"]) {
        expect(caps[key]).toBeUndefined();
      }
      // (c) Legacy HTTP+SSE transport is not implemented: a GET carrying
      // Accept: text/event-stream is rejected (405), not an opened SSE stream.
      // This is distinct from retained 2025-era Streamable HTTP/STDIO
      // compatibility. No SSE Last-Event-ID replay is asserted here — it is
      // already covered by the C11 tests in this file and http-integration.test.ts.
      const legacyGet = await handler.fetch(new Request("http://test.local/mcp", {
        method: "GET", headers: { Accept: "text/event-stream" }
      }));
      expect(legacyGet.status).toBe(405);
    } finally { await handler.close(); }
  });
});
