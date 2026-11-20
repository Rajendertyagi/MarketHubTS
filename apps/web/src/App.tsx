import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import { fetchProvidersStatus, fetchSystemStatus, formatUptime, type ProviderStatusView } from "./lib/status";
import { StatusBadge, toneForState } from "./components/StatusBadge";
import { LivePanel } from "./components/LivePanel";
import { SubscriptionPanel } from "./components/SubscriptionPanel";
import { HistoricalPanel } from "./components/HistoricalPanel";
import { SnapshotPanel } from "./components/SnapshotPanel";
import { ActivityPanel } from "./components/ActivityPanel";

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-800/80 py-2 last:border-b-0">
      <dt className="text-sm text-slate-400">{label}</dt>
      <dd className="text-right text-sm font-medium text-slate-100 break-all">{value}</dd>
    </div>
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
    </li>
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

function ProviderPanel() {
  const query = useQuery({
    queryKey: ["provider-status"],
    queryFn: fetchProvidersStatus,
    refetchInterval: 10000,
    retry: 1
  });
  const providers = query.data?.providers;
  return (
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold">Providers</h3>
        <button type="button" onClick={() => void query.refetch()} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800">Refresh</button>
      </div>
      {query.isError && <p className="text-sm text-rose-300">Unable to read provider status.</p>}
      {!providers && !query.isError && <p className="text-sm text-slate-400">Loading provider status...</p>}
      {providers && (
        <>
          <ul className="grid gap-3 sm:grid-cols-2">
            <ProviderRow status={providers.UPSTOX} />
            <ProviderRow status={providers.FYERS} />
          </ul>
          <p className="mt-3 text-xs text-slate-400">
            {query.data?.note} No credentials are shown here.
          </p>
          <ProviderControls onChanged={() => void query.refetch()} />
        </>
      )}
    </section>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<"overview" | "live" | "history" | "activity">("overview");
  const [focusSnapshotId, setFocusSnapshotId] = useState<string | null>(null);
  const [focusHistorical, setFocusHistorical] = useState<{ canonicalId: string; interval: string; fromMs: number; toMs: number } | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["system-status"],
    queryFn: async () => {
      const data = await fetchSystemStatus();
      setLastSuccessAt(new Date().toISOString());
      return data;
    },
    refetchInterval: 5000,
    retry: 1
  });

  const data = query.data;
  const readiness = data?.readiness;
  const overall = readiness?.status ?? (query.isError ? "error" : "unknown");
  const overallLabel = readiness ? (readiness.ready ? "Ready" : "Not ready") : query.isError ? "Unavailable" : "Checking";

  const connectionInfo = useMemo(() => {
    if (!readiness?.details) return null;
    const { host, port, lan, environment } = readiness.details;
    return { host, port, lan, environment };
  }, [readiness]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded focus:bg-sky-600 focus:px-3 focus:py-2">Skip to content</a>
      <header className="border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-600/20 ring-1 ring-sky-500/30">
              <span className="text-sm font-bold text-sky-300">MH</span>
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">MarketHubTS</h1>
              <p className="text-xs text-slate-400">Local-first market data platform foundation</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label={overallLabel} tone={toneForState(readiness?.ready ? "ready" : overall === "error" ? "error" : overall)} />
            {data?.version && <span className="text-xs text-slate-400">v{data.version}</span>}
            <button type="button" onClick={() => void query.refetch()} className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-500">Refresh</button>
          </div>
        </div>
        <nav className="mx-auto max-w-6xl px-4 sm:px-6" aria-label="Primary">
          <div className="flex gap-1 border-t border-slate-800/80 pt-2 pb-0">
            <button type="button" onClick={() => setActiveTab("overview")} aria-current={activeTab === "overview" ? "page" : undefined}
              className={`rounded-t-md border border-b-0 px-3 py-2 text-sm font-medium ${activeTab === "overview" ? "border-slate-700 bg-slate-900 text-slate-100" : "border-transparent text-slate-400 hover:text-slate-200"}`}>
              Overview
            </button>
            <button type="button" onClick={() => setActiveTab("live")} aria-current={activeTab === "live" ? "page" : undefined}
              className={`rounded-t-md border border-b-0 px-3 py-2 text-sm font-medium ${activeTab === "live" ? "border-slate-700 bg-slate-900 text-slate-100" : "border-transparent text-slate-400 hover:text-slate-200"}`}>
              Live data
            </button>
            <button type="button" onClick={() => setActiveTab("history")} aria-current={activeTab === "history" ? "page" : undefined}
              className={`rounded-t-md border border-b-0 px-3 py-2 text-sm font-medium ${activeTab === "history" ? "border-slate-700 bg-slate-900 text-slate-100" : "border-transparent text-slate-400 hover:text-slate-200"}`}>
              History & snapshots
            </button>
            <button type="button" onClick={() => setActiveTab("activity")} aria-current={activeTab === "activity" ? "page" : undefined}
              className={`rounded-t-md border border-b-0 px-3 py-2 text-sm font-medium ${activeTab === "activity" ? "border-slate-700 bg-slate-900 text-slate-100" : "border-transparent text-slate-400 hover:text-slate-200"}`}>
              MCP / Activity
            </button>
            <span className="px-3 py-2 text-sm text-slate-500" title="Not implemented in this milestone">Market modules (planned)</span>
          </div>
        </nav>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <div className="mb-6">
          <h2 className="text-xl font-semibold">System overview</h2>
          <p className="mt-1 text-sm text-slate-400">Real runtime status from the local MarketHubTS backend. Market data, providers, catalog, alerts, and MCP HTTP are not implemented in this foundation milestone.</p>
        </div>

        {query.isLoading && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6" role="status" aria-live="polite">
            <div className="flex items-center gap-3 text-slate-300">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-sky-400" />
              <span>Loading system status...</span>
            </div>
          </div>
        )}

        {query.isError && (
          <div className="mb-6 rounded-xl border border-rose-800/60 bg-rose-950/30 p-5" role="alert">
            <h3 className="text-sm font-semibold text-rose-200">Unable to reach backend</h3>
            <p className="mt-1 text-sm text-rose-100/90">{(query.error as Error).message}</p>
            <p className="mt-2 text-xs text-rose-200/70">Ensure the API is running and accessible. In development, start with <code className="rounded bg-rose-900/40 px-1">bun run dev</code>. The UI will retry automatically.</p>
            <button type="button" onClick={() => void query.refetch()} className="mt-3 rounded-md bg-rose-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-600 focus:outline-none focus:ring-2 focus:ring-rose-400">Retry now</button>
          </div>
        )}

        {data && (
          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 lg:col-span-2">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-base font-semibold">Runtime health</h3>
                <StatusBadge label={data.readiness.ready ? "Ready" : "Not ready"} tone={data.readiness.ready ? "ok" : "error"} />
              </div>
              <dl>
                <InfoRow label="Service" value={data.service} />
                <InfoRow label="Version" value={data.version} />
                <InfoRow label="Environment" value={String(connectionInfo?.environment ?? "unknown")} />
                <InfoRow label="Uptime" value={formatUptime(data.uptimeMs)} />
                <InfoRow label="API check" value={data.readiness.checks.api} />
                <InfoRow label="Database check" value={data.readiness.checks.database} />
                <InfoRow label="Config check" value={data.readiness.checks.config} />
                <InfoRow label="Last backend timestamp" value={data.timestamp} />
                <InfoRow label="Last successful refresh" value={lastSuccessAt ?? "—"} />
              </dl>
              {!data.readiness.ready && (
                <div className="mt-4 rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 text-sm text-amber-100">The application is running but not fully ready. Check database availability and startup logs.</div>
              )}
            </section>

            <div className="space-y-4">
              <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <h3 className="mb-3 text-base font-semibold">Connection</h3>
                <dl>
                  <InfoRow label="Bind host" value={String(connectionInfo?.host ?? "—")} />
                  <InfoRow label="Port" value={String(connectionInfo?.port ?? "—")} />
                  <InfoRow label="LAN mode" value={connectionInfo?.lan ? "Enabled" : "Disabled"} />
                  <InfoRow label="DB configured" value={data.readiness.details?.databasePathConfigured ? "Yes" : "No"} />
                </dl>
              </section>

              <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
                <h3 className="mb-3 text-base font-semibold">Foundation status</h3>
                <ul className="space-y-2 text-sm text-slate-300">
                  <li className="flex items-center justify-between"><span>Runtime & config</span><StatusBadge label="Implemented" tone="ok" /></li>
                  <li className="flex items-center justify-between"><span>SQLite & migrations</span><StatusBadge label="Implemented" tone="ok" /></li>
                  <li className="flex items-center justify-between"><span>API health/readiness</span><StatusBadge label="Implemented" tone="ok" /></li>
                  <li className="flex items-center justify-between"><span>WebUI shell</span><StatusBadge label="Implemented" tone="ok" /></li>
                  <li className="flex items-center justify-between"><span>Market data/providers</span><StatusBadge label="Not implemented" tone="neutral" /></li>
                  <li className="flex items-center justify-between"><span>MCP HTTP transport</span><StatusBadge label="Not implemented" tone="neutral" /></li>
                </ul>
              </section>
            </div>
          </div>
        )}

        <ProviderPanel />
        {activeTab === "live" && (
          <>
            <LivePanel />
            <SubscriptionPanel />
          </>
        )}
        {activeTab === "history" && (
          <>
            <HistoricalPanel focus={focusHistorical} />
            <SnapshotPanel focusSnapshotId={focusSnapshotId} />
          </>
        )}
        {activeTab === "activity" && (
          <ActivityPanel
            httpHandlerMounted={data?.mcp?.httpHandlerMounted ?? null}
            onOpenSnapshot={(snapshotId) => { setFocusSnapshotId(snapshotId); setActiveTab("history"); }}
            onOpenHistorical={(ref) => { setFocusHistorical(ref); setActiveTab("history"); }}
          />
        )}
        <Outlet />
      </main>
    </div>
  );
}
