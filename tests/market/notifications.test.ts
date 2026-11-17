import { describe, expect, test } from "bun:test";
import type { FreshnessPolicy, LiveChangeEvent } from "../../packages/contracts/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import type { NormalizeObservationInput } from "../../packages/market-core/src/index";

const NIFTY = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000,
  unknownMaxAgeMs: 5_000,
  maxRetainedObservationAgeMs: 60_000
};

function harness() {
  const service = new MarketDataService({
    now: () => new Date(BASE),
    policy,
    maxInstruments: 10,
    session: () => "OPEN"
  });
  return service;
}

function observation(ltp: number): NormalizeObservationInput {
  return {
    provider: "UPSTOX", canonicalId: NIFTY, value: { ltp },
    rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time", receivedAtMs: BASE
  };
}

describe("MarketDataService change notifications", () => {
  test("emits exactly one event per successful revision change", () => {
    const service = harness();
    const events: LiveChangeEvent[] = [];
    service.subscribe((e) => events.push(e));

    service.track(NIFTY);
    service.setProviderConnection("UPSTOX", "STREAMING");
    service.applyProviderUpdate(observation(100));
    service.untrack(NIFTY);

    expect(events.map((e) => e.type)).toEqual([
      "item-updated", "provider-connection-changed", "item-updated", "item-removed"
    ]);
    expect(events.map((e) => e.revision)).toEqual([1, 2, 3, 4]);
    expect(service.revision).toBe(4);
  });

  test("no event for no-op track or unchanged connection state", () => {
    const service = harness();
    const events: LiveChangeEvent[] = [];
    service.subscribe((e) => events.push(e));

    service.track(NIFTY);
    service.track(NIFTY); // no-op
    service.setProviderConnection("UPSTOX", "NOT_STARTED");
    service.setProviderConnection("UPSTOX", "NOT_STARTED"); // no-op (same state + error)
    service.setProviderConnection("UPSTOX", "STREAMING");
    service.setProviderConnection("UPSTOX", "STREAMING"); // no-op

    expect(events.map((e) => e.type)).toEqual([
      "item-updated", "provider-connection-changed", "provider-connection-changed"
    ]);
    expect(service.revision).toBe(3);
  });

  test("untrack emits only on actual removal", () => {
    const service = harness();
    const events: LiveChangeEvent[] = [];
    service.subscribe((e) => events.push(e));
    expect(service.untrack(NIFTY)).toBe(false);
    expect(events.length).toBe(0);
    service.track(NIFTY);
    expect(service.untrack(NIFTY)).toBe(true);
    expect(events.length).toBe(2);
    expect(events[1]!.type).toBe("item-removed");
  });

  test("item-updated carries the correct detached item", () => {
    const service = harness();
    let captured: LiveChangeEvent | null = null;
    service.subscribe((e) => { captured = e; });
    service.track(NIFTY);
    service.applyProviderUpdate(observation(123));

    expect(captured!.type).toBe("item-updated");
    if (captured!.type === "item-updated") {
      expect(captured!.canonicalId).toBe(NIFTY);
      expect(captured!.item.observations.UPSTOX?.value.ltp).toBe(123);
      // Detached: mutating the event must not change canonical state.
      captured!.item.observations.UPSTOX!.value.ltp = 999;
      expect(service.getItem(NIFTY)!.observations.UPSTOX!.value.ltp).toBe(123);
    }
  });

  test("connection change signals a required snapshot refresh", () => {
    const service = harness();
    const events: LiveChangeEvent[] = [];
    service.subscribe((e) => events.push(e));
    service.setProviderConnection("UPSTOX", "DISCONNECTED", "socket closed");

    expect(events.length).toBe(1);
    const event = events[0]!;
    expect(event.type).toBe("provider-connection-changed");
    if (event.type === "provider-connection-changed") {
      expect(event.provider).toBe("UPSTOX");
      expect(event.status.state).toBe("DISCONNECTED");
      expect(event.status.error).toBe("socket closed");
      expect(event.requiresSnapshotRefresh).toBe(true);
    }
  });

  test("listener exceptions are isolated and do not break mutation or peers", () => {
    const service = harness();
    const seen: string[] = [];
    service.subscribe(() => { throw new Error("bad listener"); });
    service.subscribe((e) => seen.push(e.type));

    expect(() => service.track(NIFTY)).not.toThrow();
    expect(() => service.applyProviderUpdate(observation(1))).not.toThrow();
    expect(seen).toEqual(["item-updated", "item-updated"]);
    expect(service.getItem(NIFTY)!.observations.UPSTOX?.value.ltp).toBe(1);
  });

  test("unsubscribe stops notifications", () => {
    const service = harness();
    const events: LiveChangeEvent[] = [];
    const off = service.subscribe((e) => events.push(e));
    service.track(NIFTY);
    off();
    service.untrack(NIFTY);
    expect(events.map((e) => e.type)).toEqual(["item-updated"]);
  });

  test("snapshot includes provider connection statuses", () => {
    const service = harness();
    service.setProviderConnection("UPSTOX", "STREAMING");
    const snapshot = service.getSnapshot();
    expect(snapshot.connections).toEqual([
      { provider: "UPSTOX", state: "STREAMING", changedAtMs: BASE, error: null }
    ]);
  });
});
