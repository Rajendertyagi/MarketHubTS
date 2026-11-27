/**
 * G0-A — parent-side catalog refresh child manager.
 *
 * Owns the full child lifecycle: spawn with `process.execPath` + `windowsHide`,
 * install the IPC/exit handlers at spawn, validate every inbound message,
 * verify that the child opened the SAME database file in WAL mode on the same
 * SQLite version, perform the minimal `ping`/`ready` round-trip, request a
 * graceful `shutdown`, and observe `exited`/`onExit` with code and signal.
 *
 * Provider runs are SERIALIZED (plan §5.1): a single queue and a single active
 * child mean a second request is never spawned until the first child has
 * settled and exited. No refresh pipeline, write coordinator or crash-recovery
 * policy lives here yet — those are G0-B/C/D.
 */
import { resolve } from "node:path";
import { repoRoot, resolveDatabasePath } from "@markethub/database";
import type { ProviderId } from "@markethub/contracts";
import {
  MAX_IPC_MESSAGE_BYTES,
  ipcMessageByteLength,
  parseChildMessage,
  type ChildMessage,
  type ReadyMessage
} from "./catalog-refresh-ipc";

/** Short bounded wait after a last-resort kill; G0-A has no transaction to unwind. */
const EXIT_ESCALATION_TIMEOUT_MS = 1_000;
/** Bounded stderr tail retained for failure diagnostics (no large payloads). */
const STDERR_CAPTURE_BYTES = 2_048;

type ChildProcess = ReturnType<typeof Bun.spawn>;

export interface ChildExitInfo {
  code: number | null;
  signal: string | number | null;
  killed: boolean;
}

export interface RefreshRequest {
  runId: string;
  provider: ProviderId;
  nowIso: string;
  intentKey: string;
  generation: number;
}

export interface ChildRunResult {
  runId: string;
  provider: ProviderId;
  ok: boolean;
  ready: ReadyMessage | undefined;
  error: string | undefined;
  exit: ChildExitInfo;
  maxMessageBytes: number;
  protocolErrors: string[];
  /** G0-B: terminal child message (`result`/`cancelled`/`error`) in pipeline mode. */
  terminal?: ChildMessage;
}

export type ManagerEvent =
  | { type: "spawn"; runId: string; pid: number }
  | { type: "message"; runId: string; messageType: string }
  | { type: "ready"; runId: string; ready: ReadyMessage }
  | { type: "phase"; runId: string; phase: string }
  | { type: "txn-settled"; runId: string; outcome: string; generation?: number }
  | { type: "exit"; runId: string; exit: ChildExitInfo }
  | { type: "settled"; runId: string; ok: boolean };

/** G0-D: result of the parent's write-permit drain + generation grant. */
export interface TxnGrantDecision {
  granted: boolean;
  generation?: number;
  reason?: string;
}

/**
 * G0-D additive ownership hooks. When omitted the manager keeps the G0-A/B
 * behaviour (unconditional grant with `request.generation`), so existing
 * foundation tests are unchanged. Production wires these to
 * `CatalogWriteOwnership` in `index.ts`.
 */
export interface ManagerOwnershipHooks {
  requestGrant?: (request: RefreshRequest) => Promise<TxnGrantDecision> | TxnGrantDecision;
  onSettled?: (info: {
    runId: string;
    provider: ProviderId;
    ok: boolean;
    terminal: ChildMessage | undefined;
    exit: ChildExitInfo;
  }) => void;
  onUnexpectedExit?: (info: { runId: string; exit: ChildExitInfo }) => void;
}

export interface ManagerOptions {
  dbPath: string;
  childEntryPath?: string;
  cwd?: string;
  messageTimeoutMs?: number;
  exitTimeoutMs?: number;
  expectedSqliteVersion?: string;
  expectedJournalMode?: string;
  onEvent?: (event: ManagerEvent) => void;
  /** G0-B: `pipeline` runs the refresh pipeline and awaits a terminal message;
   * `handshake` (default) preserves the G0-A ping/pong foundation test path. */
  mode?: "handshake" | "pipeline";
  /** Bounded exit wait for a pipeline child (real downloads can take minutes). */
  pipelineExitTimeoutMs?: number;
  /** G0-D: optional ownership integration; absent = G0-A/B unconditional grant. */
  ownershipHooks?: ManagerOwnershipHooks;
}

export interface ReadyExpectation {
  dbPath: string;
  journalMode: string;
  sqliteVersion: string;
}

