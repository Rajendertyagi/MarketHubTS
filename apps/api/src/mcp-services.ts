import type { AppConfig } from "@markethub/config";
import { checkDatabase, type DatabaseHandle } from "@markethub/database";
import { healthStatusSchema, providerStatusMapSchema } from "@markethub/contracts";
import { nowIso } from "@markethub/shared";
import type { McpServices } from "@markethub/mcp-core";
import type {
  CatalogRepository, MarketDataService, HistoricalCandleService, OptionChainSnapshotService
} from "@markethub/market-core";
import type { LiveEventHub } from "@markethub/realtime";
import { composeProviderStatuses } from "./provider-routes";

/**
 * Build the HTTP-backed MCP services from the existing injected state.
 * Extracted from the application entry point so it can be tested without
 * importing a module that executes main(). All dependencies are injected —
 * no new state, database, provider or application instance is created here.
 */
export function createHttpMcpServices(
  config: AppConfig,
  db: DatabaseHandle,
  catalog: CatalogRepository,
  hub: LiveEventHub,
  registry: import("@markethub/market-core").ProviderRegistry,
  service: MarketDataService,
  historicalService: HistoricalCandleService,
  snapshotService: OptionChainSnapshotService
): McpServices {
  return {
    getHealth: async () => {
      const parsed = healthStatusSchema.safeParse({
        status: "ok",
        service: "markethub-api",
        timestamp: nowIso(),
        version: config.version,
        checks: { api: "ok", database: checkDatabase(db.sqlite) === "ok" ? "ok" : "error" }
      });
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: { category: "internal", message: "Failed to build health status" } };
    },
    searchCatalog: async (req) => {
      const text = req.text.trim();
      if (!text) {
        return { ok: false, error: { category: "validation", message: "text must be non-empty" } };
      }
      const limit = Math.max(1, Math.min(Math.trunc(req.limit), 100));
      const rows = await catalog.searchInstruments({
        text,
        limit,
        ...(req.afterCanonicalId !== undefined ? { afterCanonicalId: req.afterCanonicalId } : {})
      });
      const page = rows.slice(0, limit);
      const nextCursor = rows.length > limit && page.length > 0 ? page[page.length - 1]!.canonicalId : null;
      return { ok: true, value: { instruments: page, nextCursor } };
    },
    readEventFeed: async (req) => {
      const result = hub.readAfter(req.after, req.limit);
      if (result.outcome === "snapshot-required") {
        return {
          ok: true,
          value: { events: [], nextCursor: null, snapshotRequired: { reason: result.reason } }
        };
      }
      return { ok: true, value: { events: result.events, nextCursor: result.nextCursor, resumeCursor: result.resumeCursor } };
    },
    getProviderStatus: async () => {
      const composed = composeProviderStatuses({ providerRegistry: registry, service });
      if (!composed) return { ok: false, error: { category: "unavailable", message: "Provider registry unavailable" } };
      const parsed = providerStatusMapSchema.safeParse(composed);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: { category: "internal", message: "Invalid provider status" } };
    },
    getLiveSnapshot: async () => ({ ok: true, value: service.getSnapshot() }),
    getCachedCandles: async (req) => ({ ok: true, value: { candles: historicalService.getCached(req) } }),
    getCoverage: async (req) => ({ ok: true, value: historicalService.getCoverageStatus(req) }),
    fetchHistorical: async (req) => ({ ok: true, value: await historicalService.fetchOnDemand(req) }),
    listSnapshots: async (filter) => ({ ok: true, value: { snapshots: snapshotService.listSnapshots(filter.configId, filter.fromMs, filter.toMs) } }),
    listSnapshotsPage: async (req) => {
      const result = snapshotService.listSnapshotsPage(req);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            category: result.reason === "unknown_config" ? "unavailable" : "validation",
            message: result.message,
            ...(result.reason === "unknown_config" ? { reason: "unknown_config" as const } : {})
          }
        };
      }
      return { ok: true, value: { snapshots: result.snapshots, nextCursor: result.nextCursor } };
    },
    getSnapshot: async (id) => {
      const snapshot = snapshotService.getSnapshot(id);
      return snapshot
        ? { ok: true, value: snapshot }
        : { ok: false, error: { category: "unavailable", message: "Snapshot not found" } };
    },
    captureSnapshot: async (req) => ({ ok: true, value: await snapshotService.captureOnDemand(req) })
  };
}
