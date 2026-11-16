import type { Hono } from "hono";
import { apiErrorSchema, type CredentialStore, type ProviderConfig, type ProviderId, type ProviderSettings } from "@markethub/contracts";
import type { ProviderRegistry } from "@markethub/market-core";
import type { UpstoxAdapter } from "@markethub/broker-upstox";
import type { FyersAdapter } from "@markethub/broker-fyers";
import { isLocalPeer } from "./lib/net";

export interface ProviderRouteDependencies {
  providerRegistry?: ProviderRegistry;
  credentials?: CredentialStore;
  settings?: ProviderSettings;
  providerConfig?: ProviderConfig;
  upstox?: UpstoxAdapter;
  fyers?: FyersAdapter;
}

/** Registers provider routes on the existing app. No separate listener or security framework. */
export function registerProviderRoutes(app: Hono, deps: ProviderRouteDependencies): void {  // Read-only provider diagnostics. Safe for LAN clients; never includes credentials.
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
      try {
        await deps.fyers!.setConfig(body.appId, body.redirectUri);
        return c.json({ ok: true });
      } catch (error) {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: error instanceof Error ? error.message : String(error) }), 400);
      }
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


}
