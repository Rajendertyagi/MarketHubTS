import { createHash } from "node:crypto";
import { istDateString, type CatalogSyncResult, type ProviderId } from "@markethub/contracts";
import type { CatalogRepository } from "../types";
import { CatalogSyncService } from "./apply";
import {
  FyersImportAccumulator, FYERS_MASTER_URLS, FYERS_SOURCE, type FyersMasterSegment
} from "./fyers-master";
import { validateCompleteImportReport, type ProviderImportReport } from "./import-report";
import { UpstoxImportAccumulator, UPSTOX_MASTER_URL, UPSTOX_SOURCE } from "./upstox-master";

const FETCH_TIMEOUT_MS = 20_000;
const PROVIDERS: ProviderId[] = ["UPSTOX", "FYERS"];
/** Small app-owned daily trigger: 30 minutes, well inside the 15–60 min range. */
const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Bounded sanity limits for the Upstox streaming pipeline (WP2-A). These are
 * deliberately generous relative to the verified baseline (64,158,142 B
 * decompressed / 136,631 rows) so a legitimate future master still imports;
 * they exist to fail closed on runaway or malicious sources, not to cap the
 * supported catalogue. They are module constants, not a new configuration
 * surface (plan §WP2-C).
 */
const UPSTOX_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const UPSTOX_MAX_ROWS = 1_000_000;
const UPSTOX_MAX_ELEMENT_CHARS = 4 * 1024 * 1024;

/**
 * Bounded sanity limits for the FYERS streaming pipeline (WP2-B). Deliberately
 * generous relative to the verified baseline (NSE_FO 90,878,119 B / 87,577
 * rows; BSE_FO 10,556,944 B / 9,875; NSE_CM 11,268,482 B / 10,210; BSE_CM
 * 14,698,626 B / 13,019 — 127,402,171 B / 120,681 rows in total) so a
 * legitimate future master still imports; they exist to fail closed on runaway
 * or malicious sources, not to cap the supported catalogue. Module constants,
 * not a new configuration surface (plan §WP2-C).
 */
const FYERS_MAX_SEGMENT_BYTES = 256 * 1024 * 1024;
const FYERS_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const FYERS_MAX_ROWS = 1_000_000;
const FYERS_MAX_ELEMENT_CHARS = 4 * 1024 * 1024;

/**
 * Combine a per-run cancellation signal with the unconditional fetch timeout.
 * `AbortSignal.any` is available in the supported Bun 1.4.5 runtime (verified);
 * the manual fallback keeps the helper safe on any runtime that lacks it.
 * Without this, a run-owned controller would silently drop the 20 s timeout.
 */
function combinedFetchSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const combined = new AbortController();
  const abort = () => combined.abort();
  signal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  if (signal.aborted || timeout.aborted) combined.abort();
  return combined.signal;
}

/**
 * Explicit refresh-owner lifecycle (WP3-A). `RUNNING` accepts starts; `STOPPING`
 * is entered atomically at the first stop call and rejects new work; `STOPPED`
 * is reached only after every active task has settled. Exposed for tests and
 * diagnostics via `CatalogMasterRefresh.state`.
 */
export type CatalogRefreshState = "RUNNING" | "STOPPING" | "STOPPED";

export interface CatalogRefreshEvent {
  provider: ProviderId;
  /** `CANCELLED` is distinct from `FAILED`: shutdown cancellation never means a
   * provider failure and is never recorded as a successful refresh. */
  outcome: "SKIPPED" | "REFRESHED" | "FAILED" | "DIAGNOSTIC" | "CANCELLED";
  reason?: string;
  status?: string;
  counts?: Record<string, number>;
}

export type MasterFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * G0-B — structured outcome of one provider's download→parse→validate→apply
 * pipeline. It carries no large payloads and no live objects, so it can cross
 * the child IPC boundary. `applyAttempted` distinguishes an apply-time failure
 * (the sync already recorded its diagnostic) from a pipeline-time failure (the
 * parent must record the diagnostic).
 */
export interface ProviderPipelineOutcome {
  status: string;
  counts: Record<string, number>;
  sourceVersion?: string;
  conflicts?: string[];
  error?: string;
  cancelled: boolean;
  applyAttempted: boolean;
}

/** Options for the reusable pipeline core (in-process or child). */
export interface ProviderPipelineOptions {
  provider: ProviderId;
  nowIso: string;
  fetchFn: MasterFetch;
  sync: CatalogSyncService;
  signal?: AbortSignal;
  /** Parent-generated run ID threaded into `applyCompleteProviderSnapshot`. */
  runId?: string;
  onProgress?: (phase: "DOWNLOAD" | "PARSE" | "VALIDATE" | "AWAIT_TXN_GRANT" | "TXN" | "SETTLED") => void;
  /** Child-only hook: awaited immediately before the atomic apply (txn-granted ack). */
  beforeApply?: () => Promise<void>;
}

/**
 * Parent-side seam that executes one provider run (G0-B: via the child manager).
 * Implementations MUST construct their `CatalogSyncService` in child mode
 * (`disableDiagnosticRunRecording: true`): the parent owns every terminal
 * diagnostic record. An outcome with `applyAttempted: true` means the sync
 * already recorded its own failure inside the atomic apply path, so the parent
 * must not record a second one.
 */
export interface RefreshExecutorParams {
  provider: ProviderId;
  runId: string;
  nowIso: string;
  signal: AbortSignal;
}
export type RefreshExecutor = (params: RefreshExecutorParams) => Promise<ProviderPipelineOutcome>;

/**
 * Diagnostic high-water marks for the most recent Upstox streaming ingestion.
 * Test/diagnostic only — not part of the public package API and not exposed to
 * any consumer. `maxParserBufferChars` is the largest *transient* decompressed
 * text fragment held by the parser: a partial element plus the most recently
 * appended chunk, measured on buffer growth before compaction. It is bounded
 * by one source row plus one stream chunk, never by the full source.
 */
export interface UpstoxStreamMetrics {
  maxParserBufferChars: number;
  maxDecompressedBytes: number;
  rowsStreamed: number;
}

let lastUpstoxStreamMetrics: UpstoxStreamMetrics | null = null;

