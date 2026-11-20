import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, UriTemplate } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});
const SNAPSHOT = {
  revision: 5, capturedAtMs: 1000,
  items: [{ canonicalId: "A", observations: {}, selected: { provider: "UPSTOX", value: { ltp: 100 } }, pinned: false, updatedAtMs: 1000 }],
  connections: []
};
const PROVIDERS = {
  UPSTOX: { id: "UPSTOX", enabled: true, authState: "AUTHENTICATED", streamingState: "STREAMING", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null },
  FYERS: { id: "FYERS", enabled: true, authState: "NOT_CONFIGURED", streamingState: "NOT_STARTED", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null }
};

const calls: string[] = [];
const services: McpServices = {
  getHealth: async () => ({ ok: true, value: HEALTH }),
  searchCatalog: async (req) => {
    calls.push(`catalog:${req.text}:${req.limit}:${req.afterCanonicalId ?? "first"}`);
    return { ok: true, value: { instruments: [], nextCursor: null } };
  },
  readEventFeed: async (req) => {
    calls.push(`feed:${req.after ?? "first"}:${req.limit}`);
    return { ok: true, value: { events: [], nextCursor: null, resumeCursor: "r:0" } };
  },
  getProviderStatus: async () => ({ ok: true, value: PROVIDERS as never }),
  getLiveSnapshot: async () => ({ ok: true, value: SNAPSHOT as never }),
  getCachedCandles: async (req) => { calls.push(`candles:${req.canonicalId}:${req.interval}`); return { ok: true, value: { candles: [] } }; },
  getCoverage: async () => ({ ok: true, value: { gaps: [], unavailableNotes: [] } }),
  fetchHistorical: async () => ({ ok: true, value: { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] } }),
  listSnapshots: async () => ({ ok: true, value: { snapshots: [] } }),
  listSnapshotsPage: async (req) => {
    const id = req.selector.kind === "config" ? req.selector.configId : "-";
    calls.push(`page:${req.selector.kind}:${id}:${req.cursor ?? "first"}`);
    if (req.selector.kind === "config" && req.selector.configId === "missing") {
      return { ok: false, error: { category: "unavailable", message: "Unknown capture configuration", reason: "unknown_config" } };
    }
    return { ok: true, value: { snapshots: [], nextCursor: null } };
  },
  getSnapshot: async (id) => ({ ok: true, value: { id, configId: null, capturedAt: "2026-01-01T00:00:00.000Z", provider: "UPSTOX", envelope: { strikes: [] }, provenance: {} } as never }),
  captureSnapshot: async () => ({ ok: true, value: { snapshot: null, error: "no provider available" } })
};

async function connect() {
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
  const client = new Client({ name: "resources-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  return { client, handler };
}

describe("M6-B3 URI templates (installed SDK matcher)", () => {
  test("catalog template requires all query variables in order and returns raw values", () => {
    const t = new UriTemplate("markethub://catalog/instruments{?query,limit,cursor}");
    expect(t.match("markethub://catalog/instruments?query=NIFTY&limit=25&cursor=first"))
      .toEqual({ query: "NIFTY", limit: "25", cursor: "first" });
    expect(t.match("markethub://catalog/instruments?query=NIFTY&limit=25")).toBeNull();
    expect(t.match("markethub://catalog/instruments?limit=25&query=NIFTY&cursor=first")).toBeNull();
    expect(t.match("markethub://catalog/instruments?query=&limit=25&cursor=first")).toBeNull();
    expect(t.match("markethub://catalog/instruments?query=NIFTY%20INDEX&limit=25&cursor=first"))
      .toEqual({ query: "NIFTY%20INDEX", limit: "25", cursor: "first" });
  });

  test("snapshot templates distinguish a real 'none' config from the null-config partition", () => {
    const byConfig = new UriTemplate("markethub://snapshots/config/{configId}{?cursor}");
    const byNull = new UriTemplate("markethub://snapshots/null-config{?cursor}");
    expect(byConfig.match("markethub://snapshots/config/none?cursor=first"))
      .toEqual({ configId: "none", cursor: "first" });
    expect(byNull.match("markethub://snapshots/null-config?cursor=first"))
      .toEqual({ cursor: "first" });
    expect(byNull.match("markethub://snapshots/null-config")).toBeNull();
    // The old invalid optional-variable form is not used.
    expect(new UriTemplate("markethub://snapshots/{configId?}").variableNames).toEqual(["configId?"]);
  });

  test("historical and events templates handle encoded paths and first sentinel", () => {
    const historical = new UriTemplate("markethub://historical/{canonicalId}/{interval}{?from,to}");
    expect(historical.match("markethub://historical/NIFTY%20INDEX/1D?from=2026-01-01&to=2026-02-01"))
      .toEqual({ canonicalId: "NIFTY%20INDEX", interval: "1D", from: "2026-01-01", to: "2026-02-01" });
    expect(historical.match("markethub://historical/NIFTY/INDEX/1D?from=a&to=b")).toBeNull();
    const live = new UriTemplate("markethub://events/live{?after,limit}");
    expect(live.match("markethub://events/live?after=first&limit=25"))
      .toEqual({ after: "first", limit: "25" });
    expect(live.match("markethub://events/live?limit=25")).toBeNull();
  });
});

describe("M6-B3 resources over MCP", () => {
  test("static resources and templates are discovered in deterministic order", async () => {
    const { client, handler } = await connect();
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toEqual([
        "markethub://market/snapshot", "markethub://events/alerts"
      ]);
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
        "markethub://catalog/instruments{?query,limit,cursor}",
        "markethub://historical/{canonicalId}/{interval}{?from,to}",
        "markethub://snapshots/config/{configId}{?cursor}",
        "markethub://snapshots/null-config{?cursor}",
        "markethub://events/live{?after,limit}"
      ]);
    } finally { await client.close(); await handler.close(); }
  });

  test("resource reads decode variables and forward the correct selector", async () => {
    const { client, handler } = await connect();
    try {
      const snapshot = await client.readResource({ uri: "markethub://market/snapshot" });
      expect(snapshot.contents[0]!.text).toContain("revision");

      await client.readResource({ uri: "markethub://catalog/instruments?query=NIFTY%20INDEX&limit=25&cursor=first" });
      expect(calls).toContain("catalog:NIFTY INDEX:25:first");

      await client.readResource({ uri: "markethub://historical/NIFTY%20INDEX/1D?from=2026-01-01&to=2026-02-01" });
      expect(calls).toContain("candles:NIFTY INDEX:1D");

      await client.readResource({ uri: "markethub://snapshots/config/none?cursor=first" });
      expect(calls).toContain("page:config:none:first");

      await client.readResource({ uri: "markethub://snapshots/null-config?cursor=first" });
      expect(calls).toContain("page:null-config:-:first");

      await client.readResource({ uri: "markethub://events/live?after=first&limit=25" });
      expect(calls).toContain("feed:first:25");
    } finally { await client.close(); await handler.close(); }
  });

  test("invalid input and contract-only resource return explicit errors, never empty success", async () => {
    const { client, handler } = await connect();
    try {
      await expect(client.readResource({ uri: "markethub://catalog/instruments?query=%20&limit=25&cursor=first" })).rejects.toThrow();
      await expect(client.readResource({ uri: "markethub://events/alerts" })).rejects.toThrow(/unavailable in M6/);
      await expect(client.readResource({ uri: "markethub://snapshots/config/missing?cursor=first" })).rejects.toThrow();
    } finally { await client.close(); await handler.close(); }
  });
});
