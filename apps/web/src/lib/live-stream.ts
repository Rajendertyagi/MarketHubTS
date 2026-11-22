import { LIVE_EVENT, LIVE_EVENT_NAMES, type LiveSnapshot } from "@markethub/contracts";
import { applyDataEvent, isSafeRevision, parseSseMessage } from "./live";

/** Event payload shape delivered to named SSE listeners. */
export interface SseEventLike {
  data: string;
  lastEventId: string;
}
export type SseListener = (event: SseEventLike) => void;

/**
 * Minimal EventSource surface so tests can supply a deterministic fake.
 * Named events are dispatched through addEventListener, matching the browser
 * EventSource API and the backend's named SSE events.
 */
export interface EventSourceLike {
  addEventListener(type: string, listener: SseListener): void;
  removeEventListener(type: string, listener: SseListener): void;
  close(): void;
}

/** Compatibility alias — the canonical event names live in @markethub/contracts. */
export const SSE_EVENT_NAMES = LIVE_EVENT_NAMES;

export type StreamStatus = "idle" | "connecting" | "live" | "recovering" | "error" | "closed";
export type RefreshStatus = "idle" | "fetching" | "stale" | "error";

export interface StreamState {
  /** SSE transport status only — never proof of a streaming provider feed. */
  streamStatus: StreamStatus;
  refreshStatus: RefreshStatus;
  lastError: string | null;
  refreshError: string | null;
}

export interface LiveStreamControllerOptions {
  createEventSource: (url: string) => EventSourceLike;
  /** Stored snapshot from a previous instance (StrictMode remount) — resume via ?since=. */
  initialSnapshot?: LiveSnapshot;
  fetchSnapshot: () => Promise<LiveSnapshot>;
  /** Retry delay; receives an abort signal so pending delays can be cancelled on stop(). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  onSnapshot: (snapshot: LiveSnapshot) => void;
  onState: (state: StreamState) => void;
  maxRecoveryAttempts?: number;
  recoveryBaseDelayMs?: number;
  recoveryMaxDelayMs?: number;
  maxRefreshAttempts?: number;
  refreshBaseDelayMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns one SSE transport lifecycle. A fresh instance is created per React
 * effect lifecycle; stop() is terminal for that instance. All listeners from
 * a superseded EventSource are removed and their callbacks are inert via
 * streamGeneration checks.
 */
export class LiveStreamController {
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryBaseDelayMs: number;
  private readonly recoveryMaxDelayMs: number;
  private readonly maxRefreshAttempts: number;
  private readonly refreshBaseDelayMs: number;
  private readonly abortController = new AbortController();

  private stopped = false;
  private streamGeneration = 0;
  private recoveryGeneration = 0;
  private refreshGeneration = 0;
  private eventSource: EventSourceLike | null = null;
  private sourceListeners: Array<[string, SseListener]> = [];
  private recovering = false;
  private refreshExhausted = false;
  /** True only for an initial no-cursor stream awaiting its first snapshot. */
  private awaitingInitialSnapshot = false;

  private snapshot: LiveSnapshot | null = null;
  private appliedRevision = 0;
  private streamStatus: StreamStatus = "idle";
  private refreshStatus: RefreshStatus = "idle";
  private lastError: string | null = null;
  private refreshError: string | null = null;

  constructor(private readonly opts: LiveStreamControllerOptions) {
    this.maxRecoveryAttempts = opts.maxRecoveryAttempts ?? 3;
    this.recoveryBaseDelayMs = opts.recoveryBaseDelayMs ?? 250;
    this.recoveryMaxDelayMs = opts.recoveryMaxDelayMs ?? 1000;
    this.maxRefreshAttempts = opts.maxRefreshAttempts ?? 2;
    this.refreshBaseDelayMs = opts.refreshBaseDelayMs ?? 200;
  }

  /** Open the initial no-cursor stream. Idempotent. */
  start(): void {
    if (this.stopped || this.streamStatus !== "idle") return;
    const stored = this.opts.initialSnapshot;
    if (stored && isSafeRevision(stored.revision)) {
      // Resume from an already validated stored snapshot: onopen is sufficient.
      this.snapshot = stored;
      this.appliedRevision = stored.revision;
      this.openStream(stored.revision);
    } else {
      // Initial synchronization: stay connecting until a valid snapshot arrives.
      this.openStream(null);
    }
  }

