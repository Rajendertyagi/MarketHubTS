import { describe, expect, test } from "bun:test";
import type { FreshnessPolicy } from "../../packages/contracts/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import type { NormalizeObservationInput } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import type { ClientSession, LiveEventHubOptions, OutboundEvent } from "../../packages/realtime/src/index";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const B = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";
const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000
};

function harness(overrides: Partial<LiveEventHubOptions> = {}) {
  const service = new MarketDataService({
    now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
  });
  const hub = new LiveEventHub(service, {
    replayMaxEvents: 100, replayMaxBytes: 1_000_000,
    clientMaxEvents: 100, clientMaxBytes: 1_000_000,
    refreshIntervalMs: 0,
    ...overrides
  });
  hub.start();
  service.track(A);
  service.track(B);
  // Cursor at the post-tracking baseline: subsequent reads see only emitted events.
  const base = service.getSnapshot().revision;
  return { service, hub, base };
}

function observation(canonicalId: string, ltp: number): NormalizeObservationInput {
  return {
    provider: "UPSTOX", canonicalId, value: { ltp },
    rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time", receivedAtMs: BASE
  };
}

function emit(service: MarketDataService, canonicalId: string, ltp: number): void {
  service.applyProviderUpdate(observation(canonicalId, ltp));
}

async function readN(session: ClientSession, n: number): Promise<OutboundEvent[]> {
  const out: OutboundEvent[] = [];
  for (let i = 0; i < n; i++) {
    const event = await session.next();
    if (event === null) break;
    out.push(event);
  }
  return out;
}

describe("LiveEventHub.readAfter (M6-B1)", () => {
  test("valid cursor returns ordered events with limit+1 lookahead", () => {
    const { service, hub, base } = harness();
    emit(service, A, 100); // base+1
    emit(service, B, 200); // base+2
    emit(service, A, 101); // base+3

    const first = hub.readAfter(String(base), 2);
    expect(first.outcome).toBe("page");
    if (first.outcome !== "page") return;
    expect(first.events.map((e) => e.id)).toEqual([String(base + 1), String(base + 2)]);
    expect(first.nextCursor).toBe(String(base + 2)); // lookahead row (base+3) exists

    const second = hub.readAfter(first.nextCursor!, 2);
    expect(second.outcome).toBe("page");
    if (second.outcome !== "page") return;
    expect(second.events.map((e) => e.id)).toEqual([String(base + 3)]);
    expect(second.nextCursor).toBeNull(); // no lookahead row
    hub.stop();
  });

  test("no cursor reads all retained history; empty page and full final page yield null", () => {
    const { service, hub, base } = harness();
    emit(service, A, 100); // base+1

    const all = hub.readAfter(undefined, 10);
    expect(all.outcome).toBe("page");
    if (all.outcome === "page") {
      expect(all.events.length).toBe(base + 1); // track events + emitted event
      expect(all.nextCursor).toBeNull();
    }

    const empty = hub.readAfter(String(base + 1), 10);
    expect(empty.outcome).toBe("page");
    if (empty.outcome === "page") {
      expect(empty.events).toEqual([]);
      expect(empty.nextCursor).toBeNull();
    }
    hub.stop();
  });

  test("invalid and future cursors return snapshot-required", () => {
    const { service, hub, base } = harness();
    emit(service, A, 100); // base+1
    emit(service, B, 200); // base+2

    expect(hub.readAfter("not-a-number", 10)).toEqual({ outcome: "snapshot-required", reason: "invalid-cursor" });
    expect(hub.readAfter(String(base + 99), 10)).toEqual({ outcome: "snapshot-required", reason: "future-cursor" });
    hub.stop();
  });

  test("expired cursor (evicted history) returns snapshot-required", () => {
    // Keep only one replay event so early revisions are evicted.
    const { service, hub, base } = harness({ replayMaxEvents: 1 });
    emit(service, A, 100); // base+1
    emit(service, B, 200); // base+2 — evicts earlier history
    expect(hub.readAfter(String(base), 10)).toEqual({ outcome: "snapshot-required", reason: "expired-cursor" });
    hub.stop();
  });

  test("lost history after restart returns snapshot-required, not empty success", () => {
    const { service, hub } = harness();
    emit(service, A, 100);
    emit(service, B, 200);
    hub.stop(); // clears history but source revision stays > 0

    expect(hub.readAfter(undefined, 10)).toEqual({ outcome: "snapshot-required", reason: "expired-cursor" });
  });

  test("bounded reads never exceed the requested limit", () => {
    const { service, hub, base } = harness();
    for (let i = 0; i < 10; i++) emit(service, A, 100 + i);
    const result = hub.readAfter(String(base), 3);
    expect(result.outcome).toBe("page");
    if (result.outcome === "page") {
      expect(result.events.length).toBe(3);
      expect(result.nextCursor).toBe(String(base + 3));
    }
    hub.stop();
  });

  test("readAfter does not create sessions or disturb existing SSE clients", async () => {
    const { service, hub, base } = harness();
    emit(service, A, 100); // base+1
    const stream = hub.openStream({ lastEventId: undefined, since: undefined });
    expect(stream.outcome).toBe("session");
    if (stream.outcome !== "session") return;
    const before = hub.getStats().clients;

    hub.readAfter(String(base), 10);
    expect(hub.getStats().clients).toBe(before); // no new client session

    emit(service, B, 200); // base+2
    const events = await readN(stream.session, 2);
    expect(events.some((e) => e.id === String(base + 2))).toBe(true); // existing client still receives live events
    hub.closeSession(stream.session);
    hub.stop();
  });
});
