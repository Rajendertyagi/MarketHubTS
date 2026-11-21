import { loadConfig, providerConfigFromAppConfig, redactConfigForLog } from "@markethub/config";
import {
  openDatabase, runMigrations, defaultMigrationsFolder, SqliteCredentialStore, SqliteProviderSettings,
  SqliteSubscriptionRepository, SqliteCatalogRepository, AppSettings, CandleRepository, SnapshotRepository,
  McpActivityRepository, type DatabaseHandle
} from "@markethub/database";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer } from "@markethub/mcp-core";
import { MarketDataService, ProviderRegistry, HistoricalCandleService, OptionChainSnapshotService } from "@markethub/market-core";
import { LiveEventHub } from "@markethub/realtime";
import { UpstoxAdapter } from "@markethub/broker-upstox";
import { FyersAdapter } from "@markethub/broker-fyers";
import { createApp } from "./app";
import { createHttpMcpServices } from "./mcp-services";
import { createMcpNotificationBridge, type McpNotificationBridge } from "./mcp-notification-bridge";
import { createLogger } from "./lib/logger";
import { LockedProviderDriver, StreamSupervisor } from "./stream-supervisor";
import { SubscriptionCoordinator } from "./subscription-coordinator";

type RunningServer = ReturnType<typeof Bun.serve>;

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let server: RunningServer | null = null;
let db: DatabaseHandle | null = null;
let hub: LiveEventHub | null = null;
let coordinator: SubscriptionCoordinator | null = null;
let mcpHandler: ReturnType<typeof createMcpHandler> | null = null;
let notificationBridge: McpNotificationBridge | null = null;

// M6-D: deliberate handler bounds. maxSubscriptions is a conservative 64 (a
// single local owner with a handful of MCP clients, not a public service);
// tests/mcp/fanout.test.ts sweeps 8/32/64 subscribers and records p95 latency
// and heap delta; measurements and the 50 ms latency budget are preserved in
// docs/M6_D_FANOUT_EVIDENCE.md. These bound stream count and request size; the
// SDK does not impose a per-stream frame/byte cap (documented in the M6-D/E
// plan). No new settings framework is introduced.
const MCP_MAX_SUBSCRIPTIONS = 64;
const MCP_KEEP_ALIVE_MS = 15_000;
const MCP_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;


