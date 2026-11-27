import { resolve } from "node:path";
import { loadConfig, providerConfigFromAppConfig, redactConfigForLog } from "@markethub/config";
import {
  openDatabase, runMigrations, defaultMigrationsFolder, SqliteCredentialStore, SqliteProviderSettings,
  SqliteSubscriptionRepository, SqliteCatalogRepository, AppSettings, CandleRepository, SnapshotRepository,
  McpActivityRepository, type DatabaseHandle
} from "@markethub/database";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer } from "@markethub/mcp-core";
import { MarketDataService, ProviderRegistry, HistoricalCandleService, OptionChainSnapshotService, CatalogSyncService, CatalogMasterRefresh } from "@markethub/market-core";
import { LiveEventHub } from "@markethub/realtime";
import { UpstoxAdapter } from "@markethub/broker-upstox";
import { FyersAdapter } from "@markethub/broker-fyers";
import { createApp } from "./app";
import { createHttpMcpServices } from "./mcp-services";
import { createMcpNotificationBridge, type McpNotificationBridge } from "./mcp-notification-bridge";
import { wrapMcpHandlerFetch, MCP_SSE_MAX_BUFFERED_BYTES, MCP_SSE_MAX_BUFFERED_FRAMES } from "./mcp-sse-bound";
import { createLogger } from "./lib/logger";
import { LockedProviderDriver, StreamSupervisor } from "./stream-supervisor";
import { SubscriptionCoordinator } from "./subscription-coordinator";
import {
  CatalogRefreshChildManager, type ManagerEvent, type ManagerOwnershipHooks
} from "./catalog-refresh-child-manager";
import { CatalogWriteOwnership, type OwnerPhase, type RecoveryDecision } from "./catalog-write-ownership";
import { CatalogWriteCoordinator } from "./catalog-write-coordinator";

type RunningServer = ReturnType<typeof Bun.serve>;

/**
 * Disable Bun's per-request idle timeout for SSE responses only.
 *
 * Bun's default `idleTimeout` (10 s) applies while a response is being
 * streamed, which would close a quiet `subscriptions/listen` stream before the
 * 15 s MCP keepalive fires. `server.timeout(req, 0)` disables the idle timeout
 * for that one request; the global server timeout is left unchanged. The
 * content-type check is applied to the RESPONSE returned by the handler, so
 * JSON responses keep the normal timeout. Wrapping at the `Bun.serve` seam is
 * correct because Hono's `app.fetch` does not forward the Bun server to routes.
 *
 * Exported for a focused unit test (spy server) and a real-listener test; the
 * module only starts the application when it is the entry point.
 */
export function withSseIdleTimeout(
  fetchHandler: (request: Request, server: RunningServer) => Response | Promise<Response>
): (request: Request, server: RunningServer) => Promise<Response> {
  return async (request, bunServer) => {
    const response = await fetchHandler(request, bunServer);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("text/event-stream")) {
      bunServer.timeout(request, 0);
    }
    return response;
  };
}

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let server: RunningServer | null = null;
let db: DatabaseHandle | null = null;
let hub: LiveEventHub | null = null;
let coordinator: SubscriptionCoordinator | null = null;
let mcpHandler: ReturnType<typeof createMcpHandler> | null = null;
let notificationBridge: McpNotificationBridge | null = null;
let catalogRefresh: CatalogMasterRefresh | null = null;
// G0-A: constructed after the database is ready; no child is spawned until a
// refresh request is made. Drained before the parent DB is closed on shutdown.
let childManager: CatalogRefreshChildManager | null = null;
// G0-D: single parent-owned write permit + durable generation token. Constructed
// after migrations so startup recovery can read the existing token.
let ownership: CatalogWriteOwnership | null = null;
// G0-C: API-owned write coordinator. Reads the authoritative permit state from
// G0-D ownership and owns active write scopes + the stop-admit drain.
let writeCoordinator: CatalogWriteCoordinator | null = null;

