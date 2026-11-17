import { useEffect, useMemo } from "react";
import { parseSnapshot, projectDisplayModel, type DisplayItem } from "../lib/live";
import { LiveStreamController } from "../lib/live-stream";
import { useLiveStore } from "../store/live-store";
import { StatusBadge, toneForState } from "./StatusBadge";

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  const shown = value === null || value === undefined || value === "" ? "—" : String(value);
  return (
    <div className="flex justify-between gap-3 border-b border-slate-800/70 py-1 last:border-b-0">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-right text-xs font-medium text-slate-200 break-all">{shown}</dd>
    </div>
  );
}

function ItemRow({ item }: { item: DisplayItem }) {
  const tone = item.mode === "LIVE" ? "ok" : item.mode === "LAST_KNOWN" ? "warn" : "neutral";
  return (
    <li className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-100 break-all">{item.canonicalId}</span>
        <StatusBadge label={item.mode} tone={tone} />
      </div>
      <dl className="mt-2">
        <Field label="LTP" value={item.ltp} />
        <Field label="Last traded qty" value={item.lastTradedQuantity} />
        <Field label="Close" value={item.close} />
        <Field label="Open" value={item.open} />
        <Field label="High" value={item.high} />
        <Field label="Low" value={item.low} />
        <Field label="Volume" value={item.volume} />
        <Field label="Freshness" value={item.freshness} />
        <Field label="Provider" value={item.provider} />
        <Field label="Reason" value={item.reason} />
        <Field label="Age basis" value={item.ageBasis} />
        <Field label="Timestamp trusted" value={item.timestampTrusted === undefined ? undefined : String(item.timestampTrusted)} />
        <Field label="Source observed at" value={item.provenance?.sourceObservedAt} />
        <Field label="Received at" value={item.provenance?.receivedAt} />
        <Field label="Source" value={item.provenance?.source} />
        <Field label="Source version" value={item.provenance?.sourceVersion} />
      </dl>
    </li>
  );
}

export function LivePanel() {
  const snapshot = useLiveStore((s) => s.snapshot);
  const stream = useLiveStore((s) => s.stream);
  const model = useMemo(() => (snapshot ? projectDisplayModel(snapshot) : null), [snapshot]);

  // A fresh terminal-per-instance controller per effect lifecycle. StrictMode
  // remounts create a new controller; the Zustand store persists across them.
  useEffect(() => {
    const controller = new LiveStreamController({
      createEventSource: (url) => {
        const source = new EventSource(url);
        return {
          set onopen(handler: (() => void) | null) { source.onopen = handler ? () => handler() : null; },
          set onmessage(handler: ((event: { data: string; lastEventId: string }) => void) | null) {
            source.onmessage = handler ? (event) => handler({ data: event.data, lastEventId: event.lastEventId }) : null;
          },
          set onerror(handler: (() => void) | null) { source.onerror = handler ? () => handler() : null; },
          close: () => source.close()
        };
      },
      fetchSnapshot: async () => {
        const response = await fetch("/api/market/snapshot", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
        return parseSnapshot(await response.json());
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      onSnapshot: (next) => useLiveStore.getState().setSnapshot(next),
      onState: (next) => useLiveStore.getState().setStream(next)
    });
    controller.start();
    return () => controller.stop();
  }, []);

  const transportTone = toneForState(
    stream.streamStatus === "live" ? "ok" : stream.streamStatus === "error" ? "error" : "unknown"
  );

  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Live data</h3>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label={`SSE ${stream.streamStatus}`} tone={transportTone} />
          <StatusBadge label={`Refresh ${stream.refreshStatus}`} tone={stream.refreshStatus === "error" ? "error" : stream.refreshStatus === "stale" ? "warn" : "neutral"} />
        </div>
      </div>

      <p className="mb-3 text-xs text-slate-400">
        SSE status reflects the local transport connection only. It is not evidence of a streaming
        provider feed. Provider connection state is shown separately below and remains authoritative.
      </p>

      {stream.streamStatus === "error" && (
        <div className="mb-3 rounded-lg border border-rose-800/60 bg-rose-950/30 p-3 text-sm text-rose-100" role="alert">
          <p className="font-medium">Live stream unavailable</p>
          <p className="mt-1 text-xs text-rose-200/80">{stream.lastError ?? "Unknown error"}</p>
        </div>
      )}
      {stream.refreshStatus === "stale" && (
        <p className="mb-3 text-xs text-amber-300" role="status">
          Snapshot refresh returned stale data; showing the last known snapshot. A later refresh may retry.
        </p>
      )}
      {stream.refreshStatus === "error" && (
        <p className="mb-3 text-xs text-rose-300" role="status">
          Snapshot refresh failed: {stream.refreshError ?? "Unknown error"}. Periodic refresh is paused until manual retry.
        </p>
      )}

      {!model && (
        <p className="text-sm text-slate-400">
          No live snapshot yet. The production streaming driver is locked and no provider feed is connected;
          live data will remain unavailable until a separately authorized stage unlocks it.
        </p>
      )}

      {model && (
        <>
          <dl className="mb-4">
            <Field label="Snapshot revision" value={model.revision} />
            <Field label="Captured at" value={new Date(model.capturedAtMs).toISOString()} />
          </dl>
          <ul className="grid gap-3 sm:grid-cols-2">
            {model.items.map((item) => <ItemRow key={item.canonicalId} item={item} />)}
          </ul>
          {model.items.length === 0 && <p className="text-sm text-slate-400">No instruments are being streamed.</p>}

          <div className="mt-4 border-t border-slate-800 pt-3">
            <h4 className="mb-2 text-sm font-semibold text-slate-200">Provider connection state</h4>
            {model.connections.length === 0 ? (
              <p className="text-xs text-slate-400">No provider connection state reported.</p>
            ) : (
              <ul className="space-y-2">
                {model.connections.map((connection) => (
                  <li key={connection.provider} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-300">{connection.provider}</span>
                    <StatusBadge label={connection.state.replaceAll("_", " ")} tone={connection.state === "STREAMING" ? "ok" : connection.state === "ERROR" ? "error" : "warn"} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
