/**
 * G0-A — catalog refresh child process entry point.
 *
 * Spawned by `CatalogRefreshChildManager` as:
 *   [process.execPath, <absolute path to this file>, <resolved dbPath>]
 *
 * Responsibilities (G0-A only): install the IPC handler first, open ONE
 * independent connection to the SAME database file with `migrate:false`,
 * report its identity in `ready`, answer `ping` with `pong`, and exit 0 on
 * `shutdown`. There is no download/parse/apply pipeline, no write coordinator,
 * no second database, no migration and no credential access here — those are
 * later G0 packages.
 */
import { openDatabase, resolveDatabasePath, type DatabaseHandle } from "@markethub/database";
import {
  MAX_IPC_MESSAGE_BYTES,
  ipcMessageByteLength,
  parseParentMessage,
  type ParentMessage
} from "./catalog-refresh-ipc";

function send(message: unknown): void {
  if (typeof process.send !== "function") return;
  // Never transfer a large payload, even if a future handler tries to.
  if (ipcMessageByteLength(message) > MAX_IPC_MESSAGE_BYTES) return;
  process.send(message);
}

function runChild(): void {
  const argvDbPath = process.argv[2] ?? null;
  let handle: DatabaseHandle | null = null;
  let currentRunId: string | null = null;

  // Keep the event loop alive while the IPC channel is open. `process.exit`
  // below is authoritative, so this timer cannot outlive a clean shutdown.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const exit = (code: number): never => {
    clearInterval(keepAlive);
    try { handle?.close(); } catch {}
    handle = null;
    process.exit(code);
  };

  const fail = (code: string, message: string): void => {
    send({ type: "error", runId: currentRunId ?? "init", code, message: message.slice(0, 300) });
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

    switch (message.type) {
      case "refresh": {
        if (handle) {
          fail("ALREADY_RUNNING", "child already has an active run");
          return;
        }
        currentRunId = message.runId;
        // The parent passes the same resolved path in argv and in the message;
        // a mismatch means the two sides are not looking at the same file.
        if (argvDbPath !== null && resolveDatabasePath(argvDbPath) !== resolveDatabasePath(message.dbPath)) {
          fail("DB_PATH_MISMATCH", "argv dbPath and refresh dbPath resolve differently");
          exit(1);
        }
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
        } catch (error) {
          fail("DB_OPEN_FAILED", error instanceof Error ? error.message : String(error));
          exit(1);
        }
        return;
      }
      case "ping": {
        if (message.runId !== currentRunId) return;
        send({ type: "pong", runId: message.runId });
        return;
      }
      case "cancel": {
        if (message.runId !== currentRunId) return;
        send({ type: "cancelled", runId: message.runId, reason: message.reason });
        return exit(0);
      }
      case "shutdown": {
        if (message.runId !== currentRunId) return;
        return exit(0);
      }
      case "txn-granted":
        // Declared for later packages; G0-A has no transaction phase.
        return;
      case "txn-refused":
        return;
      default:
        fail("UNKNOWN_MESSAGE", "unhandled parent message");
    }
  });
}

if (import.meta.main) runChild();
