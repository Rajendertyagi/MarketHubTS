import { useEffect, useState } from "react";
import { candleIntervalSchema, istDateString, parseIstDateRange } from "@markethub/contracts";
import type {
  CandleGap, CandleInterval, CandleRangeNote, HistoricalCandle, HistoricalSyncConfig,
  RetentionDataClass, RetentionSettingsView
} from "@markethub/contracts";
import {
  deleteSyncConfig, fetchCachedCandles, fetchCoverage, fetchRetention, fetchSyncConfigs,
  HistoricalHttpError, runRetentionCleanup, saveRetention, saveSyncConfig
} from "../lib/historical";
import { draftFromView, retentionSaveDecision, type RetentionDraft, type RetentionDraftErrors } from "../lib/retention-form";
import { InstrumentPicker } from "./InstrumentPicker";
import { StatusBadge } from "./StatusBadge";

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

export interface HistoricalFocus {
  canonicalId: string; interval: string; fromMs: number; toMs: number;
}

/**
 * Convert an activity historical result ref into the panel's form values.
 * Date inputs are India-local calendar dates, so istDateString (not UTC
 * slicing) is required; the interval is validated against the canonical
 * contract. Returns null for an invalid interval so the panel keeps its
 * current form state rather than navigating with a bogus value.
 */
export function historicalFocusToForm(focus: HistoricalFocus): {
  canonicalId: string; interval: CandleInterval; from: string; to: string
} | null {
  const parsed = candleIntervalSchema.safeParse(focus.interval);
  if (!parsed.success) return null;
  return {
    canonicalId: focus.canonicalId,
    interval: parsed.data,
    from: istDateString(focus.fromMs),
    to: istDateString(focus.toMs)
  };
}

const input = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100";
const button = "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50";

const RETENTION_FIELDS: { dataClass: RetentionDataClass; label: string; ariaLabel: string }[] = [
  { dataClass: "CANDLE", label: "Candle max age (days)", ariaLabel: "Candle max age days" },
  { dataClass: "SNAPSHOT", label: "Snapshot max age (days)", ariaLabel: "Snapshot max age days" },
  { dataClass: "ACTIVITY", label: "Activity max age (days)", ariaLabel: "Activity max age days" }
];

export interface RetentionFieldsViewProps {
  draft: RetentionDraft;
  errors: RetentionDraftErrors;
  status: string;
  onChange: (dataClass: RetentionDataClass, raw: string) => void;
  onSave: () => void;
  onCleanup: () => void;
}

/**
 * Pure presentational view for the retention form. Kept separate from the
 * data-loading container so rendering can be verified with react-dom/server
 * without a DOM test library. Raw draft text is rendered verbatim so invalid
 * input stays visible; field errors and aria-invalid are driven by `errors`.
 */
export function RetentionFieldsView({ draft, errors, status, onChange, onSave, onCleanup }: RetentionFieldsViewProps) {
  return (
    <div className="mt-5 border-t border-slate-800 pt-4">
      <h4 className="text-sm font-semibold text-slate-200">Retention</h4>
      <p className="mt-1 text-xs text-slate-400" role="status">{status}</p>
      <p className="mt-1 text-xs text-slate-400">
        Edits are not saved until you select Save retention. Run cleanup uses the saved settings, not this unsaved draft.
        Valid settings with no limits delete nothing.
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        {RETENTION_FIELDS.map(({ dataClass, label, ariaLabel }) => (
          <label key={dataClass} className="text-xs text-slate-300">
            {label}
            <input
              aria-label={ariaLabel}
              type="text"
              inputMode="numeric"
              className={`${input} mt-1 w-32`}
              value={draft[dataClass]}
              aria-invalid={errors[dataClass] !== undefined}
              onChange={(e) => onChange(dataClass, e.target.value)}
            />
            {errors[dataClass] && (
              <span className="mt-1 block text-xs text-amber-300" role="alert">{errors[dataClass]}</span>
            )}
          </label>
        ))}
        <button type="button" className={button} onClick={onSave}>Save retention</button>
        <button type="button" className={button} onClick={onCleanup}>Run cleanup</button>
      </div>
    </div>
  );
}

