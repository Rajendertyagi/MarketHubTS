import { describe, expect, test } from "bun:test";
import { liveSnapshotSchema, type FreshnessPolicy } from "../../packages/contracts/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import type { NormalizeObservationInput } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import type { ClientSession, LiveEventHubOptions, OutboundEvent } from "../../packages/realtime/src/index";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const B = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";
const C = "v1|NSE|INDEX|INDEX|CODE:BANKNIFTY";
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
  return { service, hub };
}

function observation(canonicalId: string, ltp: number): NormalizeObservationInput {
  return {
    provider: "UPSTOX", canonicalId, value: { ltp },
    rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time", receivedAtMs: BASE
  };
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

const noCursor = { lastEventId: undefined, since: undefined };

describe("LiveEventHub — initial sync and replay", () => {
  test("no cursor sends a valid initial snapshot then live events", async () => {
    const { service, hub } = harness();
    const result = hub.openStream(noCursor);
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;

    const first = await result.session.next();
    expect(first!.event).toBe("snapshot");
    expect(first!.id).toBe("0");
    expect(liveSnapshotSchema.parse(first!.data).revision).toBe(0);

    service.track(A);
    const second = await result.session.next();
    expect(second!.event).toBe("item-updated");
    expect(second!.id).toBe("1");
    hub.stop();
  });

  test("valid cursor replays every available change after it, without gaps or duplicates", async () => {
    const { service, hub } = harness();
    service.track(A);                                  // rev 1
    service.setProviderConnection("UPSTOX", "STREAMING"); // rev 2
    service.applyProviderUpdate(observation(A, 100));  // rev 3

    const result = hub.openStream({ lastEventId: "1", since: undefined });
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    const events = await readN(result.session, 2);
    expect(events.map((e) => e.id)).toEqual(["2", "3"]);
    expect(events.map((e) => e.event)).toEqual(["provider-connection-changed", "item-updated"]);
    hub.stop();
  });

  test("cursor at current revision skips replay and still receives later live events", async () => {
    const { service, hub } = harness();
    service.track(A); // rev 1
    const result = hub.openStream({ lastEventId: "1", since: undefined });
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    service.applyProviderUpdate(observation(A, 100)); // rev 2
    const event = await result.session.next();
    expect(event!.id).toBe("2");
    hub.stop();
  });
});

describe("LiveEventHub — cursor validation", () => {
  test("invalid, empty, future and invalid-since cursors emit snapshot-required", () => {
    const { service, hub } = harness();
    service.track(A); // rev 1
    const cases = [
      { lastEventId: "", since: undefined },       // empty-but-present header
      { lastEventId: "abc", since: undefined },    // non-numeric
      { lastEventId: "-1", since: undefined },     // negative
      { lastEventId: "999", since: undefined },    // future
      { lastEventId: undefined, since: "abc" }     // invalid query cursor
    ];
    for (const input of cases) {
      expect(hub.openStream(input).outcome).toBe("snapshot-required");
    }
    hub.stop();
  });

  test("expired cursor emits snapshot-required when history has a gap", () => {
    const { service, hub } = harness({ replayMaxEvents: 1 });
    service.track(A); // rev 1
    service.track(B); // rev 2
    service.track(C); // rev 3 — history now holds only rev 3
    expect(hub.getStats().replayEvents).toBe(1);
    expect(hub.openStream({ lastEventId: "0", since: undefined }).outcome).toBe("snapshot-required");
    hub.stop();
  });

  test("Last-Event-ID is authoritative over ?since=", () => {
    const { service, hub } = harness();
    service.track(A); // rev 1
    // Valid header wins over an invalid query cursor.
    expect(hub.openStream({ lastEventId: "1", since: "abc" }).outcome).toBe("session");
    // Empty header is invalid even when the query cursor is valid.
    expect(hub.openStream({ lastEventId: "", since: "1" }).outcome).toBe("snapshot-required");
    hub.stop();
  });
});

describe("LiveEventHub — bounds and overflow", () => {
  test("replay history is bounded by event count", async () => {
    const { service, hub } = harness({ replayMaxEvents: 2 });
    service.track(A); service.track(B); service.track(C); // rev 1,2,3
    expect(hub.getStats().replayEvents).toBe(2);
    const result = hub.openStream({ lastEventId: "1", since: undefined });
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    expect((await readN(result.session, 2)).map((e) => e.id)).toEqual(["2", "3"]);
    hub.stop();
  });

  test("replay history is bounded by approximate bytes", () => {
    const { service, hub } = harness({ replayMaxBytes: 1 });
    service.track(A);
    expect(hub.getStats().replayEvents).toBe(0);
    hub.stop();
  });

  test("client queue overflow drops data, counts drops and emits one coalesced snapshot-required", async () => {
    const { service, hub } = harness({ clientMaxEvents: 2 });
    const result = hub.openStream(noCursor);
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    await result.session.next(); // consume initial snapshot

    service.track(A); // rev 1
    service.track(B); // rev 2
    service.track(C); // rev 3 — overflow
    const events = await readN(result.session, 3);
    expect(events.map((e) => e.event)).toEqual(["item-updated", "item-updated", "snapshot-required"]);
    expect(result.session.droppedDataEvents).toBe(1);

    service.track("v1|NSE|INDEX|INDEX|CODE:FRESH"); // rev 4 — dropped while resync required
    expect(result.session.droppedDataEvents).toBe(2);
    hub.stop();
  });

  test("oversized initial snapshot is rejected instead of bypassing the byte budget", () => {
    const { service, hub } = harness({ clientMaxBytes: 1 });
    service.track(A);
    service.track(B); // non-trivial snapshot
    const result = hub.openStream(noCursor);
    expect(result.outcome).toBe("snapshot-required");
    // No session was registered carrying an oversized queued snapshot.
    expect(hub.getStats().clients).toBe(0);
    hub.stop();
  });

  test("initial snapshot is accounted against the per-client byte budget", async () => {
    const service = new MarketDataService({
      now: () => new Date(BASE), policy, maxInstruments: 20, session: () => "OPEN"
    });
    service.track(A);
    const snapshotBytes = JSON.stringify({
      event: "snapshot", id: String(service.revision), data: service.getSnapshot()
    }).length;
    const hub = new LiveEventHub(service, {
      replayMaxEvents: 100, replayMaxBytes: 1_000_000,
      clientMaxEvents: 100, clientMaxBytes: snapshotBytes,
      refreshIntervalMs: 0
    });
    hub.start();
    const result = hub.openStream(noCursor);
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    // The queued snapshot fills the budget; the next data event must overflow.
    service.track(B);
    const events = await readN(result.session, 2);
    expect(events.map((e) => e.event)).toEqual(["snapshot", "snapshot-required"]);
    hub.stop();
  });
});

describe("LiveEventHub — control events, isolation and lifecycle", () => {
  test("refresh is a control event that never advances the data revision", async () => {
    const { service, hub } = harness();
    const result = hub.openStream(noCursor);
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    await result.session.next(); // snapshot
    const before = service.revision;
    hub.emitRefresh();
    const event = await result.session.next();
    expect(event!.event).toBe("refresh");
    expect(event!.id).toBeUndefined();
    expect(service.revision).toBe(before);
    hub.stop();
  });

  test("connection changes are signaled as revisioned data events", async () => {
    const { service, hub } = harness();
    const result = hub.openStream(noCursor);
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    await result.session.next(); // snapshot
    service.setProviderConnection("UPSTOX", "DISCONNECTED", "socket closed");
    const event = await result.session.next();
    expect(event!.event).toBe("provider-connection-changed");
    expect(event!.id).toBe("1");
    hub.stop();
  });

  test("clients are isolated and closing one does not affect others", async () => {
    const { service, hub } = harness();
    const r1 = hub.openStream(noCursor);
    const r2 = hub.openStream(noCursor);
    expect(r1.outcome).toBe("session");
    expect(r2.outcome).toBe("session");
    if (r1.outcome !== "session" || r2.outcome !== "session") return;

    service.track(A);
    await r1.session.next(); await r2.session.next(); // snapshots
    const d1 = await r1.session.next();
    const d2 = await r2.session.next();
    expect(d1!.id).toBe(d2!.id);

    hub.closeSession(r1.session);
    expect(await r1.session.next()).toBeNull();
    service.track(B);
    expect((await r2.session.next())!.event).toBe("item-updated");
    hub.stop();
  });

  test("hub shutdown closes all clients and clears state", async () => {
    const { hub } = harness();
    const result = hub.openStream(noCursor);
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    expect(hub.getStats().clients).toBe(1);
    hub.stop();
    expect(hub.getStats().clients).toBe(0);
    expect(await result.session.next()).toBeNull();
  });

  test("drop telemetry stays cumulative after the overflowing client disconnects", async () => {
    const { service, hub } = harness({ clientMaxEvents: 2 });
    const result = hub.openStream(noCursor);
    expect(result.outcome).toBe("session");
    if (result.outcome !== "session") return;
    await result.session.next(); // snapshot
    service.track(A);
    service.track(B);
    service.track(C); // overflow -> one dropped data event
    expect(hub.getStats().totalDroppedDataEvents).toBe(1);

    hub.closeSession(result.session);
    expect(hub.getStats().clients).toBe(0);
    // Cumulative counter survives client removal.
    expect(hub.getStats().totalDroppedDataEvents).toBe(1);
    hub.stop();
  });
});
