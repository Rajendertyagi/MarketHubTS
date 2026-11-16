import { rmSync } from "node:fs";

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function closeDatabaseHandle(handle: { close: () => void } | null | undefined): void {
  if (!handle) return;
  handle.close();
}

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
