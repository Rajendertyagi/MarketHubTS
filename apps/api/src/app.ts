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
import type { CredentialStore, ProviderConfig, ProviderId } from "@markethub/contracts";
import type { ProviderRegistry } from "@markethub/market-core";
import type { UpstoxAdapter } from "@markethub/broker-upstox";
import type { FyersAdapter } from "@markethub/broker-fyers";
import type { Logger } from "./lib/logger";

export interface AppDependencies {
  config: AppConfig;
  db: DatabaseHandle;
  logger: Logger;
  startedAt: number;
  webDistDir?: string;
  providerRegistry?: ProviderRegistry;
  credentials?: CredentialStore;
  providerConfig?: ProviderConfig;
  upstox?: UpstoxAdapter;
  fyers?: FyersAdapter;
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
  const parts = h.split(".").map(Number);
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

/** Simple local-owner check for credential-changing routes. No app-level login. */
function isLocalPeer(request: Request, env: unknown): boolean {
  const server = env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  const ip = server?.requestIP?.(request);
  if (!ip) return false;
  const address = ip.address.toLowerCase();
  if (address === "::1" || address === "localhost") return true;
  if (address.startsWith("::ffff:")) return isLocalPeer(request, { requestIP: () => ({ address: address.slice(7) }) });
  return isLoopbackHost(address);
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

  // Read-only provider diagnostics. Safe for LAN clients; never includes credentials.
  app.get("/api/providers/status", (c) => {
    return c.json({
      providers: deps.providerRegistry?.getStatuses() ?? null,
      localManagement: true,
      note: "Credential management and authentication must be performed locally on the application host."
    });
  });

  // Credential-changing routes are local-owner only (single simple peer check).
  app.use("/api/provider/*", async (c, next) => {
    if (c.req.method === "GET" && c.req.path.endsWith("/callback")) {
      // FYERS callback: loopback-only, validated below.
    }
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Provider management is local-owner only" }), 403);
    }
    await next();
  });
  app.use("/api/credentials/*", async (c, next) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Credential management is local-owner only" }), 403);
    }
    await next();
  });

  if (deps.upstox && deps.credentials) {
    app.post("/api/provider/upstox/token", async (c) => {
      const body = await c.req.json().catch(() => ({})) as any;
      if (typeof body?.token !== "string" || !body.token.trim()) {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "A non-empty token is required" }), 400);
      }
      try {
        return c.json(await deps.upstox!.setToken(body.token, typeof body.expiresAt === "string" ? body.expiresAt : undefined));
      } catch (error) {
        return c.json(apiErrorSchema.parse({ error: "credential_error", message: error instanceof Error ? error.message : String(error) }), 400);
      }
    });
  }

  if (deps.fyers && deps.providerConfig) {
    app.post("/api/provider/fyers/config", async (c) => {
      const body = await c.req.json().catch(() => ({})) as any;
      if (typeof body?.appId !== "string" || typeof body?.redirectUri !== "string") {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "appId and redirectUri are required" }), 400);
      }
      deps.providerConfig!.fyersAppId = body.appId.trim();
      deps.providerConfig!.fyersRedirectUri = body.redirectUri.trim();
      return c.json({ ok: true });
    });

    app.post("/api/provider/fyers/app-secret", async (c) => {
      const body = await c.req.json().catch(() => ({})) as any;
      if (typeof body?.appSecret !== "string" || !body.appSecret.trim()) {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "A non-empty appSecret is required" }), 400);
      }
      try {
        await deps.fyers!.setAppSecret(body.appSecret);
        return c.json({ ok: true });
      } catch (error) {
        return c.json(apiErrorSchema.parse({ error: "credential_error", message: error instanceof Error ? error.message : String(error) }), 400);
      }
    });

    app.post("/api/provider/fyers/auth/start", async (c) => {
      try {
        const result = await deps.fyers!.startAuth();
        return c.json({ authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt });
      } catch (error) {
        return c.json(apiErrorSchema.parse({ error: "auth_error", message: error instanceof Error ? error.message : String(error) }), 400);
      }
    });

    app.get("/api/provider/fyers/callback", async (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const error = c.req.query("error");
      const status = await deps.fyers!.completeAuth({
        ...(code ? { code } : {}),
        ...(state ? { state } : {}),
        ...(error ? { error } : {})
      });
      const ok = status.authState === "AUTHENTICATED";
      return c.html(`<!doctype html><title>MarketHubTS</title><p>${ok ? "FYERS authentication completed. You can close this window." : "FYERS authentication failed. Review provider status in the app."}</p>`);
    });
  }

  if (deps.providerRegistry) {
    app.post("/api/provider/:id/validate", async (c) => {
      const id = c.req.param("id") as ProviderId;
      if (id !== "UPSTOX" && id !== "FYERS") {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "Unknown provider" }), 400);
      }
      return c.json(await deps.providerRegistry!.validate(id));
    });

    app.post("/api/provider/:id/remove", async (c) => {
      const id = c.req.param("id") as ProviderId;
      if (id !== "UPSTOX" && id !== "FYERS") {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "Unknown provider" }), 400);
      }
      const body = await c.req.json().catch(() => ({})) as any;
      if (body?.confirm !== true) {
        return c.json(apiErrorSchema.parse({ error: "confirmation_required", message: "Set confirm=true" }), 400);
      }
      await deps.providerRegistry!.remove(id);
      return c.json(deps.providerRegistry!.getStatuses());
    });
  }

  if (deps.credentials) {
    app.post("/api/credentials/reset", async (c) => {
      const body = await c.req.json().catch(() => ({})) as any;
      if (body?.confirm !== true) {
        return c.json(apiErrorSchema.parse({ error: "confirmation_required", message: "Set confirm=true" }), 400);
      }
      await deps.credentials!.reset();
      return c.json({ ok: true, message: "Credential store reset; re-authentication required" });
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