export function HistoricalPanel({ focus }: { focus?: HistoricalFocus | null }) {
  const [canonicalId, setCanonicalId] = useState("");
  const [interval, setInterval] = useState<CandleInterval>("1D");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [candles, setCandles] = useState<HistoricalCandle[] | null>(null);
  const [gaps, setGaps] = useState<CandleGap[]>([]);
  const [unavailableNotes, setUnavailableNotes] = useState<CandleRangeNote[]>([]);
  const [configs, setConfigs] = useState<HistoricalSyncConfig[]>([]);
  const [retentionDraft, setRetentionDraft] = useState<RetentionDraft>({ CANDLE: "", SNAPSHOT: "", ACTIVITY: "" });
  const [retentionView, setRetentionView] = useState<RetentionSettingsView | null>(null);
  const [retentionErrors, setRetentionErrors] = useState<RetentionDraftErrors>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadConfigs = () => {
    void fetchSyncConfigs().then(setConfigs).catch((cause) => setError(toError(cause)));
  };
  const loadRetention = () => {
    void fetchRetention().then((view) => {
      // The persisted view owns the draft on load/reload. An invalid or missing
      // view yields three blank fields; no default retention period is invented.
      setRetentionView(view);
      setRetentionDraft(draftFromView(view));
      setRetentionErrors({});
    }).catch((cause) => setError(toError(cause)));
  };

  useEffect(() => { loadConfigs(); loadRetention(); }, []);

  // M6-C: prefill the historical query from an activity result reference.
  // Date inputs are India-local calendar dates, so convert with istDateString
  // (not UTC slicing) and validate the interval against the canonical contract.
  useEffect(() => {
    if (!focus) return;
    const form = historicalFocusToForm(focus);
    if (!form) return;
    setCanonicalId(form.canonicalId);
    setInterval(form.interval);
    setFrom(form.from);
    setTo(form.to);
  }, [focus]);

  const readCached = async () => {
    // Date-only inputs are India-local calendar dates: inclusive local midnight
    // at the start date through the end of the selected final date.
    const range = parseIstDateRange(from, to);
    if (!canonicalId.trim() || !range) {
      setError("Enter a canonical ID and a valid from/to range.");
      return;
    }
    const { fromMs, toMs } = range;
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
    const decision = retentionSaveDecision(retentionDraft);
    if (decision.kind === "block") {
      // Keep the raw text exactly as typed; the block branch never calls saveRetention.
      setRetentionErrors(decision.errors);
      setMessage(null);
      return;
    }
    setRetentionErrors({});
    try {
      await saveRetention(decision.settings);
      setMessage("Retention settings saved.");
      loadRetention();
    } catch (cause) { setError(toError(cause)); }
  };

  const cleanup = async () => {
    try {
      const result = await runRetentionCleanup();
      setMessage(result.ran
        ? `Cleanup complete: ${result.candlesDeleted} candles, ${result.snapshotsDeleted} snapshots, ${result.activitiesDeleted} activity records deleted.`
        : `Cleanup disabled: ${result.reason ?? "invalid settings"}. Nothing deleted.`);
    } catch (cause) { setError(toError(cause)); }
  };

  const validRetentionView = retentionView?.valid ? retentionView : null;
  const savedClasses = validRetentionView?.settings.classes;
  const hasSavedLimits = savedClasses?.CANDLE !== undefined
    || savedClasses?.SNAPSHOT !== undefined
    || savedClasses?.ACTIVITY !== undefined;
  const retentionStatus = !validRetentionView
    ? "No valid saved retention settings. Cleanup is disabled and deletes nothing."
    : hasSavedLimits
      ? "Saved retention limits apply only to the configured data classes."
      : "Saved settings are valid, but no retention limits are configured. Cleanup will delete nothing.";

  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="text-base font-semibold">Historical candles</h3>
      <p className="mt-1 text-xs text-slate-400">
        Cached reads and coverage are derived from stored candles. No candles are fabricated; gaps are approximate and unconfirmed.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <InstrumentPicker
          value={canonicalId}
          onChange={setCanonicalId}
          label="Instrument"
          placeholder="Search by symbol or name…"
          disabled={loading}
        />
        <select aria-label="Interval" className={input} value={interval} onChange={(e) => setInterval(e.target.value as CandleInterval)}>
          {candleIntervalSchema.options.map((i) => <option key={i} value={i}>{i}</option>)}
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

      <RetentionFieldsView
        draft={retentionDraft}
        errors={retentionErrors}
        status={retentionStatus}
        onChange={(dataClass, raw) => {
          setRetentionDraft((prev) => ({ ...prev, [dataClass]: raw }));
          if (retentionErrors[dataClass] !== undefined) {
            setRetentionErrors((prev) => {
              const next = { ...prev };
              delete next[dataClass];
              return next;
            });
          }
        }}
        onSave={() => void saveRetentionSettings()}
        onCleanup={() => void cleanup()}
      />
    </section>
  );
}
