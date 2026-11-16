import { loadConfig, redactConfigForLog } from "@markethub/config";
import { openDatabase, runMigrations, defaultMigrationsFolder, type DatabaseHandle } from "@markethub/database";
import { createApp } from "./app";
import { createLogger } from "./lib/logger";

interface RunningServer {
  stop: (closeActiveConnections?: boolean) => void;
  port: number;
}

let shuttingDown = false;
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

  const app = createApp({ config, db, logger, startedAt: Date.now() });

  try {
    server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch }) as RunningServer;
    logger.info("listening", { host: config.host, port: server.port, lan: config.lan, env: config.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "server", message });
    try { db?.close(); } catch {}
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown_start", { signal });
    try { server?.stop(true); } catch (error) {
      logger.warn("server_stop_error", { message: error instanceof Error ? error.message : String(error) });
    }
    try { db?.close(); } catch (error) {
      logger.warn("db_close_error", { message: error instanceof Error ? error.message : String(error) });
    }
    logger.info("shutdown_complete", { signal });
    if (process.exitCode === undefined) process.exitCode = 0;
    setTimeout(() => process.exit(process.exitCode ?? 0), 10);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