  /** Terminal for this instance: invalidate callbacks, cancel timers and stop work. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    this.streamGeneration++;
    this.recoveryGeneration++;
    this.refreshGeneration++;
    this.closeEventSource();
    this.recovering = false;
    this.refreshExhausted = true;
    this.setStatus("closed");
  }

  /** Manual retry after a terminal recovery error. */
  retry(): void {
    if (this.stopped || this.streamStatus !== "error") return;
    this.triggerRecovery("manual retry");
  }

  /** Manual retry after refresh retry exhaustion (fetch-only, no stream restart). */
  retryRefresh(): void {
    if (this.stopped || this.recovering) return;
    this.refreshExhausted = false;
    this.handleRefresh();
  }

  private emitState(): void {
    this.opts.onState({
      streamStatus: this.streamStatus,
      refreshStatus: this.refreshStatus,
      lastError: this.lastError,
      refreshError: this.refreshError
    });
  }

  private setStatus(status: StreamStatus): void {
    this.streamStatus = status;
    this.emitState();
  }

  /**
   * Apply a snapshot only when it does not regress the applied revision.
   * Returns false for unsafe or stale snapshots; the caller decides whether
   * to ignore it or treat it as a failed operation.
   */
  private applySnapshotIfCurrent(snapshot: LiveSnapshot): boolean {
    if (!isSafeRevision(snapshot.revision)) return false;
    if (snapshot.revision < this.appliedRevision) return false;
    this.snapshot = snapshot;
    this.appliedRevision = snapshot.revision;
    this.opts.onSnapshot(snapshot);
    return true;
  }

  private closeEventSource(): void {
    const current = this.eventSource;
    this.eventSource = null;
    if (current) {
      for (const [type, listener] of this.sourceListeners) {
        try { current.removeEventListener(type, listener); } catch { /* already closed */ }
      }
      this.sourceListeners = [];
      try { current.close(); } catch { /* already closed */ }
    }
  }

  private openStream(cursor: number | null): void {
    if (this.stopped) return;
    const generation = ++this.streamGeneration;
    this.closeEventSource();
    this.awaitingInitialSnapshot = cursor === null;
    this.setStatus("connecting");

    const url = cursor === null
      ? "/api/market/stream"
      : `/api/market/stream?since=${cursor}`;
    const source = this.opts.createEventSource(url);
    this.eventSource = source;

    const add = (type: string, listener: SseListener) => {
      source.addEventListener(type, listener);
      this.sourceListeners.push([type, listener]);
    };

    add("open", () => {
      if (generation !== this.streamGeneration || this.stopped) return;
      // Initial sync stays connecting until a validated snapshot arrives.
      // Recovery / stored-snapshot resume may enter live on open.
      if (this.awaitingInitialSnapshot) return;
      this.setStatus("live");
    });
    add("error", () => {
      if (generation !== this.streamGeneration || this.stopped) return;
      this.triggerRecovery("SSE transport error");
    });
    for (const name of SSE_EVENT_NAMES) {
      add(name, (event) => {
        if (generation !== this.streamGeneration || this.stopped) return;
        this.handleMessage(event);
      });
    }
  }

  private handleMessage(message: SseEventLike): void {
    const parsed = parseSseMessage(message.lastEventId, message.data);
    if (parsed.kind === "invalid") {
      this.triggerRecovery(`invalid SSE message: ${parsed.reason}`);
      return;
    }
    if (parsed.kind === "control") {
      if (parsed.control === LIVE_EVENT.snapshotRequired) this.triggerRecovery(LIVE_EVENT.snapshotRequired);
      else this.handleRefresh();
      return;
    }
    if (parsed.kind === "snapshot") {
      if (!isSafeRevision(parsed.snapshot.revision)) {
        this.triggerRecovery("unsafe snapshot revision");
        return;
      }
      if (!this.applySnapshotIfCurrent(parsed.snapshot)) {
        // Stale snapshot event: current state is already newer. Ignore it
        // rather than regressing appliedRevision and reprocessing old events.
        return;
      }
      if (this.awaitingInitialSnapshot) {
        this.awaitingInitialSnapshot = false;
        this.setStatus("live");
      }
      return;
    }

    // Data event. Ignore everything while a recovery owns the state.
    if (this.recovering) return;
    if (!this.snapshot) {
      this.triggerRecovery("data event before snapshot");
      return;
    }
    const result = applyDataEvent(this.snapshot, parsed.event);
    if (result.kind === "applied") {
      this.snapshot = result.snapshot;
      this.appliedRevision = result.snapshot.revision;
      this.opts.onSnapshot(result.snapshot);
    } else if (result.kind === "invalidation-required") {
      // provider-connection-changed: full invalidation, never partial mutation.
      this.triggerRecovery("provider connection changed");
    } else if (result.kind === "gap" || result.kind === "invalid") {
      this.triggerRecovery(`event ${result.kind}`);
    }
    // duplicate -> ignore
  }

