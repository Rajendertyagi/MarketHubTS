import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { createMcpNotificationBridge } from "../../apps/api/src/mcp-notification-bridge";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { runAcceptance } from "../../scripts/m6e-lan-client";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

/**
 * CI-safe regression guard for the M6-E acceptance client. Runs the SAME 14-step
 * client used on the MacBook against a real Bun.serve listener on 127.0.0.1.
 *
 * This is NOT second-device LAN acceptance (your docs explicitly exclude
 * loopback). It proves the client, harness composition, protocol, SSE
 * notification, read-after-notify and Host/Origin rejection all work together
 * with zero external dependencies, on any machine where `bun test` runs.
 */
describe("M6-E acceptance client — CI-safe loopback regression guard", () => {
  test("all 14 acceptance steps pass against a real listener on 127.0.0.1", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "markethub-m6e-lanpath-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({
      env: {
        MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath,
        MARKETHUB_LAN: "true", MARKETHUB_HOST: "127.0.0.1"
      }
    });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);

    const service = new MarketDataService({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      policy: { openMaxAgeMs: 60_000, unknownMaxAgeMs: 60_000, maxRetainedObservationAgeMs: 86_400_000 },
      maxInstruments: 500,
      session: () => "OPEN" as const
    });
    const hub = new LiveEventHub(service, {
      replayMaxEvents: 1000, replayMaxBytes: 10_000_000,
      clientMaxEvents: 1000, clientMaxBytes: 10_000_000, refreshIntervalMs: 0
    });
    hub.start();

    const services: McpServices = {
      getHealth: async () => ({ ok: true, value: HEALTH }),
      searchCatalog: async () => ({ ok: true, value: { instruments: [], nextCursor: null } }),
      readEventFeed: async (req) => {
        const r = hub.readAfter(req.after, req.limit);
        if (r.outcome === "snapshot-required") {
          return { ok: true, value: { events: [], nextCursor: null, snapshotRequired: { reason: r.reason } } };
        }
        return { ok: true, value: { events: r.events, nextCursor: r.nextCursor, resumeCursor: r.resumeCursor } };
      },
      getProviderStatus: async () => ({ ok: true, value: {} as never }),
      getLiveSnapshot: async () => ({ ok: true, value: service.getSnapshot() as never }),
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

    const handler = createMcpHandler((ctx) => createMcpServer(ctx, services), { maxSubscriptions: 64 });
    const bridge = createMcpNotificationBridge(service, handler.notify);
    bridge.start();
    const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now(), mcpHandler: handler });

    let server: ReturnType<typeof Bun.serve> | null = null;
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      const results = await runAcceptance({
        baseUrl: `http://127.0.0.1:${server.port}/mcp`,
        ip: "127.0.0.1",
        port: server.port,
        emitTimeoutMs: 10_000,
        onReady: () => { service.track("LAN-TEST-1"); }
      });

      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        throw new Error(`acceptance steps failed: ${failed.map((r) => `${r.name}: ${r.detail}`).join("; ")}`);
      }
      expect(results.length).toBe(14);
      expect(results.every((r) => r.ok)).toBe(true);
    } finally {
      await handler.close();
      bridge.stop();
      hub.stop();
      if (server) await server.stop(true);
      closeDatabaseHandle(db);
      removeTempDir(dir);
    }
  });
});
