import { loadConfig, providerConfigFromAppConfig, redactConfigForLog } from "@markethub/config";
import {
  openDatabase, runMigrations, defaultMigrationsFolder, SqliteCredentialStore, SqliteProviderSettings,
  SqliteSubscriptionRepository, SqliteCatalogRepository, type DatabaseHandle
} from "@markethub/database";
import { MarketDataService, ProviderRegistry } from "@markethub/market-core";
import { LiveEventHub } from "@markethub/realtime";
import { UpstoxAdapter } from "@markethub/broker-upstox";
import { FyersAdapter } from "@markethub/broker-fyers";
import { createApp } from "./app";
import { createLogger } from "./lib/logger";
import { LockedUpstoxDriver, StreamSupervisor } from "./stream-supervisor";

type RunningServer = ReturnType<typeof Bun.serve>;

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let server: RunningServer | null = null;
let db: DatabaseHandle | null = null;
let hub: LiveEventHub | null = null;
let supervisor: StreamSupervisor | null = null;

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
  // Stage D production boundary: the real Upstox SDK driver is never constructed.
  const driver = new LockedUpstoxDriver();
  supervisor = new StreamSupervisor({
    service, subscriptions, catalog, driver,
    reconnect: { maxAttempts: policy.reconnectMaxAttempts, baseDelayMs: policy.reconnectBaseDelayMs }
  });
  await supervisor.start();

  const app = createApp({
    config, db, logger, startedAt: Date.now(),
    providerRegistry: registry, credentials, settings, providerConfig, upstox, fyers,
    service, hub, supervisor
  });

  try {
    server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
    logger.info("listening", { host: config.host, port: server.port, lan: config.lan, env: config.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "server", message });
    try { supervisor?.stop(); } catch {}
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
      // 1) stop accepting subscription/config work; 2) stop/cancel supervisor
      // (the locked driver owns no resources, so there is nothing to close).
      try { supervisor?.stop(); } catch (error) {
        logger.warn("supervisor_stop_error", { message: error instanceof Error ? error.message : String(error) });
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
