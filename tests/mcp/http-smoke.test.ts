import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const HEALTH = healthStatusSchema.parse({
  status: "ok",
  service: "markethub-api",
  timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0",
  checks: { api: "ok", database: "ok" }
});

/**
 * M6-A exit gate: start the real Hono/Bun application on an actual local port,
 * connect a modern-pinned Streamable HTTP client, and verify discovery, the
 * health tool and clean shutdown. No live providers or external network.
 */
describe("mcp real HTTP smoke (M6-A exit gate)", () => {
  test("pinned 2026-07-28 client discovers and calls markethub_health over /mcp", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "markethub-mcp-http-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_LAN: "false" } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);

    const services: McpServices = { getHealth: async () => ({ ok: true, value: HEALTH }) };
    const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
    const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now(), mcpHandler: handler });

    let server: ReturnType<typeof Bun.serve> | null = null;
    let client: Client | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      const url = `http://127.0.0.1:${server.port}/mcp`;

      client = new Client(
        { name: "markethub-http-smoke", version: "1.0.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));

      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "markethub_health")).toBe(true);

      const result = await client.callTool({ name: "markethub_health", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(HEALTH);

      // Invalid Host is rejected by the real listener before the handler runs.
      const rejected = await fetch(url, {
        method: "POST",
        headers: { Host: "evil.example", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} })
      });
      expect(rejected.status).toBe(403);
    } finally {
      if (client) await client.close();
      // Shutdown order: handler -> HTTP server -> DB.
      await handler.close();
      if (server) await server.stop(true);
      closeDatabaseHandle(db);
      removeTempDir(dir);
    }
  });
});
