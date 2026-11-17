import { describe, expect, test } from "bun:test";
import type { LiveSnapshot, LiveChangeEvent } from "../../packages/contracts/src/index";
import {
  LiveStreamController, SSE_EVENT_NAMES,
  type EventSourceLike, type SseEventLike, type SseListener, type StreamState
} from "../../apps/web/src/lib/live-stream";

const BASE = 1_700_000_000_000;
/** Let pending promise continuations (fetch resolution, sleep) settle. */
const flush = async () => { await Bun.sleep(0); };

function snapshot(revision: number, items: LiveSnapshot["items"] = []): LiveSnapshot {
  return { revision, capturedAtMs: BASE, items, connections: [] };
}

function item(canonicalId: string) {
  return {
    canonicalId,
    observations: {},
    selected: {
      canonicalId, provider: null, value: null, mode: "UNAVAILABLE" as const,
      freshness: "UNAVAILABLE" as const, reason: "none", observation: null
    },
    pinned: false,
    updatedAtMs: BASE
  };
}

function updated(revision: number, canonicalId: string): LiveChangeEvent {
  return { type: "item-updated", revision, canonicalId, item: item(canonicalId) };
}

function removed(revision: number, canonicalId: string): LiveChangeEvent {
  return { type: "item-removed", revision, canonicalId };
}

/** Fake EventSource that dispatches named events and records real listener invocations. */
class FakeEventSource implements EventSourceLike {
  private listeners = new Map<string, Set<SseListener>>();
  closed = false;
  lastEventId = "";
  readonly dispatched: string[] = [];
  /** Records only when a registered listener callback actually runs. */
  readonly invoked: string[] = [];

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: SseListener): void {
    const set = this.listeners.get(type) ?? new Set<SseListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: SseListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  listenerCount(type: string): number { return this.listeners.get(type)?.size ?? 0; }
  private dispatch(type: string, event: SseEventLike): void {
    this.dispatched.push(type);
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    for (const listener of set) {
      this.invoked.push(type);
      listener(event);
    }
  }
  close(): void { this.closed = true; this.listeners.clear(); }
  open(): void { this.dispatch("open", { data: "", lastEventId: this.lastEventId }); }
  emitNamed(type: string, payload: unknown, revision?: number): void {
    if (revision !== undefined) this.lastEventId = String(revision);
    this.dispatch(type, { data: JSON.stringify(payload), lastEventId: this.lastEventId });
  }
  emitData(payload: unknown, revision: number): void {
    this.emitNamed("item-updated", payload, revision);
  }
  emitControl(type: "refresh" | "snapshot-required"): void {
    this.emitNamed(type, { type });
  }
  fail(): void { this.dispatch("error", { data: "", lastEventId: this.lastEventId }); }
}

class FakeFetcher {
  calls = 0;
  private pending: Array<{ resolve: (s: LiveSnapshot) => void; reject: (e: Error) => void }> = [];
  private auto: Array<() => Promise<LiveSnapshot>> = [];

  fetchSnapshot = (): Promise<LiveSnapshot> => {
    this.calls++;
    const next = this.auto.shift();
    if (next) return next();
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  };
  resolveNext(value: LiveSnapshot): void { this.pending.shift()?.resolve(value); }
  rejectNext(error = new Error("fetch failed")): void { this.pending.shift()?.reject(error); }
  autoResolve(value: LiveSnapshot): void { this.auto.push(async () => value); }
  get pendingCount(): number { return this.pending.length; }
}

function harness(overrides: Partial<ConstructorParameters<typeof LiveStreamController>[0]> = {}) {
  const sources: FakeEventSource[] = [];
  const fetcher = new FakeFetcher();
  const states: StreamState[] = [];
  const snapshots: LiveSnapshot[] = [];
  const sleeps: number[] = [];
  let sleepAborts = 0;
  const controller = new LiveStreamController({
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    fetchSnapshot: fetcher.fetchSnapshot,
    sleep: (ms, signal) => new Promise<void>((resolve) => {
      sleeps.push(ms);
      if (signal?.aborted) { resolve(); return; }
      signal?.addEventListener("abort", () => { sleepAborts++; resolve(); }, { once: true });
      resolve(); // normal retries resolve immediately; abort still tracked
    }),
    onSnapshot: (next) => { snapshots.push(next); },
    onState: (next) => { states.push(next); },
    ...overrides
  });
  const lastState = () => states[states.length - 1]!;
  return { controller, sources, fetcher, states, snapshots, sleeps, lastState, get sleepAborts() { return sleepAborts; } };
}

async function startLive(h: ReturnType<typeof harness>, revision = 1) {
  h.controller.start();
  h.sources[0]!.open(); // initial open stays connecting
  h.sources[0]!.emitNamed("snapshot", snapshot(revision), revision); // snapshot -> live
}