/** Returns the most recent Upstox streaming metrics (diagnostic only). */
export function getLastUpstoxStreamMetrics(): UpstoxStreamMetrics | null {
  return lastUpstoxStreamMetrics;
}

/**
 * Diagnostic high-water marks for the most recent FYERS streaming ingestion.
 * Test/diagnostic only — not part of the public package API and not exposed to
 * any consumer. `maxParserBufferChars` is the largest *transient* text fragment
 * held by the keyed-object parser (a partial pair plus the most recently
 * appended chunk, measured on buffer growth before compaction). It is bounded
 * by one source row plus one stream chunk, never by the full source.
 *
 * The `retained*` counters describe a different, unavoidable working set: the
 * in-scope candidate objects the importer must keep until `finish()` can resolve
 * underlyings and emit the final snapshot. They are deterministic row counts
 * (not allocation accounting and not an RSS claim); the retained population is
 * bounded by the supported catalogue, not by the full source size.
 */
export interface FyersStreamMetrics {
  maxParserBufferChars: number;
  maxSegmentBytes: number;
  totalBytes: number;
  rowsStreamed: number;
  /** In-scope FO option rows retained by the accumulator at stream end. */
  retainedOptionCandidates: number;
  /** Referenced CM rows retained by the accumulator at stream end. */
  retainedCashCandidates: number;
  /** Peak combined retained candidate rows across the whole ingestion. */
  maxRetainedCandidates: number;
}

let lastFyersStreamMetrics: FyersStreamMetrics | null = null;

/** Returns the most recent FYERS streaming metrics (diagnostic only). */
export function getLastFyersStreamMetrics(): FyersStreamMetrics | null {
  return lastFyersStreamMetrics;
}

export interface CatalogMasterRefreshOptions {
  catalog: CatalogRepository;
  sync: CatalogSyncService;
  now?: (() => Date) | undefined;
  fetch?: MasterFetch | undefined;
  onEvent?: ((event: CatalogRefreshEvent) => void) | undefined;
  /** Interval for the in-process daily trigger. Defaults to 30 minutes. */
  refreshIntervalMs?: number | undefined;
  /** G0-B: when set, provider runs are executed through this seam (the child
   * manager in production). Scheduling, single-flight, freshness and diagnostic
   * recording stay parent-side either way. */
  executor?: RefreshExecutor | undefined;
}

/**
 * App-owned, single-flight, at-most-once-per-India-market-date refresh of the
 * public provider master files. No credentials, no generic scheduler, no queue.
 * Failures keep the last successfully imported catalogue.
 */
export class CatalogMasterRefresh {
  private readonly catalog: CatalogRepository;
  private readonly sync: CatalogSyncService;
  private readonly now: () => Date;
  private readonly fetchFn: MasterFetch;
  private readonly onEvent: ((event: CatalogRefreshEvent) => void) | undefined;
  private readonly refreshIntervalMs: number;
  private readonly executor: RefreshExecutor | undefined;
  private readonly inFlight = new Map<ProviderId, Promise<void>>();
  /** One controller per active run; aborted on STOPPING (WP3-A item 4). */
  private readonly controllers = new Map<ProviderId, AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lifecycleState: CatalogRefreshState = "RUNNING";
  /** Shared drain promise so `stop()` and `stopAndWait()` are idempotent. */
  private drainPromise: Promise<void> | null = null;

  constructor(options: CatalogMasterRefreshOptions) {
    this.catalog = options.catalog;
    this.sync = options.sync;
    this.now = options.now ?? (() => new Date());
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.onEvent = options.onEvent;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.executor = options.executor;
  }

  /** Observable lifecycle state (WP3-A item 1). */
  get state(): CatalogRefreshState {
    return this.lifecycleState;
  }

  /**
   * Non-blocking: starts the single app-owned daily trigger (once) and fires
   * an immediate refresh attempt for each provider. Rejected once STOPPING or
   * STOPPED (WP3-A item 2).
   */
  startIfNeeded(): void {
    if (this.lifecycleState !== "RUNNING") return;
    this.ensureTimer();
    for (const provider of PROVIDERS) this.kickOff(provider);
  }

  /**
   * Fire-and-forget with observable error handling: `refreshProvider` resolves
   * on every internal path, but a defensive catch guarantees no unhandled
   * rejection can escape the scheduling seam (WP3 listener-first constraint).
   */
  private kickOff(provider: ProviderId): void {
    void this.refreshProvider(provider).catch((error: unknown) => {
      this.emit({
        provider,
        outcome: "FAILED",
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      });
    });
  }

  /**
   * Legacy synchronous stop. Enters STOPPING atomically, clears timers and
   * aborts active runs, then drains in the background. The public contract is
   * unchanged (void, non-blocking); callers that must wait use `stopAndWait`.
   */
  stop(): void {
    this.beginStop();
    void this.drainPromise?.catch(() => { /* observable via stopAndWait */ });
  }

  /**
   * Explicit drain guarantee (WP3-A item 8): resolves only after every active
   * refresh task has settled. Idempotent — repeated calls await the same drain.
   */
  async stopAndWait(): Promise<void> {
    this.beginStop();
    if (this.drainPromise) await this.drainPromise;
  }

