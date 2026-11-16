import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiErrorSchema,
  healthStatusSchema,
  readinessStatusSchema,
  systemStatusSchema,
  type CheckState,
  type ReadinessStatus
} from "@markethub/contracts";
import { checkDatabase, type DatabaseHandle } from "@markethub/database";
import { nowIso } from "@markethub/shared";
import type { AppConfig } from "@markethub/config";
import type { Logger } from "./lib/logger";

export interface AppDependencies {
  config: AppConfig;
  db: DatabaseHandle;
  logger: Logger;
  startedAt: number;
}

function dbCheckState(db: DatabaseHandle): CheckState {
  return checkDatabase(db.sqlite) === "ok" ? "ok" : "error";
}

function buildReadiness(deps: AppDependencies): ReadinessStatus {
  const dbState = dbCheckState(deps.db);
  const configState: CheckState = "ok";
  const apiState: CheckState = "ok";
  const ready = dbState === "ok" && configState === "ok";
  const status = ready ? "ok" : dbState === "error" ? "error" : "degraded";
  return readinessStatusSchema.parse({
    status,
    service: "markethub-api",
    timestamp: nowIso(),
    version: deps.config.version,
    ready,
    checks: { api: apiState, database: dbState, config: configState },
    details: {
      databasePathConfigured: deps.config.dbPath.length > 0,
      uptimeMs: Date.now() - deps.startedAt,
      environment: deps.config.env,
      lan: deps.config.lan,
      host: deps.config.host,
      port: deps.config.port
    }
  });
}

function corsOrigin(config: AppConfig) {
  const allowed = new Set<string>([
    `http://localhost:${config.webPort}`,
    `http://127.0.0.1:${config.webPort}`,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`
  ]);
  return (origin: string) => {
    if (!origin) return undefined;
    if (allowed.has(origin)) return origin;
    try {
      const u = new URL(origin);
      const host = u.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
      const isPrivateLan = /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
      if (config.lan && (isLocal || isPrivateLan)) return origin;
      if (!config.lan && isLocal) return origin;
    } catch {
      return undefined;
    }
    return undefined;
  };
}

export function createApp(deps: AppDependencies) {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    deps.logger.info("http_request", { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start });
  });

  app.use(
    "*",
    cors({
      origin: corsOrigin(deps.config),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600
    })
  );

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      return c.json(apiErrorSchema.parse({ error: "http_error", message: err.message }), status);
    }
    deps.logger.error("unhandled_error", { message: err instanceof Error ? err.message : String(err) });
    return c.json(apiErrorSchema.parse({ error: "internal_error", message: "An unexpected error occurred" }), 500);
  });

  app.notFound((c) => c.json(apiErrorSchema.parse({ error: "not_found", message: "Not found" }), 404));

  app.get("/health", (c) => {
    const dbState = dbCheckState(deps.db);
    const payload = healthStatusSchema.parse({
      status: "ok",
      service: "markethub-api",
      timestamp: nowIso(),
      version: deps.config.version,
      checks: { api: "ok", database: dbState === "ok" ? "ok" : dbState === "error" ? "error" : "unknown" }
    });
    return c.json(payload);
  });

  app.get("/ready", (c) => {
    const readiness = buildReadiness(deps);
    return c.json(readiness, readiness.ready ? 200 : 503);
  });

  app.get("/api/status", (c) => {
    const health = healthStatusSchema.parse({
      status: "ok",
      service: "markethub-api",
      timestamp: nowIso(),
      version: deps.config.version,
      checks: { api: "ok", database: dbCheckState(deps.db) === "ok" ? "ok" : "error" }
    });
    const readiness = buildReadiness(deps);
    const payload = systemStatusSchema.parse({
      service: "markethub-api",
      version: deps.config.version,
      timestamp: nowIso(),
      uptimeMs: Date.now() - deps.startedAt,
      health,
      readiness
    });
    return c.json(payload);
  });

  app.get("/", (c) => c.json({ name: "MarketHubTS API", health: "/health", ready: "/ready", status: "/api/status" }));

  const distDir = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
  if (deps.config.env === "production" && existsSync(distDir)) {
    app.use("/*", serveStatic({ root: distDir }));
    app.get("*", async (c, next) => {
      const p = c.req.path;
      if (p.startsWith("/api") || p === "/health" || p === "/ready") return next();
      if (c.req.method === "GET") {
        const indexPath = resolve(distDir, "index.html");
        if (existsSync(indexPath)) return c.html(await Bun.file(indexPath).text());
      }
      return next();
    });
  }

  return app;
}