describe("named SSE event dispatch", () => {
  test("all six backend event names have registered listeners that are actually invoked", () => {
    expect(SSE_EVENT_NAMES).toEqual([
      "snapshot", "item-updated", "item-removed", "provider-connection-changed",
      "snapshot-required", "refresh"
    ]);
    const h = harness();
    h.controller.start();
    const source = h.sources[0]!;
    for (const name of SSE_EVENT_NAMES) expect(source.listenerCount(name)).toBe(1);
    expect(source.listenerCount("open")).toBe(1);
    expect(source.listenerCount("error")).toBe(1);

    // Emit each event on a fresh controller/source so recovery-triggering
    // events (provider-connection-changed, snapshot-required) don't close it.
    for (const name of SSE_EVENT_NAMES) {
      const one = harness();
      one.controller.start();
      const src = one.sources[0]!;
      expect(src.listenerCount(name)).toBe(1);
      if (name === "snapshot") src.emitNamed("snapshot", snapshot(1), 1);
      else if (name === "item-updated") src.emitNamed("item-updated", updated(1, "A"), 1);
      else if (name === "item-removed") src.emitNamed("item-removed", removed(1, "A"), 1);
      else if (name === "provider-connection-changed") src.emitNamed("provider-connection-changed", {
        type: "provider-connection-changed", revision: 1, provider: "UPSTOX",
        status: { provider: "UPSTOX", state: "DISCONNECTED", changedAtMs: BASE, error: null },
        requiresSnapshotRefresh: true
      }, 1);
      else src.emitNamed(name, { type: name });
      expect(src.invoked).toContain(name);
      one.controller.stop();
    }
    h.controller.stop();
  });

  test("listeners are removed on close and no longer invoked", () => {
    const h = harness();
    h.controller.start();
    const source = h.sources[0]!;
    h.controller.stop();
    expect(source.closed).toBe(true);
    for (const name of SSE_EVENT_NAMES) expect(source.listenerCount(name)).toBe(0);
    const invokedBefore = source.invoked.length;
    source.emitNamed("refresh", { type: "refresh" });
    expect(source.invoked.length).toBe(invokedBefore);
  });
});

describe("initial connection state", () => {
  test("initial open without a snapshot remains connecting", () => {
    const h = harness();
    h.controller.start();
    h.sources[0]!.open();
    expect(h.lastState().streamStatus).toBe("connecting");
    h.controller.stop();
  });

  test("a valid initial snapshot transitions to live", () => {
    const h = harness();
    h.controller.start();
    h.sources[0]!.open();
    expect(h.lastState().streamStatus).toBe("connecting");
    h.sources[0]!.emitNamed("snapshot", snapshot(1), 1);
    expect(h.lastState().streamStatus).toBe("live");
    expect(h.snapshots[0]!.revision).toBe(1);
    h.controller.stop();
  });

  test("recovery ?since= connection with no events enters live on open", async () => {
    const h = harness();
    await startLive(h);
    h.sources[0]!.emitControl("snapshot-required");
    h.fetcher.resolveNext(snapshot(2));
    await flush();
    expect(h.sources[1]!.url).toBe("/api/market/stream?since=2");
    h.sources[1]!.open();
    expect(h.lastState().streamStatus).toBe("live");
    h.controller.stop();
  });
});