/**
 * WP3 listener-first seam. The HTTP listener is already bound when this runs;
 * scheduling refresh here (never during `createApp`) keeps startup independent
 * of remote downloads. Exported so a real-listener G0 test exercises the exact
 * production ordering. Synchronous errors are surfaced through `onError`; the
 * refresh tasks themselves are fire-and-forget with internal error handling.
 */
export function startRefreshAfterListening(
  refresh: CatalogMasterRefresh | undefined,
  onError: (error: unknown) => void
): void {
  if (!refresh) return;
  try {
    refresh.startIfNeeded();
  } catch (error) {
    onError(error);
  }
}

/**
 * Production composition-root wiring between the child manager and the durable
 * write permit. Extracted so focused tests exercise the EXACT callbacks used
 * in production (not a re-implementation in the test harness).
 *
 *  - `onManagerEvent` mirrors validated child phases into the durable token.
 *    `CatalogWriteOwnership.updatePhase` suppresses the SQLite write once the
 *    permit is OWNED, so a `TXN` progress message arriving while the child holds
 *    `BEGIN IMMEDIATE` cannot block the parent event loop (G0 fix #2).
 *  - `onSettled` respects an UNKNOWN permit left by unexpected-exit recovery:
 *    a RETRY decision retains the token and refuses new reservations until a
 *    later recovery succeeds (G0 fix #3).
 *  - An UNOBSERVED exit (`exitObserved === false`) is fail-closed in both hooks:
 *    the permit stays UNKNOWN and the durable token is retained, so no second
 *    writer can be reserved/granted while the old child may still be alive.
 */
export interface CatalogOwnershipWiring {
  onManagerEvent: (event: ManagerEvent) => void;
  ownershipHooks: ManagerOwnershipHooks;
}

export function createCatalogOwnershipWiring(
  ownership: CatalogWriteOwnership,
  onRecovery?: (info: {
    runId: string;
    exit: { code: number | null; signal: string | number | null };
    decision: RecoveryDecision;
  }) => void
): CatalogOwnershipWiring {
  return {
    onManagerEvent: (event) => {
      if (event.type === "phase") ownership.updatePhase(event.phase as OwnerPhase);
    },
    ownershipHooks: {
      requestGrant: async () => {
        const decision = await ownership.grant();
        return decision.granted
          ? { granted: true, generation: decision.generation }
          : { granted: false, reason: decision.reason };
      },
      onSettled: ({ ok, terminal, exitObserved }) => {
        // Unobserved exit (kill could not be confirmed): the child may still be
        // alive. Keep the permit UNKNOWN and retain the durable token. Never
        // release here — a successful writer probe is NOT authorization while
        // the old process may still hold the write lock. This guard is
        // authoritative even if onUnexpectedExit was not wired.
        if (exitObserved === false) {
          ownership.markUnknown();
          return;
        }
        if (terminal?.type === "result" && terminal.status === "FENCED") {
          ownership.updatePhase("FENCED");
        } else if (ok && terminal?.type === "result" && terminal.status === "COMPLETED") {
          ownership.updatePhase("SETTLED");
        }
        // G0 fix #3: an unexpected exit may have left the permit UNKNOWN with a
        // retained token (e.g. recover() returned RETRY because a writer may
        // still be active). Settlement must NOT discard that token — doing so
        // erases the evidence needed for the next recovery and would admit a
        // second writer. Only release when the permit is not UNKNOWN.
        if (ownership.currentState !== "UNKNOWN") ownership.release();
      },
      onUnexpectedExit: ({ runId, exit, exitObserved }) => {
        ownership.markUnknown();
        if (exitObserved === false) {
          // Do NOT run recover(): its RESUME path transitions to IDLE on a
          // successful writer probe, which would admit a second child while
          // the old one may still be alive. Surface a non-authorizing
          // diagnostic instead; the permit stays UNKNOWN with its token.
          onRecovery?.({
            runId,
            exit,
            decision: {
              decision: "REFUSED",
              generation: ownership.currentGeneration,
              reason: "child exit unobserved after kill escalation"
            }
          });
          return;
        }
        const decision = ownership.recover();
        onRecovery?.({ runId, exit, decision });
      }
    }
  };
}

