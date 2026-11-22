import { systemStatusSchema, type ProviderId, type SystemStatus } from "@markethub/contracts";

function extractErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `Status request failed (${status})`;
}

export async function fetchSystemStatus(): Promise<SystemStatus> {
  const res = await fetch("/api/status", { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new Error(`Status request failed (${res.status})`);
    throw new Error("Received invalid status response from backend");
  }

  if (!res.ok) {
    throw new Error(extractErrorMessage(json, res.status));
  }

  const parsed = systemStatusSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Received invalid status response from backend");
  }
  return parsed.data;
}

export interface ProviderStatusView {
  id: ProviderId;
  enabled: boolean;
  authState: string;
  streamingState: string;
  validatedAt: string | null;
  expiresAt: string | null;
  expiryKnown: boolean;
  restrictions: string[];
  error: string | null;
}

export interface ProvidersStatusResponse {
  providers: Record<"UPSTOX" | "FYERS", ProviderStatusView> | null;
  localManagement: boolean;
  note: string;
}

export async function fetchProvidersStatus(): Promise<ProvidersStatusResponse> {
  const res = await fetch("/api/providers/status", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Provider status request failed (${res.status})`);
  return (await res.json()) as ProvidersStatusResponse;
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
