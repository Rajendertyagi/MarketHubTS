import { describe, expect, test } from "bun:test";
import type {
  FreshnessPolicy,
  MarketSessionState,
  ProviderId
} from "../../packages/contracts/src/index";
import {
  evaluateFreshness,
  LiveStateCapacityError,
  MarketDataService,
  normalizeObservation,
  normalizeProviderTimestamp,
  timestampsCompatible,
  UntrackedInstrumentError
} from "../../packages/market-core/src/index";
import type { NormalizeObservationInput } from "../../packages/market-core/src/index";

// Representative M2 canonical index identity (not a provider identifier).
const NIFTY = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const OTHER = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";

const BASE = 1_700_000_000_000;
const policy: FreshnessPolicy = {
  openMaxAgeMs: 15_000,
  unknownMaxAgeMs: 5_000,
  maxRetainedObservationAgeMs: 60_000
};

function harness(maxInstruments = 10) {
  let nowMs = BASE;
  let session: MarketSessionState = "OPEN";
  const evicted: string[] = [];
  const service = new MarketDataService({
    now: () => new Date(nowMs),
    policy,
    maxInstruments,
    session: () => session,
    onEvict: (id) => evicted.push(id)
  });
  return {
    service,
    evicted,
    advance: (ms: number) => { nowMs += ms; },
    setNow: (ms: number) => { nowMs = ms; },
    setSession: (s: MarketSessionState) => { session = s; },
    nowMs: () => nowMs
  };
}

function update(service: MarketDataService, provider: ProviderId, overrides: Partial<NormalizeObservationInput> = {}): void {
  const input: NormalizeObservationInput = {
    provider,
    canonicalId: NIFTY,
    value: { ltp: provider === "UPSTOX" ? 100 : 200 },
    rawProviderTimestamp: BASE,
    providerTimestampUnit: "MS",
    providerTimestampMeaning: "last traded time",
    receivedAtMs: BASE,
    ...overrides
  };
  service.applyProviderUpdate(input);
}

function connectBoth(service: MarketDataService): void {
  service.setProviderConnection("UPSTOX", "STREAMING");
  service.setProviderConnection("FYERS", "STREAMING");
}

describe("per-provider observations", () => {
  test("retains independent observations and updating one does not overwrite the other", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    update(h.service, "UPSTOX", { value: { ltp: 100 } });
    update(h.service, "FYERS", { value: { ltp: 200 } });

    let item = h.service.getSnapshot().items[0]!;
    expect(item.observations.UPSTOX?.value.ltp).toBe(100);
    expect(item.observations.FYERS?.value.ltp).toBe(200);

    update(h.service, "UPSTOX", { value: { ltp: 101 }, receivedAtMs: BASE + 1, rawProviderTimestamp: BASE + 1 });
    item = h.service.getSnapshot().items[0]!;
    expect(item.observations.UPSTOX?.value.ltp).toBe(101);
    expect(item.observations.FYERS?.value.ltp).toBe(200);
  });

  test("provider disconnect does not destroy observations and is not presented as streaming", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    update(h.service, "UPSTOX", { value: { ltp: 100 } });
    h.service.setProviderConnection("UPSTOX", "DISCONNECTED", "socket closed");

    const snapshot = h.service.getSnapshot();
    expect(snapshot.items[0]!.observations.UPSTOX?.value.ltp).toBe(100);
    expect(h.service.getConnectionStatus("UPSTOX")?.state).toBe("DISCONNECTED");
    expect(h.service.getConnectionStatus("UPSTOX")?.error).toBe("socket closed");
    expect(snapshot.items[0]!.selected.mode).toBe("LAST_KNOWN");
    expect(snapshot.items[0]!.selected.provider).toBe("UPSTOX");
  });
});

