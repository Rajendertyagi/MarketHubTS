import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { describe, expect, test } from "bun:test";
import type { CanonicalInstrument } from "../../packages/contracts/src/index";
import {
  createPickerController, initialPickerState, InstrumentPickerView, keyToAction,
  PICKER_MAX_RESULTS, type PickerActions, type PickerState
} from "../../apps/web/src/components/InstrumentPicker";
import type { CatalogSearchPage, CatalogSearchQuery } from "../../apps/web/src/lib/catalog";

function instrument(id: string, symbol: string, name: string): CanonicalInstrument {
  return {
    canonicalId: id, identityKey: `key:${id}`, identityVersion: 1,
    exchange: "NSE", segment: "EQ", marketType: "CASH", instrumentCategory: "EQUITY",
    canonicalSymbol: symbol, displayName: name, tradingStatus: "ACTIVE", lifecycleStatus: "ACTIVE",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  } as CanonicalInstrument;
}

const A = instrument("id-A", "AAA", "Alpha");
const B = instrument("id-B", "BBB", "Beta");

const noopActions: PickerActions = {
  onText: () => {}, onSelect: () => {}, onLoadMore: () => {}, onRetry: () => {}, onKeyDown: () => {}
};

function render(state: PickerState, value = "", cached: { canonicalId: string; label: string } | null = null): string {
  return renderToStaticMarkup(createElement(InstrumentPickerView, {
    state, value, cached, label: "Instrument", placeholder: undefined, disabled: undefined, actions: noopActions
  }) as never);
}

function makeController(overrides: {
  search?: (q: CatalogSearchQuery) => Promise<CatalogSearchPage>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}) {
  let state = initialPickerState();
  const calls: CatalogSearchQuery[] = [];
  const controller = createPickerController({
    search: overrides.search ?? (async (q) => { calls.push(q); return { instruments: [A], nextCursor: null }; }),
    sleep: overrides.sleep ?? (async () => {}),
    onState: (s) => { state = s; }
  });
  return { controller, calls, getState: () => state };
}