  /** Steps 1, 3, 4 and 8 of the shutdown contract; safe to call repeatedly. */
  private beginStop(): void {
    if (this.lifecycleState !== "RUNNING") return;
    // 1) Atomic, observable transition. All later steps run from STOPPING.
    this.lifecycleState = "STOPPING";
    // 3) Clear every future timer so no scheduled refresh can fire again.
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 4) Abort every active run's controller; cancellation propagates through
    // fetch/decompress/parse/staging via the signal threaded into doRefresh.
    for (const controller of this.controllers.values()) {
      try { controller.abort(); } catch { /* best effort */ }
    }
    // 8) Start the single drain; new tasks are impossible once STOPPING.
    this.drainPromise = this.drain();
  }

  private async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
    // 9/10) Only now is it safe for the owner to report STOPPED; the caller
    // closes the database after stopAndWait resolves.
    this.lifecycleState = "STOPPED";
  }

  /** One small in-process timer; every tick reuses the same single-flight path. */
  private ensureTimer(): void {
    if (this.lifecycleState !== "RUNNING" || this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.lifecycleState !== "RUNNING") return;
      for (const provider of PROVIDERS) this.kickOff(provider);
    }, this.refreshIntervalMs);
    // Do not keep the process alive solely for this diagnostic refresh.
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  private async refreshProvider(provider: ProviderId): Promise<void> {
    if (this.lifecycleState !== "RUNNING" || this.inFlight.has(provider)) return;
    const controller = new AbortController();
    this.controllers.set(provider, controller);
    const task = this.doRefresh(provider, controller.signal).finally(() => {
      this.inFlight.delete(provider);
      this.controllers.delete(provider);
    });
    this.inFlight.set(provider, task);
    await task;
  }

  private async doRefresh(provider: ProviderId, signal: AbortSignal): Promise<void> {
    // Cancellation is checked only at well-defined boundaries. Once the atomic
    // DB transaction starts it is never abandoned mid-flight (WP3-A item 7).
    if (signal.aborted) return this.emitCancelled(provider);

    // Read-only freshness check stays parent-side and pre-spawn (plan §4.3 step 1).
    // The child never runs it and writes no run record for a skip.
    const today = istDateString(this.now().getTime());
    try {
      const runs = await this.catalog.listSyncRuns({ provider, status: "COMPLETED", limit: 1 });
      const last = runs[0];
      if (last) {
        const lastDate = istDateString(Date.parse(last.finishedAt ?? last.startedAt));
        if (lastDate === today) {
          this.emit({ provider, outcome: "SKIPPED", reason: "ALREADY_REFRESHED_TODAY" });
          return;
        }
      }
    } catch {
      // A freshness lookup failure is diagnostic only: it is not positive
      // evidence of a successful refresh today, so still attempt the refresh.
      this.emit({ provider, outcome: "DIAGNOSTIC", reason: "FRESHNESS_LOOKUP_FAILED" });
    }
    if (signal.aborted) return this.emitCancelled(provider);

    const nowIso = this.now().toISOString();
    if (this.executor) return this.doRefreshViaExecutor(provider, signal, nowIso);

    // In-process path (regression): same shared pipeline core, parent-owned
    // diagnostics. `applyAttempted` prevents a second FAILED row when the sync
    // already recorded one inside its failure path.
    try {
      const outcome = await this.runPipelineCore({
        provider, nowIso, fetchFn: this.fetchFn, sync: this.sync, signal
      });
      if (outcome.cancelled || signal.aborted) return this.emitCancelled(provider);
      if (outcome.status === "COMPLETED") {
        this.emit({ provider, outcome: "REFRESHED", status: outcome.status, counts: outcome.counts });
      } else {
        if (!outcome.applyAttempted) {
          await this.recordDiagnosticFailure(provider, nowIso, outcome.error ?? "refresh failed");
        }
        this.emit({
          provider, outcome: "FAILED", status: outcome.status, counts: outcome.counts,
          ...(outcome.error ? { reason: outcome.error } : {})
        });
      }
    } catch (e) {
      if (signal.aborted) return this.emitCancelled(provider);
      const message = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      await this.recordDiagnosticFailure(provider, nowIso, message);
      this.emit({ provider, outcome: "FAILED", reason: message });
    }
  }

  /** G0-B: execute one provider run through the injected child seam. The parent
   * generates the run ID, owns scheduling/freshness and records every terminal
   * diagnostic after the child settles (decision (a)). Executor implementations
   * must run their sync in child mode (diagnostic recorder disabled); when an
   * outcome reports `applyAttempted: true` the sync already recorded the failure
   * inside its atomic apply path, so recording here too would double-record. */
  private async doRefreshViaExecutor(
    provider: ProviderId, signal: AbortSignal, nowIso: string
  ): Promise<void> {
    const runId = crypto.randomUUID();
    try {
      const outcome = await this.executor!({ provider, runId, nowIso, signal });
      if (outcome.cancelled || signal.aborted) return this.emitCancelled(provider);
      if (outcome.status === "COMPLETED") {
        this.emit({ provider, outcome: "REFRESHED", status: outcome.status, counts: outcome.counts });
      } else {
        // Same contract as the in-process path: only pipeline-time failures
        // (apply not attempted) get a parent diagnostic row. Apply-time failures
        // were already recorded by the child-mode sync inside the transaction.
        if (!outcome.applyAttempted) {
          await this.recordDiagnosticFailure(provider, nowIso, outcome.error ?? `refresh ${outcome.status}`);
        }
        this.emit({
          provider, outcome: "FAILED", status: outcome.status, counts: outcome.counts,
          ...(outcome.error ? { reason: outcome.error } : {})
        });
      }
    } catch (e) {
      if (signal.aborted) return this.emitCancelled(provider);
      const message = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      await this.recordDiagnosticFailure(provider, nowIso, message);
      this.emit({ provider, outcome: "FAILED", reason: message });
    }
  }

  /** Parent-owned diagnostic FAILED record (autocommit, outside any tx). */
  private async recordDiagnosticFailure(
    provider: ProviderId, startedAt: string, message: string
  ): Promise<void> {
    const source = provider === "UPSTOX" ? UPSTOX_SOURCE : FYERS_SOURCE;
    try {
      await this.catalog.recordSyncRun?.({
        runId: crypto.randomUUID(),
        source,
        provider,
        scopeJson: JSON.stringify({ source }),
        completeness: "COMPLETE",
        status: "FAILED",
        startedAt,
        finishedAt: this.now().toISOString(),
        countsJson: JSON.stringify({}),
        conflictsJson: JSON.stringify([{ type: "REFRESH_FAILED", severity: "ERROR", message }]),
        error: message
      });
    } catch {
      // best effort
    }
  }

  /**
   * G0-B shared pipeline core: download → parse → validate → apply. No freshness
   * check and no diagnostic run record live here — both are parent-owned. The
   * parsing/validation/apply semantics are the pre-existing ones; only the
   * process boundary (which caller invokes them) moved.
   */
  async runPipelineCore(options: ProviderPipelineOptions): Promise<ProviderPipelineOutcome> {
    const { provider, nowIso, fetchFn, sync, signal, runId, onProgress, beforeApply } = options;
    if (signal?.aborted) return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted: false };
    let applyAttempted = false;
    try {
      if (provider === "UPSTOX") {
        onProgress?.("DOWNLOAD");
        const accumulator = new UpstoxImportAccumulator();
        const { sourceVersion, lastModified } = await this.streamUpstoxInto(
          accumulator, UPSTOX_MASTER_URL, signal, fetchFn
        );
        if (signal?.aborted) return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted };
        onProgress?.("PARSE");
        const { batch, reconciliation, report } = accumulator.finish({
          now: nowIso,
          sourceVersion,
          ...(lastModified ? { sourceObservedAt: lastModified } : {})
        });
        onProgress?.("VALIDATE");
        this.assertValidCompleteImport(report, "UPSTOX");
        if (signal?.aborted) return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted };
        if (beforeApply) { onProgress?.("AWAIT_TXN_GRANT"); await beforeApply(); }
        onProgress?.("TXN");
        applyAttempted = true;
        const result = await sync.applyCompleteProviderSnapshot(batch, reconciliation, runId);
        onProgress?.("SETTLED");
        if (signal?.aborted) return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted };
        return this.outcomeFromResult(result, sourceVersion, applyAttempted);
      }
      onProgress?.("DOWNLOAD");
      const accumulator = new FyersImportAccumulator();
      const { sourceVersion } = await this.streamFyersInto(accumulator, signal, fetchFn);
      if (signal?.aborted) return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted };
      onProgress?.("PARSE");
      // FYERS derives its source data date from in-scope lastUpdate values;
      // a local fetch time must never be substituted (sourceObservedAt is
      // intentionally not passed).
      const { batch, reconciliation, report } = accumulator.finish({ now: nowIso, sourceVersion });
      onProgress?.("VALIDATE");
      this.assertValidCompleteImport(report, "FYERS");
      if (signal?.aborted) return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted };
      if (beforeApply) { onProgress?.("AWAIT_TXN_GRANT"); await beforeApply(); }
      onProgress?.("TXN");
      applyAttempted = true;
      const result = await sync.applyCompleteProviderSnapshot(batch, reconciliation, runId);
      onProgress?.("SETTLED");
      if (signal?.aborted) return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted };
      return this.outcomeFromResult(result, sourceVersion, applyAttempted);
    } catch (e) {
      if (signal?.aborted) return { status: "CANCELLED", counts: {}, cancelled: true, applyAttempted };
      const message = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      return { status: "FAILED", counts: {}, error: message, cancelled: false, applyAttempted };
    }
  }

  private outcomeFromResult(
    result: CatalogSyncResult, sourceVersion: string | undefined, applyAttempted: boolean
  ): ProviderPipelineOutcome {
    return {
      status: result.status,
      counts: result.counts,
      ...(sourceVersion ? { sourceVersion } : {}),
      ...(result.conflicts?.length
        ? { conflicts: result.conflicts.map((c) => c.message.slice(0, 300)).slice(0, 64) }
        : {}),
      ...(result.error ? { error: result.error.slice(0, 300) } : {}),
      cancelled: false,
      applyAttempted
    };
  }

  /** Distinct cancellation record — never FAILED, never REFRESHED, no DB touch. */
  private emitCancelled(provider: ProviderId): void {
    this.emit({ provider, outcome: "CANCELLED", reason: "SHUTDOWN_CANCELLED" });
  }

  /**
   * WP2-A bounded Upstox ingestion. Streams the response body, incrementally
   * decompresses gzip, incrementally parses the top-level JSON array into one
   * element at a time, hashes the decompressed bytes incrementally, and feeds
   * each element into the shared importer accumulator.
   *
   * Failure paths (all fail closed — no partial snapshot reaches reconciliation):
   *  - non-2xx (including an unexpected 304): HTTP error;
   *  - HTML/other clearly wrong content type: rejected before parsing;
   *  - empty body, truncated gzip, malformed/truncated JSON, unexpected shapes:
   *    parser/decompressor error;
   *  - decompressed byte / row / element limits exceeded: explicit error;
   *  - cancellation via `signal`: checked between chunks and passed to fetch.
   */
  private async streamUpstoxInto(
    accumulator: UpstoxImportAccumulator,
    url: string,
    signal: AbortSignal | undefined,
    fetchFn: MasterFetch = this.fetchFn
  ): Promise<{ sourceVersion: string; lastModified?: string }> {
    const response = await fetchFn(url, {
      signal: combinedFetchSignal(signal)
    });
    if (!response.ok) throw new Error(`Master download failed: HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html")) {
      throw new Error("Master download returned an unexpected content type");
    }
    const lastModified = sourceDateFromHeader(response.headers.get("last-modified"));
    if (!response.body) throw new Error("Master download had no body");

    const reader = response.body.getReader();
    const first = await reader.read().catch((e: unknown) => {
      try { reader.releaseLock(); } catch { /* best effort */ }
      throw e;
    });
    if (first.done || !first.value || first.value.length === 0) {
      try { reader.releaseLock(); } catch { /* best effort */ }
      throw new Error("Master download was empty");
    }
    const isGzip = first.value[0] === 0x1f && first.value[1] === 0x8b;
    const firstChunk = first.value;

    // Replay the already-read first chunk, then the remainder of the body.
    // `pull`-driven construction preserves fetch backpressure: no chunk is
    // buffered ahead of the consumer.
    async function* rawChunks(): AsyncGenerator<Uint8Array<ArrayBuffer>> {
      yield firstChunk;
      while (true) {
        const r = await reader.read();
        if (r.done) return;
        yield r.value;
      }
    }

    let byteStream: ReadableStream<Uint8Array<ArrayBuffer>> = toReadableStream(rawChunks());
    if (isGzip) {
      // TS 7 types DecompressionStream's readable as Uint8Array<ArrayBufferLike>;
      // its runtime chunks are Uint8Array<ArrayBuffer>. Narrow with a local cast.
      byteStream = byteStream.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array<ArrayBuffer>>;
    }

    const hasher = new IncrementalSha256();
    // Fatal decoding: invalid UTF-8 is a malformed source and must fail closed.
    // For valid UTF-8 (the only case that can produce a successful import) the
    // decompressed bytes are exactly TextEncoder.encode(text), so the hash is
    // byte-identical to the previous sha256(decompressed text) contract.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parser = new JsonArrayElementParser();
    let decompressedBytes = 0;
    let rows = 0;

    const consume = (element: unknown): void => {
      rows++;
      if (rows > UPSTOX_MAX_ROWS) throw new Error("Upstox master exceeded row limit");
      accumulator.addRow(element);
    };

    try {
      for await (const chunk of byteStream) {
        if (signal?.aborted) throw new Error("Upstox master download cancelled");
        decompressedBytes += chunk.byteLength;
        if (decompressedBytes > UPSTOX_MAX_DECOMPRESSED_BYTES) {
          throw new Error("Upstox master exceeded decompressed byte limit");
        }
        hasher.update(chunk);
        const text = decoder.decode(chunk, { stream: true });
        for (const element of parser.push(text)) consume(element);
      }
      const tail = decoder.decode();
      if (tail) for (const element of parser.push(tail)) consume(element);
      parser.finish();
      lastUpstoxStreamMetrics = {
        maxParserBufferChars: parser.maxBufferedChars,
        maxDecompressedBytes: decompressedBytes,
        rowsStreamed: rows
      };
    } finally {
      try { reader.releaseLock(); } catch { /* best effort */ }
    }

    return { sourceVersion: hasher.digest(), ...(lastModified ? { lastModified } : {}) };
  }

  /**
   * WP2-B bounded FYERS ingestion. Fetches the four official segment files
   * strictly sequentially, consumes each response body as a stream, parses the
   * top-level keyed JSON object one key/value pair at a time, and feeds each
   * value into the shared importer accumulator. The legacy source-version
   * contract (`sha256(JSON.stringify(files))`, where `files` is the object of
   * four parsed segment objects in `FYERS_MASTER_URLS` order) is reproduced
   * incrementally: the outer/inner braces, segment keys and each pair's
   * `JSON.stringify(key) + ":" + JSON.stringify(value)` are hashed as they are
   * parsed, so no second full JSON string is ever materialised.
   *
   * Failure paths (all fail closed — no partial snapshot reaches reconciliation):
   *  - non-2xx (including an unexpected 304): HTTP error;
   *  - HTML/other clearly wrong content type: rejected before parsing;
   *  - empty body, truncated gzip, malformed/truncated JSON, unexpected shapes
   *    (non-object top level, primitive pair values): parser/decompressor error;
   *  - segment byte / total byte / row / element limits exceeded: explicit error;
   *  - cancellation via `signal`: checked between chunks and passed to fetch.
   */
  private async streamFyersInto(
    accumulator: FyersImportAccumulator,
    signal: AbortSignal | undefined,
    fetchFn: MasterFetch = this.fetchFn
  ): Promise<{ sourceVersion: string }> {
    const hasher = new IncrementalSha256();
    const encoder = new TextEncoder();
    const segments = Object.keys(FYERS_MASTER_URLS) as FyersMasterSegment[];
    let totalBytes = 0;
    let maxSegmentBytes = 0;
    let rows = 0;
    let maxParserBufferChars = 0;

    for (let si = 0; si < segments.length; si++) {
      if (signal?.aborted) throw new Error("FYERS master download cancelled");
      const segment = segments[si]!;
      const response = await fetchFn(FYERS_MASTER_URLS[segment], {
        signal: combinedFetchSignal(signal)
      });
      if (!response.ok) throw new Error(`FYERS ${segment} download failed: HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/html")) {
        throw new Error(`FYERS ${segment} download returned an unexpected content type`);
      }
      if (!response.body) throw new Error(`FYERS ${segment} download had no body`);

      const reader = response.body.getReader();
      const first = await reader.read().catch((e: unknown) => {
        try { reader.releaseLock(); } catch { /* best effort */ }
        throw e;
      });
      if (first.done || !first.value || first.value.length === 0) {
        try { reader.releaseLock(); } catch { /* best effort */ }
        throw new Error(`FYERS ${segment} download was empty`);
      }
      const isGzip = first.value[0] === 0x1f && first.value[1] === 0x8b;
      const firstChunk = first.value;

      // Replay the already-read first chunk, then the remainder of the body.
      // `pull`-driven construction preserves fetch backpressure: no chunk is
      // buffered ahead of the consumer.
      async function* rawChunks(): AsyncGenerator<Uint8Array<ArrayBuffer>> {
        yield firstChunk;
        while (true) {
          const r = await reader.read();
          if (r.done) return;
          yield r.value;
        }
      }

      let byteStream: ReadableStream<Uint8Array<ArrayBuffer>> = toReadableStream(rawChunks());
      if (isGzip) {
        byteStream = byteStream.pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array<ArrayBuffer>>;
      }

      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parser = new JsonObjectPairParser();
      let segmentBytes = 0;

      // Reproduce `JSON.stringify(files)` byte-for-byte, incrementally.
      // `segment` is a trusted constant key from `FYERS_MASTER_URLS`; using
      // JSON.stringify keeps the key fragment correct even if that ever changes.
      const segmentKey = JSON.stringify(segment);
      hasher.update(encoder.encode(si === 0 ? `{${segmentKey}:{` : `,${segmentKey}:{`));
      let firstPair = true;
      const consume = (pair: { key: string; value: unknown }): void => {
        rows++;
        if (rows > FYERS_MAX_ROWS) throw new Error("FYERS master exceeded row limit");
        if (!firstPair) hasher.update(encoder.encode(","));
        firstPair = false;
        hasher.update(encoder.encode(JSON.stringify(pair.key) + ":" + JSON.stringify(pair.value)));
        accumulator.addRow(segment, pair.value);
      };

      try {
        for await (const chunk of byteStream) {
          if (signal?.aborted) throw new Error("FYERS master download cancelled");
          segmentBytes += chunk.byteLength;
          totalBytes += chunk.byteLength;
          if (segmentBytes > FYERS_MAX_SEGMENT_BYTES) {
            throw new Error(`FYERS ${segment} exceeded decompressed byte limit`);
          }
          if (totalBytes > FYERS_MAX_TOTAL_BYTES) {
            throw new Error("FYERS master exceeded total byte limit");
          }
          const text = decoder.decode(chunk, { stream: true });
          for (const pair of parser.push(text)) consume(pair);
        }
        const tail = decoder.decode();
        if (tail) for (const pair of parser.push(tail)) consume(pair);
        parser.finish();
        hasher.update(encoder.encode("}"));
        if (parser.maxBufferedChars > maxParserBufferChars) maxParserBufferChars = parser.maxBufferedChars;
        if (segmentBytes > maxSegmentBytes) maxSegmentBytes = segmentBytes;
      } finally {
        try { reader.releaseLock(); } catch { /* best effort */ }
      }
    }
    hasher.update(encoder.encode("}"));
    lastFyersStreamMetrics = {
      maxParserBufferChars, maxSegmentBytes, totalBytes, rowsStreamed: rows,
      retainedOptionCandidates: accumulator.retainedOptionCandidates,
      retainedCashCandidates: accumulator.retainedCashCandidates,
      maxRetainedCandidates: accumulator.maxRetainedCandidates
    };
    return { sourceVersion: hasher.digest() };
  }

  private emit(event: CatalogRefreshEvent): void {
    try { this.onEvent?.(event); } catch { /* diagnostics must not affect refresh */ }
  }

  /**
   * Fail-closed gate before reconciliation. A malformed or unexpectedly empty
   * master must never reach `applyCompleteProviderSnapshot`: otherwise a
   * COMPLETE snapshot with silently skipped rows could mark previously active
   * mappings REMOVED. Throwing here is caught by `doRefresh`, which records a
   * FAILED run and keeps the last-known-good catalogue untouched.
   */
  private assertValidCompleteImport(report: ProviderImportReport, provider: ProviderId): void {
    const validation = validateCompleteImportReport(report, provider);
    if (!validation.ok) {
      throw new Error(`${provider} complete master import failed validation: ${validation.errors.join(", ")}`);
    }
  }
}