describe("LiveStreamController — data events", () => {
  test("data events are applied with revision checks", async () => {
    const h = harness();
    await startLive(h);
    h.sources[0]!.emitData(updated(2, "A"), 2);
    expect(h.snapshots[h.snapshots.length - 1]!.revision).toBe(2);
    expect(h.snapshots[h.snapshots.length - 1]!.items.map((i) => i.canonicalId)).toEqual(["A"]);
    h.sources[0]!.emitData(updated(2, "A"), 2); // duplicate
    expect(h.snapshots[h.snapshots.length - 1]!.revision).toBe(2);
    h.controller.stop();
  });

  test("item-removed removes the item from the snapshot", async () => {
    const h = harness();
    await startLive(h, 1);
    h.sources[0]!.emitData(updated(2, "A"), 2);
    h.sources[0]!.emitData(updated(3, "B"), 3);
    expect(h.snapshots[h.snapshots.length - 1]!.items.map((i) => i.canonicalId)).toEqual(["A", "B"]);
    h.sources[0]!.emitNamed("item-removed", removed(4, "A"), 4);
    const latest = h.snapshots[h.snapshots.length - 1]!;
    expect(latest.revision).toBe(4);
    expect(latest.items.map((i) => i.canonicalId)).toEqual(["B"]);
    h.controller.stop();
  });

  test("provider-connection-changed fully invalidates without partial mutation", async () => {
    const h = harness();
    await startLive(h, 1);
    h.sources[0]!.emitData(updated(2, "A"), 2);
    const before = h.snapshots.length;
    const event: LiveChangeEvent = {
      type: "provider-connection-changed", revision: 3, provider: "UPSTOX",
      status: { provider: "UPSTOX", state: "DISCONNECTED", changedAtMs: BASE, error: null },
      requiresSnapshotRefresh: true
    };
    h.sources[0]!.emitNamed("provider-connection-changed", event, 3);
    expect(h.snapshots.length).toBe(before);
    expect(h.lastState().streamStatus).toBe("recovering");
    h.fetcher.resolveNext(snapshot(4, [item("A")]));
    await flush();
    expect(h.sources[1]!.url).toBe("/api/market/stream?since=4");
    h.controller.stop();
  });

  test("duplicate provider-connection event after recovery causes no extra fetch", async () => {
    const h = harness();
    await startLive(h, 1);
    const event: LiveChangeEvent = {
      type: "provider-connection-changed", revision: 2, provider: "UPSTOX",
      status: { provider: "UPSTOX", state: "DISCONNECTED", changedAtMs: BASE, error: null },
      requiresSnapshotRefresh: true
    };
    h.sources[0]!.emitNamed("provider-connection-changed", event, 2);
    h.fetcher.resolveNext(snapshot(3));
    await flush();
    h.sources[1]!.open();
    const callsAfterRecovery = h.fetcher.calls;
    h.sources[1]!.emitNamed("provider-connection-changed", { ...event, revision: 2 }, 2);
    await flush();
    expect(h.fetcher.calls).toBe(callsAfterRecovery);
    expect(h.lastState().streamStatus).toBe("live");
    h.controller.stop();
  });

  test("onerror triggers controlled recovery", async () => {
    const h = harness();
    await startLive(h);
    h.sources[0]!.fail();
    expect(h.lastState().streamStatus).toBe("recovering");
    expect(h.fetcher.calls).toBe(1);
    h.controller.stop();
  });
});

describe("LiveStreamController — refresh", () => {
  test("refresh fetches a snapshot, keeps EventSource open, and later events still apply", async () => {
    const h = harness();
    await startLive(h);
    h.sources[0]!.emitControl("refresh");
    expect(h.lastState().refreshStatus).toBe("fetching");
    h.fetcher.resolveNext(snapshot(3));
    await flush();
    expect(h.lastState().refreshStatus).toBe("idle");
    expect(h.snapshots[h.snapshots.length - 1]!.revision).toBe(3);
    expect(h.sources[0]!.closed).toBe(false);
    h.sources[0]!.emitData(updated(4, "A"), 4);
    expect(h.snapshots[h.snapshots.length - 1]!.revision).toBe(4);
    h.controller.stop();
  });

  test("superseded refresh generation is ignored with no state mutation", async () => {
    const h = harness();
    await startLive(h);
    h.sources[0]!.emitControl("refresh");
    h.sources[0]!.emitControl("refresh");
    expect(h.fetcher.pendingCount).toBe(2);
    const before = h.snapshots.length;
    h.fetcher.resolveNext(snapshot(5));
    await flush();
    expect(h.snapshots.length).toBe(before);
    expect(h.lastState().refreshStatus).toBe("fetching");
    h.fetcher.resolveNext(snapshot(6));
    await flush();
    expect(h.snapshots[h.snapshots.length - 1]!.revision).toBe(6);
    expect(h.lastState().refreshStatus).toBe("idle");
    h.controller.stop();
  });

  test("current-generation stale revision is rejected and marked stale", async () => {
    const h = harness();
    await startLive(h, 5);
    h.sources[0]!.emitControl("refresh");
    const before = h.snapshots.length;
    h.fetcher.resolveNext(snapshot(4));
    await flush();
    expect(h.snapshots.length).toBe(before);
    expect(h.lastState().refreshStatus).toBe("stale");
    h.controller.stop();
  });

  test("refresh fetch failure uses bounded fetch-only retry, then ignores periodic controls until manual retry", async () => {
    const h = harness({ maxRefreshAttempts: 2, refreshBaseDelayMs: 10 });
    await startLive(h);
    h.sources[0]!.emitControl("refresh");
    h.fetcher.rejectNext(new Error("network"));
    await flush();
    expect(h.lastState().refreshStatus).toBe("fetching");
    h.fetcher.rejectNext(new Error("network"));
    await flush();
    expect(h.lastState().refreshStatus).toBe("error");
    expect(h.sources[0]!.closed).toBe(false);
    const callsAfterExhaustion = h.fetcher.calls;
    h.sources[0]!.emitControl("refresh");
    expect(h.fetcher.calls).toBe(callsAfterExhaustion);
    h.controller.retryRefresh();
    h.fetcher.resolveNext(snapshot(7));
    await flush();
    expect(h.lastState().refreshStatus).toBe("idle");
    expect(h.snapshots[h.snapshots.length - 1]!.revision).toBe(7);
    h.controller.stop();
  });

  test("recovery invalidates an in-flight refresh", async () => {
    const h = harness();
    await startLive(h);
    h.sources[0]!.emitControl("refresh");
    h.sources[0]!.emitControl("snapshot-required");
    expect(h.fetcher.pendingCount).toBe(2);
    const before = h.snapshots.length;
    h.fetcher.resolveNext(snapshot(8));
    await flush();
    expect(h.snapshots.length).toBe(before);
    expect(h.lastState().refreshStatus).toBe("idle");
    h.fetcher.resolveNext(snapshot(9));
    await flush();
    expect(h.snapshots[h.snapshots.length - 1]!.revision).toBe(9);
    h.controller.stop();
  });
});

