import { loadConfig, providerConfigFromAppConfig, redactConfigForLog, type AppConfig } from "@markethub/config";
import {
  openDatabase, runMigrations, defaultMigrationsFolder, SqliteCredentialStore, SqliteProviderSettings,
  SqliteSubscriptionRepository, SqliteCatalogRepository, checkDatabase, type DatabaseHandle
} from "@markethub/database";
import { healthStatusSchema } from "@markethub/contracts";
import { nowIso } from "@markethub/shared";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "@markethub/mcp-core";
import { MarketDataService, ProviderRegistry } from "@markethub/market-core";
import { LiveEventHub } from "@markethub/realtime";
import { UpstoxAdapter } from "@markethub/broker-upstox";
import { FyersAdapter } from "@markethub/broker-fyers";
import { createApp } from "./app";
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

/** Build the HTTP-backed MCP services from the existing injected state. */
function createHttpMcpServices(config: AppConfig, db: DatabaseHandle): McpServices {
  return {
    getHealth: async () => {
      const parsed = healthStatusSchema.safeParse({
        status: "ok",
        service: "markethub-api",
        timestamp: nowIso(),
        version: config.version,
        checks: { api: "ok", database: checkDatabase(db.sqlite) === "ok" ? "ok" : "error" }
      });
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: { category: "internal", message: "Failed to build health status" } };
    }
  };
}

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

  // M6-A: one handler for the process lifetime; its factory builds a fresh
  // McpServer per request over the existing services. No second app/DB/provider.
  const runtimeDb = db;
  mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx, createHttpMcpServices(config, runtimeDb)));

  const app = createApp({
    config, db, logger, startedAt: Date.now(),
    providerRegistry: registry, credentials, settings, providerConfig, upstox, fyers,
    service, hub, coordinator, mcpHandler
  });

  try {
    server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
    logger.info("listening", { host: config.host, port: server.port, lan: config.lan, env: config.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "server", message });
    try { coordinator?.stop(); } catch {}
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
      // 4) stop hub timers and clients before the HTTP server and DB close.
      try { hub?.stop(); } catch (error) {
        logger.warn("hub_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 5) close the MCP handler and its in-flight exchanges before the HTTP
      // server and DB go away — no MCP handler may outlive its database.
      try { if (mcpHandler) await mcpHandler.close(); } catch (error) {
        logger.warn("mcp_handler_close_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 6) close HTTP server; 7) close/checkpoint DB.
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