/**
 * G0-B — reusable pipeline entry point for the refresh child. It reuses the
 * exact streaming/validation/apply implementation in `CatalogMasterRefresh`
 * (no duplicated market-data logic); only the caller/process boundary differs.
 * The supplied `sync` is expected to be constructed in child mode (diagnostic
 * recorder disabled) so the child writes SQLite only inside the atomic apply.
 */
export async function runProviderRefreshPipeline(
  options: ProviderPipelineOptions
): Promise<ProviderPipelineOutcome> {
  const runner = new CatalogMasterRefresh({
    // The pipeline core never touches the catalog repository; a no-op instance
    // keeps the constructor contract intact without giving the child a second
    // data owner.
    catalog: {
      listSyncRuns: async () => [],
      recordSyncRun: async () => {}
    } as unknown as CatalogRepository,
    sync: options.sync,
    now: () => new Date(options.nowIso),
    fetch: options.fetchFn
  });
  return runner.runPipelineCore(options);
}

/** Only a parseable Last-Modified header is a reliable source date; never use local fetch time. */
function sourceDateFromHeader(value: string | null): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** Incremental SHA-256 over decompressed bytes; preserves the existing hash contract. */
class IncrementalSha256 {
  private readonly hash = createHash("sha256");
  update(bytes: Uint8Array): void { this.hash.update(bytes); }
  digest(): string { return this.hash.digest("hex"); }
}

