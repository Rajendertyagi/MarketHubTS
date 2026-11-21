import { describe, expect, test } from "bun:test";
import { createMcpNotificationBridge, MARKET_SNAPSHOT_URI } from "../../apps/api/src/mcp-notification-bridge";
import { MarketDataService } from "../../packages/market-core/src/index";

function makeService() {
  const service = new MarketDataService({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    policy: { openMaxAgeMs: 60_000, unknownMaxAgeMs: 60_000, maxRetainedObservationAgeMs: 86_400_000 },
    maxInstruments: 20,
    session: () => "OPEN" as const
  });
  return service;
}

describe("M6-D notification bridge", () => {
  test("start subscribes exactly once and maps every change to the stable snapshot URI", () => {
    const service = makeService();
    const published: string[] = [];
    const bridge = createMcpNotificationBridge(service, { resourceUpdated: (uri) => published.push(uri) });

    bridge.start();
    bridge.start(); // idempotent — no second listener

    service.track("NIFTY");
    service.untrack("NIFTY");
    expect(published).toEqual([MARKET_SNAPSHOT_URI, MARKET_SNAPSHOT_URI]);
    expect(MARKET_SNAPSHOT_URI).toBe("markethub://market/snapshot");
    bridge.stop();
  });

  test("stop is idempotent and detaches the listener", () => {
    const service = makeService();
    const published: string[] = [];
    const bridge = createMcpNotificationBridge(service, { resourceUpdated: (uri) => published.push(uri) });
    bridge.start();
    bridge.stop();
    bridge.stop(); // idempotent
    service.track("NIFTY");
    expect(published).toHaveLength(0);
  });

  test("publisher failure is contained and reported; canonical mutation still succeeds", () => {
    const service = makeService();
    const errors: unknown[] = [];
    const bridge = createMcpNotificationBridge(
      service,
      { resourceUpdated: () => { throw new Error("publish failed"); } },
      (error) => errors.push(error)
    );
    bridge.start();
    // The canonical mutation must not throw even though the notifier throws.
    expect(() => service.track("NIFTY")).not.toThrow();
    expect(service.getSnapshot().items.length).toBe(1);
    expect(errors).toHaveLength(1);
    bridge.stop();
  });

  test("a throwing error callback never escapes", () => {
    const service = makeService();
    const bridge = createMcpNotificationBridge(
      service,
      { resourceUpdated: () => { throw new Error("publish failed"); } },
      () => { throw new Error("diagnostic failed"); }
    );
    bridge.start();
    expect(() => service.track("NIFTY")).not.toThrow();
    bridge.stop();
  });
});
