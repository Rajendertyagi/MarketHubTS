import { describe, expect, test } from "bun:test";
import type { LiveChangeEvent, LiveEventSource, LiveSnapshot } from "../../packages/contracts/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import type { ClientSession, LiveEventHubOptions, OutboundEvent } from "../../packages/realtime/src/index";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const B = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";
const BASE = 1_700_000_000_000;

/** Controllable source: revisions start at 0 for each fresh instance. */
function fakeSource() {
  let revision = 0;
  const listeners = new Set<(event: LiveChangeEvent) => void>();
  const snapshot = (): LiveSnapshot => ({ revision, capturedAtMs: BASE, items: [], connections: [] });
  const source: LiveEventSource = {
    get revision() { return revision; },
    getSnapshot: snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
  const emit = (canonicalId: string = A): number => {
    revision += 1;
    const event: LiveChangeEvent = { type: "item-removed", revision, canonicalId };
    for (const listener of listeners) listener(event);
    return revision;
  };
  return { source, emit, get revision() { return revision; } };
}

function harness(overrides: Partial<LiveEventHubOptions> = {}) {
  const source = fakeSource();
  const hub = new LiveEventHub(source.source, {
    replayMaxEvents: 100, replayMaxBytes: 1_000_000,
    clientMaxEvents: 100, clientMaxBytes: 1_000_000,
    refreshIntervalMs: 0,
    ...overrides
  });
  hub.start();
  return { source, hub };
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
  test("valid same-instance cursor round-trip with limit+1 lookahead", () => {
    const { source, hub } = harness();
    source.emit(A); // rev 1
    source.emit(B); // rev 2
    source.emit(A); // rev 3

    const first = hub.readAfter(undefined, 2);
    expect(first.outcome).toBe("page");
    if (first.outcome !== "page") return;
    expect(first.events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(first.nextCursor).not.toBeNull(); // lookahead row (rev 3) exists

    const second = hub.readAfter(first.nextCursor!, 2);
    expect(second.outcome).toBe("page");
    if (second.outcome !== "page") return;
    expect(second.events.map((e) => e.id)).toEqual(["3"]);
    expect(second.nextCursor).toBeNull(); // no lookahead row
    hub.stop();
  });

  test("no cursor reads all retained history; caught-up page yields null", () => {
    const { source, hub } = harness();
    source.emit(A); // rev 1
    source.emit(B); // rev 2

    const all = hub.readAfter(undefined, 10);
    expect(all.outcome).toBe("page");
    if (all.outcome === "page") {
      expect(all.events.length).toBe(2);
      expect(all.nextCursor).toBeNull();
    }

    // A cursor from a lookahead page resumes at the next event and terminates
    // with nextCursor null once the retained history is exhausted.
    const first = hub.readAfter(undefined, 1);
    expect(first.outcome).toBe("page");
    if (first.outcome !== "page") return;
    expect(first.nextCursor).not.toBeNull();
    const resumed = hub.readAfter(first.nextCursor!, 10);
    expect(resumed.outcome).toBe("page");
    if (resumed.outcome === "page") {
      expect(resumed.events.map((e) => e.id)).toEqual(["2"]);
      expect(resumed.nextCursor).toBeNull();
    }
    hub.stop();
  });

  test("final page resumeCursor allows reading a later new event", () => {
    const { source, hub } = harness();
    source.emit(A); // rev 1
    source.emit(B); // rev 2

    const final = hub.readAfter(undefined, 10);
    expect(final.outcome).toBe("page");
    if (final.outcome !== "page") return;
    expect(final.nextCursor).toBeNull(); // final page
    expect(final.resumeCursor).toBeTruthy(); // checkpoint still present

    source.emit(A); // rev 3 — new event after the final page
    const resumed = hub.readAfter(final.resumeCursor, 10);
    expect(resumed.outcome).toBe("page");
    if (resumed.outcome === "page") {
      expect(resumed.events.map((e) => e.id)).toEqual(["3"]);
      expect(resumed.nextCursor).toBeNull();
    }
    hub.stop();
  });

  test("empty caught-up page resumeCursor allows reading a later new event", () => {
    const { source, hub } = harness();
    source.emit(A); // rev 1
    source.emit(B); // rev 2 — provides the lookahead row for a cursor
    const first = hub.readAfter(undefined, 1);
    expect(first.outcome).toBe("page");
    if (first.outcome !== "page") return;
    const second = hub.readAfter(first.nextCursor!, 1);
    expect(second.outcome).toBe("page");
    if (second.outcome !== "page") return;
    const caughtUp = hub.readAfter(second.resumeCursor, 10);
    expect(caughtUp.outcome).toBe("page");
    if (caughtUp.outcome !== "page") return;
    expect(caughtUp.events).toEqual([]);
    expect(caughtUp.nextCursor).toBeNull();
    expect(caughtUp.resumeCursor).toBeTruthy();

    source.emit(A); // rev 3 — new event after the empty caught-up page
    const resumed = hub.readAfter(caughtUp.resumeCursor, 10);
    expect(resumed.outcome).toBe("page");
    if (resumed.outcome === "page") expect(resumed.events.map((e) => e.id)).toEqual(["3"]);
    hub.stop();
  });

  test("multi-page read: every page including the final one carries resumeCursor", () => {
    const { source, hub } = harness();
    for (let i = 0; i < 5; i++) source.emit(A); // rev 1..5

    let cursor: string | undefined;
    let pages = 0;
    let finalResume: string | null = null;
    while (true) {
      const page = hub.readAfter(cursor, 2);
      expect(page.outcome).toBe("page");
      if (page.outcome !== "page") break;
      pages += 1;
      expect(page.resumeCursor).toBeTruthy();
      if (page.nextCursor === null) { finalResume = page.resumeCursor; break; }
      cursor = page.nextCursor;
    }
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(finalResume).toBeTruthy();

    source.emit(B); // rev 6
    const resumed = hub.readAfter(finalResume!, 10);
    expect(resumed.outcome).toBe("page");
    if (resumed.outcome === "page") expect(resumed.events.map((e) => e.id)).toEqual(["6"]);
    hub.stop();
  });

  test("invalid and future cursors return snapshot-required", () => {
    const { source, hub } = harness();
    source.emit(A); // rev 1
    source.emit(B); // rev 2

    expect(hub.readAfter("not-a-number", 10)).toEqual({ outcome: "snapshot-required", reason: "invalid-cursor" });
    // A bare numeric cursor is the legacy format and is rejected.
    expect(hub.readAfter("1", 10)).toEqual({ outcome: "snapshot-required", reason: "invalid-cursor" });
    hub.stop();
  });

  test("expired same-instance cursor (evicted history) returns snapshot-required", () => {
    const { source, hub } = harness({ replayMaxEvents: 2 });
    source.emit(A); // rev 1
    source.emit(B); // rev 2
    source.emit(A); // rev 3 — history now [2, 3]

    // Obtain a real opaque cursor at rev 2 via lookahead (rev 3 is the extra row).
    const first = hub.readAfter(undefined, 1);
    expect(first.outcome).toBe("page");
    if (first.outcome !== "page") return;
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();

    // Emit enough to evict rev 2 from the bounded history.
    source.emit(B); // rev 4
    source.emit(A); // rev 5 — history now [4, 5]

    expect(hub.readAfter(cursor!, 10)).toEqual({ outcome: "snapshot-required", reason: "expired-cursor" });
    hub.stop();
  });

  test("lost history after restart returns snapshot-required, not empty success", () => {
    const { source, hub } = harness();
    source.emit(A);
    source.emit(B);
    hub.stop(); // clears history but source revision stays 2

    expect(hub.readAfter(undefined, 10)).toEqual({ outcome: "snapshot-required", reason: "expired-cursor" });
  });

  test("bounded reads never exceed the requested limit", () => {
    const { source, hub } = harness();
    for (let i = 0; i < 10; i++) source.emit(A);
    const result = hub.readAfter(undefined, 3);
    expect(result.outcome).toBe("page");
    if (result.outcome === "page") {
      expect(result.events.length).toBe(3);
      expect(result.nextCursor).not.toBeNull();
    }
    hub.stop();
  });

  test("readAfter does not create sessions or disturb existing SSE clients", async () => {
    const { source, hub } = harness();
    source.emit(A); // rev 1
    const stream = hub.openStream({ lastEventId: undefined, since: undefined });
    expect(stream.outcome).toBe("session");
    if (stream.outcome !== "session") return;
    const before = hub.getStats().clients;

    hub.readAfter(undefined, 10);
    expect(hub.getStats().clients).toBe(before); // no new client session

    source.emit(B); // rev 2
    const events = await readN(stream.session, 2);
    expect(events.some((e) => e.id === "2")).toBe(true); // existing SSE client still receives live events
    hub.closeSession(stream.session);
    hub.stop();
  });

  test("cursor from a previous instance is rejected after revision reset", () => {
    // Instance 1 reaches revision 100; client saves a cursor at revision 80.
    const first = harness();
    for (let i = 0; i < 100; i++) first.source.emit(A);
    const oldCursorPage = first.hub.readAfter(undefined, 100);
    expect(oldCursorPage.outcome).toBe("page");
    if (oldCursorPage.outcome !== "page") return;
    // Walk forward to obtain a real opaque cursor near revision 80.
    let cursor: string | null = null;
    let page = first.hub.readAfter(undefined, 25);
    while (page.outcome === "page" && page.nextCursor !== null) {
      cursor = page.nextCursor;
      page = first.hub.readAfter(cursor, 25);
    }
    expect(cursor).not.toBeNull();
    first.hub.stop();

    // Instance 2: fresh source (revision resets to 0) and fresh hub.
    const second = harness();
    for (let i = 0; i < 100; i++) second.source.emit(A); // exceeds the old numeric revision
    const result = second.hub.readAfter(cursor!, 10);
    expect(result).toEqual({ outcome: "snapshot-required", reason: "previous-instance-cursor" });
    second.hub.stop();
  });

  test("resumeCursor from a previous instance is rejected after restart", () => {
    const first = harness();
    for (let i = 0; i < 30; i++) first.source.emit(A);
    const final = first.hub.readAfter(undefined, 100);
    expect(final.outcome).toBe("page");
    if (final.outcome !== "page") return;
    const oldResume = final.resumeCursor; // checkpoint from the old runtime
    first.hub.stop();

    const second = harness();
    for (let i = 0; i < 100; i++) second.source.emit(A); // new instance exceeds old revision
    expect(second.hub.readAfter(oldResume, 10)).toEqual({
      outcome: "snapshot-required",
      reason: "previous-instance-cursor"
    });
    second.hub.stop();
  });

  test("legacy bare-numeric cursor from a previous instance is rejected", () => {
    const second = harness();
    for (let i = 0; i < 100; i++) second.source.emit(A);
    expect(second.hub.readAfter("80", 10)).toEqual({ outcome: "snapshot-required", reason: "invalid-cursor" });
    second.hub.stop();
  });
});
