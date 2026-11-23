import type { Hono } from "hono";
import {
  apiErrorSchema,
  candleGapSchema,
  candleRangeNoteSchema,
  candleRangeRequestSchema,
  historicalCandleSchema,
  historicalSyncConfigSchema,
  retentionCleanupResultSchema,
  retentionSettingsSchema,
  retentionSettingsViewSchema,
  type CandleRangeRequest,
  type RetentionCleanupResult as RetentionCleanupResultContract
} from "@markethub/contracts";
import type { HistoricalCandleService } from "@markethub/market-core";
import type { AppSettings, CandleRepository, SnapshotRepository, McpActivityRepository } from "@markethub/database";
import { isLocalPeer } from "./lib/net";

export interface HistoricalRouteDependencies {
  service: HistoricalCandleService;
  candles: CandleRepository;
  snapshots: SnapshotRepository;
  settings: AppSettings;
  activities?: McpActivityRepository;
}

/** Kept as a public alias so existing consumers do not break; the shape is contract-owned. */
export type RetentionCleanupResult = RetentionCleanupResultContract;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Operational retention cleanup. Fails closed: a missing, malformed or
 * schema-invalid setting disables all cleanup and deletes nothing. No default
 * duration is substituted. Bounded and FK-safe via the repository methods.
 */
export function applyRetentionCleanup(
  settings: AppSettings,
  candles: CandleRepository,
  snapshots: SnapshotRepository,
  activities: McpActivityRepository | undefined,
  now: () => number = () => Date.now()
): RetentionCleanupResult {
  const read = settings.getRetention();
  if (!read.valid || !read.settings) {
    return { ran: false, reason: read.error ?? "retention settings unavailable", candlesDeleted: 0, snapshotsDeleted: 0, activitiesDeleted: 0 };
  }
  const current = now();
  const candleDays = read.settings.classes.CANDLE?.maxAgeDays;
  const snapshotDays = read.settings.classes.SNAPSHOT?.maxAgeDays;
  const activityDays = read.settings.classes.ACTIVITY?.maxAgeDays;
  return {
    ran: true,
    reason: null,
    candlesDeleted: candleDays !== undefined ? candles.cleanupCandles(current - candleDays * DAY_MS) : 0,
    snapshotsDeleted: snapshotDays !== undefined ? snapshots.cleanupSnapshots(current - snapshotDays * DAY_MS) : 0,
    activitiesDeleted: activityDays !== undefined && activities ? activities.cleanupActivities(current - activityDays * DAY_MS) : 0
  };
}

function parseRange(c: { req: { query: (key: string) => string | undefined } }): CandleRangeRequest | null {
  const canonicalId = c.req.query("canonicalId");
  const interval = c.req.query("interval");
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  if (!canonicalId || !interval || !fromRaw || !toRaw) return null;
  const fromMs = Number(fromRaw), toMs = Number(toRaw);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return null;
  const parsed = candleRangeRequestSchema.safeParse({ canonicalId, interval, fromMs, toMs });
  return parsed.success ? parsed.data as CandleRangeRequest : null;
}

/** Cached historical reads, sync config CRUD and validated retention. No market logic here. */
export function registerHistoricalRoutes(app: Hono, deps: HistoricalRouteDependencies): void {
  // Cached candles — read-only, safe for LAN clients.
  app.get("/api/historical/candles", (c) => {
    const request = parseRange(c);
    if (!request) return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "canonicalId, interval, from and to are required" }), 400);
    const candles = deps.service.getCached(request).map((candle) => historicalCandleSchema.parse(candle));
    return c.json({ candles });
  });

  // Coverage/status — derived from stored timestamps, never a fabricated claim.
  app.get("/api/historical/coverage", (c) => {
    const request = parseRange(c);
    if (!request) return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "canonicalId, interval, from and to are required" }), 400);
    const status = deps.service.getCoverageStatus(request);
    const gaps = status.gaps.map((gap) => candleGapSchema.parse(gap));
    const unavailableNotes = status.unavailableNotes.map((note) => candleRangeNoteSchema.parse(note));
    return c.json({ gaps, basis: gaps[0]?.basis ?? null, confirmed: false, unavailableNotes });
  });

  // On-demand fetch. In M5 no live providers are wired (Phase 4B/Stage G), so
  // this honestly reports no data rather than fabricating candles. It never
  // reads or mutates saved sync config.
  app.post("/api/historical/fetch", async (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "On-demand fetch is local-owner only" }), 403);
    }
    const parsed = candleRangeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "Invalid range request" }), 400);
    const result = await deps.service.fetchOnDemand(parsed.data as CandleRangeRequest);
    return c.json({
      candles: result.candles.map((candle) => historicalCandleSchema.parse(candle)),
      gaps: result.gaps.map((gap) => candleGapSchema.parse(gap)),
      unavailable: result.unavailable,
      conflicts: result.conflicts,
      providersTried: result.providersTried
    });
  });

  // --- Sync config CRUD (WebUI-owned, local-owner only) ---
  app.get("/api/historical/sync-configs", (c) => {
    return c.json({ configs: deps.candles.listSyncConfigs().map((config) => historicalSyncConfigSchema.parse(config)) });
  });

  app.post("/api/historical/sync-configs", async (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Configuration is local-owner only" }), 403);
    }
    const parsed = historicalSyncConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "Invalid sync config" }), 400);
    const stored = deps.candles.putSyncConfig(parsed.data);
    return c.json({ config: historicalSyncConfigSchema.parse(stored) });
  });

  app.delete("/api/historical/sync-configs/:id", (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Configuration is local-owner only" }), 403);
    }
    deps.candles.deleteSyncConfig(c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- Retention (validated app_meta, covers both CANDLE and SNAPSHOT classes) ---
  app.get("/api/retention", (c) => {
    const read = deps.settings.getRetention();
    return c.json(retentionSettingsViewSchema.parse({ settings: read.settings, valid: read.valid, error: read.error }));
  });

  app.put("/api/retention", async (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Retention configuration is local-owner only" }), 403);
    }
    const parsed = retentionSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "Invalid retention settings" }), 400);
    deps.settings.setRetention(parsed.data);
    return c.json(retentionSettingsViewSchema.parse({ settings: parsed.data, valid: true, error: null }));
  });

  app.post("/api/retention/cleanup", (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Retention cleanup is local-owner only" }), 403);
    }
    return c.json(retentionCleanupResultSchema.parse(applyRetentionCleanup(deps.settings, deps.candles, deps.snapshots, deps.activities)));
  });
}