describe("InstrumentPicker controller", () => {
  test("empty text issues no request and returns to idle", async () => {
    const h = makeController();
    h.controller.onText("   ");
    await Bun.sleep(0);
    expect(h.calls).toHaveLength(0);
    expect(h.getState().results).toEqual([]);
  });

  test("debounced query issues one request with limit 25", async () => {
    const h = makeController();
    h.controller.onText("alpha");
    await Bun.sleep(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.text).toBe("alpha");
    expect(h.calls[0]!.limit).toBe(25);
  });

  test("stale completions are ignored by generation guard", async () => {
    let resolveFirst: ((p: CatalogSearchPage) => void) | null = null;
    const h = makeController({
      search: (q) => q.text === "first"
        ? new Promise<CatalogSearchPage>((r) => { resolveFirst = r; })
        : Promise.resolve({ instruments: [B], nextCursor: null })
    });
    h.controller.onText("first");
    await Bun.sleep(0);
    h.controller.onText("second");
    await Bun.sleep(0);
    resolveFirst?.({ instruments: [A], nextCursor: null });
    await Bun.sleep(0);
    expect(h.getState().results.map((r) => r.canonicalId)).toEqual([B.canonicalId]);
  });

  test("single-flight Load More: second click while pending issues no request", async () => {
    let resolvePage: ((p: CatalogSearchPage) => void) | null = null;
    const h = makeController();
    h.controller.dispose();
    const calls: CatalogSearchQuery[] = [];
    const c2 = createPickerController({
      search: (q) => { calls.push(q); return q.cursor
        ? new Promise<CatalogSearchPage>((r) => { resolvePage = r; })
        : Promise.resolve({ instruments: [A], nextCursor: "cursor-1" }); },
      sleep: async () => {},
      onState: () => {}
    });
    c2.onText("alpha");
    await Bun.sleep(0);
    c2.onLoadMore();
    await Bun.sleep(0);
    expect(calls.filter((c) => c.cursor).length).toBe(1);
    c2.onLoadMore();
    await Bun.sleep(0);
    expect(calls.filter((c) => c.cursor).length).toBe(1);
    resolvePage?.({ instruments: [B], nextCursor: null });
    await Bun.sleep(0);
    c2.dispose();
  });

  test("100-result cap stops Load More", async () => {
    let state = initialPickerState();
    let pageIndex = 0;
    const c = createPickerController({
      search: async () => {
        const start = pageIndex++ * 25;
        const instruments = Array.from({ length: 25 }, (_, i) => instrument(`id-${start + i}`, `S${start + i}`, `Stock ${start + i}`));
        return { instruments, nextCursor: "next" };
      },
      sleep: async () => {},
      onState: (s) => { state = s; }
    });
    c.onText("x");
    await Bun.sleep(0);
    for (let i = 0; i < 5; i++) { c.onLoadMore(); await Bun.sleep(0); }
    expect(state.results.length).toBeLessThanOrEqual(PICKER_MAX_RESULTS);
    expect(state.nextCursor).toBeNull();
    c.dispose();
  });

  test("cap is enforced even when a load-more page would overshoot", async () => {
    let state = initialPickerState();
    let page = 0;
    const c = createPickerController({
      search: async () => {
        // First page 90, second page 25 -> would merge to 115 without the slice.
        const count = page++ === 0 ? 90 : 25;
        const start = page === 1 ? 0 : 90;
        return {
          instruments: Array.from({ length: count }, (_, i) => instrument(`id-${start + i}`, `S${start + i}`, `Stock ${start + i}`)),
          nextCursor: "next"
        };
      },
      sleep: async () => {},
      onState: (s) => { state = s; }
    });
    c.onText("x");
    await Bun.sleep(0);
    expect(state.results.length).toBe(90);
    c.onLoadMore();
    await Bun.sleep(0);
    expect(state.results.length).toBe(PICKER_MAX_RESULTS);
    expect(state.nextCursor).toBeNull();
    c.dispose();
  });

  test("dispose prevents post-unmount fetch", async () => {
    let resolveSleep: (() => void) | null = null;
    const h = makeController({ sleep: () => new Promise<void>((r) => { resolveSleep = r; }) });
    h.controller.onText("alpha");
    h.controller.dispose();
    resolveSleep?.();
    await Bun.sleep(0);
    expect(h.calls).toHaveLength(0);
  });

  test("select passes canonicalId only; typing never auto-selects", async () => {
    const selected: string[] = [];
    const c = createPickerController({
      search: async () => ({ instruments: [A], nextCursor: null }),
      sleep: async () => {},
      onState: () => {},
      onChange: (id) => selected.push(id)
    });
    c.onText("alpha");
    await Bun.sleep(0);
    expect(selected).toEqual([]); // no auto-select on typing
    expect(c.select(A)).toBe(A.canonicalId);
    expect(selected).toEqual([A.canonicalId]);
    expect(c.getCached()).toEqual({ canonicalId: A.canonicalId, label: "Alpha (AAA) · NSE/EQ" });
    c.dispose();
  });

  test("keyToAction maps Arrow/Enter/Escape and ignores others", () => {
    expect(keyToAction("ArrowDown")).toBe("down");
    expect(keyToAction("ArrowUp")).toBe("up");
    expect(keyToAction("Enter")).toBe("select");
    expect(keyToAction("Escape")).toBe("clear");
    expect(keyToAction("a")).toBeNull();
  });

  test("onKey Enter selects active option; Escape clears text but keeps value", async () => {
    const selected: string[] = [];
    let state = initialPickerState();
    const c = createPickerController({
      search: async () => ({ instruments: [A], nextCursor: null }),
      sleep: async () => {},
      onState: (s) => { state = s; },
      onChange: (id) => selected.push(id)
    });
    c.onText("alpha");
    await Bun.sleep(0);
    c.moveActive(1);
    expect(c.onKey("Enter")).toBe("select");
    expect(selected).toEqual([A.canonicalId]);
    expect(c.onKey("Escape")).toBe("handled");
    expect(state.text).toBe("");
    c.dispose();
  });

  test("stale completion aborts the previous request signal", async () => {
    const signals: AbortSignal[] = [];
    const c = createPickerController({
      search: (q) => { if (q.signal) signals.push(q.signal); return Promise.resolve({ instruments: [A], nextCursor: null }); },
      sleep: async () => {},
      onState: () => {}
    });
    c.onText("first");
    await Bun.sleep(0);
    c.onText("second");
    await Bun.sleep(0);
    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals[0]!.aborted).toBe(true);
    c.dispose();
  });

  test("debounce delay is honored before fetch", async () => {
    let release: (() => void) | null = null;
    let fetched = false;
    const c = createPickerController({
      search: async () => { fetched = true; return { instruments: [], nextCursor: null }; },
      sleep: () => new Promise<void>((r) => { release = r; }),
      onState: () => {}
    });
    c.onText("alpha");
    await Bun.sleep(0);
    expect(fetched).toBe(false);
    release?.();
    await Bun.sleep(0);
    expect(fetched).toBe(true);
    c.dispose();
  });
});

