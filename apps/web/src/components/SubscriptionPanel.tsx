import { useEffect, useState } from "react";
import type { SubscriptionSelection } from "@markethub/contracts";
import {
  fetchSubscriptions, replaceSubscriptions, SubscriptionHttpError, type SubscriptionErrorKind
} from "../lib/subscriptions";
import { useLiveStore, type SubscriptionErrorState } from "../store/live-store";
import { InstrumentPicker } from "./InstrumentPicker";
import { StatusBadge } from "./StatusBadge";
import { SubscriptionRuntimeView } from "./SubscriptionRuntimeView";

const ERROR_LABELS: Record<SubscriptionErrorKind | "runtime", string> = {
  forbidden: "Local-owner only — subscription changes must be made on the application host.",
  validation: "Validation error",
  persistence: "Persistence failure — desired state was not saved.",
  internal: "Internal error",
  runtime: "Desired state saved; runtime reconciliation failed"
};

function errorState(error: unknown): SubscriptionErrorState {
  if (error instanceof SubscriptionHttpError) {
    return { kind: error.kind, message: `${ERROR_LABELS[error.kind]}: ${error.message}` };
  }
  return { kind: "internal", message: error instanceof Error ? error.message : "Unexpected error" };
}

export function SubscriptionPanel() {
  const view = useLiveStore((s) => s.subscriptions);
  const setSubscriptions = useLiveStore((s) => s.setSubscriptions);
  const error = useLiveStore((s) => s.subscriptionError);
  const setError = useLiveStore((s) => s.setSubscriptionError);
  const [draftId, setDraftId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchSubscriptions()
      .then((loaded) => { if (active) setSubscriptions(loaded); })
      .catch((cause) => { if (active) setError(errorState(cause)); });
    return () => { active = false; };
  }, [setSubscriptions, setError]);

  const selections: SubscriptionSelection[] = view?.selections ?? [];

  // Prefer the per-provider runtime map when it is populated. The legacy
  // `runtime` field is the coordinator's first runtime, so rendering it in
  // addition to a populated `runtimes` map would duplicate that entry.
  const runtimeEntries = view?.runtimes && Object.keys(view.runtimes).length > 0
    ? Object.entries(view.runtimes)
    : null;

  const commit = async (next: SubscriptionSelection[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await replaceSubscriptions(next);
      if (result.view) setSubscriptions(result.view);
      if (result.runtimeError) {
        setError({ kind: "runtime", message: `${ERROR_LABELS.runtime}: ${result.runtimeError}` });
      }
    } catch (cause) {
      setError(errorState(cause));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const canonicalId = draftId.trim();
    if (!canonicalId || selections.some((s) => s.canonicalId === canonicalId)) return;
    setDraftId("");
    void commit([...selections, { canonicalId, enabled: true }]);
  };

  const toggle = (canonicalId: string) => {
    void commit(selections.map((s) => s.canonicalId === canonicalId ? { ...s, enabled: !s.enabled } : s));
  };

  const remove = (canonicalId: string) => {
    void commit(selections.filter((s) => s.canonicalId !== canonicalId));
  };

  const input = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100";
  const button = "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50";

  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <h3 className="text-base font-semibold">Streaming selections</h3>
      <p className="mt-1 text-xs text-slate-400">
        Search the canonical catalog to add an instrument to your streaming selections.
      </p>

      <div className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <InstrumentPicker
            value={draftId}
            onChange={setDraftId}
            label="Instrument"
            placeholder="Search by symbol or name…"
            disabled={busy}
          />
        </div>
        <button type="button" disabled={busy || draftId.trim().length === 0} className={button} onClick={add}>Add</button>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 text-xs text-amber-100" role="alert">
          {error.message}
        </p>
      )}

      {view && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <h4 className="mb-2 text-sm font-semibold text-slate-200">Desired state</h4>
            <p className="mb-2 text-xs text-slate-400">Generation {view.generation} · Applied {view.runtime.generation}</p>
            <ul className="space-y-2">
              {selections.length === 0 && <li className="text-xs text-slate-400">No selections.</li>}
              {selections.map((selection) => {
                const resolution = view.runtime.resolutions.find((r) => r.canonicalId === selection.canonicalId);
                return (
                  <li key={selection.canonicalId} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-200 break-all">{selection.canonicalId}</span>
                      <StatusBadge label={selection.enabled ? "Enabled" : "Disabled"} tone={selection.enabled ? "ok" : "neutral"} />
                    </div>
                    <p className="mt-1 text-xs text-slate-400">
                      {resolution?.available ? "Mapping available" : (resolution?.reason ?? "No resolution")}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button type="button" disabled={busy} className={button} onClick={() => toggle(selection.canonicalId)}>
                        {selection.enabled ? "Disable" : "Enable"}
                      </button>
                      <button type="button" disabled={busy} className={button} onClick={() => remove(selection.canonicalId)}>Remove</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold text-slate-200">Runtime</h4>
            {runtimeEntries ? (
              <div className="space-y-3">
                {runtimeEntries.map(([providerKey, runtime]) => (
                  <SubscriptionRuntimeView key={providerKey} runtime={runtime} providerKey={providerKey} />
                ))}
              </div>
            ) : (
              <SubscriptionRuntimeView runtime={view.runtime} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
