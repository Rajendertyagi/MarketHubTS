import { describe, expect, mock, test } from "bun:test";
// react-dom is a workspace dependency of @markethub/web, not the repo root.
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import type { McpActivityView } from "../../packages/contracts/src/index";
import {
  ActivityPanelView, buildActivityQuery, createActivityPanelActions,
  type ActivityPanelController, type ActivityPanelViewActions, type ActivityPanelViewState
} from "../../apps/web/src/components/ActivityPanel";

const noop = () => {};
const actions: ActivityPanelViewActions = {
  onRefresh: noop, onApplyFilters: noop, onToolName: noop, onTransport: noop,
  onStatus: noop, onFrom: noop, onTo: noop, onOperationId: noop, onLookup: noop,
  onViewDetails: noop, onPrevPage: noop, onNextPage: noop,
  onOpenSnapshot: noop, onOpenHistorical: noop
};

function baseState(overrides: Partial<ActivityPanelViewState> = {}): ActivityPanelViewState {
  return {
    httpHandlerMounted: true, stdioObserved: false, records: [], nextCursor: null,
    pageIndex: 0, loading: false, error: null, detail: null,
    toolName: "", transport: "", status: "", from: "", to: "", operationId: "",
    ...overrides
  };
}

function render(state: ActivityPanelViewState): string {
  // Call the pure view as a function to avoid needing react/jsx-runtime in the
  // test file (no DOM/JSX test infrastructure is installed in this repo).
  return renderToStaticMarkup(ActivityPanelView({ state, actions }) as never);
}

const record: McpActivityView = {
  id: "a1", operationId: "55555555-5555-4555-8555-555555555555", toolName: "markethub_health",
  transport: "HTTP", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.100Z",
  durationMs: 100, clientStartedAt: null, clientFinishedAt: null,
  clientName: "test-client", clientVersion: "2.3.4", status: "succeeded",
  errorCategory: null, errorMessage: null, summaryJson: '{"query":"NIFTY"}',
  dataResultRef: { kind: "snapshot", snapshotId: "snap-12345678" }
};

describe("M6-C ActivityPanel component rendering", () => {
  test("empty state is shown when there are no records", () => {
    const html = render(baseState());
    expect(html).toContain("No activity recorded yet.");
    expect(html).toContain("MCP / Activity");
  });

  test("loading and error states are shown", () => {
    expect(render(baseState({ loading: true }))).toContain("Loading activity…");
    const errorHtml = render(baseState({ error: "Validation error: bad input" }));
    expect(errorHtml).toContain("Validation error: bad input");
    expect(errorHtml).toContain('role="alert"');
  });

  test("HTTP-mounted and STDIO status labels are truthful", () => {
    expect(render(baseState({ httpHandlerMounted: true }))).toContain("HTTP handler mounted");
    expect(render(baseState({ httpHandlerMounted: false }))).toContain("HTTP handler not mounted");
    expect(render(baseState({ httpHandlerMounted: null }))).toContain("Status unknown");
    expect(render(baseState({ stdioObserved: true }))).toContain("Activity observed");
    expect(render(baseState({ stdioObserved: false }))).toContain("No activity observed / status unknown");
  });

  test("record list displays finishedAt and clientVersion", () => {
    const html = render(baseState({ records: [record] }));
    expect(html).toContain("markethub_health");
    expect(html).toContain("Finished: 2026-01-01T00:00:00.100Z");
    expect(html).toContain("test-client");
    expect(html).toContain("2.3.4");
  });

  test("detail view displays finishedAt and clientVersion", () => {
    const html = render(baseState({ detail: record }));
    expect(html).toContain("Started: 2026-01-01T00:00:00.000Z");
    expect(html).toContain("Finished: 2026-01-01T00:00:00.100Z");
    expect(html).toContain("Client: test-client 2.3.4");
  });

  test("result links render for snapshot and historical refs", () => {
    const snapshotHtml = render(baseState({ records: [record] }));
    expect(snapshotHtml).toContain("Open snapshot snap-123");

    const historical: McpActivityView = {
      ...record, dataResultRef: { kind: "historical", canonicalId: "NIFTY", interval: "1D", fromMs: 1, toMs: 2 }
    };
    const historicalHtml = render(baseState({ records: [historical] }));
    expect(historicalHtml).toContain("Open historical NIFTY / 1D");
  });

  test("pagination buttons reflect page index and cursor availability", () => {
    const first = render(baseState({ pageIndex: 0, nextCursor: "c1" }));
    expect(first).toContain("Page 1");
    expect(first).toMatch(/<button[^>]* disabled="">Previous</);
    expect(first).not.toMatch(/<button[^>]* disabled="">Next</);

    const second = render(baseState({ pageIndex: 1, nextCursor: null }));
    expect(second).toContain("Page 2");
    expect(second).not.toMatch(/<button[^>]* disabled="">Previous</);
    expect(second).toMatch(/<button[^>]* disabled="">Next</);
  });

  test("filter controls reflect current filter state", () => {
    const html = render(baseState({ toolName: "catalog_search", transport: "STDIO", status: "failed" }));
    expect(html).toContain('value="catalog_search"');
    expect(html).toContain('value="STDIO" selected');
    expect(html).toContain('value="failed" selected');
  });
});