describe("LiveStreamController — lifecycle and safety", () => {
  test("capped recovery retries then visible error and manual retry", async () => {
    const h = harness({ maxRecoveryAttempts: 2, recoveryBaseDelayMs: 100, recoveryMaxDelayMs: 250 });
    await startLive(h);
    h.sources[0]!.fail();
    h.fetcher.rejectNext(new Error("down"));
    await flush();
    h.fetcher.rejectNext(new Error("down"));
    await flush();
    expect(h.lastState().streamStatus).toBe("error");
    expect(h.lastState().lastError).toContain("down");
    expect(h.sleeps.length).toBe(1);
    expect(h.sleeps[0]!).toBe(100);
    h.controller.retry();
    expect(h.lastState().streamStatus).toBe("recovering");
    h.controller.stop();
  });

  test("stop cancels a pending retry delay and no further retry work runs", async () => {
    // Sleep stays pending until aborted, proving cancellation rather than timing luck.
    let sleepStarted = 0;
    let sleepAborted = 0;
    const h = harness({
      maxRecoveryAttempts: 3,
      sleep: (_ms, signal) => new Promise<void>((resolve) => {
        sleepStarted++;
        if (signal?.aborted) { resolve(); return; }
        signal?.addEventListener("abort", () => { sleepAborted++; resolve(); }, { once: true });
      })
    });
    await startLive(h);
    h.sources[0]!.fail();
    h.fetcher.rejectNext(new Error("down")); // first failure -> pending retry sleep
    await flush();
    expect(sleepStarted).toBe(1);
    const callsBeforeStop = h.fetcher.calls;
    h.controller.stop(); // aborts the pending sleep
    await flush();
    expect(sleepAborted).toBe(1); // pending delay was cancelled
    expect(h.lastState().streamStatus).toBe("closed");
    expect(h.fetcher.calls).toBe(callsBeforeStop); // no further retry fetch
    expect(sleepStarted).toBe(1); // no additional retry scheduled
  });

  test("stop cancels work and invalidates late callbacks and fetches", async () => {
    const h = harness();
    await startLive(h);
    h.sources[0]!.emitControl("snapshot-required");
    h.controller.stop();
    expect(h.lastState().streamStatus).toBe("closed");
    const before = h.snapshots.length;
    h.fetcher.resolveNext(snapshot(10));
    h.sources[0]!.emitData(updated(11, "A"), 11);
    expect(h.snapshots.length).toBe(before);
    expect(h.lastState().streamStatus).toBe("closed");
  });

  test("StrictMode remount resumes from stored applied revision via ?since=", async () => {
    const first = harness();
    await startLive(first, 5);
    first.controller.stop();

    const second = harness({ initialSnapshot: snapshot(5) });
    second.controller.start();
    expect(second.sources[0]!.url).toBe("/api/market/stream?since=5");
    second.sources[0]!.open(); // no events follow
    expect(second.lastState().streamStatus).toBe("live");

    const before = second.snapshots.length;
    first.sources[0]!.emitData(updated(99, "OLD"), 99);
    expect(second.snapshots.length).toBe(before);
    second.controller.stop();
  });

  test("streamStatus live does not imply a streaming provider feed", async () => {
    const h = harness();
    const withLockedProvider: LiveSnapshot = {
      ...snapshot(1),
      connections: [{ provider: "UPSTOX", state: "NOT_STARTED", changedAtMs: BASE, error: null }]
    };
    h.controller.start();
    h.sources[0]!.open();
    h.sources[0]!.emitNamed("snapshot", withLockedProvider, 1);
    expect(h.lastState().streamStatus).toBe("live");
    expect(h.snapshots[0]!.connections[0]!.state).toBe("NOT_STARTED");
    h.controller.stop();
  });
});
