/** SSE-ready outbound message. The route maps this directly to writeSSE(). */
export interface OutboundEvent {
  /** SSE event name: snapshot | item-updated | item-removed | provider-connection-changed | snapshot-required | refresh */
  event: string;
  /** SSE id — the canonical data revision for data/snapshot events; absent for control events. */
  id?: string;
  /** JSON payload. */
  data: unknown;
}

export interface LiveEventHubOptions {
  replayMaxEvents: number;
  replayMaxBytes: number;
  clientMaxEvents: number;
  clientMaxBytes: number;
  /** 0 disables the periodic refresh timer (useful in tests). */
  refreshIntervalMs: number;
  /** Narrow seam for deterministic refresh-timer control in tests. Defaults to globals. */
  timerScheduler?: IntervalScheduler;
}

/** Narrow interval-timer seam used by LiveEventHub. */
export interface IntervalScheduler {
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export interface CursorInput {
  /** Last-Event-ID header. undefined means the header was absent; "" is present-but-invalid. */
  lastEventId: string | undefined;
  /** ?since= query value, used only when the header is absent. */
  since: string | undefined;
}

export interface ClientSession {
  readonly id: number;
  /** Resolves with the next outbound event, or null once the session is closed. */
  next(): Promise<OutboundEvent | null>;
  close(): void;
  readonly droppedDataEvents: number;
}

export type OpenStreamResult =
  | { outcome: "session"; session: ClientSession }
  | { outcome: "snapshot-required"; reason: string };

export interface HubStats {
  replayEvents: number;
  replayBytes: number;
  clients: number;
  totalDroppedDataEvents: number;
}
