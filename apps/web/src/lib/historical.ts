import {
  candleGapSchema,
  candleRangeNoteSchema,
  historicalCandleSchema,
  historicalSyncConfigSchema,
  retentionCleanupResultSchema,
  retentionSettingsSchema,
  retentionSettingsViewSchema,
  type CandleGap,
  type CandleRangeNote,
  type CandleRangeRequest,
  type HistoricalCandle,
  type HistoricalSyncConfig,
  type RetentionCleanupResult,
  type RetentionSettings,
  type RetentionSettingsView
} from "@markethub/contracts";

export type HistoricalErrorKind = "forbidden" | "validation" | "unavailable" | "internal";

export class HistoricalHttpError extends Error {
  constructor(readonly kind: HistoricalErrorKind, message: string) {
    super(message);
    this.name = "HistoricalHttpError";
  }
}

function classify(status: number): HistoricalErrorKind {
  if (status === 403) return "forbidden";
  if (status === 400) return "validation";
  if (status === 422) return "unavailable";
  return "internal";
}

function messageOf(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `Historical request failed (${status})`;
}

async function readPayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function rangeQuery(request: CandleRangeRequest): string {
  const params = new URLSearchParams({
    canonicalId: request.canonicalId,
    interval: request.interval,
    from: String(request.fromMs),
    to: String(request.toMs)
  });
  return params.toString();
}

export interface CachedCandlesResult {
  candles: HistoricalCandle[];
}

export async function fetchCachedCandles(request: CandleRangeRequest): Promise<CachedCandlesResult> {
  const response = await fetch(`/api/historical/candles?${rangeQuery(request)}`, { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  const candles = (payload as { candles?: unknown }).candles;
  if (!Array.isArray(candles)) throw new HistoricalHttpError("internal", "Invalid candles payload");
  return { candles: candles.map((c) => historicalCandleSchema.parse(c) as HistoricalCandle) };
}

export interface CoverageResult {
  gaps: CandleGap[];
  basis: string | null;
  confirmed: false;
  /** Authoritative permanent restrictions for the requested window. */
  unavailableNotes: CandleRangeNote[];
}

export async function fetchCoverage(request: CandleRangeRequest): Promise<CoverageResult> {
  const response = await fetch(`/api/historical/coverage?${rangeQuery(request)}`, { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  const p = payload as { gaps?: unknown; basis?: unknown; unavailableNotes?: unknown };
  if (!Array.isArray(p.gaps)) throw new HistoricalHttpError("internal", "Invalid coverage payload");
  const notes = Array.isArray(p.unavailableNotes) ? p.unavailableNotes : [];
  return {
    gaps: p.gaps.map((g) => candleGapSchema.parse(g) as CandleGap),
    basis: typeof p.basis === "string" ? p.basis : null,
    confirmed: false,
    unavailableNotes: notes.map((n) => candleRangeNoteSchema.parse(n) as CandleRangeNote)
  };
}

export async function fetchSyncConfigs(): Promise<HistoricalSyncConfig[]> {
  const response = await fetch("/api/historical/sync-configs", { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  const configs = (payload as { configs?: unknown }).configs;
  if (!Array.isArray(configs)) throw new HistoricalHttpError("internal", "Invalid sync config payload");
  return configs.map((c) => historicalSyncConfigSchema.parse(c) as HistoricalSyncConfig);
}

export async function saveSyncConfig(config: HistoricalSyncConfig): Promise<HistoricalSyncConfig> {
  const response = await fetch("/api/historical/sync-configs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(historicalSyncConfigSchema.parse(config))
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  return historicalSyncConfigSchema.parse((payload as { config?: unknown }).config) as HistoricalSyncConfig;
}

export async function deleteSyncConfig(id: string): Promise<void> {
  const response = await fetch(`/api/historical/sync-configs/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Accept: "application/json" } });
  if (!response.ok) {
    const payload = await readPayload(response);
    throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  }
}

export async function fetchRetention(): Promise<RetentionSettingsView> {
  const response = await fetch("/api/retention", { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  return retentionSettingsViewSchema.parse(payload);
}

export async function saveRetention(settings: RetentionSettings): Promise<RetentionSettingsView> {
  const response = await fetch("/api/retention", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(retentionSettingsSchema.parse(settings))
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  return retentionSettingsViewSchema.parse(payload);
}

export async function runRetentionCleanup(): Promise<RetentionCleanupResult> {
  const response = await fetch("/api/retention/cleanup", { method: "POST", headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  return retentionCleanupResultSchema.parse(payload);
}
