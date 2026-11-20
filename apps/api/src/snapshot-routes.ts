import type { Hono } from "hono";
import {
  apiErrorSchema,
  optionChainCaptureConfigSchema,
  optionChainCaptureRequestSchema,
  optionChainSnapshotSchema
} from "@markethub/contracts";
import type { OptionChainSnapshotService, OptionChainRequest } from "@markethub/market-core";
import type { SnapshotPageSelector } from "@markethub/contracts";
import type { SnapshotRepository } from "@markethub/database";
import { isLocalPeer } from "./lib/net";

export interface SnapshotRouteDependencies {
  service: OptionChainSnapshotService;
  snapshots: SnapshotRepository;
}

function parseOptionalMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Stored snapshot retrieval, capture config CRUD and manual capture. No market logic here. */
export function registerSnapshotRoutes(app: Hono, deps: SnapshotRouteDependencies): void {
  // Stored snapshots — read-only, safe for LAN clients.
  app.get("/api/snapshots", (c) => {
    const configId = c.req.query("configId");
    const fromMs = parseOptionalMs(c.req.query("from"));
    const toMs = parseOptionalMs(c.req.query("to"));
    const snapshots = deps.service.listSnapshots(configId, fromMs, toMs).map((s) => optionChainSnapshotSchema.parse(s));
    return c.json({ snapshots });
  });

  // --- Capture config CRUD (WebUI-owned, local-owner only) ---
  app.get("/api/snapshots/configs", (c) => {
    return c.json({ configs: deps.service.listCaptureConfigs().map((config) => optionChainCaptureConfigSchema.parse(config)) });
  });

  app.post("/api/snapshots/configs", async (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Configuration is local-owner only" }), 403);
    }
    const parsed = optionChainCaptureConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "Invalid capture config" }), 400);
    deps.service.putCaptureConfig(parsed.data);
    return c.json({ config: optionChainCaptureConfigSchema.parse(deps.service.getCaptureConfig(parsed.data.id)!) });
  });

  app.delete("/api/snapshots/configs/:id", (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Configuration is local-owner only" }), 403);
    }
    deps.service.deleteCaptureConfig(c.req.param("id")); // snapshots retained (config_id nulled)
    return c.json({ ok: true });
  });

  // Manual on-demand capture. In M5 no live providers are wired (Phase 4B/Stage
  // G), so this honestly reports no provider rather than fabricating a chain.
  // It never reads or mutates saved capture config.
  app.post("/api/snapshots/capture", async (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Manual capture is local-owner only" }), 403);
    }
    const parsed = optionChainCaptureRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "Invalid capture request" }), 400);
    }
    const body = parsed.data;
    const request: OptionChainRequest = {
      underlyingCanonicalId: body.underlyingCanonicalId,
      expiryDate: body.expiryDate,
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.strikeRangeJson !== undefined ? { strikeRangeJson: body.strikeRangeJson } : {}),
      ...(body.nativeIdentifier ? { nativeIdentifier: body.nativeIdentifier } : {})
    };
    const result = await deps.service.captureOnDemand(request);
    if (!result.snapshot) {
      return c.json(apiErrorSchema.parse({ error: "capture_unavailable", message: result.error ?? "Capture unavailable" }), 422);
    }
    return c.json({ snapshot: optionChainSnapshotSchema.parse(result.snapshot) });
  });

  // B3: newest-first bounded page with an explicit discriminated selector.
  // Static /page MUST precede the dynamic /:id route. No magic string: a real
  // config id of "none" is addressed via scope=config&configId=none.
  app.get("/api/snapshots/page", (c) => {
    const scope = c.req.query("scope");
    const configId = c.req.query("configId");
    const limitRaw = c.req.query("limit");
    const cursor = c.req.query("cursor");

    let selector: SnapshotPageSelector;
    if (scope === "config") {
      if (configId === undefined || configId.length === 0) {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "scope=config requires a non-empty configId" }), 400);
      }
      selector = { kind: "config", configId };
    } else if (scope === "null-config") {
      if (configId !== undefined) {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "scope=null-config must not include configId" }), 400);
      }
      selector = { kind: "null-config" };
    } else {
      return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "scope must be 'config' or 'null-config'" }), 400);
    }

    const limit = limitRaw === undefined ? 25 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "limit must be an integer between 1 and 100" }), 400);
    }

    const result = deps.service.listSnapshotsPage({
      selector, limit, ...(cursor !== undefined ? { cursor } : {})
    });
    if (!result.ok) {
      if (result.reason === "unknown_config") {
        return c.json(apiErrorSchema.parse({ error: "not_found", message: result.message }), 404);
      }
      return c.json(apiErrorSchema.parse({ error: "invalid_request", message: result.message }), 400);
    }
    return c.json({
      snapshots: result.snapshots.map((s) => optionChainSnapshotSchema.parse(s)),
      nextCursor: result.nextCursor
    });
  });

  // Dynamic :id route MUST be registered after all static /api/snapshots/*
  // routes — Hono matches in registration order, so an earlier :id would
  // shadow /api/snapshots/configs, /api/snapshots/capture and /api/snapshots/page.
  app.get("/api/snapshots/:id", (c) => {
    const snapshot = deps.service.getSnapshot(c.req.param("id"));
    if (!snapshot) return c.json(apiErrorSchema.parse({ error: "not_found", message: "Snapshot not found" }), 404);
    return c.json({ snapshot: optionChainSnapshotSchema.parse(snapshot) });
  });
}
