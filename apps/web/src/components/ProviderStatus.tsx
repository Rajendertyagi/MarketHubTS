import { useState } from "react";
import type { ProviderStatusesResponse } from "@markethub/contracts";
import { StatusBadge } from "./StatusBadge";

// Derive the view types from the shared response contract so the WebUI never
// maintains a second, hand-written provider status shape.
export type ProviderStatusMapView = NonNullable<ProviderStatusesResponse["providers"]>;
export type ProviderStatusView = ProviderStatusMapView[keyof ProviderStatusMapView];

type Capability = ProviderStatusView["capabilities"][number];
type Limit = ProviderStatusView["limits"][number];
type CapabilityState = Capability["state"];
type CapabilitySource = Capability["source"];
type BadgeTone = "ok" | "warn" | "error" | "neutral";

// Local presentation only: contract state/source values map to a badge tone and
// label. No capability names, states or sources are invented here — every record
// rendered below comes from the validated backend response.
const statePresentation: Record<CapabilityState, { tone: BadgeTone; label: string }> = {
  AVAILABLE: { tone: "ok", label: "AVAILABLE" },
  UNAVAILABLE: { tone: "error", label: "UNAVAILABLE" },
  UNKNOWN: { tone: "warn", label: "UNKNOWN" }
};

const sourcePresentation: Record<CapabilitySource, { tone: BadgeTone; label: string }> = {
  API: { tone: "ok", label: "API" },
  DOCUMENTATION: { tone: "warn", label: "DOCUMENTATION" },
  USER: { tone: "neutral", label: "USER" },
  UNKNOWN: { tone: "warn", label: "UNKNOWN" }
};

