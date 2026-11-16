import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
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
  webDistDir?: string;
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

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname;
}

function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHostname(hostname).toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (isIP(h) === 4) {
    const parts = h.split(".").map((n) => Number(n));
    return parts.length === 4 && parts[0] === 127 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  }
  return false;
}

function isPrivateLanIpv4(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (isIP(h) !== 4) return false;
  const parts = h.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function isAllowedCorsOrigin(origin: string, config: Pick<AppConfig, "lan" | "port" | "webPort">): boolean {
  if (!origin) return false;
  const allowed = new Set<string>([
    `http://localhost:${config.webPort}`,
    `http://127.0.0.1:${config.webPort}`,
    `http://localhost:${config.port}`,
    `http://127.0.0.1:${config.port}`
  ]);
  if (allowed.has(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname;
    if (isLoopbackHost(host)) return true;
    if (config.lan && isPrivateLanIpv4(host)) return true;
  } catch {
    return false;
  }
  return false;
}

function corsOrigin(config: AppConfig) {
  return (origin: string) => (isAllowedCorsOrigin(origin, config) ? origin : undefined);
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

  const distDir = deps.webDistDir ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
  const indexPath = resolve(distDir, "index.html");
  const serveWeb = deps.config.env === "production" && existsSync(indexPath);

  if (serveWeb) {
    app.get("/", async (c) => c.html(await Bun.file(indexPath).text()));
    app.use("/*", serveStatic({ root: distDir }));
    app.get("*", async (c, next) => {
      const p = c.req.path;
      if (p.startsWith("/api") || p === "/health" || p === "/ready") return next();
      if (c.req.method === "GET") {
        return c.html(await Bun.file(indexPath).text());
      }
      return next();
    });
  } else {
    app.get("/", (c) => c.json({ name: "MarketHubTS API", health: "/health", ready: "/ready", status: "/api/status" }));
  }

  return app;
}
