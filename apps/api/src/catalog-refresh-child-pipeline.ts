/**
 * G0-B/G0-D — refresh child pipeline adapter.
 *
 * Installs the child-side IPC handler and runs the complete download → parse →
 * validate → apply pipeline in THIS process on its own SQLite connection to the
 * same database file. All market-data parsing/validation/apply logic is reused
 * unchanged from `@markethub/market-core`; this module only owns the process
 * boundary: the child-owned `AbortController`, progress reporting, the
 * `txn-starting`/`txn-granted(generation)`/`txn-refused` handshake and the
 * structured terminal result. A parent `cancel` aborts the run and rejects any
 * pending grant waiter at once, so a run blocked in `AWAIT_TXN_GRANT` settles as
 * `cancelled` without waiting for the grant timeout.
 *
 * The child writes SQLite ONLY inside the atomic apply transaction: its
 * `CatalogSyncService` is constructed in child mode (diagnostic recorder
 * disabled), so no autocommit `recordSyncRun` happens on any failure path.
 * Terminal diagnostics are recorded by the parent after settlement.
 *
 * G0-D generation fence (plan §6.2 item 6): immediately after `BEGIN IMMEDIATE`
 * and BEFORE any catalog write, the current generation is read from `app_meta`
 * on THIS SAME connection and compared with the generation carried by
 * `txn-granted`. A mismatch rolls the transaction back with zero catalog writes
 * and a `FENCED` outcome. Because the check and all catalog writes share one
 * `BEGIN IMMEDIATE`, a recovering parent's generation bump cannot interleave
 * with an old child's transaction.
 *
 * Spawned as: [process.execPath, <absolute path to this file>, <resolved dbPath>]
 */
import { Database } from "bun:sqlite";
import { openDatabase, SqliteCatalogRepository, type DatabaseHandle } from "@markethub/database";
import { CatalogSyncService } from "@markethub/market-core";
import type { CatalogRepository, CatalogRepositoryTx } from "../../../packages/market-core/src/types";
import {
  runProviderRefreshPipeline,
  type ProviderPipelineOutcome
} from "../../../packages/market-core/src/sync/refresh";
import type { MasterFetch } from "../../../packages/market-core/src/sync/refresh";
import { readGeneration } from "./catalog-write-ownership";
import {
  MAX_IPC_MESSAGE_BYTES,
  ipcMessageByteLength,
  parseParentMessage,
  type ParentMessage
} from "./catalog-refresh-ipc";

/** Bounded wait for the parent's write-permit acknowledgement. */
const DEFAULT_GRANT_TIMEOUT_MS = 30_000;

export interface ChildPipelineOptions {
  /** Injectable for fixture-driven tests; production uses the global fetch. */
  fetchFn?: MasterFetch;
  /** Injectable for tests; production uses `process.send`. */
  send?: (message: unknown) => void;
  grantTimeoutMs?: number;
  /**
   * Test-only deterministic hook: awaited AFTER the grant is received but
   * BEFORE the atomic apply begins. Used by the fence-race test to hold an old
   * child at the transaction boundary while a new parent bumps the generation.
   */
  beforeTxn?: () => Promise<void> | void;
}

interface GrantWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Internal signal: the in-transaction generation check failed. */
class FencedError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`ownership generation mismatch: expected ${expected}, found ${actual}`);
    this.name = "FencedError";
  }
}

/**
 * Wrap the repository so the ownership generation is validated INSIDE the same
 * `BEGIN IMMEDIATE` as every catalog write. The check runs before `fn`, so a
 * mismatch throws before `createSyncRun`/upserts and the transaction rolls back
 * with zero catalog writes. All other repository methods are inherited from the
 * real `SqliteCatalogRepository` via the prototype chain.
 */
