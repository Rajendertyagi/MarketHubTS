import { describe, expect, test } from "bun:test";
import type { FreshnessPolicy } from "../../packages/contracts/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import type { NormalizeObservationInput } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import type { ClientSession, LiveEventHubOptions, OutboundEvent } from "../../packages/realtime/src/index";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000
};
const noCursor = { lastEventId: undefined, since: undefined };

class FakeIntervalScheduler {
  tasks: Array<{ handle: number; fn: () => void; ms: number; cancelled: boolean }> = [];
  private next = 1;
  setInterval = (fn: () => void, ms: number): ReturnType<typeof setInterval> => {
    const handle = this.next++;
    this.tasks.push({ handle, fn, ms, cancelled: false });
    return handle as unknown as ReturnType<typeof setInterval>;
  };
  clearInterval = (handle: ReturnType<typeof setInterval>): void => {
    const t = this.tasks.find((x) => x.handle === (handle as unknown as number));
    if (t) t.cancelled = true;
  };
  fire(handle: ReturnType<typeof setInterval>): void {
    const t = this.tasks.find((x) => x.handle === (handle as unknown as number));
    if (t && !t.cancelled) t.fn();
  }
  get active() { return this.tasks.filter((t) => !t.cancelled); }
}

function harness(overrides: Partial<LiveEventHubOptions> = {}) {
  const service = new MarketDataService({
    now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
  });
  const scheduler = new FakeIntervalScheduler();
  const hub = new LiveEventHub(service, {
    replayMaxEvents: 100, replayMaxBytes: 1_000_000,
    clientMaxEvents: 100, clientMaxBytes: 1_000_000,
    refreshIntervalMs: 0,
    timerScheduler: scheduler as unknown as LiveEventHubOptions["timerScheduler"],
    ...overrides
  });
  hub.start();
  return { service, hub, scheduler };
}

function observation(ltp: number): NormalizeObservationInput {
  return {
    provider: "UPSTOX", canonicalId: A, value: { ltp },
    rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time", receivedAtMs: BASE
  };
}

describe("Stage F — hub timer seam and stress", () => {
  test("refresh timer is armed on start and cleared on stop", () => {
    const { hub, scheduler } = harness({ refreshIntervalMs: 1000 });
    expect(scheduler.active.length).toBe(1);
    expect(scheduler.active[0]!.ms).toBe(1000);
    hub.stop();
    expect(scheduler.active.length).toBe(0);
  });

  test("firing the refresh timer emits a refresh control event", async () => {
    const { hub, scheduler } = harness({ refreshIntervalMs: 1000 });
    const result = hub.openStream(noCursor);
    if (result.outcome !== "session") throw new Error("expected session");
    await result.session.next(); // initial snapshot
    scheduler.fire(scheduler.active[0]!.handle as unknown as ReturnType<typeof setInterval>);
    const event = await result.session.next();
    expect(event!.event).toBe("refresh");
    hub.stop();
  });

  test("pending next() resolves null when the session closes", async () => {
    const { hub } = harness();
    const result = hub.openStream(noCursor);
    if (result.outcome !== "session") throw new Error("expected session");
    await result.session.next(); // drain initial snapshot
    const pending = result.session.next();
    hub.closeSession(result.session);
    expect(await pending).toBeNull();
    hub.stop();
  });

  test("10,000-event soak keeps replay bounded and revision monotonic", () => {
    const { service, hub } = harness({ replayMaxEvents: 50 });
    service.track(A);
    for (let i = 0; i < 10_000; i++) service.applyProviderUpdate(observation(i));
    const stats = hub.getStats();
    expect(stats.replayEvents).toBeLessThanOrEqual(50);
    const snapshot = service.getSnapshot();
    expect(snapshot.revision).toBe(10_001);
    hub.stop();
  });

  test("100-client load: every client receives a live event", async () => {
    const { service, hub } = harness({ clientMaxEvents: 10 });
    service.track(A);
    const sessions: ClientSession[] = [];
    for (let i = 0; i < 100; i++) {
      const result = hub.openStream({ lastEventId: String(service.revision), since: undefined });
      if (result.outcome !== "session") throw new Error("expected session");
      sessions.push(result.session);
    }
    service.applyProviderUpdate(observation(42));
    for (const session of sessions) {
      const event = await session.next();
      expect(event!.event).toBe("item-updated");
    }
    expect(hub.getStats().clients).toBe(100);
    hub.stop();
  });

  test("1,000 open/close cycles leave no clients", () => {
    const { hub } = harness();
    for (let i = 0; i < 1000; i++) {
      const result = hub.openStream(noCursor);
      if (result.outcome !== "session") throw new Error("expected session");
      hub.closeSession(result.session);
    }
    expect(hub.getStats().clients).toBe(0);
    hub.stop();
  });
});