async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info("starting", { config: redactConfigForLog(config) });

  try {
    db = openDatabase({ dbPath: config.dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    logger.info("database_ready", { path: db.path });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "database", message });
    try { db?.close(); } catch {}
    process.exitCode = 1;
    return;
  }

  const credentials = new SqliteCredentialStore(db);
  const settings = new SqliteProviderSettings(db);
  const providerConfig = providerConfigFromAppConfig(config);
  const registry = new ProviderRegistry();
  const upstox = new UpstoxAdapter({ credentials, settings, config: providerConfig });
  const fyers = new FyersAdapter({ credentials, settings, config: providerConfig });
  await Promise.all([upstox.initialize(), fyers.initialize()]);
  registry.register(upstox);
  registry.register(fyers);
  if (credentials.status().state === "UNAVAILABLE") {
    logger.warn("credentials_unavailable", { reason: credentials.status().reason ?? "unknown" });
  }

  // One canonical live-data service shared by REST, SSE and the supervisor.
  // No real market-session source exists yet; UNKNOWN is the conservative choice.
  const policy = config.livePolicy;
  const service = new MarketDataService({
    now: () => new Date(),
    policy: {
      openMaxAgeMs: policy.openMaxAgeMs,
      unknownMaxAgeMs: policy.unknownMaxAgeMs,
      maxRetainedObservationAgeMs: policy.maxRetainedObservationAgeMs
    },
    maxInstruments: policy.maxInstruments,
    session: () => "UNKNOWN" as const
  });

  hub = new LiveEventHub(service, {
    replayMaxEvents: policy.replayMaxEvents,
    replayMaxBytes: policy.replayMaxBytes,
    clientMaxEvents: policy.clientMaxEvents,
    clientMaxBytes: policy.clientMaxBytes,
    refreshIntervalMs: policy.refreshIntervalMs
  });
  hub.start();

  const catalog = new SqliteCatalogRepository(db.db, db.sqlite);
  const subscriptions = new SqliteSubscriptionRepository(db.db, db.sqlite);
  // AD-024 production boundary: one shared coordinator owns desired state; each
  // configured provider has an independent runtime with its own locked driver.
  // No real SDK, socket or provider connection is ever constructed. Only a
  // separately authorized Stage G change may unlock a real driver.
  const runtimeOptions = {
    service, subscriptions, catalog,
    coordinated: true,
    reconnect: { maxAttempts: policy.reconnectMaxAttempts, baseDelayMs: policy.reconnectBaseDelayMs }
  };
  const upstoxRuntime = new StreamSupervisor({
    ...runtimeOptions, provider: "UPSTOX", createDriver: () => new LockedProviderDriver("UPSTOX")
  });
  const fyersRuntime = new StreamSupervisor({
    ...runtimeOptions, provider: "FYERS", createDriver: () => new LockedProviderDriver("FYERS")
  });
  coordinator = new SubscriptionCoordinator({
    service, subscriptions, catalog,
    runtimes: [
      { provider: "UPSTOX", supervisor: upstoxRuntime },
      { provider: "FYERS", supervisor: fyersRuntime }
    ]
  });
  await upstoxRuntime.start();
  await fyersRuntime.start();
  await coordinator.start();

  // M6-B2: construct the M5 services once and share the same instances with
  // REST routes and the MCP adapter. No second app/DB/provider/service.
  const appSettings = new AppSettings(db.db);
  const candleRepo = new CandleRepository(db.db, db.sqlite);
  const snapshotRepo = new SnapshotRepository(db.db, db.sqlite);
  const activityRepo = new McpActivityRepository(db.db, db.sqlite);
  const historicalService = new HistoricalCandleService({ candles: candleRepo, settings: appSettings, providers: [] });
  const snapshotService = new OptionChainSnapshotService({ snapshots: snapshotRepo, settings: appSettings, providers: [] });

  // M6-A: one handler for the process lifetime; its factory builds a fresh
  // McpServer per request over the existing services. No second app/DB/provider.
  const runtimeDb = db;
  const runtimeHub = hub;
  const runtimeCatalog = catalog;
  mcpHandler = createMcpHandler((ctx) =>
    createMcpServer(ctx, createHttpMcpServices(
      config, runtimeDb, runtimeCatalog, runtimeHub, registry, service, historicalService, snapshotService, activityRepo,
      (error) => logger.warn("mcp_activity_write_failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      })
    )),
    {
      maxSubscriptions: MCP_MAX_SUBSCRIPTIONS,
      keepAliveMs: MCP_KEEP_ALIVE_MS,
      maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
      onerror: (error) => logger.warn("mcp_handler_error", {
        message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      })
    }
  );

  // M6-D: one process-lifetime bridge from the canonical live-change source to
  // the handler's notifier. Never created per request or per subscription.
  notificationBridge = createMcpNotificationBridge(
    service,
    mcpHandler.notify,
    (error) => logger.warn("mcp_notification_publish_failed", {
      message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    })
  );
  notificationBridge.start();

  const app = createApp({
    config, db, logger, startedAt: Date.now(),
    providerRegistry: registry, credentials, settings, providerConfig, upstox, fyers,
    service, hub, coordinator, mcpHandler, catalogRepo: catalog,
    appSettings, candleRepo, snapshotRepo, historicalService, snapshotService, activityRepo
  });

  try {
    server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
    logger.info("listening", { host: config.host, port: server.port, lan: config.lan, env: config.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "server", message });
    try { coordinator?.stop(); } catch {}
    // Close the MCP handler before detaching the bridge or closing the DB.
    try { if (mcpHandler) await mcpHandler.close(); } catch {}
    try { notificationBridge?.stop(); } catch {}
    try { hub?.stop(); } catch {}
    try { db?.close(); } catch {}
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: string, exitAfter: boolean) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info("shutdown_start", { signal });
      // 1) stop accepting subscription/config work; 2) stop/cancel the shared
      // coordinator and its provider runtimes (locked drivers own no resources).
      try { coordinator?.stop(); } catch (error) {
        logger.warn("coordinator_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // M6-D shutdown order: keep the handler alive until close() so active
      // listen streams receive graceful completion, then detach the bridge so
      // no publish races teardown, then stop the hub/server/DB.
      // 2) close the MCP handler (graceful listen completion, then abort in-flight).
      try { if (mcpHandler) await mcpHandler.close(); } catch (error) {
        logger.warn("mcp_handler_close_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 3) unsubscribe the bridge after the handler is closed.
      try { notificationBridge?.stop(); } catch (error) {
        logger.warn("mcp_notification_bridge_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 4) stop hub timers and clients before the HTTP server and DB close.
      try { hub?.stop(); } catch (error) {
        logger.warn("hub_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 5) close HTTP server; 6) close/checkpoint DB.
      try { if (server) await server.stop(true); } catch (error) {
        logger.warn("server_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      try { db?.close(); } catch (error) {
        logger.warn("db_close_error", { message: error instanceof Error ? error.message : String(error) });
      }
      logger.info("shutdown_complete", { signal });
      if (process.exitCode === undefined) process.exitCode = 0;
      if (exitAfter) process.exit(process.exitCode ?? 0);
    })();
    return shutdownPromise;
  };

  process.on("SIGINT", () => { void shutdown("SIGINT", true); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM", true); });
  if (process.env.MARKETHUB_TEST_SHUTDOWN_ON_STDIN_END === "1" && process.stdin && typeof process.stdin.on === "function") {
    const onStdinEnd = () => { void shutdown("STDIN_END", true); };
    process.stdin.on("end", onStdinEnd);
    process.stdin.on("close", onStdinEnd);
    try { process.stdin.resume(); } catch {}
  }
}

void main();
