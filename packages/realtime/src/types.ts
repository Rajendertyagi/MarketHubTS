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

/**
 * Result of a stateless bounded read over retained replay history. Distinct
 * from OpenStreamResult: no client session is created and no SSE stream is
 * consumed. A normal page (including an empty one) has outcome "page"; a
 * cursor-recovery condition has outcome "snapshot-required" and must never be
 * reported as an empty successful page.
 */
export type FeedReadResult =
  | {
      outcome: "page";
      events: OutboundEvent[];
      /** Pagination continuation: present only when the lookahead row exists. */
      nextCursor: string | null;
      /** Always-present runtime-scoped checkpoint for the next read, including final and empty pages. */
      resumeCursor: string;
    }
  | { outcome: "snapshot-required"; reason: string };

export interface HubStats {
  replayEvents: number;
  replayBytes: number;
  clients: number;
  totalDroppedDataEvents: number;
}
