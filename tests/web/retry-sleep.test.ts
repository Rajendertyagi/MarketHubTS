import { describe, expect, test } from "bun:test";
import { createRetrySleep } from "../../apps/web/src/lib/retry-sleep";

/** Structural fake AbortSignal that exposes listener bookkeeping. */
class FakeSignal {
  aborted = false;
  readonly listeners = new Set<() => void>();
  addCalls = 0;
  removeCalls = 0;
  addEventListener(_type: string, fn: () => void): void {
    this.addCalls++;
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: () => void): void {
    this.removeCalls++;
    this.listeners.delete(fn);
  }
  abort(): void {
    this.aborted = true;
    for (const fn of [...this.listeners]) fn();
  }
}

function asSignal(fake: FakeSignal): AbortSignal {
  return fake as unknown as AbortSignal;
}

describe("Stage F — abort-safe retry sleep", () => {
  test("normal timeout removes the abort listener", async () => {
    const signal = new FakeSignal();
    const sleep = createRetrySleep();
    await sleep(1, asSignal(signal));
    expect(signal.listeners.size).toBe(0);
    expect(signal.removeCalls).toBeGreaterThanOrEqual(1);
  });

  test("abort clears the timer, removes the listener and resolves", async () => {
    const signal = new FakeSignal();
    const sleep = createRetrySleep();
    const p = sleep(1000, asSignal(signal));
    signal.abort();
    await p;
    expect(signal.listeners.size).toBe(0);
    expect(signal.removeCalls).toBeGreaterThanOrEqual(1);
  });

  test("already-aborted signal resolves immediately without adding a listener", async () => {
    const signal = new FakeSignal();
    signal.aborted = true;
    const sleep = createRetrySleep();
    await sleep(1000, asSignal(signal));
    expect(signal.addCalls).toBe(0);
    expect(signal.listeners.size).toBe(0);
  });

  test("repeated cycles do not accumulate listeners", async () => {
    const sleep = createRetrySleep();
    for (let i = 0; i < 100; i++) {
      const signal = new FakeSignal();
      await sleep(1, asSignal(signal));
      expect(signal.listeners.size).toBe(0);
    }
  });

  test("works without a signal", async () => {
    const sleep = createRetrySleep();
    await sleep(1);
  });
});
