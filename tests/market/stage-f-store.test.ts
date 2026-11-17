import { describe, expect, test } from "bun:test";
import type { FreshnessPolicy, LiveChangeEvent } from "../../packages/contracts/src/index";
import { LiveStateStore, LiveStateCapacityError } from "../../packages/market-core/src/index";

const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000
};

function store(maxInstruments = 10) {
  return new LiveStateStore({
    now: () => new Date(BASE), policy, maxInstruments, session: () => "OPEN"
  });
}

describe("Stage F — LiveStateStore stress", () => {
  test("bounded size: tracking beyond capacity throws without mutating", () => {
    const s = store(3);
    s.track("a"); s.track("b"); s.track("c");
    expect(() => s.track("d")).toThrow(LiveStateCapacityError);
    expect(s.getSnapshot().items.length).toBe(3);
    expect(s.getSnapshot().revision).toBe(3);
  });

  test("monotonic revision across many mutations", () => {
    const s = store(20);
    s.track("a");
    let last = s.revision;
    for (let i = 0; i < 1000; i++) {
      s.applyObservation({
        provider: "UPSTOX", canonicalId: "a", value: { ltp: i },
        rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
        providerTimestampMeaning: "last traded time", receivedAtMs: BASE
      } as any);
      expect(s.revision).toBeGreaterThan(last);
      last = s.revision;
    }
    s.untrack("a");
    expect(s.revision).toBeGreaterThan(last);
  });

  test("snapshots are detached from internal state", () => {
    const s = store(5);
    s.track("a");
    const snap = s.getSnapshot();
    const item = s.getItem("a")!;
    (item.selected as any).value = { ltp: 999999 };
    (snap.items[0] as any).canonicalId = "mutated";
    const fresh = s.getSnapshot();
    expect(fresh.items[0]!.canonicalId).toBe("a");
    expect(fresh.items[0]!.selected.value).not.toEqual({ ltp: 999999 });
  });

  test("listener failures are isolated and unsubscribe stops delivery", () => {
    const s = store(5);
    const good: LiveChangeEvent[] = [];
    const bad = () => { throw new Error("listener failed"); };
    const goodListener = (e: LiveChangeEvent) => { good.push(e); };
    const unsubBad = s.subscribe(bad);
    const unsubGood = s.subscribe(goodListener);
    expect(() => s.track("a")).not.toThrow();
    expect(good.length).toBe(1);
    unsubBad();
    unsubGood();
    s.track("b");
    expect(good.length).toBe(1);
  });

  test("1000 track/untrack cycles keep revision monotonic and size bounded", () => {
    const s = store(10);
    let last = 0;
    for (let i = 0; i < 1000; i++) {
      const id = `id-${i % 10}`;
      if (!s.getItem(id)) s.track(id);
      else s.untrack(id);
      expect(s.revision).toBeGreaterThan(last);
      last = s.revision;
      expect(s.getSnapshot().items.length).toBeLessThanOrEqual(10);
    }
  });
});