describe("InstrumentPicker view", () => {
  test("renders idle state with no results", () => {
    const html = render(initialPickerState());
    expect(html).toContain("Instrument");
    expect(html).not.toContain('role="listbox"');
  });

  test("renders results with listbox/option ARIA and exact canonical IDs", () => {
    const state = { ...initialPickerState(), text: "alpha", results: [A, B], activeIndex: 0 };
    const html = render(state, A.canonicalId, { canonicalId: A.canonicalId, label: "Alpha (AAA) · NSE/EQ" });
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-activedescendant');
    expect(html).toContain("Alpha (AAA)");
  });

  test("cached label is not shown against a different external value", () => {
    const state = { ...initialPickerState(), results: [A] };
    const html = render(state, B.canonicalId, { canonicalId: A.canonicalId, label: "Alpha (AAA) · NSE/EQ" });
    const valueDisplay = html.match(/data-testid="picker-value">([^<]*)</)?.[1] ?? "";
    expect(valueDisplay).toBe(B.canonicalId);
    expect(valueDisplay).not.toContain("Alpha (AAA)");
  });

  test("load-more button appears only with nextCursor and below cap", () => {
    const withCursor = { ...initialPickerState(), text: "x", results: [A], nextCursor: "c" };
    expect(render(withCursor)).toContain("Load more");
    const atCap = { ...withCursor, results: Array.from({ length: PICKER_MAX_RESULTS }, (_, i) => instrument(`id-${i}`, `S${i}`, `S ${i}`)) };
    expect(render(atCap)).not.toContain("Load more");
  });

  test("error state shows retry", () => {
    const html = render({ ...initialPickerState(), error: "boom" });
    expect(html).toContain("Retry");
    expect(html).toContain('role="alert"');
  });

  test("no-match state shows an honest message", () => {
    const html = render({ ...initialPickerState(), text: "zzz" });
    expect(html).toContain("No matching instruments in the catalog.");
  });

  test("two picker views render distinct ARIA ids", () => {
    const state = { ...initialPickerState(), text: "x", results: [A], activeIndex: 0 };
    const renderWithPrefix = (prefix: string) => renderToStaticMarkup(createElement(InstrumentPickerView, {
      state, value: "", cached: null, label: "Instrument", placeholder: undefined,
      disabled: undefined, actions: noopActions, idPrefix: prefix
    }) as never);
    const first = renderWithPrefix("picker-a");
    const second = renderWithPrefix("picker-b");
    expect(first).toContain('id="picker-a-options"');
    expect(second).toContain('id="picker-b-options"');
    expect(first).toContain('aria-controls="picker-a-options"');
    expect(second).toContain('aria-controls="picker-b-options"');
    expect(first).toContain('aria-activedescendant="picker-a-option-0"');
    expect(second).toContain('aria-activedescendant="picker-b-option-0"');
  });
});