/**
 * Ownership-release step shared by BOTH shutdown cleanup paths
 * (`drainStartupFailure` and `shutdown`). Exported so the regression test can
 * exercise the exact production step rather than a re-implementation.
 *
 * An UNKNOWN permit (unobserved child exit or unresolved recovery) is NOT safe
 * to release: the durable token must survive shutdown so the next process can
 * verify the prior run before admitting a writer. `releaseIfSafe()` enforces
 * that; ordinary clean shutdown is unchanged.
 */
export function releaseOwnershipForShutdown(
  ownership: CatalogWriteOwnership | undefined | null
): { released: boolean; skippedUnknown: boolean } {
  if (!ownership) return { released: false, skippedUnknown: false };
  const result = ownership.releaseIfSafe();
  return { released: result.released, skippedUnknown: !result.released && result.reason === "UNKNOWN" };
}

/**
 * WP3-A item 10: partial-initialization failure runs the same drain sequence
 * as graceful shutdown before any resource is closed. Every step is best
 * effort and idempotent so repeated calls cannot double-close or throw.
 */
async function drainStartupFailure(): Promise<void> {
  try { if (catalogRefresh) await catalogRefresh.stopAndWait(); } catch {}
  try { if (childManager) await childManager.shutdown(); } catch {}
  // G0-D: release the write permit and clear the durable token only after the
  // child has settled and exited, never before (plan §6.4 steps 4–6). An UNKNOWN
  // permit is deliberately retained: its durable token is the evidence the next
  // process needs to verify the prior run (unobserved exit / unresolved recovery).
  try { releaseOwnershipForShutdown(ownership); } catch {}
  try { coordinator?.stop(); } catch {}
  try { if (mcpHandler) await mcpHandler.close(); } catch {}
  try { notificationBridge?.stop(); } catch {}
  try { hub?.stop(); } catch {}
  try { if (server) await server.stop(true); } catch {}
  try { db?.close(); } catch {}
}

// M6-D: deliberate handler bounds. maxSubscriptions is a conservative 64 (a
// single local owner with a handful of MCP clients, not a public service);
// tests/mcp/fanout.test.ts sweeps 8/32/64 subscribers and records p95 latency
// and heap delta; measurements and the 50 ms latency budget are preserved in
// docs/M6_D_FANOUT_EVIDENCE.md. These bound stream count and request size; the
// SDK does not impose a per-stream frame/byte cap (documented in the M6-D/E
// plan). No new settings framework is introduced.
const MCP_MAX_SUBSCRIPTIONS = 64;
const MCP_KEEP_ALIVE_MS = 15_000;
const MCP_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;


