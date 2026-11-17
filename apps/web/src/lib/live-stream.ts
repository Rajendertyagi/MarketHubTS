import type { LiveSnapshot } from "@markethub/contracts";
import { applyDataEvent, isSafeRevision, parseSseMessage } from "./live";

/** Minimal EventSource surface so tests can supply a deterministic fake. */
export interface EventSourceLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

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
  fetchSnapshot: () => Promise<LiveSnapshot>;
  sleep: (ms: number) => Promise<void>;
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
 * effect lifecycle; stop() is terminal for that instance. All callbacks from
 * a superseded EventSource are inert via streamGeneration checks.
 */
export class LiveStreamController {
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryBaseDelayMs: number;
  private readonly recoveryMaxDelayMs: number;
  private readonly maxRefreshAttempts: number;
  private readonly refreshBaseDelayMs: number;

  private stopped = false;
  private streamGeneration = 0;
  private recoveryGeneration = 0;
  private refreshGeneration = 0;
  private eventSource: EventSourceLike | null = null;
  private recovering = false;
  private refreshExhausted = false;

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
    this.openStream(null);
  }

  /** Terminal for this instance: invalidate all callbacks and cancel work. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
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

  /** Manual retry after refresh retry exhaustion. */
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

  private closeEventSource(): void {
    const current = this.eventSource;
    this.eventSource = null;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      try { current.close(); } catch { /* already closed */ }
    }
  }

  private openStream(cursor: number | null): void {
    if (this.stopped) return;
    const generation = ++this.streamGeneration;
    this.closeEventSource();
    this.setStatus("connecting");

    const url = cursor === null
      ? "/api/market/stream"
      : `/api/market/stream?since=${cursor}`;
    const source = this.opts.createEventSource(url);
    this.eventSource = source;

    source.onopen = () => {
      if (generation !== this.streamGeneration || this.stopped) return;
      // After a validated REST recovery snapshot, onopen alone is sufficient
      // to enter live — a ?since= stream may send no snapshot event at all.
      this.setStatus("live");
    };
    source.onmessage = (message) => {
      if (generation !== this.streamGeneration || this.stopped) return;
      this.handleMessage(message);
    };
    source.onerror = () => {
      if (generation !== this.streamGeneration || this.stopped) return;
      this.triggerRecovery("SSE transport error");
    };
  }

  private handleMessage(message: { data: string; lastEventId: string }): void {
    const parsed = parseSseMessage(message.lastEventId, message.data);
    if (parsed.kind === "invalid") {
      this.triggerRecovery(`invalid SSE message: ${parsed.reason}`);
      return;
    }
    if (parsed.kind === "control") {
      if (parsed.control === "snapshot-required") this.triggerRecovery("snapshot-required");
      else this.handleRefresh();
      return;
    }
    if (parsed.kind === "snapshot") {
      if (!isSafeRevision(parsed.snapshot.revision)) {
        this.triggerRecovery("unsafe snapshot revision");
        return;
      }
      this.snapshot = parsed.snapshot;
      this.appliedRevision = parsed.snapshot.revision;
      this.opts.onSnapshot(parsed.snapshot);
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

  private async runRecovery(generation: number, reason: string): Promise<void> {
    let attempt = 0;
    while (!this.stopped && generation === this.recoveryGeneration) {
      try {
        const snapshot = await this.opts.fetchSnapshot();
        if (this.stopped || generation !== this.recoveryGeneration) return;
        if (!isSafeRevision(snapshot.revision)) throw new Error("invalid snapshot revision");
        this.snapshot = snapshot;
        this.appliedRevision = snapshot.revision;
        this.opts.onSnapshot(snapshot);
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
        await this.opts.sleep(delay);
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
        this.snapshot = snapshot;
        this.appliedRevision = snapshot.revision;
        this.opts.onSnapshot(snapshot);
        this.refreshStatus = "idle";
        this.refreshError = null;
        this.emitState();
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
        await this.opts.sleep(this.refreshBaseDelayMs);
      }
    }
  }
}
