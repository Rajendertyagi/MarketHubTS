import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok",
  service: "markethub-api",
  timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0",
  checks: { api: "ok", database: "ok" }
});

/**
 * Spawn the real STDIO process and connect a modern-pinned client. A tiny local
 * HTTP server stands in for the API health endpoint the STDIO tool calls — no
 * live providers, no external network.
 */
describe("mcp stdio modern (M6-A)", () => {
  test("modern-pinned client discovers and calls markethub_health over stdio", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/health"
          ? Response.json(HEALTH)
          : new Response("not found", { status: 404 })
    });

    let client: Client | null = null;
    try {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["apps/mcp-server/src/index.ts"],
        cwd: process.cwd(),
        env: { ...process.env, MARKETHUB_API_URL: `http://127.0.0.1:${api.port}` } as Record<string, string>
      });
      client = new Client(
        { name: "markethub-stdio-test", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      );
      await client.connect(transport);

      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "markethub_health")).toBe(true);

      const result = await client.callTool({ name: "markethub_health", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(HEALTH);

      // Clean client + transport closure.
      await client.close();
      client = null;
    } finally {
      if (client) await client.close();
      await api.stop(true);
    }
  });

  test("modern STDIO: discover body, resources/prompts, listen control-plane, clean shutdown", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/health") return Response.json(HEALTH);
        if (path === "/api/market/snapshot") {
          return Response.json({ revision: 0, capturedAtMs: 0, items: [], connections: [] });
        }
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
      client = new Client({ name: "m6e-stdio", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(transport);

      // server/discover response body (modern mechanism on STDIO).
      const discover = await client.getDiscoverResult();
      expect(discover.supportedVersions).toContain("2026-07-28");
      const caps = discover.capabilities as Record<string, Record<string, unknown>>;
      // §5.3: STDIO is control-plane only — no live relay, so resources.subscribe
      // must be absent/false and ALL three listChanged bits must be false.
      expect(caps.resources?.subscribe).not.toBe(true); // no live relay on STDIO
      expect(caps.tools?.listChanged).toBe(false);
      expect(caps.prompts?.listChanged).toBe(false);
      expect(caps.resources?.listChanged).toBe(false);

      // Resource + prompt access over the spawned process.
      const snap = await client.readResource({ uri: "markethub://market/snapshot" });
      expect(snap.contents[0]!.mimeType).toBe("application/json");
      const prompt = await client.getPrompt({ name: "explain_market_snapshot", arguments: {} });
      expect(prompt.messages.length).toBeGreaterThan(0);

      // subscriptions/listen control-plane: SDK handles it, but the honored
      // filter must NOT claim resourceSubscriptions (no event relay on STDIO).
      const sub = await client.listen({ resourceSubscriptions: ["markethub://market/snapshot"] });
      // §5.3: the honored filter must omit resourceSubscriptions (no relay) and
      // ALL three listChanged bits (static inventories) on STDIO too.
      expect(sub.honoredFilter.resourceSubscriptions).toBeUndefined();
      expect(sub.honoredFilter.toolsListChanged).toBeUndefined();
      expect(sub.honoredFilter.promptsListChanged).toBeUndefined();
      expect(sub.honoredFilter.resourcesListChanged).toBeUndefined();
      // C12: client cancellation on STDIO resolves the subscription as 'local'.
      const closed = sub.closed;
      await sub.close();
      expect(await closed).toBe("local");

      await client.close();
      client = null;
    } finally {
      if (client) await client.close();
      await api.stop(true);
    }
  });

  /**
   * M6-E combined-gap 1: STDIO reconnect control plane. The official SDK does
   * NOT automatically reopen `subscriptions/listen` after a reconnect — the
   * client must explicitly call `listen()` again on the new connection. This
   * test proves that sequence against two freshly spawned STDIO processes with
   * a pinned modern client, and confirms STDIO never advertises
   * `resources.subscribe` (no live relay) on either connection.
   */
  test("modern STDIO reconnect: no auto-reopen; explicit re-listen yields a fresh honest ack", async () => {
    const api = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/health") return Response.json(HEALTH);
        if (path === "/api/market/snapshot") {
          return Response.json({ revision: 0, capturedAtMs: 0, items: [], connections: [] });
        }
        return Response.json({ error: "not_found", message: "not found" }, { status: 404 });
      }
    });

    /** Spawn a fresh STDIO server process and connect a pinned modern client. */
    const connectStdio = async (name: string): Promise<Client> => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["apps/mcp-server/src/index.ts"],
        cwd: process.cwd(),
        env: { ...process.env, MARKETHUB_API_URL: `http://127.0.0.1:${api.port}` } as Record<string, string>
      });
      const client = new Client({ name, version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
      await client.connect(transport);
      return client;
    };

    let client1: Client | null = null;
    let client2: Client | null = null;
    try {
      // 1) First modern STDIO connection (real spawned process).
      client1 = await connectStdio("m6e-stdio-reconnect-1");
      expect(client1.getNegotiatedProtocolVersion()).toBe("2026-07-28");

      // 2) Open subscriptions/listen on the first connection. The honored
      // filter is honestly empty: no live relay and static inventories on STDIO.
      const sub1 = await client1.listen({ resourceSubscriptions: ["markethub://market/snapshot"] });
      expect(sub1.honoredFilter.resourceSubscriptions).toBeUndefined();
      expect(sub1.honoredFilter.toolsListChanged).toBeUndefined();
      expect(sub1.honoredFilter.promptsListChanged).toBeUndefined();
      expect(sub1.honoredFilter.resourcesListChanged).toBeUndefined();
      const sub1Closed = sub1.closed;

      // 3) Close the first connection (subscription, then client/transport/child).
      await sub1.close();
      expect(await sub1Closed).toBe("local");
      await client1.close();
      client1 = null;

      // 4) Establish a NEW STDIO connection (fresh process + fresh client).
      client2 = await connectStdio("m6e-stdio-reconnect-2");
      expect(client2.getNegotiatedProtocolVersion()).toBe("2026-07-28");

      // Official SDK behaviour: subscriptions are NOT automatically reopened
      // after reconnect. No auto-opened subscription exists on the new client;
      // a fresh listen() is required to receive anything.
      expect(client2.autoOpenedSubscription).toBeUndefined();

      // 7) resources.subscribe stays disabled on STDIO after reconnect, and all
      // listChanged bits remain explicitly false (§5.3 control-plane boundary).
      const discover = await client2.getDiscoverResult();
      const caps = discover.capabilities as Record<string, Record<string, unknown>>;
      expect(caps.resources?.subscribe).not.toBe(true);
      expect(caps.tools?.listChanged).toBe(false);
      expect(caps.prompts?.listChanged).toBe(false);
      expect(caps.resources?.listChanged).toBe(false);

      // 5 + 6) Explicitly re-open subscriptions/listen. listen() resolves only
      // when the NEW acknowledgement arrives, so this proves a fresh ack; the
      // honored filter is honestly empty/unsupported on STDIO.
      const sub2 = await client2.listen({ resourceSubscriptions: ["markethub://market/snapshot"] });
      expect(sub2.honoredFilter.resourceSubscriptions).toBeUndefined();
      expect(sub2.honoredFilter.toolsListChanged).toBeUndefined();
      expect(sub2.honoredFilter.promptsListChanged).toBeUndefined();
      expect(sub2.honoredFilter.resourcesListChanged).toBeUndefined();
      const sub2Closed = sub2.closed;
      await sub2.close();
      expect(await sub2Closed).toBe("local");

      await client2.close();
      client2 = null;
    } finally {
      if (client1) await client1.close().catch(() => {});
      if (client2) await client2.close().catch(() => {});
      await api.stop(true);
    }
  });
});
