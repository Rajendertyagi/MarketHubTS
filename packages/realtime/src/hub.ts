import type { LiveChangeEvent, LiveEventSource } from "@markethub/contracts";
import type {
  ClientSession, CursorInput, HubStats, LiveEventHubOptions, OpenStreamResult, OutboundEvent
} from "./types";

/** Approximate retained payload size. UTF-16 length is a deterministic, documented proxy for bytes. */
function estimateBytes(event: OutboundEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

interface QueuedEvent {
  outbound: OutboundEvent;
  bytes: number;
}

type ParsedCursor =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "value"; value: number };

function parseCursorValue(raw: string, reason: string): ParsedCursor {
  if (raw === "" || !/^\d+$/.test(raw)) return { kind: "invalid", reason };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return { kind: "invalid", reason };
  return { kind: "value", value };
}

/** Cursor precedence: Last-Event-ID is authoritative when present, even when empty. */
export function parseCursor(input: CursorInput): ParsedCursor {
  if (input.lastEventId !== undefined) return parseCursorValue(input.lastEventId, "invalid-last-event-id");
  if (input.since !== undefined) return parseCursorValue(input.since, "invalid-since");
  return { kind: "none" };
}

/**
 * One bounded per-client queue. Data events are bounded by count and bytes;
 * control events bypass those limits but are coalesced so they cannot grow
 * without bound. Overflow drops data events, records a counter, and emits one
 * coalesced snapshot-required signal while retaining the subscriber.
 */
class ClientQueue implements ClientSession {
  private readonly queue: QueuedEvent[] = [];
  private bytes = 0;
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private resyncRequired = false;
  private pendingSnapshotRequired = false;
  private pendingRefresh = false;
  droppedDataEvents = 0;

  constructor(
    readonly id: number,
    private readonly opts: LiveEventHubOptions,
    private readonly onDrop: (count: number) => void
  ) {}

  private drop(): void {
    this.droppedDataEvents++;
    this.onDrop(1);
  }

  pushData(outbound: OutboundEvent, bytes: number): void {
    if (this.closed) return;
    if (this.resyncRequired) {
      this.drop();
      return;
    }
    if (this.queue.length >= this.opts.clientMaxEvents || this.bytes + bytes > this.opts.clientMaxBytes) {
      this.drop();
      this.resyncRequired = true;
      this.pushControl({ event: "snapshot-required", data: { type: "snapshot-required", reason: "client-queue-overflow" } });
      return;
    }
    this.enqueue({ outbound, bytes });
  }

  /**
   * Initial snapshot is accounted against the client byte/count budget. Its
   * size is pre-validated in openStream(), so it always fits when called.
   */
  pushInitialSnapshot(outbound: OutboundEvent, bytes: number): void {
    if (this.closed) return;
    this.enqueue({ outbound, bytes });
  }

  /** Control events are small and coalesced; they are never blocked by a full data queue. */
  pushControl(outbound: OutboundEvent): void {
    if (this.closed) return;
    if (outbound.event === "snapshot-required") {
      if (this.pendingSnapshotRequired) return;
      this.pendingSnapshotRequired = true;
    } else if (outbound.event === "refresh") {
      if (this.pendingRefresh) return;
      this.pendingRefresh = true;
    }
    this.enqueue({ outbound, bytes: estimateBytes(outbound) });
  }

  private enqueue(item: QueuedEvent): void {
    this.queue.push(item);
    this.bytes += item.bytes;
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }

  next(): Promise<OutboundEvent | null> {
    if (this.queue.length) return Promise.resolve(this.dequeue());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(() => {
        if (this.queue.length) resolve(this.dequeue());
        else if (this.closed) resolve(null);
      });
    });
  }

  private dequeue(): OutboundEvent {
    const item = this.queue.shift()!;
    this.bytes -= item.bytes;
    if (item.outbound.event === "snapshot-required") this.pendingSnapshotRequired = false;
    if (item.outbound.event === "refresh") this.pendingRefresh = false;
    return item.outbound;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.bytes = 0;
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
  }
}

interface ReplayEntry {
  revision: number;
  outbound: OutboundEvent;
  bytes: number;
}

/**
 * Bounded replay history plus per-client queues over the canonical service's
 * change notifications. REST and SSE both read the same canonical snapshot;
 * this hub only transports compact revisioned events.
 */
