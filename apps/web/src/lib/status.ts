import type { SystemStatus } from "@markethub/contracts";

export async function fetchSystemStatus(): Promise<SystemStatus> {
  const res = await fetch("/api/status", { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const message =
      json && typeof json === "object" && json !== null && "message" in json && typeof (json as any).message === "string"
        ? (json as any).message
        : `Status request failed (${res.status})`;
    throw new Error(message);
  }
  return json as SystemStatus;
}

export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
