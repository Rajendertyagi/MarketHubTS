import { rmSync } from "node:fs";

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function closeDatabaseHandle(handle: { close: () => void } | null | undefined): void {
  if (!handle) return;
  handle.close();
}

/**
 * Synchronous temp-dir removal. Prefer `removeTempDirAsync` in harnesses that
 * own a SQLite handle: Bun's `Database.close()` defers the OS file-handle
 * release to GC finalization, and the blocking `Atomics.wait` below starves the
 * finalizers that release it under full-suite parallel load (EBUSY on Windows).
 */
export function removeTempDir(dir: string, attempts = 40, delayMs = 50): void {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      if (typeof (globalThis as any).Bun?.gc === "function") {
        try {
          (globalThis as any).Bun.gc(true);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) sleepSync(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to remove temp dir: ${dir}`);
}

/**
 * Async temp-dir removal for harnesses that own a SQLite handle.
 *
 * Root cause this addresses: Bun's `Database.close()` does not synchronously
 * release the OS file handle. The actual close is deferred to GC finalization
 * of the cached prepared statements created by drizzle. `Bun.gc(true)` is
 * required to trigger that finalization, but finalizers run on the event loop.
 * The synchronous helper's `Atomics.wait` blocks the JS thread, so under
 * full-suite parallel load the finalizers are starved past the retry budget and
 * `rmSync` keeps seeing EBUSY on the SQLite file (and its WAL sidecars).
 *
 * Yielding with `await Bun.sleep()` between GC-forced attempts lets those
 * finalizers run, so the handle is released and removal succeeds. The retry
 * count is unchanged — the fix is the event-loop yield, not more retries.
 */
export async function removeTempDirAsync(dir: string, attempts = 40, delayMs = 50): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      if (typeof (globalThis as any).Bun?.gc === "function") {
        try {
          (globalThis as any).Bun.gc(true);
        } catch {}
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await Bun.sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to remove temp dir: ${dir}`);
}