export class LiveEventHub {
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly clients = new Map<number, ClientQueue>();
  private readonly history: ReplayEntry[] = [];
  private historyBytes = 0;
  private nextClientId = 1;
  private started = false;
  private totalDropped = 0;

  constructor(
    private readonly source: LiveEventSource,
    private readonly opts: LiveEventHubOptions
  ) {}

  private get timerScheduler() {
    return this.opts.timerScheduler ?? { setInterval, clearInterval };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.source.subscribe((event) => this.onChange(event));
    if (this.opts.refreshIntervalMs > 0) {
      this.timer = this.timerScheduler.setInterval(() => this.emitRefresh(), this.opts.refreshIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) {
      this.timerScheduler.clearInterval(this.timer);
      this.timer = null;
    }
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
    this.history.length = 0;
    this.historyBytes = 0;
  }

  private onChange(event: LiveChangeEvent): void {
    const outbound: OutboundEvent = { event: event.type, id: String(event.revision), data: event };
    const bytes = estimateBytes(outbound);
    this.history.push({ revision: event.revision, outbound, bytes });
    this.historyBytes += bytes;
    this.evictHistory();
    for (const client of this.clients.values()) client.pushData(outbound, bytes);
  }

  private evictHistory(): void {
    while (this.history.length > this.opts.replayMaxEvents || this.historyBytes > this.opts.replayMaxBytes) {
      const oldest = this.history.shift();
      if (!oldest) break;
      this.historyBytes -= oldest.bytes;
    }
  }

  /** Periodic freshness control event. Carries no data revision. */
  emitRefresh(): void {
    const outbound: OutboundEvent = { event: "refresh", data: { type: "refresh" } };
    for (const client of this.clients.values()) client.pushControl(outbound);
  }

  /**
   * Atomic replay-to-live registration: validation, boundary capture, subscriber
   * registration and initial queueing all happen in one synchronous section.
   */
  openStream(input: CursorInput): OpenStreamResult {
    const cursor = parseCursor(input);
    const snapshot = this.source.getSnapshot();
    const current = snapshot.revision;

    if (cursor.kind === "invalid") {
      return { outcome: "snapshot-required", reason: cursor.reason };
    }
    if (cursor.kind === "value") {
      if (cursor.value > current) {
        return { outcome: "snapshot-required", reason: "future-cursor" };
      }
      if (cursor.value < current) {
        const oldest = this.history[0]?.revision;
        if (oldest === undefined || oldest > cursor.value + 1) {
          return { outcome: "snapshot-required", reason: "expired-cursor" };
        }
      }
    }

    if (cursor.kind === "none") {
      // The initial snapshot is a full payload: validate it against the client
      // budget before registering a session. If it cannot fit, return a
      // deterministic snapshot-required so the client retrieves via REST.
      const snapshotEvent: OutboundEvent = {
        event: "snapshot", id: String(snapshot.revision), data: snapshot
      };
      const bytes = estimateBytes(snapshotEvent);
      if (bytes > this.opts.clientMaxBytes || 1 > this.opts.clientMaxEvents) {
        return { outcome: "snapshot-required", reason: "snapshot-exceeds-client-budget" };
      }
      const client = new ClientQueue(this.nextClientId++, this.opts, (n) => { this.totalDropped += n; });
      this.clients.set(client.id, client);
      client.pushInitialSnapshot(snapshotEvent, bytes);
      return { outcome: "session", session: client };
    }

    const client = new ClientQueue(this.nextClientId++, this.opts, (n) => { this.totalDropped += n; });
    this.clients.set(client.id, client);
    if (cursor.kind === "value" && cursor.value < current) {
      for (const entry of this.history) {
        if (entry.revision > cursor.value) client.pushData(entry.outbound, entry.bytes);
      }
    }

    return { outcome: "session", session: client };
  }

  closeSession(session: ClientSession): void {
    this.clients.delete(session.id);
    session.close();
  }

  getStats(): HubStats {
    // Cumulative across all clients, including those already disconnected.
    return {
      replayEvents: this.history.length,
      replayBytes: this.historyBytes,
      clients: this.clients.size,
      totalDroppedDataEvents: this.totalDropped
    };
  }
}
