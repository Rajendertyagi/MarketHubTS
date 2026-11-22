import { describe, expect, mock, test } from "bun:test";
// react-dom is a workspace dependency of @markethub/web, not the repo root.
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import {
  mcpActivityStatusSchema, mcpActivityTransportSchema,
  type McpActivityView, type McpOperationDescriptor
} from "../../packages/contracts/src/index";
import {
  ActivityPanelView, buildActivityQuery, createActivityPanelActions,
  type ActivityPanelController, type ActivityPanelViewActions, type ActivityPanelViewState,
  type OperationsLoadState
} from "../../apps/web/src/components/ActivityPanel";

const noop = () => {};
const actions: ActivityPanelViewActions = {
  onRefresh: noop, onApplyFilters: noop, onRetryOperations: noop, onToolName: noop, onTransport: noop,
  onStatus: noop, onFrom: noop, onTo: noop, onOperationId: noop, onLookup: noop,
  onViewDetails: noop, onPrevPage: noop, onNextPage: noop,
  onOpenSnapshot: noop, onOpenHistorical: noop
};

/** Synthetic descriptors covering all three registration groups. */
const sampleOperations: McpOperationDescriptor[] = [
  { name: "markethub_health", type: "tool", description: "Health" },
  { name: "catalog_search", type: "tool", description: "Search" },
  { name: "catalog-instruments", type: "resource", title: "Catalog instruments", description: "Instruments" },
  { name: "events-live", type: "resource", title: "Live event feed", description: "Events" },
  { name: "explain_market_snapshot", type: "prompt", title: "Explain a market snapshot", description: "Explain" }
];

function baseState(overrides: Partial<ActivityPanelViewState> = {}): ActivityPanelViewState {
  return {
    httpHandlerMounted: true, stdioObserved: false, records: [], nextCursor: null,
    pageIndex: 0, loading: false, error: null, detail: null,
    operations: [], operationsLoading: false, operationsError: null,
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
    const html = render(baseState({
      operations: sampleOperations, toolName: "catalog_search", transport: "STDIO", status: "failed"
    }));
    expect(html).toMatch(/<option value="catalog_search" selected="">catalog_search<\/option>/);
    expect(html).toContain('value="STDIO" selected');
    expect(html).toContain('value="failed" selected');
  });

  test("transport and status options derive from the shared contracts", () => {
    const html = render(baseState());
    expect(html).toMatch(/<option value=""[^>]*>Any transport<\/option>/);
    expect(html).toMatch(/<option value=""[^>]*>Any status<\/option>/);
    for (const transport of mcpActivityTransportSchema.options) {
      expect(html).toContain(`value="${transport}"`);
    }
    for (const status of mcpActivityStatusSchema.options) {
      expect(html).toContain(`value="${status}"`);
    }
  });
});

describe("Phase 2C — ActivityPanel operation selector rendering", () => {
  test("Any operation is the default and groups come from descriptor type", () => {
    const html = render(baseState({ operations: sampleOperations }));
    expect(html).toContain('aria-label="Filter operation"');
    expect(html).toMatch(/<option value=""[^>]*>Any operation<\/option>/);
    expect(html).toContain('<optgroup label="Tools">');
    expect(html).toContain('<optgroup label="Resources">');
    expect(html).toContain('<optgroup label="Prompts">');
    // Tools show the stable name; resources/prompts show their title.
    expect(html).toContain('<option value="markethub_health">markethub_health</option>');
    expect(html).toContain('<option value="catalog-instruments">Catalog instruments</option>');
    expect(html).toContain('<option value="explain_market_snapshot">Explain a market snapshot</option>');
  });

  test("all choices come from supplied state, including a synthetic 20th descriptor (AC4)", () => {
    const synthetic: McpOperationDescriptor = {
      name: "brand_new_operation", type: "tool", description: "Registered after deployment"
    };
    const html = render(baseState({ operations: [...sampleOperations, synthetic] }));
    expect(html).toContain('<option value="brand_new_operation">brand_new_operation</option>');
    // No component constant: an empty descriptor list yields only the default.
    const emptyHtml = render(baseState({ operations: [] }));
    expect(emptyHtml).toContain("Any operation");
    expect(emptyHtml).not.toContain("markethub_health</option>");
    expect(emptyHtml).not.toContain("<optgroup");
  });

  test("selected stable name is reflected as the select value and maps to toolName", () => {
    const html = render(baseState({ operations: sampleOperations, toolName: "catalog_search" }));
    expect(html).toMatch(/<option value="catalog_search" selected="">catalog_search<\/option>/);
  });

  test("descriptor loading, error/retry and empty states render honestly", () => {
    expect(render(baseState({ operationsLoading: true }))).toContain("Loading operations…");
    const errorHtml = render(baseState({ operationsError: "Error: upstream down" }));
    expect(errorHtml).toContain("Could not load operations: Error: upstream down");
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Retry");
    // Any operation stays available even when discovery failed.
    expect(errorHtml).toContain("Any operation");
  });
});

