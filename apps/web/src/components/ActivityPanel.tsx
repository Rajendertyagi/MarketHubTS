import { useEffect, useRef, useState } from "react";
import {
  mcpActivityStatusSchema, mcpActivityTransportSchema,
  type McpActivityView, type McpOperationDescriptor
} from "@markethub/contracts";
import {
  ActivityHttpError, fetchActivity, fetchActivityByOperation
} from "../lib/activity";
import { fetchMcpOperations, McpOperationsHttpError } from "../lib/mcp-operations";
import { StatusBadge } from "./StatusBadge";

interface ActivityPanelProps {
  httpHandlerMounted: boolean | null;
  onOpenSnapshot?: (snapshotId: string) => void;
  onOpenHistorical?: (ref: { canonicalId: string; interval: string; fromMs: number; toMs: number }) => void;
}

function toError(error: unknown): string {
  if (error instanceof ActivityHttpError) {
    const prefix = error.kind === "forbidden" ? "Local-owner only"
      : error.kind === "validation" ? "Validation error"
      : error.kind === "not-found" ? "Not found"
      : error.kind === "unavailable" ? "Unavailable"
      : "Error";
    return `${prefix}: ${error.message}`;
  }
  if (error instanceof McpOperationsHttpError) {
    const prefix = error.kind === "forbidden" ? "Local-owner only"
      : error.kind === "validation" ? "Validation error"
      : error.kind === "not-found" ? "Not found"
      : error.kind === "unavailable" ? "Unavailable"
      : "Error";
    return `${prefix}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unexpected error";
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Shared, render-stable holder for descriptor-load cancellation. The container
 * keeps this in a ref so an unmount can abort in-flight work and a retry can
 * supersede an earlier load, regardless of which render's actions are in use.
 */
export interface OperationsLoadState {
  abort: AbortController | null;
  generation: number;
}

function statusTone(status: string): "ok" | "warn" | "error" | "neutral" {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "error";
  if (status === "interrupted") return "warn";
  return "neutral";
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  return `${ms} ms`;
}

/** State and callbacks consumed by the pure presentational view. */
export interface ActivityPanelViewState {
  httpHandlerMounted: boolean | null;
  stdioObserved: boolean;
  records: McpActivityView[];
  nextCursor: string | null;
  pageIndex: number;
  loading: boolean;
  error: string | null;
  detail: McpActivityView | null;
  /** Registration-owned descriptors for the Operation selector. */
  operations: McpOperationDescriptor[];
  operationsLoading: boolean;
  operationsError: string | null;
  toolName: string;
  transport: string;
  status: string;
  from: string;
  to: string;
  operationId: string;
}

export interface ActivityPanelViewActions {
  onRefresh: () => void;
  onApplyFilters: () => void;
  onRetryOperations: () => void;
  onToolName: (value: string) => void;
  onTransport: (value: string) => void;
  onStatus: (value: string) => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onOperationId: (value: string) => void;
  onLookup: () => void;
  onViewDetails: (operationId: string) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onOpenSnapshot: (snapshotId: string) => void;
  onOpenHistorical: (ref: { canonicalId: string; interval: string; fromMs: number; toMs: number }) => void;
}

/** Pure filter/pagination query builder, extracted for interaction tests. */
export interface ActivityFilterState {
  toolName: string; transport: string; status: string; from: string; to: string;
}

export function buildActivityQuery(filters: ActivityFilterState, cursor?: string) {
  return {
    ...(filters.toolName.trim() ? { toolName: filters.toolName.trim() } : {}),
    ...(filters.transport ? { transport: filters.transport as "HTTP" | "STDIO" } : {}),
    ...(filters.status ? { status: filters.status as McpActivityView["status"] } : {}),
    ...(filters.from ? { from: new Date(filters.from).toISOString() } : {}),
    ...(filters.to ? { to: new Date(filters.to).toISOString() } : {}),
    limit: 25,
    ...(cursor ? { cursor } : {})
  };
}

const inputClass = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100";
const buttonClass = "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50";

/**
 * Pure presentational view. Kept separate from the data-loading container so
 * rendering can be verified with react-dom/server without a DOM test library.
 */
export function ActivityPanelView({ state, actions }: { state: ActivityPanelViewState; actions: ActivityPanelViewActions }) {
  const resultLink = (record: McpActivityView) => {
    const ref = record.dataResultRef;
    if (!ref) return null;
    if (ref.kind === "snapshot") {
      return <button type="button" className="text-sky-400 hover:underline" onClick={() => actions.onOpenSnapshot(ref.snapshotId)}>
        Open snapshot {ref.snapshotId.slice(0, 8)}…
      </button>;
    }
    return <button type="button" className="text-sky-400 hover:underline" onClick={() => actions.onOpenHistorical({
      canonicalId: ref.canonicalId, interval: ref.interval, fromMs: ref.fromMs, toMs: ref.toMs
    })}>Open historical {ref.canonicalId} / {ref.interval}</button>;
  };

  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">MCP / Activity</h3>
        <button type="button" className={buttonClass} onClick={actions.onRefresh}>Refresh</button>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs text-slate-400">HTTP MCP</p>
          <p className="mt-1 text-sm text-slate-100">
            {state.httpHandlerMounted === null ? "Status unknown" : state.httpHandlerMounted ? "HTTP handler mounted" : "HTTP handler not mounted"}
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs text-slate-400">STDIO MCP</p>
          <p className="mt-1 text-sm text-slate-100">{state.stdioObserved ? "Activity observed" : "No activity observed / status unknown"}</p>
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-5">
        <select aria-label="Filter operation" className={inputClass} value={state.toolName} onChange={(e) => actions.onToolName(e.target.value)}>
          <option value="">Any operation</option>
          {(["tool", "resource", "prompt"] as const).map((type) => {
            const group = state.operations.filter((operation) => operation.type === type);
            if (group.length === 0) return null;
            const label = type === "tool" ? "Tools" : type === "resource" ? "Resources" : "Prompts";
            return (
              <optgroup key={type} label={label}>
                {group.map((operation) => (
                  <option key={operation.name} value={operation.name}>{"title" in operation ? operation.title : operation.name}</option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <select aria-label="Filter transport" className={inputClass} value={state.transport} onChange={(e) => actions.onTransport(e.target.value)}>
          <option value="">Any transport</option>
          {mcpActivityTransportSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="Filter status" className={inputClass} value={state.status} onChange={(e) => actions.onStatus(e.target.value)}>
          <option value="">Any status</option>
          {mcpActivityStatusSchema.options.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <input aria-label="From time" type="datetime-local" className={inputClass} value={state.from} onChange={(e) => actions.onFrom(e.target.value)} />
        <input aria-label="To time" type="datetime-local" className={inputClass} value={state.to} onChange={(e) => actions.onTo(e.target.value)} />
        <button type="button" className={buttonClass} onClick={actions.onApplyFilters}>Apply filters</button>
      </div>

      {state.operationsLoading && <p className="mb-2 text-xs text-slate-400" role="status">Loading operations…</p>}
      {state.operationsError && (
        <p className="mb-3 flex items-center gap-2 text-sm text-rose-300" role="alert">
          <span>Could not load operations: {state.operationsError}</span>
          <button type="button" className={buttonClass} onClick={actions.onRetryOperations}>Retry</button>
        </p>
      )}

      <div className="mb-4 flex gap-2">
        <input aria-label="Operation ID" className={inputClass} placeholder="Exact operation ID" value={state.operationId} onChange={(e) => actions.onOperationId(e.target.value)} />
        <button type="button" className={buttonClass} onClick={actions.onLookup}>Find operation</button>
      </div>

      {state.loading && <p className="text-sm text-slate-400" role="status">Loading activity…</p>}
      {state.error && <p className="mb-3 text-sm text-rose-300" role="alert">{state.error}</p>}
      {!state.loading && !state.error && state.records.length === 0 && <p className="text-sm text-slate-400">No activity recorded yet.</p>}

      {state.detail && (
        <div className="mb-4 rounded-lg border border-sky-800/60 bg-sky-950/20 p-3 text-xs text-slate-200">
          <p>Operation: {state.detail.operationId}</p>
          <p>Status: {state.detail.status} · Transport: {state.detail.transport} · Duration: {formatDuration(state.detail.durationMs)}</p>
          <p>Started: {state.detail.startedAt} · Finished: {state.detail.finishedAt ?? "—"}</p>
          <p>Client: {state.detail.clientName ?? "—"} {state.detail.clientVersion ?? ""}</p>
          {state.detail.errorMessage && <p className="text-rose-300">{state.detail.errorCategory}: {state.detail.errorMessage}</p>}
          {state.detail.summaryJson && <pre className="mt-2 whitespace-pre-wrap text-slate-400">{state.detail.summaryJson}</pre>}
          {resultLink(state.detail)}
        </div>
      )}

      <ul className="grid gap-2">
        {state.records.map((record) => (
          <li key={record.id} className={`rounded-lg border p-3 ${record.status === "started" || record.status === "interrupted" ? "border-amber-800/60 bg-amber-950/20" : "border-slate-800 bg-slate-950/40"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-100">{record.toolName}</span>
              <StatusBadge label={record.status} tone={statusTone(record.status)} />
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {record.transport} · {record.startedAt} · Finished: {record.finishedAt ?? "—"} · {formatDuration(record.durationMs)}
              {record.clientName ? ` · ${record.clientName}` : ""}
              {record.clientVersion ? ` ${record.clientVersion}` : ""}
            </p>
            <p className="mt-1 text-xs text-slate-500 break-all">Operation: {record.operationId}</p>
            <button type="button" className="mt-1 text-sky-400 hover:underline text-xs" onClick={() => actions.onViewDetails(record.operationId)}>View details</button>
            {record.errorMessage && <p className="mt-1 text-xs text-rose-300">{record.errorCategory}: {record.errorMessage}</p>}
            {resultLink(record)}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center gap-2">
        <button type="button" className={buttonClass} disabled={state.pageIndex === 0} onClick={actions.onPrevPage}>Previous</button>
        <span className="text-xs text-slate-400">Page {state.pageIndex + 1}</span>
        <button type="button" className={buttonClass} disabled={!state.nextCursor} onClick={actions.onNextPage}>Next</button>
      </div>
    </section>
  );
}

/**
 * Dependencies for the interaction factory. State is read at call time (the
 * container rebuilds actions each render), and the API client is injectable so
 * interactions can be exercised in tests without a DOM.
 */
export interface ActivityPanelController {
  state: ActivityPanelViewState;
  pageCursors: Array<string | undefined>;
  setRecords: (value: McpActivityView[]) => void;
  setNextCursor: (value: string | null) => void;
  setPageCursors: (update: Array<string | undefined> | ((prev: Array<string | undefined>) => Array<string | undefined>)) => void;
  setPageIndex: (value: number) => void;
  setStdioObserved: (value: boolean) => void;
  setDetail: (value: McpActivityView | null) => void;
  setLoading: (value: boolean) => void;
  setError: (value: string | null) => void;
  setOperationId: (value: string) => void;
  setOperations: (value: McpOperationDescriptor[]) => void;
  setOperationsLoading: (value: boolean) => void;
  setOperationsError: (value: string | null) => void;
  setToolName: (value: string) => void;
  setTransport: (value: string) => void;
  setStatus: (value: string) => void;
  setFrom: (value: string) => void;
  setTo: (value: string) => void;
  fetchActivity: typeof fetchActivity;
  fetchActivityByOperation: typeof fetchActivityByOperation;
  fetchMcpOperations: typeof fetchMcpOperations;
  /** Render-stable cancellation holder supplied by the container's ref. */
  operationsLoad: OperationsLoadState;
  onOpenSnapshot?: ((snapshotId: string) => void) | undefined;
  onOpenHistorical?: ((ref: { canonicalId: string; interval: string; fromMs: number; toMs: number }) => void) | undefined;
}

/** Build the panel's interaction callbacks from an injectable controller. */
export function createActivityPanelActions(ctrl: ActivityPanelController): ActivityPanelViewActions {
  const load = async (cursor?: string, overrides?: Partial<ActivityFilterState>) => {
    ctrl.setLoading(true);
    ctrl.setError(null);
    try {
      const { toolName, transport, status, from, to } = { ...ctrl.state, ...overrides };
      const page = await ctrl.fetchActivity(buildActivityQuery({ toolName, transport, status, from, to }, cursor));
      ctrl.setRecords(page.records);
      ctrl.setNextCursor(page.nextCursor);
    } catch (cause) {
      ctrl.setError(toError(cause));
      ctrl.setRecords([]);
      ctrl.setNextCursor(null);
    } finally {
      ctrl.setLoading(false);
    }
  };

  // Descriptor discovery is independent of activity history: a failure here
  // only sets operationsError and never touches records/loading/error.
  const loadOperations = async () => {
    if (ctrl.operationsLoad.abort) ctrl.operationsLoad.abort.abort();
    const controller = new AbortController();
    ctrl.operationsLoad.abort = controller;
    const signal = controller.signal;
    const generation = ++ctrl.operationsLoad.generation;
    ctrl.setOperationsLoading(true);
    ctrl.setOperationsError(null);
    try {
      const descriptors = await ctrl.fetchMcpOperations(signal);
      if (generation !== ctrl.operationsLoad.generation) return;
      ctrl.setOperations(descriptors);
      // A previously selected operation may have been removed from the
      // registration set. Reset to "Any operation" and reload page 1 without
      // the stale toolName; otherwise keep the current selection untouched.
      const selected = ctrl.state.toolName.trim();
      if (selected && !descriptors.some((descriptor) => descriptor.name === selected)) {
        ctrl.setToolName("");
        ctrl.setPageCursors([undefined]);
        ctrl.setPageIndex(0);
        void load(undefined, { toolName: "" });
      }
    } catch (cause) {
      if (generation !== ctrl.operationsLoad.generation) return;
      if (isAbortError(cause)) return;
      ctrl.setOperationsError(toError(cause));
    } finally {
      if (generation === ctrl.operationsLoad.generation) ctrl.setOperationsLoading(false);
    }
  };

  // STDIO presence is independent of the current filters/page: a separate
  // lightweight query keeps the status truthful even when the list is filtered.
  const loadStdioPresence = () => {
    void ctrl.fetchActivity({ transport: "STDIO", limit: 1 })
      .then((page) => ctrl.setStdioObserved(page.records.length > 0))
      .catch(() => ctrl.setStdioObserved(false));
  };

  const lookup = async (id?: string) => {
    const target = (id ?? ctrl.state.operationId).trim();
    if (!target) { ctrl.setError("Enter an operation ID first."); return; }
    ctrl.setLoading(true);
    ctrl.setError(null);
    try {
      ctrl.setDetail(await ctrl.fetchActivityByOperation(target));
    } catch (cause) {
      ctrl.setError(toError(cause));
      ctrl.setDetail(null);
    } finally {
      ctrl.setLoading(false);
    }
  };

  return {
    onRefresh: () => { void load(); loadStdioPresence(); },
    onApplyFilters: () => {
      ctrl.setPageCursors([undefined]);
      ctrl.setPageIndex(0);
      void load();
      loadStdioPresence();
    },
    onRetryOperations: () => { void loadOperations(); },
    // The select applies immediately (page 1 + reload), unlike the old
    // deferred free-text input. Pass the new value explicitly so the query is
    // correct even before React commits the state update.
    onToolName: (value) => {
      ctrl.setToolName(value);
      ctrl.setPageCursors([undefined]);
      ctrl.setPageIndex(0);
      void load(undefined, { toolName: value });
      loadStdioPresence();
    },
    onTransport: ctrl.setTransport,
    onStatus: ctrl.setStatus,
    onFrom: ctrl.setFrom,
    onTo: ctrl.setTo,
    onOperationId: ctrl.setOperationId,
    onLookup: () => void lookup(),
    onViewDetails: (id) => { ctrl.setOperationId(id); void lookup(id); },
    onPrevPage: () => {
      const target = ctrl.state.pageIndex - 1;
      ctrl.setPageIndex(target);
      void load(ctrl.pageCursors[target]);
    },
    onNextPage: () => {
      const next = ctrl.state.nextCursor;
      if (!next) return;
      const target = ctrl.state.pageIndex + 1;
      ctrl.setPageCursors((prev) => [...prev.slice(0, target), next]);
      ctrl.setPageIndex(target);
      void load(next);
    },
    onOpenSnapshot: (snapshotId) => ctrl.onOpenSnapshot?.(snapshotId),
    onOpenHistorical: (ref) => ctrl.onOpenHistorical?.(ref)
  };
}

/** Data-loading container: owns state and wires the pure view to the API client. */
export function ActivityPanel({ httpHandlerMounted, onOpenSnapshot, onOpenHistorical }: ActivityPanelProps) {
  const [records, setRecords] = useState<McpActivityView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // One cursor per visited page; index 0 is the unfiltered first page.
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [stdioObserved, setStdioObserved] = useState(false);
  const [toolName, setToolName] = useState("");
  const [transport, setTransport] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [operationId, setOperationId] = useState("");
  const [detail, setDetail] = useState<McpActivityView | null>(null);
  const [operations, setOperations] = useState<McpOperationDescriptor[]>([]);
  const [operationsLoading, setOperationsLoading] = useState(false);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable across renders so unmount can abort and retry can supersede work.
  const operationsLoadRef = useRef<OperationsLoadState>({ abort: null, generation: 0 });

  const state: ActivityPanelViewState = {
    httpHandlerMounted, stdioObserved, records, nextCursor, pageIndex,
    loading, error, detail, operations, operationsLoading, operationsError,
    toolName, transport, status, from, to, operationId
  };
  const actions = createActivityPanelActions({
    state, pageCursors, setRecords, setNextCursor, setPageCursors, setPageIndex,
    setStdioObserved, setDetail, setLoading, setError, setOperationId,
    setOperations, setOperationsLoading, setOperationsError,
    setToolName, setTransport, setStatus, setFrom, setTo,
    fetchActivity, fetchActivityByOperation, fetchMcpOperations,
    operationsLoad: operationsLoadRef.current, onOpenSnapshot, onOpenHistorical
  });

  // Initial descriptor load, activity load and STDIO presence probe run once
  // on mount. Abort any in-flight descriptor fetch on unmount.
  useEffect(() => {
    actions.onRetryOperations();
    actions.onRefresh();
    return () => { operationsLoadRef.current.abort?.abort(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <ActivityPanelView state={state} actions={actions} />;
}
