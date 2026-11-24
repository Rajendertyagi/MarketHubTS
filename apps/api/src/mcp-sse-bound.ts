import type { McpHttpHandler } from "@modelcontextprotocol/server";

/**
 * M6-D slow-consumer mitigation — application-owned bounded SSE response wrapper.
 *
 * The MCP SDK (2.4.0) enqueues every `subscriptions/listen` frame into the
 * response `ReadableStream` with a plain `controller.enqueue()` and exposes no
 * per-stream byte/frame cap. A client that stops reading but stays connected can
 * therefore grow that queue without limit.
 *
 * This module wraps the handler's `fetch` at the composition layer using only
 * public web-standard APIs (no SDK fork, no second event system). For SSE
 * responses it takes `response.body.getReader()` and runs an **application-owned
 * actively-drained bounded pull loop**: upstream chunks are read continuously,
 * independent of downstream pulls, into an explicit bounded buffer; the
 * downstream `ReadableStream` is fed from that buffer only as the consumer pulls.
 * Backpressure from a slow consumer therefore cannot stop the drain, and unread
 * bytes accumulate only in this capped buffer (never in the SDK queue).
 *
 * On overflow the wrapper calls `reader.cancel(reason)` on the upstream reader
 * (normative — this triggers the SDK's `cancel()` → `teardown(false)` → bus
 * unsubscribe + keepalive clear + open removal), then ends the downstream
 * response with a plain EOF. No completion frame is synthesized: the SDK owns
 * the subscription id, and the client recovers by re-opening `subscriptions/listen`
 * and re-reading the authoritative snapshot/feed (read-after-notify).
 *
 * The bound values are derived from sustained-load measurements recorded in
 * `docs/M6_D_FANOUT_EVIDENCE.md`; they are not arbitrary.
 */

/** Reason string reported on overflow (also used as the upstream cancel reason). */
export const SSE_OVERFLOW_REASON = "slow_consumer_bound_exceeded" as const;

/**
 * Per-subscription application-owned buffer caps. Derived from the sustained
 * healthy-burst envelope measured in `tests/mcp/slow-consumer.test.ts` (T5) and
 * recorded in `docs/M6_D_FANOUT_EVIDENCE.md` §7. Frames are counted as upstream
 * chunks (one SDK `writeFrame` enqueue = one frame, including keepalives).
 */
export const MCP_SSE_MAX_BUFFERED_BYTES = 16 * 1024; // 16 KiB
export const MCP_SSE_MAX_BUFFERED_FRAMES = 96;

export interface SseOverflowInfo {
  reason: typeof SSE_OVERFLOW_REASON;
  /** Buffered bytes at the moment the next chunk would have exceeded the cap. */
  bufferedBytes: number;
  /** Buffered frames at the moment the next chunk would have exceeded the cap. */
  bufferedFrames: number;
  maxBufferedBytes: number;
  maxBufferedFrames: number;
  /** Monotonic per-response id (diagnostic correlation only). */
  streamId: number;
}

export interface SseBufferSample {
  bufferedBytes: number;
  bufferedFrames: number;
  streamId: number;
}

export interface BoundedSseOptions {
  /** Max encoded SSE bytes held in the application-owned buffer per response. */
  maxBufferedBytes: number;
  /** Max SSE frames (upstream chunks) held in the application-owned buffer per response. */
  maxBufferedFrames: number;
  /** Best-effort diagnostic callback on overflow. Never throws into canonical paths. */
  onOverflow?: (info: SseOverflowInfo) => void;
  /**
   * Optional per-append diagnostic hook used for measurement/observability.
   * Not supplied in production composition.
   */
  onBuffered?: (sample: SseBufferSample) => void;
  /**
   * Diagnostic hook invoked when the upstream reader is cancelled (overflow or
   * consumer cancel). Used by tests to verify normative cancellation; not
   * supplied in production composition.
   */
  onUpstreamCancel?: (reason: unknown) => void;
}

let nextStreamId = 1;

function isSseResponse(response: Response): boolean {
  if (!response.body) return false;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("text/event-stream");
}

/**
 * Wrap a single web-standard Response. Non-SSE responses are returned unchanged.
 * SSE responses get an application-owned actively-drained bounded buffer.
 *
 * Scope note: this intentionally applies to ALL `text/event-stream` responses
 * from the MCP handler, not only `subscriptions/listen`. In the current MCP
 * 2026-07-28 handler, listen streams are the SSE surface (other responses are
 * JSON unless a mid-call notification upgrades them, which is not used here).
 * If a non-listen SSE endpoint is ever added, narrow this gate by route/method.
 */
