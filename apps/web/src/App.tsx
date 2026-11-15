import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import type { HealthStatus } from "@markethub/contracts";

async function fetchHealth(): Promise<HealthStatus> {
  const res = await fetch("/health");
  if (!res.ok) throw new Error(`Health request failed: ${res.status}`);
  return (await res.json()) as HealthStatus;
}

export function App() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    refetchInterval: 5000
  });

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4">
        <h1 className="text-xl font-semibold">MarketHubTS</h1>
        <p className="text-sm text-slate-400">Phase 1 foundation — React + Vite + Hono + Bun</p>
      </header>
      <main className="mx-auto max-w-4xl p-6">
        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-3 text-lg font-medium">Backend health</h2>
          {isLoading && <p className="text-slate-400">Checking API...</p>}
          {error && <p className="text-red-400">Unable to reach API: {(error as Error).message}</p>}
          {data && (
            <div className="space-y-2 text-sm">
              <div><span className="text-slate-400">Status:</span> <span className="text-emerald-400">{data.status}</span></div>
              <div><span className="text-slate-400">Service:</span> {data.service}</div>
              <div><span className="text-slate-400">Version:</span> {data.version}</div>
              <div><span className="text-slate-400">Database:</span> {data.checks.database}</div>
              <div><span className="text-slate-400">Timestamp:</span> {data.timestamp}</div>
            </div>
          )}
        </section>
        <Outlet />
      </main>
    </div>
  );
}
