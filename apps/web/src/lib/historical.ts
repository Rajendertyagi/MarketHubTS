import {
  candleGapSchema,
  historicalCandleSchema,
  historicalSyncConfigSchema,
  retentionSettingsSchema,
  type CandleGap,
  type CandleRangeRequest,
  type HistoricalCandle,
  type HistoricalSyncConfig,
  type RetentionSettings
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
}

export async function fetchCoverage(request: CandleRangeRequest): Promise<CoverageResult> {
  const response = await fetch(`/api/historical/coverage?${rangeQuery(request)}`, { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  const gaps = (payload as { gaps?: unknown }).gaps;
  if (!Array.isArray(gaps)) throw new HistoricalHttpError("internal", "Invalid coverage payload");
  return { gaps: gaps.map((g) => candleGapSchema.parse(g) as CandleGap), basis: (payload as { basis?: string | null }).basis ?? null, confirmed: false };
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

export interface RetentionView {
  settings: RetentionSettings | null;
  valid: boolean;
  error: string | null;
}

export async function fetchRetention(): Promise<RetentionView> {
  const response = await fetch("/api/retention", { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  const p = payload as { settings?: unknown; valid?: unknown; error?: unknown };
  return {
    settings: p.settings ? retentionSettingsSchema.parse(p.settings) : null,
    valid: p.valid === true,
    error: typeof p.error === "string" ? p.error : null
  };
}

export async function saveRetention(settings: RetentionSettings): Promise<RetentionView> {
  const response = await fetch("/api/retention", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(retentionSettingsSchema.parse(settings))
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  const p = payload as { settings?: unknown };
  return { settings: retentionSettingsSchema.parse(p.settings), valid: true, error: null };
}

export interface RetentionCleanupResult {
  ran: boolean;
  reason: string | null;
  candlesDeleted: number;
  snapshotsDeleted: number;
}

export async function runRetentionCleanup(): Promise<RetentionCleanupResult> {
  const response = await fetch("/api/retention/cleanup", { method: "POST", headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new HistoricalHttpError(classify(response.status), messageOf(payload, response.status));
  const p = payload as RetentionCleanupResult;
  return { ran: p.ran === true, reason: p.reason ?? null, candlesDeleted: p.candlesDeleted ?? 0, snapshotsDeleted: p.snapshotsDeleted ?? 0 };
}
