import {
  optionChainCaptureConfigSchema,
  optionChainSnapshotSchema,
  type OptionChainCaptureConfig,
  type OptionChainSnapshot
} from "@markethub/contracts";

export type SnapshotErrorKind = "forbidden" | "validation" | "unavailable" | "not-found" | "internal";

export class SnapshotHttpError extends Error {
  constructor(readonly kind: SnapshotErrorKind, message: string) {
    super(message);
    this.name = "SnapshotHttpError";
  }
}

function classify(status: number): SnapshotErrorKind {
  if (status === 403) return "forbidden";
  if (status === 400) return "validation";
  if (status === 404) return "not-found";
  if (status === 422) return "unavailable";
  return "internal";
}

function messageOf(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `Snapshot request failed (${status})`;
}

async function readPayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export async function fetchSnapshots(filter: { configId?: string; from?: number; to?: number } = {}): Promise<OptionChainSnapshot[]> {
  const params = new URLSearchParams();
  if (filter.configId) params.set("configId", filter.configId);
  if (filter.from !== undefined) params.set("from", String(filter.from));
  if (filter.to !== undefined) params.set("to", String(filter.to));
  const query = params.toString();
  const response = await fetch(`/api/snapshots${query ? `?${query}` : ""}`, { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new SnapshotHttpError(classify(response.status), messageOf(payload, response.status));
  const snapshots = (payload as { snapshots?: unknown }).snapshots;
  if (!Array.isArray(snapshots)) throw new SnapshotHttpError("internal", "Invalid snapshots payload");
  return snapshots.map((s) => optionChainSnapshotSchema.parse(s) as OptionChainSnapshot);
}

export async function fetchSnapshot(id: string): Promise<OptionChainSnapshot> {
  const response = await fetch(`/api/snapshots/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new SnapshotHttpError(classify(response.status), messageOf(payload, response.status));
  return optionChainSnapshotSchema.parse((payload as { snapshot?: unknown }).snapshot) as OptionChainSnapshot;
}

export async function fetchCaptureConfigs(): Promise<OptionChainCaptureConfig[]> {
  const response = await fetch("/api/snapshots/configs", { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new SnapshotHttpError(classify(response.status), messageOf(payload, response.status));
  const configs = (payload as { configs?: unknown }).configs;
  if (!Array.isArray(configs)) throw new SnapshotHttpError("internal", "Invalid capture config payload");
  return configs.map((c) => optionChainCaptureConfigSchema.parse(c) as OptionChainCaptureConfig);
}

export async function saveCaptureConfig(config: OptionChainCaptureConfig): Promise<OptionChainCaptureConfig> {
  const response = await fetch("/api/snapshots/configs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(optionChainCaptureConfigSchema.parse(config))
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new SnapshotHttpError(classify(response.status), messageOf(payload, response.status));
  return optionChainCaptureConfigSchema.parse((payload as { config?: unknown }).config) as OptionChainCaptureConfig;
}

export async function deleteCaptureConfig(id: string): Promise<void> {
  const response = await fetch(`/api/snapshots/configs/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Accept: "application/json" } });
  if (!response.ok) {
    const payload = await readPayload(response);
    throw new SnapshotHttpError(classify(response.status), messageOf(payload, response.status));
  }
}

export interface CaptureRequest {
  underlyingCanonicalId: string;
  expiryDate: string;
  provider?: "UPSTOX" | "FYERS";
  strikeRangeJson?: string | null;
  nativeIdentifier?: string;
}

export async function captureSnapshot(request: CaptureRequest): Promise<OptionChainSnapshot> {
  const response = await fetch("/api/snapshots/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(request)
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new SnapshotHttpError(classify(response.status), messageOf(payload, response.status));
  return optionChainSnapshotSchema.parse((payload as { snapshot?: unknown }).snapshot) as OptionChainSnapshot;
}