async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info("starting", { config: redactConfigForLog(config) });

  try {
    db = openDatabase({ dbPath: config.dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    logger.info("database_ready", { path: db.path });
    // G0-D: the durable ownership token and monotonic generation are read from
    // app_meta here (after migrations). Startup recovery runs before any child
    // is dispatched; see the conditional startRefreshAfterListening below.
    ownership = new CatalogWriteOwnership(db.sqlite, db.path, (event) => {
      logger.info("catalog_write_ownership", {
        from: event.from, to: event.to, generation: event.generation
      });
    });
    // G0-C: the coordinator reads the authoritative permit state from G0-D and
    // installs the real write-scope drain into the grant handshake. No new
    // state machine is introduced; `busy_timeout` stays at 5000 ms.
    writeCoordinator = new CatalogWriteCoordinator({
      getPermitState: () => ownership!.currentState,
      onEvent: (event) => logger.info("catalog_write_coordinator", { ...event })
    });
    ownership.setDrainHook(() => writeCoordinator!.drain());
    // G0-A/G0-B: the child manager is constructed here (after migrations) but
    // does not spawn anything until CatalogMasterRefresh schedules a provider
    // run. Pipeline mode runs the full refresh in the child; the parent keeps
    // scheduling, freshness and diagnostic recording. G0-D wires the ownership
    // hooks so the grant is drained and generation-fenced, never unconditional.
    const ownershipWiring = createCatalogOwnershipWiring(ownership!, ({ runId, exit, decision }) => {
      logger.warn("catalog_ownership_recovery", {
        runId, decision: decision.decision,
        code: exit.code, signal: exit.signal,
        ...("reason" in decision ? { reason: decision.reason } : {})
      });
    });
    childManager = new CatalogRefreshChildManager({
      dbPath: db.path,
      mode: "pipeline",
      childEntryPath: resolve(import.meta.dir, "catalog-refresh-child-pipeline.ts"),
      onEvent: ownershipWiring.onManagerEvent,
      ownershipHooks: ownershipWiring.ownershipHooks
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "database", message });
    try { db?.close(); } catch {}
    process.exitCode = 1;
    return;
  }

  // WP3-A item 10: any failure after partial initialization must drain the
  // refresh owner and all other resources before closing the database.
  try {
  const credentials = new SqliteCredentialStore(db, writeCoordinator ?? undefined);
  const settings = new SqliteProviderSettings(db, writeCoordinator ?? undefined);
  const providerConfig = providerConfigFromAppConfig(config);
  const registry = new ProviderRegistry();
  const upstox = new UpstoxAdapter({ credentials, settings, config: providerConfig });
  const fyers = new FyersAdapter({ credentials, settings, config: providerConfig });
  await Promise.all([upstox.initialize(), fyers.initialize()]);
  registry.register(upstox);
  registry.register(fyers);
  if (credentials.status().state === "UNAVAILABLE") {
    logger.warn("credentials_unavailable", { reason: credentials.status().reason ?? "unknown" });
  }

  // One canonical live-data service shared by REST, SSE and the supervisor.
  // No real market-session source exists yet; UNKNOWN is the conservative choice.
  const policy = config.livePolicy;
  const service = new MarketDataService({
    now: () => new Date(),
    policy: {
      openMaxAgeMs: policy.openMaxAgeMs,
      unknownMaxAgeMs: policy.unknownMaxAgeMs,
      maxRetainedObservationAgeMs: policy.maxRetainedObservationAgeMs
    },
    maxInstruments: policy.maxInstruments,
    session: () => "UNKNOWN" as const
  });

  hub = new LiveEventHub(service, {
    replayMaxEvents: policy.replayMaxEvents,
    replayMaxBytes: policy.replayMaxBytes,
    clientMaxEvents: policy.clientMaxEvents,
    clientMaxBytes: policy.clientMaxBytes,
    refreshIntervalMs: policy.refreshIntervalMs
  });
  hub.start();

  const catalog = new SqliteCatalogRepository(db.db, db.sqlite, writeCoordinator ?? undefined);
  // WP4A: one app-owned refresh owner for the public provider master files.
  // No credentials, no live market-data calls, no generic scheduler.
  catalogRefresh = new CatalogMasterRefresh({
    catalog,
    sync: new CatalogSyncService(catalog),
    now: () => new Date(),
    // G0-B: the parent generates the run ID and delegates the pipeline to the
    // serialized child. Cancellation is forwarded as a cooperative IPC message;
    // the child owns its AbortController. The structured terminal result is
    // mapped back to the shared pipeline outcome for parent-owned diagnostics.
    executor: async ({ provider, runId, nowIso, signal }) => {
      // G0-D: reserve the single write permit and bump the durable generation
      // BEFORE dispatch. A stale/unknown permit is a retryable failure, never a
      // second writer. The child validates this generation inside its txn.
      const reservation = ownership!.reserve({
        runId, provider, pid: process.pid, startedAt: nowIso
      });
      if (!reservation.ok) {
        return {
          status: "FAILED", counts: {}, cancelled: false, applyAttempted: false,
          error: `catalog write ownership unavailable: ${reservation.reason}`
        };
      }
      const onAbort = () => { void childManager?.cancel(runId, "shutdown"); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await childManager!.requestRefresh({
          runId, provider, nowIso, intentKey: "catalog-master-refresh", generation: reservation.generation
        });
        const terminal = result.terminal;
        if (terminal?.type === "result") {
          return {
            status: terminal.status,
            counts: terminal.counts,
            ...(terminal.sourceVersion ? { sourceVersion: terminal.sourceVersion } : {}),
            ...(terminal.conflicts ? { conflicts: terminal.conflicts } : {}),
            ...(terminal.error ? { error: terminal.error } : {}),
            cancelled: false,
            applyAttempted: true
          };
        }
        if (terminal?.type === "cancelled") {
          return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted: false };
        }
        return {
          status: "FAILED", counts: {}, cancelled: false, applyAttempted: false,
          error: result.error ?? "child produced no terminal result"
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    onEvent: (event) => {
      if (event.outcome === "FAILED") logger.warn("catalog_master_refresh_failed", { provider: event.provider, reason: event.reason ?? event.status ?? "unknown" });
      else logger.info("catalog_master_refresh", { provider: event.provider, outcome: event.outcome, status: event.status });
    }
  });
  const subscriptions = new SqliteSubscriptionRepository(db.db, db.sqlite, writeCoordinator ?? undefined);
  // AD-024 production boundary: one shared coordinator owns desired state; each
  // configured provider has an independent runtime with its own locked driver.
  // No real SDK, socket or provider connection is ever constructed. Only a
  // separately authorized Stage G change may unlock a real driver.
  const runtimeOptions = {
    service, subscriptions, catalog,
    coordinated: true,
    reconnect: { maxAttempts: policy.reconnectMaxAttempts, baseDelayMs: policy.reconnectBaseDelayMs }
  };
  const upstoxRuntime = new StreamSupervisor({
    ...runtimeOptions, provider: "UPSTOX", createDriver: () => new LockedProviderDriver("UPSTOX")
  });
  const fyersRuntime = new StreamSupervisor({
    ...runtimeOptions, provider: "FYERS", createDriver: () => new LockedProviderDriver("FYERS")
  });
  coordinator = new SubscriptionCoordinator({
    service, subscriptions, catalog,
    runtimes: [
      { provider: "UPSTOX", supervisor: upstoxRuntime },
      { provider: "FYERS", supervisor: fyersRuntime }
    ]
  });
  await upstoxRuntime.start();
  await fyersRuntime.start();
  await coordinator.start();

  // M6-B2: construct the M5 services once and share the same instances with
  // REST routes and the MCP adapter. No second app/DB/provider/service.
  const appSettings = new AppSettings(db.db, writeCoordinator ?? undefined);
  const candleRepo = new CandleRepository(db.db, db.sqlite, writeCoordinator ?? undefined);
  const snapshotRepo = new SnapshotRepository(db.db, db.sqlite, writeCoordinator ?? undefined);
  const activityRepo = new McpActivityRepository(db.db, db.sqlite, writeCoordinator ?? undefined);
  const historicalService = new HistoricalCandleService({
    candles: candleRepo, settings: appSettings, providers: [], writeGuard: writeCoordinator ?? undefined
  });
  const snapshotService = new OptionChainSnapshotService({
    snapshots: snapshotRepo, settings: appSettings, providers: [], writeGuard: writeCoordinator ?? undefined
  });

  // M6-A: one handler for the process lifetime; its factory builds a fresh
  // McpServer per request over the existing services. No second app/DB/provider.
  const runtimeDb = db;
  const runtimeHub = hub;
  const runtimeCatalog = catalog;
  const rawMcpHandler = createMcpHandler((ctx) =>
    createMcpServer(ctx, createHttpMcpServices(
      config, runtimeDb, runtimeCatalog, runtimeHub, registry, service, historicalService, snapshotService, activityRepo,
      (error) => logger.warn("mcp_activity_write_failed", {
        message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      }),
      writeCoordinator ?? undefined
    )),
    {
      maxSubscriptions: MCP_MAX_SUBSCRIPTIONS,
      keepAliveMs: MCP_KEEP_ALIVE_MS,
      maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
      onerror: (error) => logger.warn("mcp_handler_error", {
        message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      })
    }
  );

  // M6-D slow-consumer mitigation: wrap the handler's fetch so SSE listen
  // streams are bounded by an application-owned actively-drained buffer. The
  // wrapper preserves the full handler shape (close/notify/bus delegated), and
  // is applied BEFORE the bridge/app/shutdown capture the handler identity.
  // Bounds are measurement-derived (docs/M6_D_FANOUT_EVIDENCE.md §7).
  mcpHandler = wrapMcpHandlerFetch(rawMcpHandler, {
    maxBufferedBytes: MCP_SSE_MAX_BUFFERED_BYTES,
    maxBufferedFrames: MCP_SSE_MAX_BUFFERED_FRAMES,
    onOverflow: (info) => logger.warn("mcp_sse_slow_consumer_overflow", {
      reason: info.reason,
      bufferedBytes: info.bufferedBytes,
      bufferedFrames: info.bufferedFrames,
      maxBufferedBytes: info.maxBufferedBytes,
      maxBufferedFrames: info.maxBufferedFrames
    })
  });

  // M6-D: one process-lifetime bridge from the canonical live-change source to
  // the handler's notifier. Never created per request or per subscription.
  notificationBridge = createMcpNotificationBridge(
    service,
    mcpHandler.notify,
    (error) => logger.warn("mcp_notification_publish_failed", {
      message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    })
  );
  notificationBridge.start();

  const app = createApp({
    config, db, logger, startedAt: Date.now(),
    providerRegistry: registry, credentials, settings, providerConfig, upstox, fyers,
    service, hub, coordinator, mcpHandler, catalogRepo: catalog, catalogRefresh,
    appSettings, candleRepo, snapshotRepo, historicalService, snapshotService, activityRepo,
    writeGuard: writeCoordinator ?? undefined
  });

  try {
    // Per-request idle-timeout override for SSE only (global idleTimeout is
    // unchanged). See withSseIdleTimeout above.
    server = Bun.serve({ hostname: config.host, port: config.port, fetch: withSseIdleTimeout(app.fetch) });
    logger.info("listening", { host: config.host, port: server.port, lan: config.lan, env: config.env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "server", message });
    await drainStartupFailure();
    process.exitCode = 1;
    return;
  }

  // WP3 listener-first: the listener is bound, so remote refresh work can no
  // longer delay readiness. Errors are observable; no unhandled rejection.
  const startRefresh = () => startRefreshAfterListening(catalogRefresh ?? undefined, (error) => {
    logger.error("catalog_refresh_start_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  });

  // G0-D: verify any durable token left by a previous process BEFORE any child
  // is dispatched. A committed COMPLETED row is the sole positive proof of a
  // prior commit (do not re-apply); a live writer makes recovery retryable; a
  // successful probe only permits a fresh reserve with a bumped generation.
  //
  // The ambiguous RESUME case additionally performs a FAIL-CLOSED post-bump
  // verification with the EXACT parent-generated runId: if that lookup fails,
  // ownership stays UNKNOWN, the token is retained and NO refresh is scheduled.
  // This is deliberately distinct from the ordinary startup freshness check at
  // packages/market-core/src/sync/refresh.ts:333-350, which fails OPEN on a
  // lookup error and is NOT changed by this correction.
  const recovery = ownership!.recoverForStartup();
  logger.info("catalog_ownership_startup_recovery", {
    decision: recovery.decision,
    generation: "generation" in recovery ? recovery.generation : 0,
    ...("runId" in recovery ? { runId: recovery.runId } : {}),
    ...("reason" in recovery ? { reason: recovery.reason } : {})
  });
  if (recovery.decision === "REFUSED") {
    // Fail closed: the post-bump run-state lookup failed, so a prior commit
    // cannot be ruled out. Keep the token and UNKNOWN permit; do NOT dispatch.
    logger.warn("catalog_refresh_refused", {
      runId: recovery.runId, generation: recovery.generation, reason: recovery.reason,
      note: "post-bump run-state lookup failed; refusing refresh (fail-closed)"
    });
  } else if (recovery.decision === "RETRY") {
    // Refuse to start a writer while one may still be active. Retry on a
    // bounded, unref'd cadence; reads and the HTTP listener stay available.
    logger.warn("catalog_refresh_deferred", { reason: recovery.reason });
    const retry = setInterval(() => {
      if (shuttingDown) { clearInterval(retry); return; }
      const next = ownership!.recoverForStartup();
      logger.info("catalog_ownership_retry", { decision: next.decision });
      if (next.decision === "REFUSED") {
        clearInterval(retry);
        logger.warn("catalog_refresh_refused", {
          ...("runId" in next ? { runId: next.runId } : {}),
          ...("generation" in next ? { generation: next.generation } : {}),
          ...("reason" in next ? { reason: next.reason } : {}),
          note: "post-bump run-state lookup failed; refusing refresh (fail-closed)"
        });
      } else if (next.decision !== "RETRY") {
        clearInterval(retry);
        startRefresh();
      }
    }, 2_000);
    (retry as { unref?: () => void } | null)?.unref?.();
  } else {
    startRefresh();
  }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("startup_failed", { stage: "composition", message });
    await drainStartupFailure();
    process.exitCode = 1;
    return;
  }

  const shutdown = async (signal: string, exitAfter: boolean) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      logger.info("shutdown_start", { signal });
      // WP3-A: enter STOPPING, abort active I/O and AWAIT every refresh task and
      // its atomic transaction before any database closure (items 1–9).
      try { if (catalogRefresh) await catalogRefresh.stopAndWait(); } catch (error) {
        logger.warn("catalog_refresh_drain_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // G0-A: drain any active/queued child before the parent DB is closed.
      try { if (childManager) await childManager.shutdown(); } catch (error) {
        logger.warn("child_manager_drain_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // G0-D §6.4 step 4: release the permit and clear the durable token only
      // after the child has settled and exited, before the parent DB closes.
      // An UNKNOWN permit is NOT released: the durable token must survive this
      // shutdown so a restart can verify the prior run before admitting a writer.
      try {
        const released = releaseOwnershipForShutdown(ownership);
        if (released.skippedUnknown) {
          logger.info("ownership_release_skipped", {
            reason: "permit UNKNOWN; durable token retained for next recovery"
          });
        }
      } catch (error) {
        logger.warn("ownership_release_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 1) stop accepting subscription/config work; 2) stop/cancel the shared
      // coordinator and its provider runtimes (locked drivers own no resources).
      try { coordinator?.stop(); } catch (error) {
        logger.warn("coordinator_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // M6-D shutdown order: keep the handler alive until close() so active
      // listen streams receive graceful completion, then detach the bridge so
      // no publish races teardown, then stop the hub/server/DB.
      // 2) close the MCP handler (graceful listen completion, then abort in-flight).
      try { if (mcpHandler) await mcpHandler.close(); } catch (error) {
        logger.warn("mcp_handler_close_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 3) unsubscribe the bridge after the handler is closed.
      try { notificationBridge?.stop(); } catch (error) {
        logger.warn("mcp_notification_bridge_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 4) stop hub timers and clients before the HTTP server and DB close.
      try { hub?.stop(); } catch (error) {
        logger.warn("hub_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      // 5) close HTTP server; 6) close/checkpoint DB.
      try { if (server) await server.stop(true); } catch (error) {
        logger.warn("server_stop_error", { message: error instanceof Error ? error.message : String(error) });
      }
      try { db?.close(); } catch (error) {
        logger.warn("db_close_error", { message: error instanceof Error ? error.message : String(error) });
      }
      logger.info("shutdown_complete", { signal });
      if (process.exitCode === undefined) process.exitCode = 0;
      if (exitAfter) process.exit(process.exitCode ?? 0);
    })();
    return shutdownPromise;
  };

  process.on("SIGINT", () => { void shutdown("SIGINT", true); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM", true); });
  if (process.env.MARKETHUB_TEST_SHUTDOWN_ON_STDIN_END === "1" && process.stdin && typeof process.stdin.on === "function") {
    const onStdinEnd = () => { void shutdown("STDIN_END", true); };
    process.stdin.on("end", onStdinEnd);
    process.stdin.on("close", onStdinEnd);
    try { process.stdin.resume(); } catch {}
  }
}

// Only start the application when this module is the entry point. Importing it
// from a test must not open the database or bind a port; the exported
// withSseIdleTimeout helper is exercised directly in that case.
if (import.meta.main) void main();