/** Mutable controller with injectable API clients for interaction tests. */
function makeController(
  initial: Partial<ActivityPanelViewState> = {},
  options: {
    operations?: McpOperationDescriptor[];
    fetchMcpOperations?: (signal?: AbortSignal) => Promise<McpOperationDescriptor[]>;
  } = {}
) {
  let current = baseState(initial);
  let cursors: Array<string | undefined> = [undefined];
  const listCalls: unknown[] = [];
  const detailCalls: string[] = [];
  const operationsCalls: Array<AbortSignal | undefined> = [];
  const operationsLoad: OperationsLoadState = { abort: null, generation: 0 };
  const fetchActivity = mock(async (query: unknown) => {
    listCalls.push(query);
    return { records: [record], nextCursor: "next-cursor" };
  });
  const fetchActivityByOperation = mock(async (id: string) => {
    detailCalls.push(id);
    return record;
  });
  const fetchMcpOperations = mock(async (signal?: AbortSignal) => {
    operationsCalls.push(signal);
    if (options.fetchMcpOperations) return options.fetchMcpOperations(signal);
    return options.operations ?? sampleOperations;
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
    setOperations: (v) => { current = { ...current, operations: v }; },
    setOperationsLoading: (v) => { current = { ...current, operationsLoading: v }; },
    setOperationsError: (v) => { current = { ...current, operationsError: v }; },
    setToolName: (v) => { current = { ...current, toolName: v }; },
    setTransport: (v) => { current = { ...current, transport: v }; },
    setStatus: (v) => { current = { ...current, status: v }; },
    setFrom: (v) => { current = { ...current, from: v }; },
    setTo: (v) => { current = { ...current, to: v }; },
    fetchActivity, fetchActivityByOperation, fetchMcpOperations, operationsLoad
  };
  return {
    ctrl, listCalls, detailCalls, operationsCalls, fetchActivity, fetchActivityByOperation, fetchMcpOperations,
    getState: () => current, getCursors: () => cursors
  };
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

describe("Phase 2C — ActivityPanel operation selector interactions", () => {
  test("changing the operation immediately applies the filter and resets pagination", async () => {
    const h = makeController({ pageIndex: 2, nextCursor: "c2" });
    h.ctrl.setPageCursors([undefined, "c1", "c2"]);
    const a = createActivityPanelActions(h.ctrl);
    a.onToolName("catalog_search");
    await flush();
    expect(h.getState().toolName).toBe("catalog_search");
    expect(h.getState().pageIndex).toBe(0);
    expect(h.getCursors()).toEqual([undefined]);
    expect(h.listCalls[0]).toMatchObject({ toolName: "catalog_search", limit: 25 });
    expect(h.listCalls[0]).not.toHaveProperty("cursor");
    // STDIO presence probe still runs, matching Apply-filters behavior.
    expect(h.listCalls[1]).toEqual({ transport: "STDIO", limit: 1 });
  });

  test("operation selection combines with transport/status/date filters", async () => {
    const h = makeController({ transport: "HTTP", status: "failed", from: "2026-01-01T00:00", to: "2026-01-02T00:00" });
    const a = createActivityPanelActions(h.ctrl);
    a.onToolName("markethub_health");
    await flush();
    expect(h.listCalls[0]).toMatchObject({
      toolName: "markethub_health", transport: "HTTP", status: "failed", limit: 25
    });
    expect(typeof h.listCalls[0]!.from).toBe("string");
    expect(typeof h.listCalls[0]!.to).toBe("string");
  });

  test("selecting Any operation clears the toolName filter", async () => {
    const h = makeController({ toolName: "catalog_search" });
    const a = createActivityPanelActions(h.ctrl);
    a.onToolName("");
    await flush();
    expect(h.getState().toolName).toBe("");
    expect(h.listCalls[0]).not.toHaveProperty("toolName");
  });

  test("descriptor fetch failure is isolated from activity history (real rejected fetch)", async () => {
    const h = makeController({}, {
      fetchMcpOperations: async () => { throw new Error("operations endpoint down"); }
    });
    const a = createActivityPanelActions(h.ctrl);
    // Simulate the mount sequence: descriptor load + activity load.
    a.onRetryOperations();
    a.onRefresh();
    await flush();

    expect(h.getState().operationsError).toBe("operations endpoint down");
    expect(h.getState().operationsLoading).toBe(false);
    // Activity history still succeeds and renders.
    expect(h.getState().records).toEqual([record]);
    expect(h.getState().error).toBeNull();
    expect(h.getState().loading).toBe(false);
    expect(render(h.getState())).toContain("markethub_health");
    expect(render(h.getState())).toContain("Any operation");

    // Retry re-invokes the descriptor fetch without disturbing activity.
    const before = h.operationsCalls.length;
    a.onRetryOperations();
    await flush();
    expect(h.operationsCalls.length).toBe(before + 1);
    expect(h.getState().records).toEqual([record]);
  });

  test("successful descriptor load populates options and forwards a signal", async () => {
    const h = makeController();
    const a = createActivityPanelActions(h.ctrl);
    a.onRetryOperations();
    await flush();
    expect(h.getState().operations).toEqual(sampleOperations);
    expect(h.getState().operationsError).toBeNull();
    expect(h.getState().operationsLoading).toBe(false);
    expect(h.operationsCalls).toHaveLength(1);
    expect(h.operationsCalls[0]).toBeInstanceOf(AbortSignal);
  });

  test("removed selection resets to Any operation, page 1, and omits toolName", async () => {
    const h = makeController({ toolName: "retired_operation", pageIndex: 2, nextCursor: "c2" });
    h.ctrl.setPageCursors([undefined, "c1", "c2"]);
    const a = createActivityPanelActions(h.ctrl);
    a.onRetryOperations();
    await flush();
    expect(h.getState().operations).toEqual(sampleOperations);
    expect(h.getState().toolName).toBe("");
    expect(h.getState().pageIndex).toBe(0);
    expect(h.getCursors()).toEqual([undefined]);
    expect(h.listCalls).toHaveLength(1);
    expect(h.listCalls[0]).not.toHaveProperty("toolName");
  });

  test("a still-registered selection is preserved on descriptor refresh", async () => {
    const h = makeController({ toolName: "catalog_search", pageIndex: 1 });
    h.ctrl.setPageCursors([undefined, "c1"]);
    const a = createActivityPanelActions(h.ctrl);
    a.onRetryOperations();
    await flush();
    expect(h.getState().toolName).toBe("catalog_search");
    expect(h.getState().pageIndex).toBe(1);
    expect(h.listCalls).toHaveLength(0);
  });

  test("a superseded descriptor load ignores stale results", async () => {
    let resolveFirst!: (value: McpOperationDescriptor[]) => void;
    const first = new Promise<McpOperationDescriptor[]>((resolve) => { resolveFirst = resolve; });
    const h = makeController({}, {
      fetchMcpOperations: (signal) => (signal && h.operationsCalls.length === 1 ? first : Promise.resolve(sampleOperations))
    });
    const a = createActivityPanelActions(h.ctrl);
    a.onRetryOperations(); // first load, pending
    a.onRetryOperations(); // second load supersedes the first
    await flush();
    resolveFirst([{ name: "stale", type: "tool", description: "stale" }]);
    await flush();
    expect(h.getState().operations).toEqual(sampleOperations);
    expect(h.getState().operationsLoading).toBe(false);
  });
});