/** Mutable controller with injectable API client for interaction tests. */
function makeController(initial: Partial<ActivityPanelViewState> = {}) {
  let current = baseState(initial);
  let cursors: Array<string | undefined> = [undefined];
  const listCalls: unknown[] = [];
  const detailCalls: string[] = [];
  const fetchActivity = mock(async (query: unknown) => {
    listCalls.push(query);
    return { records: [record], nextCursor: "next-cursor" };
  });
  const fetchActivityByOperation = mock(async (id: string) => {
    detailCalls.push(id);
    return record;
  });
  const ctrl: ActivityPanelController = {
    get state() { return current; },
    get pageCursors() { return cursors; },
    setRecords: (v) => { current = { ...current, records: v }; },
    setNextCursor: (v) => { current = { ...current, nextCursor: v }; },
    setPageCursors: (update) => { cursors = typeof update === "function" ? update(cursors) : update; },
    setPageIndex: (v) => { current = { ...current, pageIndex: v }; },
    setStdioObserved: (v) => { current = { ...current, stdioObserved: v }; },
    setDetail: (v) => { current = { ...current, detail: v }; },
    setLoading: (v) => { current = { ...current, loading: v }; },
    setError: (v) => { current = { ...current, error: v }; },
    setOperationId: (v) => { current = { ...current, operationId: v }; },
    setToolName: (v) => { current = { ...current, toolName: v }; },
    setTransport: (v) => { current = { ...current, transport: v }; },
    setStatus: (v) => { current = { ...current, status: v }; },
    setFrom: (v) => { current = { ...current, from: v }; },
    setTo: (v) => { current = { ...current, to: v }; },
    fetchActivity, fetchActivityByOperation
  };
  return { ctrl, listCalls, detailCalls, fetchActivity, fetchActivityByOperation, getState: () => current, getCursors: () => cursors };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("M6-C ActivityPanel interactions", () => {
  test("Apply filters issues a filtered list request and a STDIO presence request", async () => {
    const h = makeController({ toolName: "catalog_search", status: "failed" });
    const a = createActivityPanelActions(h.ctrl);
    a.onApplyFilters();
    await flush();
    expect(h.listCalls.length).toBe(2);
    expect(h.listCalls[0]).toMatchObject({ toolName: "catalog_search", status: "failed", limit: 25 });
    expect(h.listCalls[1]).toEqual({ transport: "STDIO", limit: 1 });
    expect(h.getState().pageIndex).toBe(0);
    expect(h.getCursors()).toEqual([undefined]);
  });

  test("Next and Previous page callbacks use the correct cursors", async () => {
    const h = makeController({ pageIndex: 0, nextCursor: "cursor-1" });
    const a = createActivityPanelActions(h.ctrl);
    a.onNextPage();
    await flush();
    expect(h.getState().pageIndex).toBe(1);
    expect(h.getCursors()).toEqual([undefined, "cursor-1"]);
    expect(h.listCalls[0]).toMatchObject({ cursor: "cursor-1" });

    a.onPrevPage();
    await flush();
    expect(h.getState().pageIndex).toBe(0);
    expect(h.listCalls[1]).not.toHaveProperty("cursor");
  });

  test("View details populates the operation ID and performs a detail lookup", async () => {
    const h = makeController();
    const a = createActivityPanelActions(h.ctrl);
    a.onViewDetails(record.operationId);
    await flush();
    expect(h.getState().operationId).toBe(record.operationId);
    expect(h.detailCalls).toEqual([record.operationId]);
    expect(h.getState().detail).toEqual(record);
  });

  test("detail lookup with an empty operation ID sets an error and skips the API", async () => {
    const h = makeController({ operationId: "   " });
    const a = createActivityPanelActions(h.ctrl);
    a.onLookup();
    await flush();
    expect(h.detailCalls).toHaveLength(0);
    expect(h.getState().error).toBe("Enter an operation ID first.");
  });

  test("snapshot and historical navigation callbacks forward the ref values", () => {
    const openedSnapshot: string[] = [];
    const openedHistorical: unknown[] = [];
    const h = makeController();
    const a = createActivityPanelActions({
      ...h.ctrl,
      onOpenSnapshot: (id) => openedSnapshot.push(id),
      onOpenHistorical: (ref) => openedHistorical.push(ref)
    });
    a.onOpenSnapshot("snap-1");
    a.onOpenHistorical({ canonicalId: "NIFTY", interval: "1D", fromMs: 1, toMs: 2 });
    expect(openedSnapshot).toEqual(["snap-1"]);
    expect(openedHistorical).toEqual([{ canonicalId: "NIFTY", interval: "1D", fromMs: 1, toMs: 2 }]);
  });
});

describe("M6-C ActivityPanel filter/pagination query builder", () => {
  test("builds a bounded query from filters", () => {
    const query = buildActivityQuery({ toolName: "  catalog_search  ", transport: "HTTP", status: "succeeded", from: "2026-01-01T00:00", to: "2026-01-02T00:00" });
    expect(query.toolName).toBe("catalog_search");
    expect(query.transport).toBe("HTTP");
    expect(query.status).toBe("succeeded");
    expect(query.limit).toBe(25);
    expect(typeof query.from).toBe("string");
    expect(typeof query.to).toBe("string");
  });

  test("omits empty filters and includes the pagination cursor", () => {
    const query = buildActivityQuery({ toolName: "", transport: "", status: "", from: "", to: "" }, "cursor-1");
    expect(query).toEqual({ limit: 25, cursor: "cursor-1" });
  });
});
