import { rmSync } from "node:fs";

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Force a full GC so Bun can finalize cached prepared statements that still
 * hold the SQLite OS handle open. Shared by both removal helpers. */
function forceGc(): void {
  if (typeof (globalThis as any).Bun?.gc === "function") {
    try {
      (globalThis as any).Bun.gc(true);
    } catch {}
  }
}

/** Windows keeps a file locked until every handle is released. EBUSY/EPERM
 * are the transient codes seen while Bun's deferred finalizers run; anything
 * else is a real failure and should surface immediately. */
function isRetryableRmError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "EBUSY" || code === "EPERM";
}

export function closeDatabaseHandle(handle: { close: () => void } | null | undefined): void {
  if (!handle) return;
  handle.close();
}

/**
 * Synchronous temp-dir removal, hardened for Windows handle release.
 *
 * Retries/backoffs on EBUSY/EPERM and forces GC before every attempt so Bun's
 * deferred SQLite handle finalization has a chance to complete. Prefer
 * `removeTempDirAsync` in harnesses that own a SQLite handle: Bun's
 * `Database.close()` defers the OS file-handle release to GC finalization, and
 * the blocking `Atomics.wait` below starves the finalizers that release it
 * under full-suite parallel load (EBUSY on Windows).
 */
export function removeTempDir(dir: string, attempts = 40, delayMs = 50): void {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    forceGc();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRmError(error)) throw error;
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
    forceGc();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRmError(error)) throw error;
      if (i < attempts - 1) await Bun.sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to remove temp dir: ${dir}`);
}