export function boundSseResponse(response: Response, options: BoundedSseOptions): Response {
  if (!isSseResponse(response)) return response;

  const upstream = response.body!;
  const reader = upstream.getReader();
  const streamId = nextStreamId++;
  const { maxBufferedBytes, maxBufferedFrames } = options;

  const reportOverflow = (info: SseOverflowInfo): void => {
    try { options.onOverflow?.(info); } catch { /* diagnostics are best-effort */ }
  };
  const reportBuffered = (sample: SseBufferSample): void => {
    try { options.onBuffered?.(sample); } catch { /* diagnostics are best-effort */ }
  };

  let buffer: Uint8Array[] = [];
  let bufferedBytes = 0;
  let bufferedFrames = 0;
  let upstreamDone = false;
  let overflowed = false;
  let downstreamClosed = false;
  let drainStopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const waiters: Array<() => void> = [];

  const resolveWaiters = (): void => {
    const pending = waiters.splice(0, waiters.length);
    for (const resolve of pending) resolve();
  };

  const closeDownstream = (): void => {
    if (downstreamClosed) return;
    downstreamClosed = true;
    try { controller?.close(); } catch { /* already closed/errored */ }
  };

  const cancelUpstream = (reason: unknown): void => {
    if (drainStopped) return;
    drainStopped = true;
    try { options.onUpstreamCancel?.(reason); } catch { /* diagnostics best-effort */ }
    try { void reader.cancel(reason).catch(() => {}); } catch { /* best effort */ }
  };

  const downstream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    pull(c) {
      if (buffer.length > 0) {
        const chunk = buffer.shift()!;
        bufferedBytes -= chunk.byteLength;
        bufferedFrames -= 1;
        c.enqueue(chunk);
        return;
      }
      if (upstreamDone || overflowed) {
        closeDownstream();
        return;
      }
      // No buffered data yet: wait for the active drain loop to append or finish.
      return new Promise<void>((resolve) => { waiters.push(resolve); });
    },
    cancel(reason) {
      // Consumer cancelled (client disconnect): propagate to upstream so the SDK
      // teardown runs, and drop any buffered frames.
      buffer = [];
      bufferedBytes = 0;
      bufferedFrames = 0;
      resolveWaiters();
      cancelUpstream(reason);
    }
  });

  // Active drain loop — runs independently of downstream pulls so a slow
  // consumer cannot stop it via backpressure.
  void (async () => {
    try {
      while (!drainStopped) {
        const { done, value } = await reader.read();
        if (drainStopped) break;
        if (done) {
          upstreamDone = true;
          resolveWaiters();
          break;
        }
        if (!value) continue;

        // Check the cap BEFORE appending so the buffer never exceeds it.
        if (bufferedBytes + value.byteLength > maxBufferedBytes || bufferedFrames + 1 > maxBufferedFrames) {
          overflowed = true;
          reportOverflow({
            reason: SSE_OVERFLOW_REASON,
            bufferedBytes, bufferedFrames, maxBufferedBytes, maxBufferedFrames, streamId
          });
          // Drop queued frames: overflow ends this listen stream with a plain EOF
          // and the client re-reads authoritative state (read-after-notify).
          buffer = [];
          bufferedBytes = 0;
          bufferedFrames = 0;
          // Resolve any in-flight downstream pull so its read() ends with EOF
          // instead of hanging on a promise that will never be fulfilled.
          resolveWaiters();
          cancelUpstream(SSE_OVERFLOW_REASON);
          closeDownstream();
          break;
        }

        buffer.push(value);
        bufferedBytes += value.byteLength;
        bufferedFrames += 1;
        reportBuffered({ bufferedBytes, bufferedFrames, streamId });
        resolveWaiters();
      }
    } catch {
      // Upstream read error: end this response cleanly (plain EOF). The SDK's
      // own onerror seam reports enqueue errors; nothing throws into canonical
      // state from here.
      upstreamDone = true;
      resolveWaiters();
      closeDownstream();
    }
  })();

  return new Response(downstream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/**
 * Wrap an `McpHttpHandler` so SSE responses are bounded. The returned object
 * preserves the full handler shape: `fetch` is wrapped, `close`/`notify`/`bus`
 * are delegated unchanged. Apply this in composition before the bridge is
 * created so the bridge, the app and shutdown all use the same handler identity.
 */
export function wrapMcpHandlerFetch(handler: McpHttpHandler, options: BoundedSseOptions): McpHttpHandler {
  const originalFetch = handler.fetch;
  return {
    fetch: async (request: Request, requestOptions?: Parameters<McpHttpHandler["fetch"]>[1]) => {
      const response = await originalFetch(request, requestOptions);
      return boundSseResponse(response, options);
    },
    close: () => handler.close(),
    notify: handler.notify,
    bus: handler.bus
  };
}