export function fenceRepository(
  base: SqliteCatalogRepository,
  sqlite: Database,
  getGrantedGeneration: () => number | null,
  onSettled: (outcome: "COMMITTED" | "ROLLED_BACK" | "FENCED") => void,
  onFence: () => void
): CatalogRepository {
  const wrapped = Object.create(base) as CatalogRepository;
  Object.defineProperty(wrapped, "transaction", {
    configurable: false,
    writable: false,
    value: <T>(fn: (tx: CatalogRepositoryTx) => Promise<T> | T): Promise<T> => {
      let fencedThisTx = false;
      return base.transaction(async (tx) => {
        const granted = getGrantedGeneration();
        const actual = readGeneration(sqlite);
        if (granted === null || actual !== granted) {
          fencedThisTx = true;
          onFence();
          throw new FencedError(granted ?? -1, actual);
        }
        return fn(tx);
      }).then(
        (value) => { onSettled("COMMITTED"); return value; },
        (error) => { onSettled(fencedThisTx ? "FENCED" : "ROLLED_BACK"); throw error; }
      );
    }
  });
  return wrapped;
}

/**
 * Install the child message handler. Must be called synchronously at module
 * startup so messages sent immediately after spawn are never dropped.
 */
export function installChildPipeline(options: ChildPipelineOptions = {}): void {
  const fetchFn: MasterFetch = options.fetchFn ?? ((input, init) => fetch(input, init));
  const send = options.send ?? ((message: unknown) => {
    if (typeof process.send !== "function") return;
    if (ipcMessageByteLength(message) > MAX_IPC_MESSAGE_BYTES) return;
    process.send(message);
  });
  const grantTimeoutMs = options.grantTimeoutMs ?? DEFAULT_GRANT_TIMEOUT_MS;

  const argvDbPath = process.argv[2] ?? null;
  let handle: DatabaseHandle | null = null;
  let currentRunId: string | null = null;
  let controller: AbortController | null = null;
  let running = false;
  let refreshGeneration: number | null = null;
  let grantedGeneration: number | null = null;
  let fenced = false;
  const grantWaiters: GrantWaiter[] = [];

  // Keep the event loop alive while the IPC channel is open. `process.exit`
  // below is authoritative, so this timer cannot outlive a clean shutdown.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const exit = (code: number): never => {
    clearInterval(keepAlive);
    for (const waiter of grantWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("child exiting before txn grant"));
    }
    try { handle?.close(); } catch {}
    handle = null;
    process.exit(code);
  };

  const fail = (code: string, message: string): void => {
    send({ type: "error", runId: currentRunId ?? "init", code, message: message.slice(0, 300) });
  };

  const resolveGrants = (): void => {
    for (const waiter of grantWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const rejectGrants = (reason: string): void => {
    for (const waiter of grantWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason.slice(0, 300)));
    }
  };

  const waitForGrant = (runId: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = grantWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) grantWaiters.splice(index, 1);
        reject(new Error("timed out waiting for txn-granted"));
      }, grantTimeoutMs);
      grantWaiters.push({ resolve, reject, timer });
      send({ type: "txn-starting", runId });
    });

  const runRefresh = async (message: Extract<ParentMessage, { type: "refresh" }>): Promise<void> => {
    if (running) {
      fail("ALREADY_RUNNING", "child already has an active run");
      return;
    }
    running = true;
    currentRunId = message.runId;
    refreshGeneration = message.generation;
    grantedGeneration = null;
    fenced = false;
    // The parent passes the same resolved path in argv and in the message; a
    // mismatch means the two sides are not looking at the same file.
    if (argvDbPath !== null && argvDbPath !== message.dbPath) {
      fail("DB_PATH_MISMATCH", "argv dbPath and refresh dbPath differ");
      exit(1);
    }
    controller = new AbortController();
    try {
      handle = openDatabase({ dbPath: message.dbPath, migrate: false });
      const journal = handle.sqlite.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
      const version = handle.sqlite.query("SELECT sqlite_version() AS version").get() as { version?: string } | null;
      send({
        type: "ready",
        runId: message.runId,
        pid: process.pid,
        dbPath: handle.path,
        journalMode: journal?.journal_mode ?? "unknown",
        sqliteVersion: version?.version ?? "unknown"
      });

      const baseRepo = new SqliteCatalogRepository(handle.db, handle.sqlite);
      // G0-D: validate the granted generation inside the same BEGIN IMMEDIATE
      // as every catalog write, before any write occurs.
      const repo = fenceRepository(
        baseRepo,
        handle.sqlite,
        () => grantedGeneration,
        (outcome) => send({
          type: "txn-settled",
          runId: message.runId,
          outcome,
          ...(grantedGeneration !== null ? { generation: grantedGeneration } : {})
        }),
        () => { fenced = true; }
      );
      // Child-mode diagnostic bypass (plan §4.2 decision (a)): no autocommit
      // recordSyncRun outside the atomic apply transaction.
      const sync = new CatalogSyncService(repo, { disableDiagnosticRunRecording: true });

      const outcome: ProviderPipelineOutcome = await runProviderRefreshPipeline({
        provider: message.provider,
        nowIso: message.nowIso,
        fetchFn,
        sync,
        signal: controller.signal,
        runId: message.runId,
        onProgress: (phase) => send({ type: "progress", runId: message.runId, phase }),
        beforeApply: async () => {
          await waitForGrant(message.runId);
          if (options.beforeTxn) await options.beforeTxn();
        }
      });

      if (fenced) {
        // The in-transaction fence aborted with zero catalog writes. Report a
        // distinct FENCED terminal status so the parent never records a
        // successful refresh for a stale generation.
        send({
          type: "result",
          runId: message.runId,
          status: "FENCED",
          counts: {},
          error: "ownership generation mismatch; transaction aborted with zero writes",
          ...(grantedGeneration !== null ? { generation: grantedGeneration } : {})
        });
      } else if (outcome.cancelled || controller.signal.aborted) {
        send({ type: "cancelled", runId: message.runId, reason: "cancelled" });
      } else {
        send({
          type: "result",
          runId: message.runId,
          status: outcome.status,
          counts: outcome.counts,
          ...(outcome.sourceVersion ? { sourceVersion: outcome.sourceVersion } : {}),
          ...(outcome.conflicts ? { conflicts: outcome.conflicts } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
          ...(grantedGeneration !== null ? { generation: grantedGeneration } : {})
        });
      }
      // Yield once so the terminal IPC message is flushed before exit; an
      // immediate process.exit() can drop the last write on the IPC channel.
      await Bun.sleep(10);
      exit(0);
    } catch (error) {
      fail("PIPELINE_FAILED", error instanceof Error ? error.message : String(error));
      exit(1);
    }
  };

  // Installed before any asynchronous work: messages sent immediately after
  // spawn must not be dropped.
  process.on("message", (raw: unknown) => {
    if (ipcMessageByteLength(raw) > MAX_IPC_MESSAGE_BYTES) {
      fail("IPC_MESSAGE_TOO_LARGE", "IPC message exceeded the bounded size limit");
      return;
    }
    const parsed = parseParentMessage(raw);
    if (!parsed.ok) {
      fail("INVALID_MESSAGE", parsed.error);
      return;
    }
    const message: ParentMessage = parsed.message;
    if (currentRunId !== null && message.runId !== currentRunId) return;

    switch (message.type) {
      case "refresh":
        void runRefresh(message);
        return;
      case "cancel":
        // Abort first so the pipeline's catch maps the rejected grant wait to
        // CANCELLED, then release any pending grant waiter immediately instead
        // of leaving it to expire at the (up to 30s) grant timeout.
        try { controller?.abort(); } catch {}
        rejectGrants(message.reason || "cancelled by parent");
        return;
      case "txn-granted":
        // The grant generation is authoritative for the fence. A mismatch with
        // the dispatch generation is a protocol error: refuse to write at all.
        if (refreshGeneration !== null && message.generation !== refreshGeneration) {
          rejectGrants("txn-granted generation mismatch with refresh");
          return;
        }
        grantedGeneration = message.generation;
        resolveGrants();
        return;
      case "txn-refused":
        rejectGrants(message.reason);
        return;
      case "shutdown":
        return exit(0);
      case "ping":
        // The pipeline child does not implement the G0-A ping handshake; the
        // manager uses pipeline mode and waits for the terminal result instead.
        return;
      default:
        fail("UNKNOWN_MESSAGE", "unhandled parent message");
    }
  });
}

if (import.meta.main) installChildPipeline();
