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
      expect(caps.resources?.subscribe).not.toBe(true); // no live relay on STDIO
      expect(caps.tools?.listChanged).toBe(false);

      // Resource + prompt access over the spawned process.
      const snap = await client.readResource({ uri: "markethub://market/snapshot" });
      expect(snap.contents[0]!.mimeType).toBe("application/json");
      const prompt = await client.getPrompt({ name: "explain_market_snapshot", arguments: {} });
      expect(prompt.messages.length).toBeGreaterThan(0);

      // subscriptions/listen control-plane: SDK handles it, but the honored
      // filter must NOT claim resourceSubscriptions (no event relay on STDIO).
      const sub = await client.listen({ resourceSubscriptions: ["markethub://market/snapshot"] });
      expect(sub.honoredFilter.resourceSubscriptions).toBeUndefined();
      await sub.close();

      await client.close();
      client = null;
    } finally {
      if (client) await client.close();
      await api.stop(true);
    }
  });
});