  private triggerRecovery(reason: string): void {
    // Single-flight: coalesce any trigger while a recovery is in flight.
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    const generation = ++this.recoveryGeneration;
    // Invalidate any in-flight refresh; superseded responses must not mutate state.
    this.refreshGeneration++;
    this.refreshStatus = "idle";
    this.refreshError = null;
    this.refreshExhausted = false;
    this.closeEventSource();
    this.setStatus("recovering");
    void this.runRecovery(generation, reason);
  }

  /** Wait for a retry delay; returns false if the controller was stopped. */
  private async waitForRetry(ms: number): Promise<boolean> {
    try {
      await this.opts.sleep(ms, this.abortController.signal);
    } catch {
      // A cancellable sleep may reject on abort; treat it as cancellation.
    }
    return !this.stopped;
  }

  private async runRecovery(generation: number, reason: string): Promise<void> {
    let attempt = 0;
    while (!this.stopped && generation === this.recoveryGeneration) {
      try {
        const snapshot = await this.opts.fetchSnapshot();
        if (this.stopped || generation !== this.recoveryGeneration) return;
        // A stale or invalid recovery snapshot must not regress appliedRevision;
        // treat it as a failed attempt so bounded retry can fetch a fresh one.
        if (!this.applySnapshotIfCurrent(snapshot)) throw new Error("stale or invalid recovery snapshot");
        this.recovering = false;
        this.lastError = null;
        this.emitState();
        // Reconnect with ?since=; onopen will set live without needing a snapshot event.
        this.openStream(snapshot.revision);
        return;
      } catch (error) {
        if (this.stopped || generation !== this.recoveryGeneration) return;
        attempt++;
        if (attempt >= this.maxRecoveryAttempts) {
          this.recovering = false;
          this.lastError = `${reason}: ${errorMessage(error)}`;
          this.setStatus("error");
          return;
        }
        const delay = Math.min(
          this.recoveryBaseDelayMs * 2 ** (attempt - 1),
          this.recoveryMaxDelayMs
        );
        if (!(await this.waitForRetry(delay))) return;
      }
    }
  }

  private handleRefresh(): void {
    if (this.stopped || this.recovering || this.refreshExhausted) return;
    const generation = ++this.refreshGeneration;
    this.refreshStatus = "fetching";
    this.refreshError = null;
    this.emitState();
    void this.runRefresh(generation);
  }

  private async runRefresh(generation: number): Promise<void> {
    let attempt = 0;
    while (!this.stopped && generation === this.refreshGeneration && !this.recovering) {
      try {
        const snapshot = await this.opts.fetchSnapshot();
        // Superseded generation or recovery start: ignore completely, no mutation.
        if (this.stopped || generation !== this.refreshGeneration || this.recovering) return;
        if (!isSafeRevision(snapshot.revision)) throw new Error("invalid snapshot revision");
        if (snapshot.revision < this.appliedRevision) {
          // Current generation but stale: reject, mark stale, allow later periodic retry.
          this.refreshStatus = "stale";
          this.refreshError = "snapshot older than applied revision";
          this.emitState();
          return;
        }
        if (!this.applySnapshotIfCurrent(snapshot)) return; // defensive; guard above covers it
        this.refreshStatus = "idle";
        this.refreshError = null;
        if (this.awaitingInitialSnapshot) {
          // A refresh that arrives before the initial snapshot event still
          // supplies a validated snapshot — complete initial synchronization.
          this.awaitingInitialSnapshot = false;
          this.setStatus("live");
        } else {
          this.emitState();
        }
        return;
      } catch (error) {
        if (this.stopped || generation !== this.refreshGeneration || this.recovering) return;
        attempt++;
        if (attempt >= this.maxRefreshAttempts) {
          this.refreshStatus = "error";
          this.refreshError = errorMessage(error);
          this.refreshExhausted = true; // ignore periodic refresh until manual retry
          this.emitState();
          return;
        }
        if (!(await this.waitForRetry(this.refreshBaseDelayMs))) return;
      }
    }
  }
}