/** Pure identity check used by the manager and exercised directly by tests. */
export function verifyReady(
  ready: ReadyMessage,
  expected: ReadyExpectation
): { ok: true } | { ok: false; error: string } {
  if (resolveDatabasePath(ready.dbPath) !== resolveDatabasePath(expected.dbPath)) {
    return { ok: false, error: `db path mismatch: child=${ready.dbPath} parent=${expected.dbPath}` };
  }
  if (ready.journalMode.toLowerCase() !== expected.journalMode.toLowerCase()) {
    return { ok: false, error: `journal mode mismatch: child=${ready.journalMode} expected=${expected.journalMode}` };
  }
  if (ready.sqliteVersion !== expected.sqliteVersion) {
    return { ok: false, error: `sqlite version mismatch: child=${ready.sqliteVersion} expected=${expected.sqliteVersion}` };
  }
  if (!Number.isInteger(ready.pid) || ready.pid <= 0) {
    return { ok: false, error: `invalid child pid: ${String(ready.pid)}` };
  }
  return { ok: true };
}

function readExitInfo(proc: ChildProcess): ChildExitInfo {
  return { code: proc.exitCode, signal: proc.signalCode, killed: proc.killed };
}

/**
 * Drain stderr into a bounded tail. The reader is fire-and-forget so an
 * unresponsive child can never block the parent; only the last
 * `STDERR_CAPTURE_BYTES` characters are retained.
 */
function captureStderrBounded(stream: ReadableStream<Uint8Array> | null): () => string {
  if (!stream) return () => "";
  let tail = "";
  const decoder = new TextDecoder();
  void (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          tail += decoder.decode(value, { stream: true });
          if (tail.length > STDERR_CAPTURE_BYTES) tail = tail.slice(-STDERR_CAPTURE_BYTES);
        }
      }
    } catch {} finally {
      try { reader.releaseLock(); } catch {}
    }
  })();
  return () => tail;
}

