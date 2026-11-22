import { useEffect, useRef, useState } from "react";
import type { SubscriptionSelection, SubscriptionStateView } from "@markethub/contracts";
import {
  fetchSubscriptions, getWriteGeneration, isWritePending, replaceSubscriptions,
  SubscriptionHttpError, type SubscriptionErrorKind
} from "../lib/subscriptions";
import { createSubscriptionPoller, type SubscriptionPoller } from "../lib/subscription-poller";
import { createRetrySleep } from "../lib/retry-sleep";
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

/**
 * Write orchestration extracted so the suspend/resume-around-write contract is
 * directly testable without React DOM. The component uses this exact function.
 */
export function createCommitHandler(deps: {
  replace: typeof replaceSubscriptions;
  getPoller: () => Pick<SubscriptionPoller, "suspend" | "resume"> | null;
  applyView: (view: SubscriptionStateView) => void;
  setError: (error: SubscriptionErrorState | null) => void;
  setBusy: (busy: boolean) => void;
}) {
  return async (next: SubscriptionSelection[]): Promise<void> => {
    deps.setBusy(true);
    deps.setError(null);
    // Suspend before the PUT so no poll can start or apply while the write is
    // in flight. The PUT-returned view stays authoritative.
    deps.getPoller()?.suspend();
    try {
      const result = await deps.replace(next);
      if (result.view) deps.applyView(result.view);
      if (result.runtimeError) {
        deps.setError({ kind: "runtime", message: `${ERROR_LABELS.runtime}: ${result.runtimeError}` });
      }
    } catch (cause) {
      deps.setError(errorState(cause));
    } finally {
      // Always resume, including on failure, so the panel never gets stuck.
      deps.getPoller()?.resume();
      deps.setBusy(false);
    }
  };
}

/** Distinct from post-commit write/runtime errors: the last good view is kept. */
export function RefreshErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-3 rounded-lg border border-sky-800/60 bg-sky-950/20 p-3 text-xs text-sky-100" role="status" data-testid="refresh-error">
      <span>Refresh unavailable — showing last known state</span>
      <span className="ml-2 text-sky-200/80">{message}</span>
      <button
        type="button"
        className="ml-3 rounded-md border border-sky-700 bg-sky-900/40 px-2 py-1 font-medium hover:bg-sky-900/70"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}

export function SubscriptionPanel() {
  const view = useLiveStore((s) => s.subscriptions);
  const setSubscriptions = useLiveStore((s) => s.setSubscriptions);
  const error = useLiveStore((s) => s.subscriptionError);
  const setError = useLiveStore((s) => s.setSubscriptionError);
  const [draftId, setDraftId] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const pollerRef = useRef<SubscriptionPoller | null>(null);

  // First load only. The bounded refresh below is a separate concern and
  // reports into `refreshError`, never into the write/runtime `subscriptionError`.
  useEffect(() => {
    let active = true;
    // Guard the first load with the same write-generation invariant the poller
    // uses: a GET started before a newer write must never overwrite that
    // write's authoritative view, even if it resolves after the PUT.
    const writeGenBefore = getWriteGeneration();
    const stillCurrent = () => active &&
      writeGenBefore === getWriteGeneration() && !isWritePending();
    void fetchSubscriptions()
      .then((loaded) => { if (stillCurrent()) setSubscriptions(loaded); })
      .catch((cause) => { if (stillCurrent()) setError(errorState(cause)); });
    return () => { active = false; };
  }, [setSubscriptions, setError]);

  useEffect(() => {
    const poller = createSubscriptionPoller({
      fetchView: fetchSubscriptions,
      getWriteGeneration,
      isWritePending,
      applyView: setSubscriptions,
      onRefreshError: setRefreshError,
      sleep: createRetrySleep()
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.dispose();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [setSubscriptions]);

  const selections: SubscriptionSelection[] = view?.selections ?? [];

  // Prefer the per-provider runtime map when it is populated. The legacy
  // `runtime` field is the coordinator's first runtime, so rendering it in
  // addition to a populated `runtimes` map would duplicate that entry.
  const runtimeEntries = view?.runtimes && Object.keys(view.runtimes).length > 0
    ? Object.entries(view.runtimes)
    : null;

  const commit = createCommitHandler({
    replace: replaceSubscriptions,
    getPoller: () => pollerRef.current,
    applyView: setSubscriptions,
    setError,
    setBusy
  });

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

      {refreshError && (
        <RefreshErrorNotice message={refreshError} onRetry={() => pollerRef.current?.refreshNow()} />
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
