import { loadConfig, providerConfigFromAppConfig, redactConfigForLog } from "@markethub/config";
import { openDatabase, runMigrations, defaultMigrationsFolder, SqliteCredentialStore, type DatabaseHandle } from "@markethub/database";
import { ProviderRegistry } from "@markethub/market-core";
import { UpstoxAdapter } from "@markethub/broker-upstox";
import { FyersAdapter } from "@markethub/broker-fyers";
import { createApp } from "./app";
import { createLogger } from "./lib/logger";

type RunningServer = ReturnType<typeof Bun.serve>;

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let server: RunningServer | null = null;
let db: DatabaseHandle | null = null;

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
  const providerConfig = providerConfigFromAppConfig(config);
  const registry = new ProviderRegistry();
  const upstox = new UpstoxAdapter({ credentials, config: providerConfig });
  const fyers = new FyersAdapter({ credentials, config: providerConfig });
  registry.register(upstox);
  registry.register(fyers);
  if (credentials.status().state === "UNAVAILABLE") {
    logger.warn("credentials_unavailable", { reason: credentials.status().reason ?? "unknown" });
  }

  const app = createApp({
    config, db, logger, startedAt: Date.now(),
    providerRegistry: registry, credentials, providerConfig, upstox, fyers
  });

  try {
    server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
    logger.info("listening", { host: config.host, port: server.port, lan: config.lan, env: config.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "server", message });
    try { db?.close(); } catch {}
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: string, exitAfter: boolean) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info("shutdown_start", { signal });
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