describe("timestamp normalization", () => {
  test("converts documented units and rejects invalid or unknown values", () => {
    expect(normalizeProviderTimestamp(BASE, "MS")).toBe(BASE);
    expect(normalizeProviderTimestamp(BASE / 1000, "SECONDS")).toBe(BASE);
    expect(normalizeProviderTimestamp(BASE, "UNKNOWN")).toBeNull();
    expect(normalizeProviderTimestamp(Number.NaN, "MS")).toBeNull();
    expect(normalizeProviderTimestamp(-1, "MS")).toBeNull();
    expect(normalizeProviderTimestamp(0, "MS")).toBeNull();
    expect(normalizeProviderTimestamp(9_999_999_999_999_999, "MS")).toBeNull();
  });

  test("records provenance and trust from normalized timestamps", () => {
    const trusted = normalizeObservation({
      provider: "UPSTOX", canonicalId: NIFTY, value: { ltp: 1 },
      rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
      providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    expect(trusted.timestampTrusted).toBe(true);
    expect(trusted.normalizedProviderTimestampMs).toBe(BASE);
    expect(trusted.provenance.sourceObservedAt).toBe(new Date(BASE).toISOString());
    expect(trusted.provenance.receivedAt).toBe(new Date(BASE).toISOString());

    const untrusted = normalizeObservation({
      provider: "FYERS", canonicalId: NIFTY, value: { ltp: 1 },
      rawProviderTimestamp: BASE, providerTimestampUnit: "UNKNOWN",
      providerTimestampMeaning: "unknown", receivedAtMs: BASE
    });
    expect(untrusted.timestampTrusted).toBe(false);
    expect(untrusted.normalizedProviderTimestampMs).toBeNull();
    expect(untrusted.provenance.sourceObservedAt).toBeUndefined();
  });

  test("compares timestamps only when semantics are compatible", () => {
    const a = normalizeObservation({
      provider: "UPSTOX", canonicalId: NIFTY, value: {}, rawProviderTimestamp: BASE,
      providerTimestampUnit: "MS", providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    const same = normalizeObservation({
      provider: "FYERS", canonicalId: NIFTY, value: {}, rawProviderTimestamp: BASE + 1,
      providerTimestampUnit: "MS", providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    const diffMeaning = normalizeObservation({
      provider: "FYERS", canonicalId: NIFTY, value: {}, rawProviderTimestamp: BASE + 1,
      providerTimestampUnit: "MS", providerTimestampMeaning: "exchange feed time", receivedAtMs: BASE
    });
    const diffUnit = normalizeObservation({
      provider: "FYERS", canonicalId: NIFTY, value: {}, rawProviderTimestamp: BASE / 1000 + 1,
      providerTimestampUnit: "SECONDS", providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    const untrusted = normalizeObservation({
      provider: "FYERS", canonicalId: NIFTY, value: {}, rawProviderTimestamp: BASE,
      providerTimestampUnit: "UNKNOWN", providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    const missing = normalizeObservation({
      provider: "FYERS", canonicalId: NIFTY, value: {}, rawProviderTimestamp: null,
      providerTimestampUnit: "MS", providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    expect(timestampsCompatible(a, same)).toBe(true);
    // Different units are fine when conversion to ms is reliable and meaning matches.
    expect(timestampsCompatible(a, diffUnit)).toBe(true);
    expect(timestampsCompatible(a, diffMeaning)).toBe(false);
    expect(timestampsCompatible(a, untrusted)).toBe(false);
    expect(timestampsCompatible(a, missing)).toBe(false);
  });
});

describe("source selection", () => {
  test("ranks compatible source timestamps over receivedAt", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    // Upstox has an older receipt but a newer source timestamp; same semantics.
    update(h.service, "UPSTOX", {
      value: { ltp: 100 }, rawProviderTimestamp: BASE - 1_000, receivedAtMs: BASE - 5_000
    });
    update(h.service, "FYERS", {
      value: { ltp: 200 }, rawProviderTimestamp: BASE - 2_000, receivedAtMs: BASE - 100
    });
    const selected = h.service.getSnapshot().items[0]!.selected;
    expect(selected.provider).toBe("UPSTOX");
    expect(selected.mode).toBe("LIVE");
    expect(selected.reason).toContain("compatible source timestamp");
  });

  test("ranks compatible normalized timestamps across different units", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    // Upstox: ms source, newer observation, older receipt.
    update(h.service, "UPSTOX", {
      value: { ltp: 100 }, rawProviderTimestamp: BASE - 1_000,
      providerTimestampUnit: "MS", providerTimestampMeaning: "last traded time", receivedAtMs: BASE - 5_000
    });
    // FYERS: seconds source, older observation, newer receipt.
    update(h.service, "FYERS", {
      value: { ltp: 200 }, rawProviderTimestamp: (BASE - 2_000) / 1000,
      providerTimestampUnit: "SECONDS", providerTimestampMeaning: "last traded time", receivedAtMs: BASE - 100
    });
    const selected = h.service.getSnapshot().items[0]!.selected;
    expect(selected.provider).toBe("UPSTOX");
    expect(selected.reason).toContain("compatible source timestamp");
  });

  test("uses receivedAt fallback with a recorded reason when timestamps are incompatible", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    update(h.service, "UPSTOX", {
      value: { ltp: 100 }, rawProviderTimestamp: BASE - 5_000,
      providerTimestampUnit: "MS", providerTimestampMeaning: "last traded time", receivedAtMs: BASE - 100
    });
    update(h.service, "FYERS", {
      value: { ltp: 200 }, rawProviderTimestamp: (BASE - 1_000) / 1000,
      providerTimestampUnit: "SECONDS", providerTimestampMeaning: "exchange feed time", receivedAtMs: BASE - 50
    });
    const selected = h.service.getSnapshot().items[0]!.selected;
    expect(selected.provider).toBe("FYERS");
    expect(selected.reason).toContain("receivedAt fallback");
  });

  test("prefers connected providers and marks retained fallback LAST_KNOWN", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    update(h.service, "UPSTOX", { value: { ltp: 100 } });
    update(h.service, "FYERS", { value: { ltp: 200 } });
    expect(h.service.getSnapshot().items[0]!.selected.mode).toBe("LIVE");

    h.service.setProviderConnection("UPSTOX", "DISCONNECTED");
    h.service.setProviderConnection("FYERS", "DISCONNECTED");
    const selected = h.service.getSnapshot().items[0]!.selected;
    expect(selected.mode).toBe("LAST_KNOWN");
    expect(selected.freshness).not.toBe("FRESH");
  });

  test("returns UNAVAILABLE when no observation qualifies", () => {
    const h = harness();
    h.service.track(NIFTY);
    expect(h.service.getSnapshot().items[0]!.selected.mode).toBe("UNAVAILABLE");

    connectBoth(h.service);
    h.setNow(BASE + 120_000);
    update(h.service, "UPSTOX", { value: { ltp: 100 }, receivedAtMs: BASE, rawProviderTimestamp: BASE });
    expect(h.service.getSnapshot().items[0]!.selected.mode).toBe("UNAVAILABLE");
  });
});

describe("session-aware freshness", () => {
  test("OPEN uses the configured age threshold", () => {
    const h = harness();
    h.service.track(NIFTY);
    update(h.service, "UPSTOX", { value: { ltp: 1 } });
    expect(h.service.getSnapshot().items[0]!.observations.UPSTOX?.freshness).toBe("FRESH");
    h.advance(16_000);
    expect(h.service.getSnapshot().items[0]!.observations.UPSTOX?.freshness).toBe("STALE");
  });

  test("CLOSED yields LAST_KNOWN and inactivity alone is not stale", () => {
    const h = harness();
    h.service.track(NIFTY);
    update(h.service, "UPSTOX", { value: { ltp: 1 } });
    h.setSession("CLOSED");
    h.advance(30_000);
    const freshness = h.service.getSnapshot().items[0]!.observations.UPSTOX?.freshness;
    expect(freshness).toBe("LAST_KNOWN");
    expect(freshness).not.toBe("STALE");
    expect(freshness).not.toBe("FRESH");
  });

  test("UNKNOWN is conservative and discloses uncertainty", () => {
    const h = harness();
    h.service.track(NIFTY);
    update(h.service, "UPSTOX", { value: { ltp: 1 } });
    h.setSession("UNKNOWN");
    expect(h.service.getSnapshot().items[0]!.observations.UPSTOX?.freshness).toBe("FRESH");

    update(h.service, "FYERS", {
      value: { ltp: 2 }, rawProviderTimestamp: BASE, providerTimestampUnit: "UNKNOWN",
      providerTimestampMeaning: "unknown", receivedAtMs: BASE
    });
    expect(h.service.getSnapshot().items[0]!.observations.FYERS?.freshness).toBe("LAST_KNOWN");

    h.advance(6_000);
    expect(h.service.getSnapshot().items[0]!.observations.UPSTOX?.freshness).toBe("STALE");
  });

  test("maximum retained age applies independently of session state", () => {
    const h = harness();
    h.service.track(NIFTY);
    update(h.service, "UPSTOX", { value: { ltp: 1 } });
    h.advance(61_000);
    for (const session of ["OPEN", "CLOSED", "UNKNOWN"] as const) {
      h.setSession(session);
      expect(evaluateFreshness(
        normalizeObservation({
          provider: "UPSTOX", canonicalId: NIFTY, value: {}, rawProviderTimestamp: BASE,
          providerTimestampUnit: "MS", providerTimestampMeaning: "last traded time", receivedAtMs: BASE
        }),
        session, policy, h.nowMs()
      )).toBe("UNAVAILABLE");
    }
  });

  test("never claims freshness from an untrusted future timestamp", () => {
    const h = harness();
    h.service.track(NIFTY);
    update(h.service, "UPSTOX", { value: { ltp: 1 }, rawProviderTimestamp: BASE + 60_000, receivedAtMs: BASE });
    expect(h.service.getSnapshot().items[0]!.observations.UPSTOX?.freshness).toBe("LAST_KNOWN");
  });
});

describe("bounded storage and revision", () => {
  test("enforces explicit capacity and never silently evicts", () => {
    const h = harness(1);
    h.service.track(NIFTY);
    expect(() => h.service.track(OTHER)).toThrow(LiveStateCapacityError);
    expect(h.service.untrack(NIFTY)).toBe(true);
    expect(h.evicted).toEqual([NIFTY]);
    h.service.track(OTHER);
    expect(h.service.getSnapshot().items[0]!.canonicalId).toBe(OTHER);
    expect(() => update(h.service, "UPSTOX")).toThrow(UntrackedInstrumentError);
  });

  test("revision is monotonic and snapshots are consistent copies", () => {
    const h = harness();
    const r0 = h.service.revision;
    h.service.track(NIFTY);
    const r1 = h.service.revision;
    connectBoth(h.service);
    const r2 = h.service.revision;
    update(h.service, "UPSTOX", { value: { ltp: 1 } });
    const r3 = h.service.revision;
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
    expect(r3).toBeGreaterThan(r2);

    const snapshot = h.service.getSnapshot();
    expect(snapshot.revision).toBe(h.service.revision);
    expect(h.service.revision).toBe(r3); // reads do not advance revision
    snapshot.items[0]!.observations.UPSTOX = undefined;
    expect(h.service.getSnapshot().items[0]!.observations.UPSTOX?.value.ltp).toBe(1);
  });
});

describe("defensive copying and ownership", () => {
  function seed(h: ReturnType<typeof harness>) {
    h.service.track(NIFTY);
    connectBoth(h.service);
    h.service.applyProviderUpdate({
      provider: "UPSTOX", canonicalId: NIFTY,
      value: { ltp: 100, native: { depth: { bid: [1, 2] } } },
      rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
      providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
  }
  function nativeOf(value: { native?: Record<string, unknown> }): { depth: { bid: number[] } } {
    return value.native as { depth: { bid: number[] } };
  }

  test("mutating the submitted input object does not change internal state", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    const native = { depth: { bid: [1, 2] } };
    const value = { ltp: 100, native };
    h.service.applyProviderUpdate({
      provider: "UPSTOX", canonicalId: NIFTY, value,
      rawProviderTimestamp: BASE, providerTimestampUnit: "MS",
      providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    value.ltp = 999;
    native.depth.bid[0] = 999;
    const obs = h.service.getSnapshot().items[0]!.observations.UPSTOX!;
    expect(obs.value.ltp).toBe(100);
    expect(nativeOf(obs.value).depth.bid[0]).toBe(1);
  });

  test("getItem returns a deep copy including native fields and provenance", () => {
    const h = harness();
    seed(h);
    const item = h.service.getItem(NIFTY)!;
    item.observations.UPSTOX!.value.ltp = 999;
    nativeOf(item.observations.UPSTOX!.value).depth.bid[0] = 999;
    item.observations.UPSTOX!.provenance.notes = "tampered";
    const fresh = h.service.getSnapshot().items[0]!.observations.UPSTOX!;
    expect(fresh.value.ltp).toBe(100);
    expect(nativeOf(fresh.value).depth.bid[0]).toBe(1);
    expect(fresh.provenance.notes).toBeUndefined();
  });

  test("getSnapshot returns a deep copy including native fields and provenance", () => {
    const h = harness();
    seed(h);
    const snapshot = h.service.getSnapshot();
    const obs = snapshot.items[0]!.observations.UPSTOX!;
    obs.value.ltp = 999;
    nativeOf(obs.value).depth.bid[0] = 999;
    obs.provenance.notes = "tampered";
    const fresh = h.service.getSnapshot().items[0]!.observations.UPSTOX!;
    expect(fresh.value.ltp).toBe(100);
    expect(nativeOf(fresh.value).depth.bid[0]).toBe(1);
    expect(fresh.provenance.notes).toBeUndefined();
  });

  test("getSelected returns a deep copy that cannot alias internal storage", () => {
    const h = harness();
    seed(h);
    const selected = h.service.getSelected(NIFTY)!;
    selected.value!.ltp = 999;
    nativeOf(selected.value!).depth.bid[0] = 999;
    selected.observation!.value.ltp = 999;
    selected.observation!.provenance.notes = "tampered";
    const fresh = h.service.getSelected(NIFTY)!;
    expect(fresh.value!.ltp).toBe(100);
    expect(nativeOf(fresh.value!).depth.bid[0]).toBe(1);
    expect(fresh.observation!.value.ltp).toBe(100);
    expect(fresh.observation!.provenance.notes).toBeUndefined();
    expect(h.service.getSnapshot().items[0]!.observations.UPSTOX!.value.ltp).toBe(100);
  });
});

describe("maximum retained age and age basis", () => {
  test("a recently received but genuinely old observation is not eligible for retained fallback", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    h.service.applyProviderUpdate({
      provider: "UPSTOX", canonicalId: NIFTY, value: { ltp: 100 },
      rawProviderTimestamp: BASE - 120_000, providerTimestampUnit: "MS",
      providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    const item = h.service.getSnapshot().items[0]!;
    expect(item.observations.UPSTOX!.freshness).toBe("UNAVAILABLE");
    expect(item.selected.mode).toBe("UNAVAILABLE");
  });

  test("trusted source timestamps use SOURCE age basis", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    update(h.service, "UPSTOX", { value: { ltp: 100 } });
    expect(h.service.getSnapshot().items[0]!.observations.UPSTOX!.ageBasis).toBe("SOURCE");
  });

  test("missing source timestamps fall back to receipt time with a recorded reason", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    h.service.applyProviderUpdate({
      provider: "UPSTOX", canonicalId: NIFTY, value: { ltp: 100 },
      rawProviderTimestamp: null, providerTimestampUnit: "UNKNOWN",
      providerTimestampMeaning: "unknown", receivedAtMs: BASE
    });
    const obs = h.service.getSnapshot().items[0]!.observations.UPSTOX!;
    expect(obs.ageBasis).toBe("RECEIPT");
    expect(obs.freshness).toBe("FRESH");
    h.service.setProviderConnection("UPSTOX", "DISCONNECTED");
    const selected = h.service.getSnapshot().items[0]!.selected;
    expect(selected.mode).toBe("LAST_KNOWN");
    expect(selected.reason).toContain("local receipt time");
  });

  test("old source observations are UNAVAILABLE in OPEN, CLOSED and UNKNOWN", () => {
    const h = harness();
    h.service.track(NIFTY);
    connectBoth(h.service);
    h.service.applyProviderUpdate({
      provider: "UPSTOX", canonicalId: NIFTY, value: { ltp: 100 },
      rawProviderTimestamp: BASE - 120_000, providerTimestampUnit: "MS",
      providerTimestampMeaning: "last traded time", receivedAtMs: BASE
    });
    for (const session of ["OPEN", "CLOSED", "UNKNOWN"] as const) {
      h.setSession(session);
      const item = h.service.getSnapshot().items[0]!;
      expect(item.observations.UPSTOX!.freshness).toBe("UNAVAILABLE");
      expect(item.selected.mode).toBe("UNAVAILABLE");
    }
  });
});
