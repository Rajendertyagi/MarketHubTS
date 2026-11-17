import { describe, expect, test } from "bun:test";
import type { LiveItem, LiveSnapshot, LiveChangeEvent } from "../../packages/contracts/src/index";
import {
  applyDataEvent, isSafeRevision, parseCursorValue, parseSseMessage, projectDisplayModel
} from "../../apps/web/src/lib/live";

const BASE = 1_700_000_000_000;

function makeItem(canonicalId: string): LiveItem {
  return {
    canonicalId,
    observations: {},
    selected: {
      canonicalId, provider: null, value: null, mode: "UNAVAILABLE",
      freshness: "UNAVAILABLE", reason: "no observation", observation: null
    },
    pinned: false,
    updatedAtMs: BASE
  };
}

function makeSnapshot(revision: number): LiveSnapshot {
  return { revision, capturedAtMs: BASE, items: [], connections: [] };
}

function updated(revision: number, canonicalId: string): LiveChangeEvent {
  return { type: "item-updated", revision, canonicalId, item: makeItem(canonicalId) };
}

describe("cursor validation (matches backend parseCursorValue)", () => {
  test("accepts digit-only safe integers", () => {
    expect(parseCursorValue("0")).toEqual({ kind: "value", value: 0 });
    expect(parseCursorValue("123")).toEqual({ kind: "value", value: 123 });
  });

  test("rejects empty, non-digit, negative, decimal and unsafe values before conversion", () => {
    for (const raw of ["", "abc", "-1", "1.5", "9007199254740993", " 1"]) {
      expect(parseCursorValue(raw).kind).toBe("invalid");
    }
  });

  test("safe revision guard", () => {
    expect(isSafeRevision(0)).toBe(true);
    expect(isSafeRevision(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isSafeRevision(-1)).toBe(false);
    expect(isSafeRevision(1.5)).toBe(false);
    expect(isSafeRevision(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isSafeRevision("1")).toBe(false);
  });
});

describe("SSE message parsing", () => {
  test("parses a valid snapshot event with matching id", () => {
    const snapshot = makeSnapshot(4);
    const parsed = parseSseMessage("4", JSON.stringify(snapshot));
    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind === "snapshot") expect(parsed.snapshot.revision).toBe(4);
  });

  test("rejects a snapshot whose id does not match its revision", () => {
    const parsed = parseSseMessage("3", JSON.stringify(makeSnapshot(4)));
    expect(parsed).toEqual({ kind: "invalid", reason: "snapshot-id-mismatch" });
  });

  test("parses a valid data event and validates id against payload revision", () => {
    const parsed = parseSseMessage("2", JSON.stringify(updated(2, "A")));
    expect(parsed.kind).toBe("data");
    expect(parsed).toEqual({ kind: "data", event: updated(2, "A") });
    expect(parseSseMessage("3", JSON.stringify(updated(2, "A")))).toEqual({ kind: "invalid", reason: "id-revision-mismatch" });
  });

  test("control events are identified by type and ignore a retained lastEventId", () => {
    const required = parseSseMessage("7", JSON.stringify({ type: "snapshot-required", reason: "x" }));
    expect(required).toEqual({ kind: "control", control: "snapshot-required" });
    const refresh = parseSseMessage("7", JSON.stringify({ type: "refresh" }));
    expect(refresh).toEqual({ kind: "control", control: "refresh" });
  });

  test("rejects malformed JSON and invalid payloads", () => {
    expect(parseSseMessage("1", "not-json").kind).toBe("invalid");
    expect(parseSseMessage("1", JSON.stringify({ type: "unknown" })).kind).toBe("invalid");
  });
});

describe("pure reducer", () => {
  test("applies sequential events and ignores duplicates", () => {
    const first = applyDataEvent(makeSnapshot(0), updated(1, "A"));
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") return;
    expect(first.snapshot.revision).toBe(1);
    expect(first.snapshot.items.map((i) => i.canonicalId)).toEqual(["A"]);

    expect(applyDataEvent(first.snapshot, updated(1, "A")).kind).toBe("duplicate");
    const second = applyDataEvent(first.snapshot, updated(2, "B"));
    expect(second.kind).toBe("applied");
    if (second.kind === "applied") expect(second.snapshot.items.map((i) => i.canonicalId)).toEqual(["A", "B"]);
  });

  test("detects gaps and unsafe revisions", () => {
    expect(applyDataEvent(makeSnapshot(1), updated(3, "A")).kind).toBe("gap");
    const unsafe = { ...updated(2, "A"), revision: Number.MAX_SAFE_INTEGER + 1 } as LiveChangeEvent;
    expect(applyDataEvent(makeSnapshot(1), unsafe).kind).toBe("invalid");
  });

  test("provider-connection-changed requires full invalidation, never partial mutation", () => {
    const event: LiveChangeEvent = {
      type: "provider-connection-changed", revision: 1, provider: "UPSTOX",
      status: { provider: "UPSTOX", state: "DISCONNECTED", changedAtMs: BASE, error: null },
      requiresSnapshotRefresh: true
    };
    expect(applyDataEvent(makeSnapshot(0), event)).toEqual({ kind: "invalidation-required" });
  });
});

describe("canonical display-model projection", () => {
  test("includes only canonical fields and excludes native/unrecognized data", () => {
    const item = makeItem("A");
    item.selected = {
      ...item.selected,
      mode: "LIVE",
      freshness: "FRESH",
      provider: "UPSTOX",
      value: { ltp: 100, native: { depth: { bids: [1, 2] }, secret: "x" } } as LiveItem["selected"]["value"],
      observation: {
        provider: "UPSTOX", canonicalId: "A", value: { ltp: 100, native: { depth: {} } },
        rawProviderTimestamp: BASE, providerTimestampUnit: "MS", providerTimestampMeaning: "last traded time",
        normalizedProviderTimestampMs: BASE, timestampTrusted: true, ageBasis: "SOURCE",
        receivedAtMs: BASE, providerSequence: null, freshness: "FRESH", availability: "AVAILABLE",
        provenance: { source: "provider-feed", provider: "UPSTOX", sourceObservedAt: new Date(BASE).toISOString() }
      }
    };
    const snapshot: LiveSnapshot = { ...makeSnapshot(1), items: [item] };
    const model = projectDisplayModel(snapshot);
    const projected = model.items[0]!;

    expect(projected.ltp).toBe(100);
    expect(projected.mode).toBe("LIVE");
    expect(projected.freshness).toBe("FRESH");
    expect(projected.ageBasis).toBe("SOURCE");
    expect(projected.provenance?.source).toBe("provider-feed");
    expect(JSON.stringify(model)).not.toContain("depth");
    expect(JSON.stringify(model)).not.toContain("secret");
    expect(JSON.stringify(model)).not.toContain("native");
    expect(Object.keys(projected).some((key) => key.toLowerCase().includes("depth"))).toBe(false);
  });
});
