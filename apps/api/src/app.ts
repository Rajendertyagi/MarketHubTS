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
  type CatalogMasterRefresh, type CatalogRepository, type MarketDataService, type ProviderRegistry
} from "@markethub/market-core";
import type { LiveEventHub } from "@markethub/realtime";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { registerMcpRoute } from "./mcp-routes";
import { registerCatalogRoutes } from "./catalog-routes";
import { registerDerivativeRoutes } from "./derivative-routes";
import type { UpstoxAdapter } from "@markethub/broker-upstox";
import type { FyersAdapter } from "@markethub/broker-fyers";
import type { Logger } from "./lib/logger";
import type { StreamSupervisor } from "./stream-supervisor";
import type { SubscriptionCoordinator } from "./subscription-coordinator";
import {
  CatalogWriteBusyError, catalogWriteBusyBody, mapContentionError, writeBusyResponse,
  type ApiWriteGuard
} from "./catalog-write-coordinator";

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
  /** WP4A: app-owned provider-master refresh owner. When supplied, started non-blocking. */
  catalogRefresh?: CatalogMasterRefresh;
  /** G0-C: injected write coordinator; absent = legacy behaviour (all writes allowed). */
  writeGuard?: ApiWriteGuard | undefined;
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

  // G0-C: fail-fast gate BEFORE route validation for every interactive write
  // entry point (§7 rows #10–#30). Reads (GET/HEAD/OPTIONS), the MCP transport
  // and the read-only auth-start helper are not interactive writes. Per-route
  // checks and repository gates remain as defence in depth.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    if (c.req.path === "/api/provider/fyers/auth/start") return next();
    const busy = writeBusyResponse(deps.writeGuard, "I");
    if (busy) return busy;
    await next();
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
    // G0-C: fail-fast interactive writes and residual SQLite contention map to
    // the SAME retryable 503 contract — never a 500 (§8.2).
    const mapped = mapContentionError(err);
    if (mapped instanceof CatalogWriteBusyError) {
      deps.logger.warn("catalog_write_busy", { message: mapped.message });
      return c.json(catalogWriteBusyBody(mapped), 503);
    }
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
  const catalogRepo = deps.catalogRepo ?? new SqliteCatalogRepository(deps.db.db, deps.db.sqlite, deps.writeGuard);
  registerCatalogRoutes(app, { catalog: catalogRepo });

  // WP4B: bounded, provider-aware expiry discovery over the same catalogue
  // repository. Read-only and LAN-safe like the catalog search route.
  registerDerivativeRoutes(app, { catalog: catalogRepo });

  // WP3: catalog refresh is NOT started here. The HTTP listener must be
  // established before any provider master download is scheduled (§7.4.9 G0).
  // The composition root calls `startRefreshAfterListening` after Bun.serve()
  // succeeds; `catalogRefresh` remains injectable so tests never make calls.

  // M5 canonical historical/snapshot services. No live providers are wired in
  // M5 (Phase 4B/Stage G); empty provider lists keep on-demand operations
  // honest. All consumers (API/WebUI) share these services and repositories.
  const appSettings = deps.appSettings ?? new AppSettings(deps.db.db, deps.writeGuard);
  const candleRepo = deps.candleRepo ?? new CandleRepository(deps.db.db, deps.db.sqlite, deps.writeGuard);
  const snapshotRepo = deps.snapshotRepo ?? new SnapshotRepository(deps.db.db, deps.db.sqlite, deps.writeGuard);
  const historicalService = deps.historicalService ?? new HistoricalCandleService({
    candles: candleRepo, settings: appSettings, providers: []
  });
  const snapshotService = deps.snapshotService ?? new OptionChainSnapshotService({
    snapshots: snapshotRepo, settings: appSettings, providers: []
  });
  // M6-C: construct the activity repository once, before any route that needs
  // it, so default composition and injected composition share the same instance.
  const activityRepo = deps.activityRepo ?? new McpActivityRepository(deps.db.db, deps.db.sqlite, deps.writeGuard);
  registerHistoricalRoutes(app, {
    service: historicalService, candles: candleRepo, snapshots: snapshotRepo, settings: appSettings,
    activities: activityRepo, writeGuard: deps.writeGuard
  });
  registerSnapshotRoutes(app, { service: snapshotService, snapshots: snapshotRepo, writeGuard: deps.writeGuard });

  // M6-C: durable activity history. Write routes are local-owner-only, reads
  // follow the LAN model. Same repository instance as retention cleanup.
  registerMcpActivityRoutes(app, { activities: activityRepo, writeGuard: deps.writeGuard });

  // Phase 2: read-only operation discovery for the Activity selector. Sourced
  // from the same registration-owned descriptors used by the MCP registrations.
  registerMcpOperationsRoutes(app);

  if (deps.service && deps.hub && (deps.supervisor || deps.coordinator)) {
    registerMarketRoutes(app, {
      service: deps.service,
      hub: deps.hub,
      supervisor: deps.supervisor,
      coordinator: deps.coordinator,
      writeGuard: deps.writeGuard
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