function CapabilityList({ capabilities }: { capabilities: Capability[] }) {
  if (capabilities.length === 0) {
    return <p className="mt-2 text-xs text-slate-500">No capability metadata reported</p>;
  }
  return (
    <ul className="mt-2 space-y-1">
      {capabilities.map((capability) => {
        const state = statePresentation[capability.state];
        const source = sourcePresentation[capability.source];
        return (
          <li key={capability.name} className="rounded border border-slate-800 bg-slate-950/30 p-2" data-capability-name={capability.name}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-200">{capability.name}</span>
              <span className="flex items-center gap-1">
                <span data-state={capability.state}><StatusBadge label={state.label} tone={state.tone} /></span>
                <span data-source={capability.source}><StatusBadge label={`Source: ${source.label}`} tone={source.tone} /></span>
              </span>
            </div>
            {capability.asOf != null && <p className="mt-1 text-xs text-slate-500">As of: {capability.asOf}</p>}
            {capability.note != null && <p className="mt-1 text-xs text-slate-400">{capability.note}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function LimitList({ limits }: { limits: Limit[] }) {
  if (limits.length === 0) {
    return <p className="mt-2 text-xs text-slate-500">No limit metadata reported</p>;
  }
  return (
    <ul className="mt-2 space-y-1">
      {limits.map((limit) => {
        const state = statePresentation[limit.state];
        const source = sourcePresentation[limit.source];
        const unverified = limit.state === "UNKNOWN" && limit.source === "DOCUMENTATION";
        return (
          <li key={limit.name} className="rounded border border-slate-800 bg-slate-950/30 p-2" data-limit-name={limit.name}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-200">
                {limit.name} <span className="text-slate-400">= {limit.value === null ? "null" : String(limit.value)}</span>
              </span>
              <span className="flex items-center gap-1">
                <span data-state={limit.state}><StatusBadge label={state.label} tone={state.tone} /></span>
                <span data-source={limit.source}><StatusBadge label={`Source: ${source.label}`} tone={source.tone} /></span>
              </span>
            </div>
            {unverified && (
              <p data-unverified="true" className="mt-1 text-xs text-amber-300">Unverified — documentation-derived; not a confirmed account entitlement or effective limit.</p>
            )}
            {limit.publishedAt != null && <p className="mt-1 text-xs text-slate-500">Published: {limit.publishedAt}</p>}
            {limit.note != null && <p className="mt-1 text-xs text-slate-400">{limit.note}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function ProviderRow({ status }: { status: ProviderStatusView }) {
  const tone = status.authState === "AUTHENTICATED" ? "ok" : status.authState === "ERROR" || status.authState === "EXPIRED" ? "error" : "warn";
  return (
    <li className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-100">{status.id}</span>
        <StatusBadge label={status.authState.replaceAll("_", " ")} tone={tone} />
      </div>
      <dl className="mt-2 space-y-1 text-xs text-slate-400">
        <div className="flex justify-between gap-2"><dt>Streaming</dt><dd className="text-slate-300">{status.streamingState.replaceAll("_", " ")} (M4)</dd></div>
        <div className="flex justify-between gap-2"><dt>Validated</dt><dd className="text-slate-300">{status.validatedAt ?? "never"}</dd></div>
        <div className="flex justify-between gap-2"><dt>Expiry</dt><dd className="text-slate-300">{status.expiryKnown ? (status.expiresAt ?? "unknown") : "unknown"}</dd></div>
      </dl>
      {status.error && <p className="mt-2 text-xs text-rose-300">{status.error}</p>}
      {status.restrictions.length > 0 && <p className="mt-1 text-xs text-amber-300">{status.restrictions.join("; ")}</p>}
      <div className="mt-3 border-t border-slate-800 pt-2">
        <p className="text-xs font-semibold text-slate-300">Capabilities</p>
        <CapabilityList capabilities={status.capabilities} />
      </div>
      <div className="mt-3 border-t border-slate-800 pt-2">
        <p className="text-xs font-semibold text-slate-300">Limits</p>
        <LimitList limits={status.limits} />
      </div>
    </li>
  );
}

/** Renders every entry in the validated provider map by its own id, with no hardcoded provider names. */
export function ProviderList({ providers }: { providers: ProviderStatusMapView }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {Object.values(providers).map((status) => (
        <ProviderRow key={status.id} status={status} />
      ))}
    </ul>
  );
}

function ProviderControls({ onChanged }: { onChanged: () => void }) {
  const [upstoxToken, setUpstoxToken] = useState("");
  const [upstoxExpiry, setUpstoxExpiry] = useState("");
  const [appId, setAppId] = useState("");
  const [redirectUri, setRedirectUri] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await res.json().catch(() => ({})) as any;
      if (!res.ok) {
        setMessage(payload?.message ?? `Request failed (${res.status})`);
      } else {
        setMessage("Done");
        onChanged();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100";
  const button = "rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50";

  return (
    <div className="mt-4 grid gap-4 border-t border-slate-800 pt-4 sm:grid-cols-2">
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-slate-200">Upstox (Analytics Token)</h4>
        <input aria-label="Upstox Analytics Token" type="password" className={input} placeholder="Analytics Token" value={upstoxToken} onChange={(e) => setUpstoxToken(e.target.value)} />
        <input aria-label="Upstox token expiry" type="date" className={input} value={upstoxExpiry} onChange={(e) => setUpstoxExpiry(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className={button} onClick={() => void post("/api/provider/upstox/token", { token: upstoxToken, expiresAt: upstoxExpiry ? new Date(`${upstoxExpiry}T00:00:00Z`).toISOString() : undefined })}>Save token</button>
          <button type="button" disabled={busy} className={button} onClick={() => void post("/api/provider/UPSTOX/validate", {})}>Validate</button>
          <button type="button" disabled={busy} className={button} onClick={() => void post("/api/provider/UPSTOX/remove", { confirm: true })}>Remove</button>
        </div>
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-slate-200">FYERS (non-trading app)</h4>
        <input aria-label="FYERS App ID" className={input} placeholder="App ID" value={appId} onChange={(e) => setAppId(e.target.value)} />
        <input aria-label="FYERS redirect URI" className={input} placeholder="http://127.0.0.1:3001/api/provider/fyers/callback" value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} />
        <input aria-label="FYERS App Secret" type="password" className={input} placeholder="App Secret" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} className={button} onClick={() => void post("/api/provider/fyers/config", { appId, redirectUri })}>Save config</button>
          <button type="button" disabled={busy} className={button} onClick={() => void post("/api/provider/fyers/app-secret", { appSecret })}>Save secret</button>
          <button type="button" disabled={busy} className={button} onClick={async () => {
            setBusy(true);
            try {
              const res = await fetch("/api/provider/fyers/auth/start", { method: "POST" });
              const payload = await res.json().catch(() => ({})) as any;
              if (!res.ok) setMessage(payload?.message ?? `Request failed (${res.status})`);
              else if (payload?.authorizationUrl) window.location.href = payload.authorizationUrl;
            } finally { setBusy(false); }
          }}>Start authorization</button>
          <button type="button" disabled={busy} className={button} onClick={() => void post("/api/provider/FYERS/validate", {})}>Validate</button>
          <button type="button" disabled={busy} className={button} onClick={() => void post("/api/provider/FYERS/remove", { confirm: true })}>Remove</button>
        </div>
      </div>
      {message && <p className="sm:col-span-2 text-xs text-slate-300" role="status">{message}</p>}
      <p className="sm:col-span-2 text-xs text-slate-500">Credential management works only from the application host. From a LAN device you can view status but cannot change credentials.</p>
    </div>
  );
}

/** Pure presentation of the provider status content, kept separate from the query so it can be rendered without a QueryClient. */
export function ProviderStatusContent({
  providers, note, isError, onChanged
}: {
  providers: ProviderStatusMapView | null | undefined;
  note?: string | undefined;
  isError: boolean;
  onChanged: () => void;
}) {
  return (
    <>
      {isError && <p className="text-sm text-rose-300">Unable to read provider status.</p>}
      {providers === undefined && !isError && <p className="text-sm text-slate-400">Loading provider status...</p>}
      {providers === null && !isError && <p className="text-sm text-slate-400">Provider status is currently unavailable.</p>}
      {providers && (
        <>
          <ProviderList providers={providers} />
          <p className="mt-3 text-xs text-slate-400">
            {note ? `${note} ` : ""}No credentials are shown here.
          </p>
          <ProviderControls onChanged={onChanged} />
        </>
      )}
    </>
  );
}
