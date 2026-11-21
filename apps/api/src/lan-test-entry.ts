/**
 * M6-E LAN acceptance harness — TEST ONLY. Never imported by the production
 * composition (apps/api/src/index.ts / app.ts).
 *
 * Guard: requires MARKETHUB_LAN_TEST=1. Without it the process exits before
 * opening any port or database. The synthetic event trigger is read from stdin
 * (`emit`, `status`, `quit`) — there is deliberately NO HTTP debug/mutation
 * endpoint, not even in this test build.
 *
 * Usage (from the repo root):
 *   MARKETHUB_LAN_TEST=1 MARKETHUB_LAN=true MARKETHUB_HOST=<lan-ip> \
 *     MARKETHUB_PORT=<port> bun apps/api/src/lan-test-entry.ts
 * Then, on the second device, run the MCP client steps in
 * docs/M6_E_LAN_ACCEPTANCE.md; type `emit` here to trigger a canonical change.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "@markethub/config";
import {
  openDatabase, runMigrations, defaultMigrationsFolder, McpActivityRepository,
  SqliteCatalogRepository, AppSettings, CandleRepository, SnapshotRepository
} from "@markethub/database";
import {
  MarketDataService, ProviderRegistry, HistoricalCandleService, OptionChainSnapshotService
} from "@markethub/market-core";
import { LiveEventHub } from "@markethub/realtime";
import { createMcpServer } from "@markethub/mcp-core";
import { createApp } from "./app";
import { createHttpMcpServices } from "./mcp-services";
import { createMcpNotificationBridge } from "./mcp-notification-bridge";
import { createLogger } from "./lib/logger";

if (process.env.MARKETHUB_LAN_TEST !== "1") {
  console.error("REFUSED: LAN test harness requires MARKETHUB_LAN_TEST=1. This entry is test-only.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "markethub-lan-test-"));
const config = loadConfig({
  env: {
    MARKETHUB_ENV: "test",
    MARKETHUB_DB_PATH: join(dir, "lan-test.sqlite"),
    MARKETHUB_LAN: process.env.MARKETHUB_LAN ?? "true",
    ...(process.env.MARKETHUB_HOST ? { MARKETHUB_HOST: process.env.MARKETHUB_HOST } : {}),
    ...(process.env.MARKETHUB_PORT ? { MARKETHUB_PORT: process.env.MARKETHUB_PORT } : {})
  }
});
const logger = createLogger(config.logLevel);
const db = openDatabase({ dbPath: config.dbPath });
runMigrations(db.db, defaultMigrationsFolder);

const service = new MarketDataService({
  now: () => new Date(),
  policy: {
    openMaxAgeMs: 60_000, unknownMaxAgeMs: 60_000, maxRetainedObservationAgeMs: 86_400_000
  },
  maxInstruments: 100,
  session: () => "UNKNOWN" as const
});
const hub = new LiveEventHub(service, {
  replayMaxEvents: 1000, replayMaxBytes: 10_000_000,
  clientMaxEvents: 1000, clientMaxBytes: 10_000_000,
  refreshIntervalMs: 0
});
hub.start();

const activityRepo = new McpActivityRepository(db.db, db.sqlite);
const catalog = new SqliteCatalogRepository(db.db, db.sqlite);
const registry = new ProviderRegistry();
const appSettings = new AppSettings(db.db);
const historicalService = new HistoricalCandleService({
  candles: new CandleRepository(db.db, db.sqlite), settings: appSettings, providers: []
});
const snapshotService = new OptionChainSnapshotService({
  snapshots: new SnapshotRepository(db.db, db.sqlite), settings: appSettings, providers: []
});
const handler = createMcpHandler((ctx) =>
  createMcpServer(ctx, createHttpMcpServices(
    config, db, catalog, hub, registry, service,
    historicalService, snapshotService, activityRepo
  ))
);
const bridge = createMcpNotificationBridge(service, handler.notify, (error) =>
  logger.warn("mcp_notification_publish_failed", { message: error instanceof Error ? error.message : String(error) })
);
bridge.start();

const app = createApp({ config, db, logger, startedAt: Date.now(), mcpHandler: handler, activityRepo });
const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
logger.info("lan_test_harness_ready", { host: config.host, port: server.port, lan: config.lan, guard: "MARKETHUB_LAN_TEST=1" });
console.log(`LAN test harness listening on http://${config.host}:${server.port}/mcp — type 'emit' to trigger a synthetic change, 'quit' to stop.`);

let emitted = 0;
const shutdown = async () => {
  await handler.close();
  bridge.stop();
  hub.stop();
  await server.stop(true);
  db.close();
  console.log("LAN test harness stopped.");
  process.exit(0);
};

process.stdin.on("data", (chunk: Buffer) => {
  const line = chunk.toString().trim().toLowerCase();
  if (line === "emit") {
    emitted += 1;
    service.track(`LAN-TEST-${emitted}`);
    console.log(`emitted synthetic item-updated revision ${service.getSnapshot().revision}`);
  } else if (line === "status") {
    console.log(`revision=${service.getSnapshot().revision} emitted=${emitted}`);
  } else if (line === "quit") {
    void shutdown();
  }
});
process.stdin.resume();
