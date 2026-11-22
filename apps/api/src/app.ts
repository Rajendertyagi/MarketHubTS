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
import {
  AppSettings, CandleRepository, SnapshotRepository, SqliteCatalogRepository, McpActivityRepository, checkDatabase, type DatabaseHandle
} from "@markethub/database";
import { nowIso } from "@markethub/shared";
import type { AppConfig } from "@markethub/config";
import type { CredentialStore, ProviderConfig, ProviderId } from "@markethub/contracts";
import {
  HistoricalCandleService, OptionChainSnapshotService,
  type CatalogRepository, type MarketDataService, type ProviderRegistry
} from "@markethub/market-core";
import type { LiveEventHub } from "@markethub/realtime";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { registerMcpRoute } from "./mcp-routes";
import { registerCatalogRoutes } from "./catalog-routes";
import type { UpstoxAdapter } from "@markethub/broker-upstox";
import type { FyersAdapter } from "@markethub/broker-fyers";
import type { Logger } from "./lib/logger";
import type { StreamSupervisor } from "./stream-supervisor";
import type { SubscriptionCoordinator } from "./subscription-coordinator";

export interface AppDependencies {
  config: AppConfig;
  db: DatabaseHandle;
  logger: Logger;
  startedAt: number;
  webDistDir?: string;
  providerRegistry?: ProviderRegistry;
  settings?: import("@markethub/contracts").ProviderSettings;
  credentials?: CredentialStore;
  providerConfig?: ProviderConfig;
  upstox?: UpstoxAdapter;
  fyers?: FyersAdapter;
  service?: MarketDataService;
  hub?: LiveEventHub;
  supervisor?: StreamSupervisor;
  coordinator?: SubscriptionCoordinator;
  /** M5 seams — optional overrides for tests; defaults are built from deps.db. */
  appSettings?: AppSettings;
  candleRepo?: CandleRepository;
  snapshotRepo?: SnapshotRepository;
  historicalService?: HistoricalCandleService;
  snapshotService?: OptionChainSnapshotService;
  /** M6-A: the single application-owned MCP HTTP handler. */
  mcpHandler?: McpHttpHandler;
  /** M6-B1: catalog repository override for tests; defaults to a repo over deps.db. */
  catalogRepo?: CatalogRepository;
  /** M6-C: durable activity repository; defaults to a repo over deps.db. */
  activityRepo?: McpActivityRepository;
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

import { isLoopbackHost, isPrivateLanIpv4 } from "./lib/net";
import { registerProviderRoutes } from "./provider-routes";
import { registerMarketRoutes } from "./market-routes";
import { registerHistoricalRoutes } from "./historical-routes";
import { registerSnapshotRoutes } from "./snapshot-routes";
import { registerMcpActivityRoutes } from "./mcp-activity-routes";
import { registerMcpOperationsRoutes } from "./mcp-operation-routes";
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

/** Simple local-owner check for credential-changing routes. No app-level login. */
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
      allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"],
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


  registerProviderRoutes(app, deps);

  // M6-B1: read-only bounded catalog search over the same catalog repository.
  const catalogRepo = deps.catalogRepo ?? new SqliteCatalogRepository(deps.db.db, deps.db.sqlite);
  registerCatalogRoutes(app, { catalog: catalogRepo });

  // M5 canonical historical/snapshot services. No live providers are wired in
  // M5 (Phase 4B/Stage G); empty provider lists keep on-demand operations
  // honest. All consumers (API/WebUI) share these services and repositories.
  const appSettings = deps.appSettings ?? new AppSettings(deps.db.db);
  const candleRepo = deps.candleRepo ?? new CandleRepository(deps.db.db, deps.db.sqlite);
  const snapshotRepo = deps.snapshotRepo ?? new SnapshotRepository(deps.db.db, deps.db.sqlite);
  const historicalService = deps.historicalService ?? new HistoricalCandleService({
    candles: candleRepo, settings: appSettings, providers: []
  });
  const snapshotService = deps.snapshotService ?? new OptionChainSnapshotService({
    snapshots: snapshotRepo, settings: appSettings, providers: []
  });
  // M6-C: construct the activity repository once, before any route that needs
  // it, so default composition and injected composition share the same instance.
  const activityRepo = deps.activityRepo ?? new McpActivityRepository(deps.db.db, deps.db.sqlite);
  registerHistoricalRoutes(app, {
    service: historicalService, candles: candleRepo, snapshots: snapshotRepo, settings: appSettings,
    activities: activityRepo
  });
  registerSnapshotRoutes(app, { service: snapshotService, snapshots: snapshotRepo });

  // M6-C: durable activity history. Write routes are local-owner-only, reads
  // follow the LAN model. Same repository instance as retention cleanup.
  registerMcpActivityRoutes(app, { activities: activityRepo });

  // Phase 2: read-only operation discovery for the Activity selector. Sourced
  // from the same registration-owned descriptors used by the MCP registrations.
  registerMcpOperationsRoutes(app);

  if (deps.service && deps.hub && (deps.supervisor || deps.coordinator)) {
    registerMarketRoutes(app, {
      service: deps.service,
      hub: deps.hub,
      supervisor: deps.supervisor,
      coordinator: deps.coordinator
    });
  }
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
      readiness,
      mcp: { httpHandlerMounted: deps.mcpHandler !== undefined }
    });
    return c.json(payload);
  });

  // M6-A: register the MCP endpoint before static/SPA handlers so /mcp is never
  // intercepted. The handler is created once by the application composition root.
  if (deps.mcpHandler) {
    registerMcpRoute(app, { handler: deps.mcpHandler, config: deps.config });
  }

  const distDir = deps.webDistDir ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
  const indexPath = resolve(distDir, "index.html");
  const serveWeb = deps.config.env === "production" && existsSync(indexPath);

  if (serveWeb) {
    app.get("/", async (c) => c.html(await Bun.file(indexPath).text()));
    app.use("/*", serveStatic({ root: distDir }));
    app.get("*", async (c, next) => {
      const p = c.req.path;
      if (p.startsWith("/api") || p === "/health" || p === "/ready" || p === "/mcp") return next();
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
