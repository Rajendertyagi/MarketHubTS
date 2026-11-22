import type { SubscriptionStateView } from "@markethub/contracts";

/** Abort errors are an expected control-flow signal, not a refresh failure. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface SubscriptionPollerDeps {
  fetchView: (signal?: AbortSignal) => Promise<SubscriptionStateView>;
  getWriteGeneration: () => number;
  isWritePending: () => boolean;
  applyView: (view: SubscriptionStateView) => void;
  onRefreshError: (message: string | null) => void;
  intervalMs?: number;
  /** Resolves on abort (like createRetrySleep) so a cancelled wait never leaks. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SubscriptionPoller {
  start: () => void;
  suspend: () => void;
  resume: () => void;
  dispose: () => void;
}

/**
 * Framework-free, single-flight refresh controller for the subscription view.
 *
 * It is deliberately not a polling framework: it owns no state beyond its own
 * lifecycle and delegates fetching, applying and error reporting to injected
 * functions. That keeps the poll/write race logic testable without React DOM
 * and leaves the Zustand store as the single view owner.
 *
 * Race safety has two layers:
 *  1. AbortSignal cancels the in-flight GET on suspend/resume/dispose.
 *  2. A monotonic write generation + pending-write guard is re-checked
 *     immediately before applyView, because a response can parse before the
 *     abort is observed. Abort alone is NOT sufficient.
 */
export function createSubscriptionPoller(deps: SubscriptionPollerDeps): SubscriptionPoller {
  const intervalMs = deps.intervalMs ?? 10000;
  let generation = 0;
  let started = false;
  let suspended = false;
  let disposed = false;
  let sleepController: AbortController | null = null;
  let fetchController: AbortController | null = null;
  // Token rather than a boolean so a stale generation's `finally` cannot
  // clear the in-flight flag of a newer generation after resume().
  let inFlightToken: symbol | null = null;

  function abortControllers(): void {
    sleepController?.abort();
    fetchController?.abort();
  }

  function bumpGeneration(): void {
    generation++;
    // Allow the fresh generation to start a load even if an aborted older
    // fetch has not settled yet; the token keeps its cleanup scoped.
    inFlightToken = null;
    abortControllers();
  }

  async function loadOnce(myGen: number): Promise<void> {
    if (disposed || myGen !== generation || suspended || inFlightToken !== null) return;
    const token = Symbol("poll");
    inFlightToken = token;
    // Capture BEFORE the fetch: any write that starts from here on invalidates
    // this read even if its response arrives after the write completed.
    const writeGenBefore = deps.getWriteGeneration();
    const controller = new AbortController();
    fetchController = controller;
    try {
      const view = await deps.fetchView(controller.signal);
      // CRITICAL: re-check immediately before applying. A response may have
      // parsed before the abort was observed, so cancellation alone is not
      // enough to keep an older GET from overwriting a newer PUT result.
      if (
        disposed || myGen !== generation || suspended ||
        writeGenBefore !== deps.getWriteGeneration() || deps.isWritePending()
      ) {
        return;
      }
      deps.applyView(view);
      deps.onRefreshError(null);
    } catch (error) {
      if (disposed || myGen !== generation || suspended) return;
      if (isAbortError(error)) return;
      if (writeGenBefore !== deps.getWriteGeneration() || deps.isWritePending()) return;
      // Keep the last-known-good view: never call applyView on a failure.
      deps.onRefreshError(error instanceof Error ? error.message : "Unexpected error");
    } finally {
      if (inFlightToken === token) inFlightToken = null;
      if (fetchController === controller) fetchController = null;
    }
  }

  async function loop(myGen: number): Promise<void> {
    while (!disposed && myGen === generation) {
      const controller = new AbortController();
      sleepController = controller;
      await deps.sleep(intervalMs, controller.signal);
      if (sleepController === controller) sleepController = null;
      if (disposed || myGen !== generation) return;
      if (suspended) continue;
      await loadOnce(myGen);
    }
  }

  function startLoop(): void {
    void loop(generation);
  }

  return {
    start(): void {
      if (disposed || started) return;
      started = true;
      startLoop();
    },
    suspend(): void {
      if (disposed) return;
      suspended = true;
      abortControllers();
    },
    resume(): void {
      if (disposed) return;
      suspended = false;
      bumpGeneration();
      if (started) startLoop();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      bumpGeneration();
    }
  };
}
