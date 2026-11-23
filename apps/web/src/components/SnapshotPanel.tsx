import { useEffect, useState } from "react";
import { providerIdSchema, type OptionChainCaptureConfig, type OptionChainSnapshot, type ProviderId } from "@markethub/contracts";
import {
  captureSnapshot, deleteCaptureConfig, fetchCaptureConfigs, fetchSnapshot, fetchSnapshots,
  saveCaptureConfig, SnapshotHttpError
} from "../lib/snapshots";
import { selectedProviderOrError } from "../lib/snapshot-form";
import { InstrumentPicker } from "./InstrumentPicker";
import { StatusBadge } from "./StatusBadge";

function toError(error: unknown): string {
  if (error instanceof SnapshotHttpError) {
    const prefix = error.kind === "forbidden" ? "Local-owner only"
      : error.kind === "validation" ? "Validation error"
      : error.kind === "unavailable" ? "Unavailable (no provider wired in M5)"
      : error.kind === "not-found" ? "Not found"
      : "Error";
    return `${prefix}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unexpected error";
}

export function SnapshotPanel({ focusSnapshotId }: { focusSnapshotId?: string | null }) {
  const [focusedSnapshot, setFocusedSnapshot] = useState<OptionChainSnapshot | null>(null);
  const [configs, setConfigs] = useState<OptionChainCaptureConfig[]>([]);
  const [snapshots, setSnapshots] = useState<OptionChainSnapshot[] | null>(null);
  const [underlying, setUnderlying] = useState("");
  const [expiry, setExpiry] = useState("");
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadConfigs = () => {
    void fetchCaptureConfigs().then(setConfigs).catch((cause) => setError(toError(cause)));
  };
  const loadSnapshots = () => {
    void fetchSnapshots().then(setSnapshots).catch((cause) => setError(toError(cause)));
  };

  useEffect(() => { loadConfigs(); loadSnapshots(); }, []);

  // M6-C: open/select the snapshot referenced by an activity record.
  useEffect(() => {
    if (!focusSnapshotId) { setFocusedSnapshot(null); return; }
    void fetchSnapshot(focusSnapshotId).then(setFocusedSnapshot).catch(() => setFocusedSnapshot(null));
  }, [focusSnapshotId]);

  const addConfig = async () => {
    const selectedProvider = selectedProviderOrError(provider);
    if (selectedProvider === null) { setError("Choose a provider before adding a config."); return; }
    if (!underlying.trim() || !expiry.trim()) { setError("Enter an underlying and expiry first."); return; }
    const now = new Date().toISOString();
    const config: OptionChainCaptureConfig = {
      id: `capture-${Date.now()}`,
      underlyingCanonicalId: underlying.trim(),
      expiryDate: expiry.trim(),
      strikeRangeJson: null,
      captureEnabled: true,
      captureMode: "MANUAL",
      scheduleJson: null,
      streamingEnabled: false,
      provider: selectedProvider,
      createdAt: now,
      updatedAt: now
    };
    try {
      await saveCaptureConfig(config);
      setMessage("Capture configuration saved.");
      loadConfigs();
    } catch (cause) { setError(toError(cause)); }
  };

  const toggleConfig = async (config: OptionChainCaptureConfig) => {
    try {
      await saveCaptureConfig({ ...config, captureEnabled: !config.captureEnabled, updatedAt: new Date().toISOString() });
      loadConfigs();
    } catch (cause) { setError(toError(cause)); }
  };

  const removeConfig = async (id: string) => {
    try { await deleteCaptureConfig(id); loadConfigs(); loadSnapshots(); } catch (cause) { setError(toError(cause)); }
  };

  const capture = async () => {
    const selectedProvider = selectedProviderOrError(provider);
    if (selectedProvider === null) { setError("Choose a provider before capturing."); return; }
    if (!underlying.trim() || !expiry.trim()) { setError("Enter an underlying and expiry first."); return; }
    setLoading(true);
    setError(null);
    try {
      await captureSnapshot({ underlyingCanonicalId: underlying.trim(), expiryDate: expiry.trim(), provider: selectedProvider });
      setMessage("Snapshot captured.");
      loadSnapshots();
    } catch (cause) {
      setError(toError(cause)); // M5 has no live provider — reported honestly
    } finally { setLoading(false); }
  };

  const input = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100";
  const button = "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50";

  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="text-base font-semibold">Option-chain snapshots</h3>
      <p className="mt-1 text-xs text-slate-400">
        Capture configuration is independent of streaming selection. Missing, null and zero values are preserved as supplied; no provider data is fabricated.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <InstrumentPicker
          value={underlying}
          onChange={setUnderlying}
          label="Underlying"
          placeholder="Search by symbol or name…"
          disabled={loading}
        />
        <input aria-label="Expiry" className={input} placeholder="2026-01-29" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        <select aria-label="Provider" className={input} value={provider} onChange={(e) => setProvider(e.target.value as ProviderId | "")}>
          <option value="">Choose provider</option>
          {providerIdSchema.options.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <div className="flex gap-2">
          <button type="button" disabled={!provider} className={button} onClick={() => void addConfig()}>Add config</button>
          <button type="button" disabled={loading || !provider} className={button} onClick={() => void capture()}>Capture now</button>
        </div>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Provider selection is manual. Only the provider you choose is attempted for an explicit selection; there is no fallback to another provider. Provider-backed capture is not active in the normal application composition, so a request may report unavailable rather than return data.
      </p>

      {error && <p className="mt-3 rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-100" role="alert">{error}</p>}
      {message && <p className="mt-3 text-xs text-slate-300" role="status">{message}</p>}
      {loading && <p className="mt-3 text-xs text-slate-400" role="status">Capturing...</p>}

      <div className="mt-5 border-t border-slate-800 pt-4">
        <h4 className="text-sm font-semibold text-slate-200">Capture configurations</h4>
        {configs.length === 0 && <p className="mt-1 text-xs text-slate-400">No capture configurations saved.</p>}
        <ul className="mt-2 space-y-2">
          {configs.map((config) => (
            <li key={config.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2">
              <span className="text-xs text-slate-200 break-all">{config.underlyingCanonicalId} · {config.expiryDate} · {config.provider}</span>
              <div className="flex items-center gap-2">
                <StatusBadge label={config.captureEnabled ? "Enabled" : "Disabled"} tone={config.captureEnabled ? "ok" : "neutral"} />
                <button type="button" className={button} onClick={() => void toggleConfig(config)}>{config.captureEnabled ? "Disable" : "Enable"}</button>
                <button type="button" className={button} onClick={() => void removeConfig(config.id)}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {focusedSnapshot && (
        <div className="mt-5 rounded-lg border border-sky-800/60 bg-sky-950/20 p-3" role="status">
          <h4 className="text-sm font-semibold text-sky-200">Selected snapshot (from activity)</h4>
          <p className="mt-1 text-xs text-slate-300 break-all">
            {focusedSnapshot.id} · {focusedSnapshot.envelope.underlyingCanonicalId} · {focusedSnapshot.envelope.expiryDate}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Captured {focusedSnapshot.envelope.capturedAt} · {focusedSnapshot.envelope.strikes.length} strikes · provider {focusedSnapshot.provider}
          </p>
        </div>
      )}

      <div className="mt-5 border-t border-slate-800 pt-4">
        <h4 className="text-sm font-semibold text-slate-200">Stored snapshots</h4>
        {snapshots === null && <p className="mt-1 text-xs text-slate-400">Loading snapshots...</p>}
        {snapshots && snapshots.length === 0 && <p className="mt-1 text-xs text-slate-400">No snapshots collected yet.</p>}
        <ul className="mt-2 space-y-2">
          {snapshots?.map((snapshot) => (
            <li key={snapshot.id} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-200 break-all">{snapshot.envelope.underlyingCanonicalId} · {snapshot.envelope.expiryDate}</span>
                <StatusBadge label={snapshot.provider} tone="neutral" />
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Captured {snapshot.envelope.capturedAt} · Observation {snapshot.envelope.observationTimestamp ?? "unknown"} · {snapshot.envelope.strikes.length} strikes
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