/** Single-line, control-character-free, bounded excerpt for error messages. */
function sanitizeStderrExcerpt(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

class ChildExitedError extends Error {
  readonly exit: ChildExitInfo;
  constructor(exit: ChildExitInfo) {
    super(`child exited before the expected message: code=${String(exit.code)} signal=${String(exit.signal)}`);
    this.name = "ChildExitedError";
    this.exit = exit;
  }
}

interface Waiter {
  types: string[];
  resolve: (message: ChildMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
  request: RefreshRequest;
  proc: ChildProcess;
  messages: ChildMessage[];
  waiters: Waiter[];
  exitInfo: ChildExitInfo | null;
  maxMessageBytes: number;
  protocolErrors: string[];
}

interface QueueItem {
  request: RefreshRequest;
  resolve: (result: ChildRunResult) => void;
}

const DEFAULT_CHILD_ENTRY = resolve(import.meta.dir, "catalog-refresh-child.ts");

export class CatalogRefreshChildManager {
  private readonly dbPath: string;
  private readonly resolvedDbPath: string;
  private readonly childEntryPath: string;
  private readonly cwd: string;
  private readonly messageTimeoutMs: number;
  private readonly exitTimeoutMs: number;
  private readonly expectedSqliteVersion: string;
  private readonly expectedJournalMode: string;
  private readonly onEvent: ((event: ManagerEvent) => void) | undefined;
  private readonly mode: "handshake" | "pipeline";
  private readonly pipelineExitTimeoutMs: number;
  private readonly ownershipHooks: ManagerOwnershipHooks | undefined;

  private readonly queue: QueueItem[] = [];
  private active: ChildProcess | null = null;
  private currentRunId: string | null = null;
  private pumping = false;
  private shuttingDown = false;
  private readonly settleWaiters: Array<() => void> = [];
  private totalMaxMessageBytes = 0;
  private readonly allProtocolErrors: string[] = [];

  constructor(options: ManagerOptions) {
    this.dbPath = options.dbPath;
    this.resolvedDbPath = resolveDatabasePath(options.dbPath);
    this.childEntryPath = options.childEntryPath ?? DEFAULT_CHILD_ENTRY;
    this.cwd = options.cwd ?? repoRoot;
    this.messageTimeoutMs = options.messageTimeoutMs ?? 10_000;
    this.exitTimeoutMs = options.exitTimeoutMs ?? 10_000;
    this.expectedSqliteVersion = options.expectedSqliteVersion ?? process.versions.sqlite ?? "unknown";
    this.expectedJournalMode = options.expectedJournalMode ?? "wal";
    this.onEvent = options.onEvent;
    this.mode = options.mode ?? "handshake";
    this.pipelineExitTimeoutMs = options.pipelineExitTimeoutMs ?? 180_000;
    this.ownershipHooks = options.ownershipHooks;
  }

  get activeSubprocess(): ChildProcess | null { return this.active; }
  get activeRunId(): string | null { return this.currentRunId; }
  get queuedCount(): number { return this.queue.length; }
  get maxObservedMessageBytes(): number { return this.totalMaxMessageBytes; }
  get protocolErrors(): readonly string[] { return this.allProtocolErrors; }
  get expectedDbPath(): string { return this.resolvedDbPath; }

  /** Queue one provider run. Resolves only after that child has exited. */
  requestRefresh(request: RefreshRequest): Promise<ChildRunResult> {
    if (this.shuttingDown) {
      return Promise.resolve(this.refusedResult(request, "manager is shutting down"));
    }
    return new Promise<ChildRunResult>((resolveResult) => {
      this.queue.push({ request, resolve: resolveResult });
      this.pump();
    });
  }

  /**
   * Cooperative cancellation of a run. If the run is still queued it is removed
   * and settled as cancelled so a shutdown abort cannot spawn a child that has
   * already been cancelled (G0-B shutdown correctness). If it is active, the
   * child owns the abort logic and receives a `cancel` IPC message.
   */
  cancel(runId: string, reason = "cancelled by parent"): boolean {
    const queueIndex = this.queue.findIndex((item) => item.request.runId === runId);
    if (queueIndex >= 0) {
      const item = this.queue.splice(queueIndex, 1)[0]!;
      item.resolve(this.cancelledResult(item.request, reason));
      return true;
    }
    if (!this.active || this.currentRunId !== runId) return false;
    try {
      this.active.send({ type: "cancel", runId, reason: reason.slice(0, 300) });
      return true;
    } catch {
      return false;
    }
  }

  private cancelledResult(request: RefreshRequest, reason: string): ChildRunResult {
    return {
      runId: request.runId,
      provider: request.provider,
      ok: true,
      ready: undefined,
      error: undefined,
      exit: { code: null, signal: null, killed: false },
      maxMessageBytes: 0,
      protocolErrors: [],
      terminal: { type: "cancelled", runId: request.runId, reason: reason.slice(0, 300) }
    };
  }

  /** Stop admitting runs, wait for the active child, then drain the queue. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    while (this.active) {
      await new Promise<void>((resolveWaiter) => this.settleWaiters.push(resolveWaiter));
    }
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.resolve(this.refusedResult(item.request, "manager is shutting down"));
    }
  }

  private refusedResult(request: RefreshRequest, error: string): ChildRunResult {
    return {
      runId: request.runId,
      provider: request.provider,
      ok: false,
      ready: undefined,
      error,
      exit: { code: null, signal: null, killed: false },
      maxMessageBytes: 0,
      protocolErrors: []
    };
  }

  private emit(event: ManagerEvent): void {
    try { this.onEvent?.(event); } catch {}
  }

  private pump(): void {
    if (this.pumping || this.active || this.shuttingDown || this.queue.length === 0) return;
    this.pumping = true;
    const item = this.queue.shift()!;
    void this.runOne(item.request)
      .then((result) => item.resolve(result))
      .finally(() => {
        this.pumping = false;
        this.pump();
      });
  }

  private rejectWaiters(run: ActiveRun, error: Error): void {
    for (const waiter of run.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private onIpc(run: ActiveRun, raw: unknown): void {
    const bytes = ipcMessageByteLength(raw);
    run.maxMessageBytes = Math.max(run.maxMessageBytes, bytes);
    if (bytes > MAX_IPC_MESSAGE_BYTES) {
      run.protocolErrors.push("IPC_MESSAGE_TOO_LARGE");
      return;
    }
    const parsed = parseChildMessage(raw);
    if (!parsed.ok) {
      run.protocolErrors.push(parsed.error);
      return;
    }
    const message = parsed.message;
    if (message.runId !== run.request.runId) {
      run.protocolErrors.push(`unknown runId: ${message.runId}`);
      return;
    }
    run.messages.push(message);
    this.emit({ type: "message", runId: run.request.runId, messageType: message.type });
    if (message.type === "progress") {
      this.emit({ type: "phase", runId: run.request.runId, phase: message.phase });
    }
    if (message.type === "txn-settled") {
      this.emit({
        type: "txn-settled",
        runId: run.request.runId,
        outcome: message.outcome,
        ...(message.generation !== undefined ? { generation: message.generation } : {})
      });
    }
    // G0-D: the grant is no longer unconditional. When ownership hooks are
    // wired the parent drains write scopes and grants the current monotonic
    // generation; otherwise the G0-A/B unconditional grant is preserved.
    if (this.mode === "pipeline" && message.type === "txn-starting") {
      void this.handleTxnStarting(run);
    }
    for (const waiter of [...run.waiters]) {
      if (waiter.types.includes(message.type)) {
        clearTimeout(waiter.timer);
        run.waiters.splice(run.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }

  /**
   * G0-D: resolve the child's `txn-starting` request. The parent drains write
   * scopes and grants the current generation (or refuses with a retryable
   * reason). Never sends a grant to a child that has already exited.
   */
  private async handleTxnStarting(run: ActiveRun): Promise<void> {
    let decision: TxnGrantDecision;
    try {
      decision = this.ownershipHooks?.requestGrant
        ? await this.ownershipHooks.requestGrant(run.request)
        : { granted: true, generation: run.request.generation };
    } catch (error) {
      decision = {
        granted: false,
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      };
    }
    if (run.exitInfo) return;
    try {
      if (decision.granted) {
        run.proc.send({
          type: "txn-granted",
          runId: run.request.runId,
          generation: decision.generation ?? run.request.generation
        });
      } else {
        run.proc.send({
          type: "txn-refused",
          runId: run.request.runId,
          reason: (decision.reason ?? "write permit unavailable").slice(0, 300)
        });
      }
    } catch {}
  }

  private waitForMessage(
    run: ActiveRun, type: string | string[], timeoutMs: number
  ): Promise<ChildMessage> {
    const types = Array.isArray(type) ? type : [type];
    if (run.exitInfo) return Promise.reject(new ChildExitedError(run.exitInfo));
    const existing = run.messages.find((message) => types.includes(message.type));
    if (existing) return Promise.resolve(existing);
    return new Promise<ChildMessage>((resolveMessage, rejectMessage) => {
      const timer = setTimeout(() => {
        const index = run.waiters.findIndex(
          (waiter) => waiter.types.join("|") === types.join("|") && waiter.timer === timer
        );
        if (index >= 0) run.waiters.splice(index, 1);
        rejectMessage(new Error(`timed out waiting for ${types.join("/")} from child`));
      }, timeoutMs);
      run.waiters.push({ types, resolve: resolveMessage, reject: rejectMessage, timer });
    });
  }

  private async waitForExit(run: ActiveRun, timeoutMs: number): Promise<ChildExitInfo> {
    if (run.exitInfo) return run.exitInfo;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out waiting for child exit")), timeoutMs);
    });
    try {
      await Promise.race([run.proc.exited, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    run.exitInfo = readExitInfo(run.proc);
    return run.exitInfo;
  }

  private async runOne(request: RefreshRequest): Promise<ChildRunResult> {
    const run: ActiveRun = {
      request,
      proc: null as unknown as ChildProcess,
      messages: [],
      waiters: [],
      exitInfo: null,
      maxMessageBytes: 0,
      protocolErrors: []
    };

    const proc = Bun.spawn([process.execPath, this.childEntryPath, this.resolvedDbPath], {
      cwd: this.cwd,
      env: { ...process.env },
      windowsHide: true,
      serialization: "advanced",
      stdout: "ignore",
      stderr: "pipe",
      ipc: (raw: unknown) => this.onIpc(run, raw),
      onExit: (child, code, signal) => {
        const info: ChildExitInfo = { code, signal, killed: child.killed };
        const firstObservation = run.exitInfo === null;
        run.exitInfo = info;
        if (firstObservation) this.emit({ type: "exit", runId: request.runId, exit: info });
        this.rejectWaiters(run, new ChildExitedError(info));
      }
    });
    run.proc = proc;
    const readStderr = captureStderrBounded(proc.stderr);
    this.active = proc;
    this.currentRunId = request.runId;
    // `onExit` is documented but fires after `exited` resolves in Bun 1.4.5;
    // observe `exited` too so waiters are released promptly. Emit at most one
    // exit event per run regardless of which channel observes it first.
    void proc.exited.then(() => {
      if (!run.exitInfo) {
        const info = readExitInfo(proc);
        run.exitInfo = info;
        this.emit({ type: "exit", runId: request.runId, exit: info });
        this.rejectWaiters(run, new ChildExitedError(info));
      }
    }).catch(() => {});
    this.emit({ type: "spawn", runId: request.runId, pid: proc.pid });

    let ok = false;
    let ready: ReadyMessage | undefined;
    let error: string | undefined;
    let terminal: ChildMessage | undefined;

    try {
      proc.send({
        type: "refresh",
        runId: request.runId,
        provider: request.provider,
        dbPath: this.resolvedDbPath,
        nowIso: request.nowIso,
        intentKey: request.intentKey,
        generation: request.generation
      });
      const readyMessage = await this.waitForMessage(run, "ready", this.messageTimeoutMs) as ReadyMessage;
      const check = verifyReady(readyMessage, {
        dbPath: this.resolvedDbPath,
        journalMode: this.expectedJournalMode,
        sqliteVersion: this.expectedSqliteVersion
      });
      if (!check.ok) throw new Error(check.error);
      ready = readyMessage;
      this.emit({ type: "ready", runId: request.runId, ready });
      if (this.mode === "pipeline") {
        // Wait for the child's terminal message BEFORE requesting shutdown —
        // otherwise a shutdown sent right after `ready` would kill the child
        // while it is still downloading/parsing/applying.
        terminal = await this.waitForMessage(
          run, ["result", "cancelled", "error"], this.pipelineExitTimeoutMs
        );
        ok = true;
      } else {
        proc.send({ type: "ping", runId: request.runId });
        await this.waitForMessage(run, "pong", this.messageTimeoutMs);
        ok = true;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (proc.exitCode === null) {
        try { proc.send({ type: "shutdown", runId: request.runId }); } catch {}
      }
      let exit: ChildExitInfo;
      let exitObserved = true;
      try {
        exit = await this.waitForExit(
          run, this.mode === "pipeline" ? this.pipelineExitTimeoutMs : this.exitTimeoutMs
        );
      } catch {
        // A graceful-shutdown timeout is a failure even when the handshake
        // succeeded: an unresponsive child must never be reported as a clean
        // run, and its slot must not be released while it may still be alive.
        ok = false;
        error = error ?? "timed out waiting for child exit";
        // Last-resort escalation. G0-A has no transaction in scope, so a kill
        // cannot leave a half-applied write behind.
        try { proc.kill(); } catch {}
        try {
          exit = await this.waitForExit(run, EXIT_ESCALATION_TIMEOUT_MS);
          error = `${error}; child killed after exit timeout (code=${String(exit.code)} signal=${String(exit.signal)})`;
        } catch {
          // Explicit unrecoverable state: exit was never observed. Record it
          // and never report success, even though the slot is released so the
          // manager cannot deadlock its queue.
          exit = readExitInfo(proc);
          exitObserved = false;
          error = `${error}; child exit unobserved after kill escalation (unrecoverable)`;
        }
      }
      if (ok && (exit.signal !== null || (exit.code !== null && exit.code !== 0))) {
        ok = false;
        error = `child exited unexpectedly: code=${String(exit.code)} signal=${String(exit.signal)}`;
      }
      if (this.mode === "pipeline") {
        terminal = run.messages.find(
          (message) => message.type === "result" || message.type === "cancelled" || message.type === "error"
        );
        if (!terminal) {
          ok = false;
          error = error ?? "child exited without a terminal result message";
        }
      }
      if (!exitObserved) ok = false;
      if (!ok) {
        const excerpt = sanitizeStderrExcerpt(readStderr());
        if (excerpt) error = error ? `${error}; stderr: ${excerpt}` : `stderr: ${excerpt}`;
      }
      // G0-D: ownership settlement and unexpected-exit observation happen
      // AFTER exit is observed but BEFORE the slot is released, so a new child
      // can never be granted while the old child's permit is still owned.
      const unexpectedExit = exit.signal !== null || (exit.code !== null && exit.code !== 0);
      try {
        // Observe an unexpected exit FIRST, while the durable token still
        // exists, so recovery can verify run state before settlement clears it.
        if (unexpectedExit) {
          this.ownershipHooks?.onUnexpectedExit?.({ runId: request.runId, exit });
        }
        this.ownershipHooks?.onSettled?.({
          runId: request.runId, provider: request.provider, ok, terminal, exit
        });
      } catch {}
      // Only now — after exit is observed or an unrecoverable state is
      // recorded — may the slot be released and the next child be spawned.
      this.active = null;
      this.currentRunId = null;
      this.totalMaxMessageBytes = Math.max(this.totalMaxMessageBytes, run.maxMessageBytes);
      this.allProtocolErrors.push(...run.protocolErrors);
      this.emit({ type: "settled", runId: request.runId, ok });
      for (const waiter of this.settleWaiters.splice(0)) waiter();
      return {
        runId: request.runId,
        provider: request.provider,
        ok,
        ready,
        error,
        exit,
        maxMessageBytes: run.maxMessageBytes,
        protocolErrors: [...run.protocolErrors],
        ...(terminal ? { terminal } : {})
      };
    }
  }
}
