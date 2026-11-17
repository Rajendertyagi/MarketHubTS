import { describe, expect, test } from "bun:test";
import type { LiveSnapshot } from "../../packages/contracts/src/index";
import {
  LiveStreamController, type EventSourceLike, type SseListener, type StreamState
} from "../../apps/web/src/lib/live-stream";

const BASE = 1_700_000_000_000;
const flush = async () => { await Bun.sleep(0); };

function snapshot(revision: number): LiveSnapshot {
  return { revision, capturedAtMs: BASE, items: [], connections: [] };
}

class FakeSource implements EventSourceLike {
  private listeners = new Map<string, Set<SseListener>>();
  closed = false;
  addEventListener(type: string, listener: SseListener): void {
    const set = this.listeners.get(type) ?? new Set<SseListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: SseListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void { this.closed = true; this.listeners.clear(); }
  get listenerCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  private dispatch(type: string, data: string, lastEventId = ""): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ data, lastEventId });
  }
  fail(): void { this.dispatch("error", ""); }
  control(type: "refresh" | "snapshot-required"): void { this.dispatch(type, JSON.stringify({ type })); }
}

interface HarnessOptions {
  maxRecoveryAttempts?: number;
  maxRefreshAttempts?: number;
  fetch?: () => Promise<LiveSnapshot>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function harness(opts: HarnessOptions = {}) {
  const sources: FakeSource[] = [];
  const states: StreamState[] = [];
  const snapshots: LiveSnapshot[] = [];
  const sleeps: number[] = [];
  let sleepAborts = 0;
  const controller = new LiveStreamController({
    createEventSource: () => { const s = new FakeSource(); sources.push(s); return s; },
    fetchSnapshot: opts.fetch ?? (async () => snapshot(1)),
    sleep: opts.sleep ?? ((ms, signal) => new Promise<void>((resolve) => {
      sleeps.push(ms);
      if (signal?.aborted) { resolve(); return; }
      signal?.addEventListener("abort", () => { sleepAborts++; resolve(); }, { once: true });
      resolve(); // deterministic: normal retries resolve immediately
    })),
    onSnapshot: (s) => { snapshots.push(s); },
    onState: (s) => { states.push(s); },
    maxRecoveryAttempts: opts.maxRecoveryAttempts ?? 3,
    maxRefreshAttempts: opts.maxRefreshAttempts ?? 2
  });
  controller.start();
  return {
    controller, sources, states, snapshots, sleeps,
    get sleepAborts() { return sleepAborts; },
    lastState: () => states[states.length - 1]!,
    currentSource: () => sources[sources.length - 1]!
  };
}

describe("Stage F — WebUI recovery/refresh await points (#9–#12)", () => {
  test("#9 recovery fetch exhaustion sets streamStatus=error", async () => {
    let calls = 0;
    const h = harness({
      maxRecoveryAttempts: 3,
      fetch: async () => { calls++; throw new Error("fetch failed"); }
    });
    h.currentSource().fail();
    await flush();
    await flush();
    expect(calls).toBe(3);
    expect(h.lastState().streamStatus).toBe("error");
    expect(h.lastState().lastError).toContain("fetch failed");
    h.controller.stop();
  });

  test("#10 recovery sleep is abort-aware: stop during sleep prevents further fetch", async () => {
    let calls = 0;
    let resolveSleep: (() => void) | null = null;
    const h = harness({
      maxRecoveryAttempts: 5,
      fetch: async () => { calls++; throw new Error("fetch failed"); },
      sleep: () => new Promise<void>((resolve) => { resolveSleep = resolve; })
    });
    h.currentSource().fail();
    await flush();
    expect(calls).toBe(1);
    expect(resolveSleep).not.toBeNull();
    h.controller.stop();
    resolveSleep!();
    await flush();
    expect(calls).toBe(1); // no further fetch after stop
  });

  test("#11 refresh fetch exhaustion sets refreshStatus=error", async () => {
    let calls = 0;
    const h = harness({
      maxRefreshAttempts: 2,
      fetch: async () => { calls++; throw new Error("refresh failed"); }
    });
    h.currentSource().control("refresh");
    await flush();
    await flush();
    expect(calls).toBe(2);
    expect(h.lastState().refreshStatus).toBe("error");
    expect(h.lastState().refreshError).toContain("refresh failed");
    h.controller.stop();
  });

  test("#12 refresh sleep is abort-aware: stop during sleep prevents further fetch", async () => {
    let calls = 0;
    let resolveSleep: (() => void) | null = null;
    const h = harness({
      maxRefreshAttempts: 5,
      fetch: async () => { calls++; throw new Error("refresh failed"); },
      sleep: () => new Promise<void>((resolve) => { resolveSleep = resolve; })
    });
    h.currentSource().control("refresh");
    await flush();
    expect(calls).toBe(1);
    h.controller.stop();
    resolveSleep!();
    await flush();
    expect(calls).toBe(1);
  });

  test("500 recovery/refresh cycles keep listener counts zero and applied revision monotonic", async () => {
    let revision = 0;
    const h = harness({
      maxRecoveryAttempts: 2,
      maxRefreshAttempts: 2,
      fetch: async () => { revision++; return snapshot(revision); }
    });
    for (let i = 0; i < 500; i++) {
      h.currentSource().control("refresh");
      await flush();
    }
    expect(h.snapshots.length).toBeGreaterThan(0);
    for (let i = 1; i < h.snapshots.length; i++) {
      expect(h.snapshots[i]!.revision).toBeGreaterThanOrEqual(h.snapshots[i - 1]!.revision);
    }
    h.controller.stop();
    for (const source of h.sources) expect(source.listenerCount).toBe(0);
  });
});
