import type { AppConfig } from "@markethub/config";
import { checkDatabase, type DatabaseHandle, type McpActivityRepository } from "@markethub/database";
import { healthStatusSchema, providerStatusMapSchema } from "@markethub/contracts";
import { nowIso } from "@markethub/shared";
import type { McpServices } from "@markethub/mcp-core";
import type {
  CatalogRepository, MarketDataService, HistoricalCandleService, OptionChainSnapshotService
} from "@markethub/market-core";
import type { LiveEventHub } from "@markethub/realtime";
import { composeProviderStatuses } from "./provider-routes";
import {
  CATALOG_WRITE_BUSY, CatalogWriteBusyError, writeBusyResponse, type ApiWriteGuard
} from "./catalog-write-coordinator";

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
  snapshotService: OptionChainSnapshotService,
  activityRepo: McpActivityRepository,
  onActivityError?: (error: unknown) => void,
  writeGuard?: ApiWriteGuard
): McpServices {
  /** G0-C §8.2: MCP tools report a retryable unavailable error, never success. */
  const busy = () => ({ ok: false as const, error: { category: "unavailable" as const, message: CATALOG_WRITE_BUSY } });
  return {
    ...(onActivityError ? { onActivityError } : {}),
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
    fetchHistorical: async (req) => {
      // G0 integration fix #5: hold ONE active write scope for the whole
      // operation. A preflight-only check let a refresh acquire OWNED while the
      // provider call was awaited, splitting the operation and turning its
      // writes into a provider-unavailable result. `withScope` admits the scope
      // only while the permit is IDLE/RESERVED and the grant drain waits for it.
      if (!writeGuard) return { ok: true, value: await historicalService.fetchOnDemand(req) };
      try {
        return {
          ok: true,
          value: await writeGuard.withScope("I", () => historicalService.fetchOnDemand(req))
        };
      } catch (error) {
        if (error instanceof CatalogWriteBusyError) return busy();
        throw error;
      }
    },
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
    captureSnapshot: async (req) => {
      // G0 integration fix #5: same full-operation write scope as fetchHistorical.
      if (!writeGuard) return { ok: true, value: await snapshotService.captureOnDemand(req) };
      try {
        return {
          ok: true,
          value: await writeGuard.withScope("I", () => snapshotService.captureOnDemand(req))
        };
      } catch (error) {
        if (error instanceof CatalogWriteBusyError) return busy();
        throw error;
      }
    },
    startActivity: async (req) => {
      if (writeBusyResponse(writeGuard) !== null) return busy(); // G0-C #27
      const result = activityRepo.start(req);
      return result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: { category: "internal", message: result.message } };
    },
    completeActivity: async (req) => {
      if (writeBusyResponse(writeGuard) !== null) return busy(); // G0-C #28
      const result = activityRepo.complete(req);
      if (result.ok) return { ok: true, value: result.value };
      return {
        ok: false,
        error: {
          category: result.reason === "not_found" ? "unavailable" : "validation",
          message: result.message
        }
      };
    }
  };
}