/** Pull-driven adapter: exposes an async generator as a backpressure-aware ReadableStream. */
function toReadableStream(gen: AsyncGenerator<Uint8Array<ArrayBuffer>>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    }
  });
}

/**
 * Incremental parser for a top-level JSON array of objects. Emits one element
 * per `push` as soon as it is complete, tracks string/escape state so braces
 * inside string values cannot confuse nesting, and fails closed on malformed,
 * truncated or trailing input. The buffer is compacted after every chunk so a
 * large source never accumulates as a single string.
 */
class JsonArrayElementParser {
  private buffer = "";
  private pos = 0;
  private phase: "start" | "array" | "done" = "start";
  private depth = 0;
  private inString = false;
  private escaped = false;
  private elementStart = -1;
  /**
   * Array-level separator state (meaningful while `phase === "array"` and
   * `depth === 0`): "first" before the first element (or an empty array),
   * "value" after a separator comma (an element must follow), "separator"
   * after a completed element (a comma or `]` must follow). This fails closed
   * on missing, leading and repeated commas while preserving valid arrays.
   */
  private arrayExpect: "first" | "value" | "separator" = "first";
  private maxBufferChars = 0;

  /** Diagnostic high-water mark of retained (unparsed) text. */
  get maxBufferedChars(): number { return this.maxBufferChars; }

