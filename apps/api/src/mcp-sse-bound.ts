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
 * responses it takes `response.body.getReader()` and runs an **independent
 * upstream drain loop** into an application-owned bounded FIFO queue. The
 * downstream `ReadableStream` is a standard (non-`direct`) Web Stream whose
 * `pull()` is a **synchronous demand signal**: it sets `pullWanted = true` and
 * calls `pump()`, which delivers queued chunks with `controller.enqueue()`.
 *
 * Why this shape (M6-E Design A): the previous wrapper's `pull()` returned a
 * pending promise when its buffer was empty, and the drain loop resolved that
 * promise WITHOUT calling `controller.enqueue()`. Per the WHATWG Streams spec,
 * fulfilling a pull promise does not re-invoke `pull()` unless `pullAgain` was
 * set; Bun's response-body sink issues exactly one outstanding read, so the
 * read request hung with the chunk stranded in the private buffer. Delivering
 * via `controller.enqueue()` on a synchronous demand signal is the exact fix.
 *
 * Backpressure from a slow consumer stops `pull()` from being called, so
 * `pullWanted` stays false and the queue accumulates up to the cap. Under
 * healthy demand the queue stays at 0–1 frames. No chunk bypasses the cap: the
 * check happens BEFORE append in the drain loop, which is the only append path
 * (there is no direct-delivery path). An oversized individual frame is treated
 * as overflow even when a consumer is ready.
 *
 * On overflow the wrapper calls `reader.cancel(reason)` on the upstream reader
 * (normative — this triggers the SDK's `cancel()` → `teardown(false)` → bus
 * unsubscribe + keepalive clear + open removal), drops queued frames, and ends
 * the downstream response with a plain EOF. No completion frame is synthesized:
 * the SDK owns the subscription id, and the client recovers by re-opening
 * `subscriptions/listen` and re-reading the authoritative snapshot/feed
 * (read-after-notify).
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
 * SSE responses get an application-owned bounded FIFO queue and a standard Web
 * Streams downstream with a synchronous `pull()` demand signal.
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

  // Application-owned bounded FIFO queue. The drain loop is the ONLY append
  // path, so every chunk passes the byte/frame cap check before it can be
  // enqueued downstream — including when a consumer is ready (no bypass).
  let queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let queuedFrames = 0;
  let upstreamDone = false;
  let overflowed = false;
  let downstreamClosed = false;
  let drainStopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let pullWanted = false;

  const dropQueue = (): void => {
    queue = [];
    queuedBytes = 0;
    queuedFrames = 0;
  };

  const closeDownstream = (): void => {
    if (downstreamClosed) return;
    downstreamClosed = true;
    try { controller?.close(); } catch { /* already closed/errored */ }
  };

  /** Idempotent: releases the SDK reader/subscription exactly once. */
  const cancelUpstream = (reason: unknown): void => {
    if (drainStopped) return;
    drainStopped = true;
    try { options.onUpstreamCancel?.(reason); } catch { /* diagnostics best-effort */ }
    try { void reader.cancel(reason).catch(() => {}); } catch { /* best effort */ }
  };

  /**
   * Deliver queued chunks only while the consumer has signalled demand. One
   * enqueue consumes one demand signal; the next consumer `read()` re-invokes
   * `pull()` and re-arms it. This is the exact stall fix: data is delivered via
   * `controller.enqueue()`, never by resolving a waiter promise. Safe under
   * concurrent producer/consumer activity because all state is synchronous and
   * single-threaded between awaits in the drain loop.
   */
  const pump = (): void => {
    while (pullWanted && queue.length > 0 && !downstreamClosed) {
      const chunk = queue.shift()!;
      queuedBytes -= chunk.byteLength;
      queuedFrames -= 1;
      pullWanted = false; // one enqueue consumes one demand signal
      try {
        controller!.enqueue(chunk);
      } catch {
        // Downstream closed/errored between the guard and enqueue (concurrent
        // cancel): drop everything and stop.
        downstreamClosed = true;
        dropQueue();
        return;
      }
    }
    // Graceful SDK completion: the SDK writes its completion frame upstream,
    // the drain sees EOF, and the wrapper closes only after every queued byte
    // has been handed to the consumer (plain EOF, no synthesized frame).
    if (upstreamDone && queue.length === 0 && !downstreamClosed) closeDownstream();
  };

  const downstream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    pull() {
      // Synchronous demand signal — NEVER return a pending promise.
      pullWanted = true;
      pump();
    },
    cancel(reason) {
      // Consumer cancelled (client disconnect): drop queued frames and
      // propagate to upstream so the SDK teardown runs exactly once.
      dropQueue();
      cancelUpstream(reason);
    }
  });

  // Independent upstream drain loop — runs continuously, not driven by
  // downstream demand, so a slow consumer cannot stop it via backpressure.
  void (async () => {
    try {
      while (!drainStopped) {
        const { done, value } = await reader.read();
        if (drainStopped) break;
        if (done) {
          upstreamDone = true;
          pump(); // deliver any frames still owed, then close on plain EOF
          break;
        }
        if (!value) continue;

        // Cap check BEFORE append — no chunk bypasses this on any path. An
        // oversized individual frame is overflow even if a consumer is ready.
        if (queuedBytes + value.byteLength > maxBufferedBytes || queuedFrames + 1 > maxBufferedFrames) {
          overflowed = true;
          reportOverflow({
            reason: SSE_OVERFLOW_REASON,
            bufferedBytes: queuedBytes, bufferedFrames: queuedFrames,
            maxBufferedBytes, maxBufferedFrames, streamId
          });
          dropQueue();
          cancelUpstream(SSE_OVERFLOW_REASON);
          closeDownstream(); // plain EOF, no synthesized completion frame
          break;
        }

        queue.push(value);
        queuedBytes += value.byteLength;
        queuedFrames += 1;
        reportBuffered({ bufferedBytes: queuedBytes, bufferedFrames: queuedFrames, streamId });
        pump();
      }
    } catch {
      // Upstream read error: end this response cleanly (plain EOF). The SDK's
      // own onerror seam reports enqueue errors; nothing throws into canonical
      // state from here.
      upstreamDone = true;
      dropQueue();
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
