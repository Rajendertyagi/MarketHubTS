/**
 * Abort-safe retry delay. The abort listener is removed on every terminal path
 * (normal timeout, abort, already-aborted signal) so repeated cycles cannot
 * accumulate listeners on a long-lived AbortSignal.
 */
export function createRetrySleep(): (ms: number, signal?: AbortSignal) => Promise<void> {
  return (ms, signal) => new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}