  /**
   * Validate comma separators in array-level text (whitespace/commas only).
   * Called for both inter-element skipped text and the trailing chunk tail so
   * a leading/repeated comma cannot hide across a chunk boundary.
   */
  private noteArrayLevelText(text: string): void {
    const commas = text.match(/,/g);
    if (!commas) return;
    if (this.arrayExpect === "first") {
      throw new Error("Malformed Upstox master array: leading comma");
    }
    if (this.arrayExpect === "value") {
      throw new Error("Malformed Upstox master array: repeated comma");
    }
    if (commas.length > 1) {
      throw new Error("Malformed Upstox master array: repeated comma");
    }
    this.arrayExpect = "value";
  }

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    // Record the true peak on growth, before parsing/compaction. `compact()`
    // only observes the post-slice buffer and would otherwise understate the
    // transient high-water mark (§7.4.4 instrumentation).
    if (this.buffer.length > this.maxBufferChars) this.maxBufferChars = this.buffer.length;
    const out: unknown[] = [];
    // Jump between structurally significant characters with a native regex
    // instead of iterating every byte of a ~64 MB source in JS. Backslashes
    // are included so escaped quotes inside string values stay correct.
    const interesting = /["{}\[\]\\]/g;
    interesting.lastIndex = this.pos;
    let match: RegExpExecArray | null;
    while ((match = interesting.exec(this.buffer)) !== null) {
      const idx = match.index;
      if (idx > this.pos) {
        const skipped = this.buffer.slice(this.pos, idx);
        if (this.phase === "start" || this.phase === "done") {
          if (/[^\s]/.test(skipped)) {
            throw new Error(this.phase === "start"
              ? "Upstox master must be a JSON array"
              : "Unexpected trailing content after Upstox master array");
          }
        } else if (this.inString) {
          // An escape payload that is not itself "interesting" (e.g. the `n`
          // in `\n` or the `u` in `\u0041`) is skipped by the regex. Consume
          // exactly one such char as the escaped payload and clear the flag;
          // otherwise the next interesting char (usually the closing quote)
          // would be mistaken for the payload and the string would never close.
          if (this.escaped) {
            this.escaped = false;
            this.pos += 1;
          }
        } else if (this.depth === 0) {
          // A bare primitive at array level is not a valid Upstox row.
          if (/[^\s,]/.test(skipped)) {
            throw new Error("Malformed Upstox master array: unexpected token at array level");
          }
          this.noteArrayLevelText(skipped);
        }
        this.pos = idx;
      }
      const ch = match[0]!;
      if (this.phase === "start") {
        if (ch !== "[") throw new Error("Upstox master must be a JSON array");
        this.phase = "array";
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (this.phase === "done") {
        throw new Error("Unexpected trailing content after Upstox master array");
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') {
          this.inString = false;
          // A top-level string element is not a valid Upstox row, but emit it
          // so the importer counts it as invalid rather than silently dropping it.
          if (this.depth === 0 && this.elementStart >= 0) {
            out.push(JSON.parse(this.buffer.slice(this.elementStart, idx + 1)));
            this.elementStart = -1;
            this.arrayExpect = "separator";
          }
        }
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === '"') {
        if (this.depth === 0 && this.elementStart < 0) {
          if (this.arrayExpect === "separator") {
            throw new Error("Malformed Upstox master array: missing comma between elements");
          }
          this.elementStart = idx;
        }
        this.inString = true;
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === "{" || ch === "[") {
        if (this.depth === 0) {
          if (this.arrayExpect === "separator") {
            throw new Error("Malformed Upstox master array: missing comma between elements");
          }
          this.elementStart = idx;
        }
        this.depth++;
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === "\\") { // stray backslash outside a string: JSON.parse will reject it
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (this.depth === 0) {
        if (ch !== "]") throw new Error("Malformed Upstox master array: unexpected '}'");
        if (this.arrayExpect === "value") {
          throw new Error("Malformed Upstox master array: trailing comma");
        }
        this.phase = "done";
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      this.depth--;
      if (this.depth === 0) {
        out.push(JSON.parse(this.buffer.slice(this.elementStart, idx + 1)));
        this.elementStart = -1;
        this.arrayExpect = "separator";
      }
      this.pos = idx + 1;
      interesting.lastIndex = this.pos;
    }
    const tail = this.buffer.slice(this.pos);
    if (this.phase === "start" || this.phase === "done") {
      if (/[^\s]/.test(tail)) {
        throw new Error(this.phase === "start"
          ? "Upstox master must be a JSON array"
          : "Unexpected trailing content after Upstox master array");
      }
    } else if (this.depth === 0 && !this.inString) {
      if (/[^\s,]/.test(tail)) {
        throw new Error("Malformed Upstox master array: unexpected token at array level");
      }
      // A separator comma can land at a chunk boundary; validate it here so a
      // leading/repeated comma cannot hide across chunks.
      this.noteArrayLevelText(tail);
    }
    this.pos = this.buffer.length;
    this.compact();
    return out;
  }

  finish(): void {
    if (this.phase !== "done") throw new Error("Truncated Upstox master array");
    if (this.inString || this.depth !== 0 || this.elementStart >= 0) {
      throw new Error("Truncated Upstox master array element");
    }
  }

  private compact(): void {
    if (this.elementStart >= 0) {
      if (this.elementStart > 0) {
        this.buffer = this.buffer.slice(this.elementStart);
        this.pos -= this.elementStart;
        this.elementStart = 0;
      }
    } else if (this.pos > 0) {
      this.buffer = this.buffer.slice(this.pos);
      this.pos = 0;
    }
    if (this.buffer.length > this.maxBufferChars) this.maxBufferChars = this.buffer.length;
    if (this.buffer.length > UPSTOX_MAX_ELEMENT_CHARS) {
      throw new Error("Upstox master row exceeded size limit");
    }
  }
}

/**
 * Incremental parser for a top-level JSON object whose values are detail
 * objects (the official FYERS Symbol Master format: `{ "SYMBOL": {…}, … }`).
 * Emits one `{ key, value }` pair as soon as its value is complete, tracks
 * string/escape/nesting state so colons, commas and braces inside string values
 * cannot confuse the structure, and fails closed on malformed, truncated,
 * trailing input and unexpected pair value shapes (primitives or arrays). The
 * buffer is compacted after every chunk so a large source
 * never accumulates as a single string.
 *
 * The emitted key is retained only so the caller can reproduce the legacy
 * `JSON.stringify(files)` source-hash contract incrementally; the importer uses
 * the value alone (exactly as `Object.values(file)` did before).
 */
class JsonObjectPairParser {
  private buffer = "";
  private pos = 0;
  private phase: "start" | "object" | "done" = "start";
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** Role of the string currently being read at depth 0: object key or value. */
  private stringRole: "key" | "value" | null = null;
  /** Start index of the current key/value slice inside `buffer`. */
  private stringStart = -1;
  private currentKey: string | null = null;
  /** Structural expectation at depth 0. */
  private expect: "key" | "colon" | "value" | "comma" = "key";
  private sawComma = false;
  private maxBufferChars = 0;

  /** Diagnostic high-water mark of retained (unparsed) text. */
  get maxBufferedChars(): number { return this.maxBufferChars; }

  push(chunk: string): Array<{ key: string; value: unknown }> {
    this.buffer += chunk;
    // Record the true peak on growth, before parsing/compaction (§7.4.4).
    if (this.buffer.length > this.maxBufferChars) this.maxBufferChars = this.buffer.length;
    const out: Array<{ key: string; value: unknown }> = [];
    // Jump between structurally significant characters with a native regex
    // instead of iterating every byte of a ~90 MB source in JS. Backslashes
    // are included so escaped quotes inside string values stay correct.
    const interesting = /["{}\[\]:,\\]/g;
    interesting.lastIndex = this.pos;
    let match: RegExpExecArray | null;
    while ((match = interesting.exec(this.buffer)) !== null) {
      const idx = match.index;
      if (idx > this.pos) {
        const skipped = this.buffer.slice(this.pos, idx);
        if (this.phase === "start" || this.phase === "done") {
          if (/[^\s]/.test(skipped)) {
            throw new Error(this.phase === "start"
              ? "FYERS master must be a JSON object"
              : "Unexpected trailing content after FYERS master object");
          }
        } else if (this.inString) {
          // An escape payload that is not itself "interesting" (e.g. the `n`
          // in `\n` or the `u` in `\u0041`) is skipped by the regex. Consume
          // exactly one such char as the escaped payload and clear the flag.
          if (this.escaped) {
            this.escaped = false;
            this.pos += 1;
          }
        } else if (this.depth === 0 && this.expect === "value") {
          // Official FYERS pair values are always objects. A bare primitive is
          // an unexpected shape and must fail closed rather than be guessed.
          if (/[^\s]/.test(skipped)) throw new Error("FYERS master: unexpected primitive pair value");
        } else if (this.depth === 0 && /[^\s]/.test(skipped)) {
          throw new Error("FYERS master: unexpected token at object level");
        }
        this.pos = idx;
      }
      const ch = match[0]!;
      if (this.phase === "start") {
        if (ch !== "{") throw new Error("FYERS master must be a JSON object");
        this.phase = "object";
        this.expect = "key";
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (this.phase === "done") {
        throw new Error("Unexpected trailing content after FYERS master object");
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') {
          this.inString = false;
          if (this.depth === 0 && this.stringRole === "key") {
            this.currentKey = JSON.parse(this.buffer.slice(this.stringStart, idx + 1)) as string;
            this.stringStart = -1;
            this.stringRole = null;
            this.expect = "colon";
          } else if (this.depth === 0 && this.stringRole === "value") {
            // A top-level pair value must be an object. Strings are structural
            // (the opening `"` is handled as a token), so the skipped-text
            // primitive check never sees them; fail closed here instead of
            // emitting a pair the importer would silently drop.
            throw new Error("FYERS master: unexpected primitive pair value");
          }
        }
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === '"') {
        if (this.depth === 0) {
          if (this.expect === "key") {
            this.stringRole = "key";
            this.sawComma = false; // a key followed the comma: not a trailing comma
          } else if (this.expect === "value") this.stringRole = "value";
          else throw new Error("FYERS master: unexpected string at object level");
          this.stringStart = idx;
          this.inString = true;
          this.pos = idx + 1;
          interesting.lastIndex = this.pos;
          continue;
        }
        this.inString = true; // string nested inside a value
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === "{" || ch === "[") {
        if (this.depth === 0) {
          if (this.expect !== "value") throw new Error("FYERS master: unexpected value start");
          // Official FYERS pair values are objects; a top-level array is an
          // unexpected shape (and would otherwise be counted as a row by the
          // importer, since arrays are `typeof "object"`). Nested arrays inside
          // a valid object value remain unaffected (depth > 0).
          if (ch === "[") throw new Error("FYERS master: unexpected array pair value");
          this.stringStart = idx;
        }
        this.depth++;
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === "\\") { // stray backslash outside a string: JSON.parse will reject it
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === ":") {
        if (this.depth === 0) {
          if (this.expect !== "colon") throw new Error("FYERS master: unexpected ':'");
          this.expect = "value";
        }
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === ",") {
        if (this.depth === 0) {
          if (this.expect !== "comma") throw new Error("FYERS master: unexpected ','");
          this.expect = "key";
          this.sawComma = true;
        }
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
        continue;
      }
      if (ch === "}" || ch === "]") {
        if (this.depth === 0) {
          if (ch !== "}") throw new Error("FYERS master: unexpected ']'");
          if (this.expect === "colon" || this.expect === "value") {
            throw new Error("FYERS master: incomplete key/value pair");
          }
          if (this.sawComma) throw new Error("FYERS master: trailing comma");
          this.phase = "done";
          this.pos = idx + 1;
          interesting.lastIndex = this.pos;
          continue;
        }
        this.depth--;
        if (this.depth === 0) {
          this.noteElement(idx + 1);
          out.push({
            key: this.currentKey!,
            value: JSON.parse(this.buffer.slice(this.stringStart, idx + 1))
          });
          this.currentKey = null;
          this.stringStart = -1;
          this.stringRole = null;
          this.expect = "comma";
        }
        this.pos = idx + 1;
        interesting.lastIndex = this.pos;
      }
    }
    const tail = this.buffer.slice(this.pos);
    if (this.phase === "start" || this.phase === "done") {
      if (/[^\s]/.test(tail)) {
        throw new Error(this.phase === "start"
          ? "FYERS master must be a JSON object"
          : "Unexpected trailing content after FYERS master object");
      }
    } else if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
        this.pos += 1;
      }
    } else if (this.depth === 0 && this.expect === "value") {
      if (/[^\s]/.test(tail)) throw new Error("FYERS master: unexpected primitive pair value");
    } else if (this.depth === 0 && /[^\s]/.test(tail)) {
      throw new Error("FYERS master: unexpected token at object level");
    }
    this.pos = this.buffer.length;
    this.compact();
    return out;
  }

  finish(): void {
    if (this.phase !== "done") throw new Error("Truncated FYERS master object");
    if (this.inString || this.depth !== 0 || this.currentKey !== null || this.stringStart >= 0) {
      throw new Error("Truncated FYERS master key/value pair");
    }
  }

  /** Fail closed on an oversized in-flight element before it is compacted away. */
  private noteElement(end: number): void {
    if (this.stringStart < 0) return;
    if (end - this.stringStart > FYERS_MAX_ELEMENT_CHARS) {
      throw new Error("FYERS master row exceeded size limit");
    }
  }

  private compact(): void {
    if (this.stringStart >= 0) {
      this.noteElement(this.buffer.length);
      if (this.stringStart > 0) {
        this.buffer = this.buffer.slice(this.stringStart);
        this.pos -= this.stringStart;
        this.stringStart = 0;
      }
    } else if (this.pos > 0) {
      this.buffer = this.buffer.slice(this.pos);
      this.pos = 0;
    }
    if (this.buffer.length > this.maxBufferChars) this.maxBufferChars = this.buffer.length;
  }
}
