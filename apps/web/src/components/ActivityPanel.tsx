import { useEffect, useState } from "react";
import type { McpActivityView } from "@markethub/contracts";
import {
  ActivityHttpError, fetchActivity, fetchActivityByOperation
} from "../lib/activity";
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
  return error instanceof Error ? error.message : "Unexpected error";
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchActivity({
        ...(toolName.trim() ? { toolName: toolName.trim() } : {}),
        ...(transport ? { transport: transport as "HTTP" | "STDIO" } : {}),
        ...(status ? { status: status as McpActivityView["status"] } : {}),
        ...(from ? { from: new Date(from).toISOString() } : {}),
        ...(to ? { to: new Date(to).toISOString() } : {}),
        limit: 25,
        ...(cursor ? { cursor } : {})
      });
      setRecords(page.records);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(toError(cause));
      setRecords([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  };

  // STDIO presence is independent of the current filters/page: a separate
  // lightweight query keeps the status truthful even when the list is filtered.
  const loadStdioPresence = () => {
    void fetchActivity({ transport: "STDIO", limit: 1 })
      .then((page) => setStdioObserved(page.records.length > 0))
      .catch(() => setStdioObserved(false));
  };

  useEffect(() => { void load(); loadStdioPresence(); }, []);

  const lookup = async (id?: string) => {
    const target = (id ?? operationId).trim();
    if (!target) { setError("Enter an operation ID first."); return; }
    setLoading(true);
    setError(null);
    try {
      setDetail(await fetchActivityByOperation(target));
    } catch (cause) {
      setError(toError(cause));
      setDetail(null);
    } finally {
      setLoading(false);
    }
  };

  const input = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100";
  const button = "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50";

  const resultLink = (record: McpActivityView) => {
    const ref = record.dataResultRef;
    if (!ref) return null;
    if (ref.kind === "snapshot") {
      return <button type="button" className="text-sky-400 hover:underline" onClick={() => onOpenSnapshot?.(ref.snapshotId)}>
        Open snapshot {ref.snapshotId.slice(0, 8)}…
      </button>;
    }
    return <button type="button" className="text-sky-400 hover:underline" onClick={() => onOpenHistorical?.({
      canonicalId: ref.canonicalId, interval: ref.interval, fromMs: ref.fromMs, toMs: ref.toMs
    })}>Open historical {ref.canonicalId} / {ref.interval}</button>;
  };

  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">MCP / Activity</h3>
        <button type="button" className={button} onClick={() => { void load(); loadStdioPresence(); }}>Refresh</button>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs text-slate-400">HTTP MCP</p>
          <p className="mt-1 text-sm text-slate-100">
            {httpHandlerMounted === null ? "Status unknown" : httpHandlerMounted ? "HTTP handler mounted" : "HTTP handler not mounted"}
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs text-slate-400">STDIO MCP</p>
          <p className="mt-1 text-sm text-slate-100">{stdioObserved ? "Activity observed" : "No activity observed / status unknown"}</p>
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-5">
        <input aria-label="Filter tool" className={input} placeholder="Tool name" value={toolName} onChange={(e) => setToolName(e.target.value)} />
        <select aria-label="Filter transport" className={input} value={transport} onChange={(e) => setTransport(e.target.value)}>
          <option value="">Any transport</option><option value="HTTP">HTTP</option><option value="STDIO">STDIO</option>
        </select>
        <select aria-label="Filter status" className={input} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="started">started</option><option value="succeeded">succeeded</option>
          <option value="failed">failed</option><option value="interrupted">interrupted</option>
        </select>
        <input aria-label="From time" type="datetime-local" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input aria-label="To time" type="datetime-local" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
        <button type="button" className={button} onClick={() => {
          setPageCursors([undefined]); setPageIndex(0); void load(); loadStdioPresence();
        }}>Apply filters</button>
      </div>

      <div className="mb-4 flex gap-2">
        <input aria-label="Operation ID" className={input} placeholder="Exact operation ID" value={operationId} onChange={(e) => setOperationId(e.target.value)} />
        <button type="button" className={button} onClick={() => void lookup()}>Find operation</button>
      </div>

      {loading && <p className="text-sm text-slate-400" role="status">Loading activity…</p>}
      {error && <p className="mb-3 text-sm text-rose-300" role="alert">{error}</p>}
      {!loading && !error && records.length === 0 && <p className="text-sm text-slate-400">No activity recorded yet.</p>}

      {detail && (
        <div className="mb-4 rounded-lg border border-sky-800/60 bg-sky-950/20 p-3 text-xs text-slate-200">
          <p>Operation: {detail.operationId}</p>
          <p>Status: {detail.status} · Transport: {detail.transport} · Duration: {formatDuration(detail.durationMs)}</p>
          {detail.errorMessage && <p className="text-rose-300">{detail.errorCategory}: {detail.errorMessage}</p>}
          {detail.summaryJson && <pre className="mt-2 whitespace-pre-wrap text-slate-400">{detail.summaryJson}</pre>}
          {resultLink(detail)}
        </div>
      )}

      <ul className="grid gap-2">
        {records.map((record) => (
          <li key={record.id} className={`rounded-lg border p-3 ${record.status === "started" || record.status === "interrupted" ? "border-amber-800/60 bg-amber-950/20" : "border-slate-800 bg-slate-950/40"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-100">{record.toolName}</span>
              <StatusBadge label={record.status} tone={statusTone(record.status)} />
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {record.transport} · {record.startedAt} · {formatDuration(record.durationMs)}
              {record.clientName ? ` · ${record.clientName}` : ""}
            </p>
            <p className="mt-1 text-xs text-slate-500 break-all">Operation: {record.operationId}</p>
            <button type="button" className="mt-1 text-sky-400 hover:underline text-xs" onClick={() => {
              setOperationId(record.operationId);
              void lookup(record.operationId);
            }}>View details</button>
            {record.errorMessage && <p className="mt-1 text-xs text-rose-300">{record.errorCategory}: {record.errorMessage}</p>}
            {resultLink(record)}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex items-center gap-2">
        <button type="button" className={button} disabled={pageIndex === 0} onClick={() => {
          const target = pageIndex - 1;
          setPageIndex(target);
          void load(pageCursors[target]);
        }}>Previous</button>
        <span className="text-xs text-slate-400">Page {pageIndex + 1}</span>
        <button type="button" className={button} disabled={!nextCursor} onClick={() => {
          if (!nextCursor) return;
          const target = pageIndex + 1;
          setPageCursors((prev) => [...prev.slice(0, target), nextCursor]);
          setPageIndex(target);
          void load(nextCursor);
        }}>Next</button>
      </div>
    </section>
  );
}
