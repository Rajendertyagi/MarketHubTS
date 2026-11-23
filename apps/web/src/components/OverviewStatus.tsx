import { StatusBadge } from "./StatusBadge";

type RowTone = "ok" | "warn" | "error" | "neutral";

type StatusRow = {
  label: string;
  badge: string;
  tone: RowTone;
  note?: string;
};

/**
 * Presentational Overview capability/status list.
 *
 * This component deliberately makes no claims that a capability is live or
 * accepted. It only reflects what is implemented in the local foundation and
 * the single runtime fact supplied by the caller (whether the MCP HTTP handler
 * is mounted). No fetch, hooks, router or React Query usage belongs here.
 */
export function OverviewStatus({ mcpHttpHandlerMounted }: { mcpHttpHandlerMounted: boolean }) {
  const rows: StatusRow[] = [
    { label: "Runtime & config", badge: "Implemented", tone: "ok" },
    { label: "SQLite & migrations", badge: "Implemented", tone: "ok" },
    { label: "API health/readiness", badge: "Implemented", tone: "ok" },
    { label: "WebUI shell", badge: "Implemented", tone: "ok" },
    {
      label: "Provider management / authentication / status",
      badge: "Implemented foundation",
      tone: "ok",
      note: "Provider management, authentication and status reporting exist. This does not mean credentials are configured, a broker is connected, or a live feed has been verified."
    },
    {
      label: "Live market-data feed",
      badge: "Locked / not activated",
      tone: "neutral",
      note: "Production streaming drivers remain locked; no real provider sockets or live feed are active."
    },
    {
      label: "Catalog search and instrument picker",
      badge: "Implemented; catalog population incomplete",
      tone: "neutral",
      note: "Search and the reusable instrument picker exist, but the full NSE/BSE instrument and derivative catalog is not populated."
    },
    {
      label: "Historical and snapshot persistence",
      badge: "Implemented offline; provider-backed retrieval inactive",
      tone: "neutral",
      note: "Offline candle and snapshot persistence, API and UI exist. Provider-backed historical and option-chain retrieval is inactive in the normal application composition; no live broker data is fetched."
    },
    {
      label: "MCP HTTP handler",
      badge: mcpHttpHandlerMounted ? "Mounted" : "Not mounted",
      tone: mcpHttpHandlerMounted ? "ok" : "neutral",
      note: "This reflects only whether the MCP HTTP handler is mounted. It is not evidence that M6-D/E notification/client conformance has been accepted or that HTTP integration acceptance has passed."
    },
    {
      label: "M6-D/E notification / client conformance",
      badge: "Not accepted",
      tone: "neutral",
      note: "Source and tests are present on develop, but completion is unverified; the phases are neither accepted nor complete."
    },
    {
      label: "Alerts and scanners",
      badge: "Not implemented",
      tone: "neutral"
    }
  ];

  return (
    <ul className="space-y-2 text-sm text-slate-300">
      {rows.map((row) => (
        <li key={row.label} className="border-b border-slate-800/80 pb-2 last:border-b-0 last:pb-0">
          <div className="flex items-center justify-between gap-3">
            <span>{row.label}</span>
            <StatusBadge label={row.badge} tone={row.tone} />
          </div>
          {row.note && <p className="mt-1 text-xs text-slate-400">{row.note}</p>}
        </li>
      ))}
    </ul>
  );
}
