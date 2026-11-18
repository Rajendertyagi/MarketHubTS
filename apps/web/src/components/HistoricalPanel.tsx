import { useEffect, useState } from "react";
import type {
  CandleGap, CandleInterval, CandleRangeNote, HistoricalCandle, HistoricalSyncConfig, RetentionSettings
} from "@markethub/contracts";
import {
  deleteSyncConfig, fetchCachedCandles, fetchCoverage, fetchRetention, fetchSyncConfigs,
  HistoricalHttpError, runRetentionCleanup, saveRetention, saveSyncConfig
} from "../lib/historical";
import { StatusBadge } from "./StatusBadge";

const INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "60m", "1D", "1W", "1M"];

function errorLabel(kind: string, message: string): string {
  const prefix = kind === "forbidden" ? "Local-owner only"
    : kind === "validation" ? "Validation error"
    : kind === "unavailable" ? "Unavailable"
    : "Error";
  return `${prefix}: ${message}`;
}

function toError(error: unknown): string {
  if (error instanceof HistoricalHttpError) return errorLabel(error.kind, error.message);
  return error instanceof Error ? error.message : "Unexpected error";
}

export function HistoricalPanel() {
  const [canonicalId, setCanonicalId] = useState("");
  const [interval, setInterval] = useState<CandleInterval>("1D");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [candles, setCandles] = useState<HistoricalCandle[] | null>(null);
  const [gaps, setGaps] = useState<CandleGap[]>([]);
  const [unavailableNotes, setUnavailableNotes] = useState<CandleRangeNote[]>([]);
  const [configs, setConfigs] = useState<HistoricalSyncConfig[]>([]);
  const [retention, setRetention] = useState<RetentionSettings | null>(null);
  const [retentionValid, setRetentionValid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadConfigs = () => {
    void fetchSyncConfigs().then(setConfigs).catch((cause) => setError(toError(cause)));
  };
  const loadRetention = () => {
    void fetchRetention().then((view) => {
      // Always keep an editable draft: from an invalid/missing state the
      // operator can still save a schema-valid "no limits" configuration.
      setRetention(view.settings ?? { version: 1, classes: {} });
      setRetentionValid(view.valid);
    }).catch((cause) => setError(toError(cause)));
  };

  useEffect(() => { loadConfigs(); loadRetention(); }, []);

  const readCached = async () => {
    const fromMs = Date.parse(from), toMs = Date.parse(to);
    if (!canonicalId.trim() || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
      setError("Enter a canonical ID and a valid from/to range.");
      return;
    }
    setLoading(true);
    setError(null);
    setCandles(null);
    setGaps([]);
    setUnavailableNotes([]);
    try {
      const request = { canonicalId: canonicalId.trim(), interval, fromMs, toMs };
      const [cached, coverage] = await Promise.all([fetchCachedCandles(request), fetchCoverage(request)]);
      setCandles(cached.candles);
      setGaps(coverage.gaps);
      setUnavailableNotes(coverage.unavailableNotes);
    } catch (cause) {
      setError(toError(cause));
    } finally {
      setLoading(false);
    }
  };

  const addConfig = async () => {
    if (!canonicalId.trim()) { setError("Enter a canonical ID first."); return; }
    const now = new Date().toISOString();
    const config: HistoricalSyncConfig = {
      id: `sync-${Date.now()}`,
      canonicalId: canonicalId.trim(),
      interval,
      enabled: true,
      dateRangeJson: null,
      scheduleJson: null,
      providerPolicyJson: null,
      createdAt: now,
      updatedAt: now
    };
    try {
      await saveSyncConfig(config);
      setMessage("Sync configuration saved.");
      loadConfigs();
    } catch (cause) { setError(toError(cause)); }
  };

  const toggleConfig = async (config: HistoricalSyncConfig) => {
    try {
      await saveSyncConfig({ ...config, enabled: !config.enabled, updatedAt: new Date().toISOString() });
      loadConfigs();
    } catch (cause) { setError(toError(cause)); }
  };

  const removeConfig = async (id: string) => {
    try { await deleteSyncConfig(id); loadConfigs(); } catch (cause) { setError(toError(cause)); }
  };

  const saveRetentionSettings = async () => {
    const draft = retention ?? { version: 1, classes: {} };
    try {
      await saveRetention(draft);
      setMessage("Retention settings saved.");
      loadRetention();
    } catch (cause) { setError(toError(cause)); }
  };

  const cleanup = async () => {
    try {
      const result = await runRetentionCleanup();
      setMessage(result.ran
        ? `Cleanup complete: ${result.candlesDeleted} candles, ${result.snapshotsDeleted} snapshots deleted.`
        : `Cleanup disabled: ${result.reason ?? "invalid settings"}. Nothing deleted.`);
    } catch (cause) { setError(toError(cause)); }
  };

  const input = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100";
  const button = "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50";

  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="text-base font-semibold">Historical candles</h3>
      <p className="mt-1 text-xs text-slate-400">
        Cached reads and coverage are derived from stored candles. No candles are fabricated; gaps are approximate and unconfirmed.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <input aria-label="Canonical instrument ID" className={input} placeholder="v1|NSE|EQ|EQ|CODE:SBIN" value={canonicalId} onChange={(e) => setCanonicalId(e.target.value)} />
        <select aria-label="Interval" className={input} value={interval} onChange={(e) => setInterval(e.target.value as CandleInterval)}>
          {INTERVALS.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <input aria-label="From" type="date" className={input} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input aria-label="To" type="date" className={input} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={loading} className={button} onClick={() => void readCached()}>Read cached</button>
        <button type="button" disabled={loading} className={button} onClick={() => void addConfig()}>Add sync config</button>
      </div>

      {error && <p className="mt-3 rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-100" role="alert">{error}</p>}
      {message && <p className="mt-3 text-xs text-slate-300" role="status">{message}</p>}
      {loading && <p className="mt-3 text-xs text-slate-400" role="status">Loading candles...</p>}

      {candles && (
        <div className="mt-4">
          <h4 className="text-sm font-semibold text-slate-200">Cached candles ({candles.length})</h4>
          {candles.length === 0 && <p className="mt-1 text-xs text-slate-400">No candles stored for this range.</p>}
          {candles.length > 0 && (
            <div className="oc-table mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-slate-400"><tr><th className="py-1">Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th><th>Provider</th></tr></thead>
                <tbody>
                  {candles.slice(0, 50).map((c) => (
                    <tr key={`${c.tsMs}-${c.provider}`} className="border-t border-slate-800/80 text-slate-200">
                      <td className="py-1">{new Date(c.tsMs).toISOString()}</td>
                      <td>{c.open}</td><td>{c.high}</td><td>{c.low}</td><td>{c.close}</td>
                      <td>{c.volume ?? "—"}</td><td>{c.provider}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3">
            <h4 className="text-sm font-semibold text-slate-200">Coverage gaps ({gaps.length})</h4>
            {gaps.length === 0 && <p className="mt-1 text-xs text-slate-400">No candidate gaps in this range.</p>}
            <ul className="mt-1 space-y-1">
              {gaps.slice(0, 20).map((g, i) => (
                <li key={i} className="text-xs text-slate-400">
                  {new Date(g.fromMs).toISOString()} → {new Date(g.toMs).toISOString()} · {g.basis} · unconfirmed
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-3">
            <h4 className="text-sm font-semibold text-slate-200">Unavailable periods ({unavailableNotes.length})</h4>
            {unavailableNotes.length === 0 && <p className="mt-1 text-xs text-slate-400">No known permanent restrictions in this range.</p>}
            <ul className="mt-1 space-y-1">
              {unavailableNotes.slice(0, 20).map((n, i) => (
                <li key={i} className="text-xs text-amber-300">
                  {new Date(n.rangeStartMs).toISOString()} → {new Date(n.rangeEndMs).toISOString()} · {n.provider} · {n.reasonCode ?? "unspecified"}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="mt-5 border-t border-slate-800 pt-4">
        <h4 className="text-sm font-semibold text-slate-200">Sync configurations</h4>
        {configs.length === 0 && <p className="mt-1 text-xs text-slate-400">No sync configurations saved.</p>}
        <ul className="mt-2 space-y-2">
          {configs.map((config) => (
            <li key={config.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2">
              <span className="text-xs text-slate-200 break-all">{config.canonicalId} · {config.interval}</span>
              <div className="flex items-center gap-2">
                <StatusBadge label={config.enabled ? "Enabled" : "Disabled"} tone={config.enabled ? "ok" : "neutral"} />
                <button type="button" className={button} onClick={() => void toggleConfig(config)}>{config.enabled ? "Disable" : "Enable"}</button>
                <button type="button" className={button} onClick={() => void removeConfig(config.id)}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-5 border-t border-slate-800 pt-4">
        <h4 className="text-sm font-semibold text-slate-200">Retention</h4>
        <p className="mt-1 text-xs text-slate-400">
          {retentionValid ? "Valid settings active." : "No valid settings — cleanup is disabled and deletes nothing."}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-300">
            Candle max age (days)
            <input aria-label="Candle max age days" type="number" min="1" className={`${input} mt-1 w-32`}
              value={retention?.classes.CANDLE?.maxAgeDays ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const days = Number(raw);
                setRetention((prev) => {
                  const classes = { ...(prev?.classes ?? {}) };
                  if (raw !== "" && Number.isInteger(days) && days > 0) classes.CANDLE = { maxAgeDays: days };
                  else delete classes.CANDLE; // clearing the input removes the limit
                  return { version: 1, classes };
                });
              }} />
          </label>
          <label className="text-xs text-slate-300">
            Snapshot max age (days)
            <input aria-label="Snapshot max age days" type="number" min="1" className={`${input} mt-1 w-32`}
              value={retention?.classes.SNAPSHOT?.maxAgeDays ?? ""}
              onChange={(e) => {
                const raw = e.target.value.trim();
                const days = Number(raw);
                setRetention((prev) => {
                  const classes = { ...(prev?.classes ?? {}) };
                  if (raw !== "" && Number.isInteger(days) && days > 0) classes.SNAPSHOT = { maxAgeDays: days };
                  else delete classes.SNAPSHOT; // clearing the input removes the limit
                  return { version: 1, classes };
                });
              }} />
          </label>
          <button type="button" className={button} onClick={() => void saveRetentionSettings()}>Save retention</button>
          <button type="button" className={button} onClick={() => void cleanup()}>Run cleanup</button>
        </div>
      </div>
    </section>
  );
}
