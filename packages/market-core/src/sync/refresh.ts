import { istDateString, type ProviderId } from "@markethub/contracts";
import type { CatalogRepository } from "../types";
import { CatalogSyncService } from "./apply";
import { buildFyersImport, FYERS_MASTER_URLS, FYERS_SOURCE, type FyersMasterSegment } from "./fyers-master";
import { buildUpstoxImport, UPSTOX_MASTER_URL, UPSTOX_SOURCE } from "./upstox-master";

const FETCH_TIMEOUT_MS = 20_000;
const PROVIDERS: ProviderId[] = ["UPSTOX", "FYERS"];
/** Small app-owned daily trigger: 30 minutes, well inside the 15–60 min range. */
const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export interface CatalogRefreshEvent {
  provider: ProviderId;
  outcome: "SKIPPED" | "REFRESHED" | "FAILED" | "DIAGNOSTIC";
  reason?: string;
  status?: string;
  counts?: Record<string, number>;
}

export type MasterFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CatalogMasterRefreshOptions {
  catalog: CatalogRepository;
  sync: CatalogSyncService;
  now?: (() => Date) | undefined;
  fetch?: MasterFetch | undefined;
  onEvent?: ((event: CatalogRefreshEvent) => void) | undefined;
  /** Interval for the in-process daily trigger. Defaults to 30 minutes. */
  refreshIntervalMs?: number | undefined;
}

/**
 * App-owned, single-flight, at-most-once-per-India-market-date refresh of the
 * public provider master files. No credentials, no generic scheduler, no queue.
 * Failures keep the last successfully imported catalogue.
 */
export class CatalogMasterRefresh {
  private readonly catalog: CatalogRepository;
  private readonly sync: CatalogSyncService;
  private readonly now: () => Date;
  private readonly fetchFn: MasterFetch;
  private readonly onEvent: ((event: CatalogRefreshEvent) => void) | undefined;
  private readonly refreshIntervalMs: number;
  private readonly inFlight = new Map<ProviderId, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: CatalogMasterRefreshOptions) {
    this.catalog = options.catalog;
    this.sync = options.sync;
    this.now = options.now ?? (() => new Date());
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.onEvent = options.onEvent;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  /**
   * Non-blocking: starts the single app-owned daily trigger (once) and fires
   * an immediate refresh attempt for each provider.
   */
  startIfNeeded(): void {
    if (this.stopped) return;
    this.ensureTimer();
    for (const provider of PROVIDERS) void this.refreshProvider(provider);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One small in-process timer; every tick reuses the same single-flight path. */
  private ensureTimer(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      for (const provider of PROVIDERS) void this.refreshProvider(provider);
    }, this.refreshIntervalMs);
    // Do not keep the process alive solely for this diagnostic refresh.
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  private async refreshProvider(provider: ProviderId): Promise<void> {
    if (this.stopped || this.inFlight.has(provider)) return;
    const task = this.doRefresh(provider).finally(() => this.inFlight.delete(provider));
    this.inFlight.set(provider, task);
    await task;
  }

  private async doRefresh(provider: ProviderId): Promise<void> {
    const today = istDateString(this.now().getTime());
    try {
      const runs = await this.catalog.listSyncRuns({ provider, status: "COMPLETED", limit: 1 });
      const last = runs[0];
      if (last) {
        const lastDate = istDateString(Date.parse(last.finishedAt ?? last.startedAt));
        if (lastDate === today) {
          this.emit({ provider, outcome: "SKIPPED", reason: "ALREADY_REFRESHED_TODAY" });
          return;
        }
      }
    } catch (e) {
      // A freshness lookup failure is diagnostic only: it is not positive
      // evidence of a successful refresh today, so still attempt the refresh.
      this.emit({ provider, outcome: "DIAGNOSTIC", reason: "FRESHNESS_LOOKUP_FAILED" });
    }

    const nowIso = this.now().toISOString();
    try {
      if (provider === "UPSTOX") {
        const text = await this.download(UPSTOX_MASTER_URL);
        const rows = JSON.parse(text) as unknown;
        const { batch, reconciliation } = buildUpstoxImport(rows, {
          now: nowIso,
          sourceVersion: await sha256(text),
          sourceObservedAt: nowIso
        });
        const result = await this.sync.applyCompleteProviderSnapshot(batch, reconciliation);
        this.emit({ provider, outcome: result.status === "COMPLETED" ? "REFRESHED" : "FAILED", status: result.status, counts: result.counts });
      } else {
        const entries = await Promise.all(
          (Object.keys(FYERS_MASTER_URLS) as FyersMasterSegment[]).map(async (segment) => {
            const text = await this.download(FYERS_MASTER_URLS[segment]);
            return [segment, JSON.parse(text) as unknown] as const;
          })
        );
        const files = Object.fromEntries(entries) as Record<FyersMasterSegment, unknown>;
        const { batch, reconciliation } = buildFyersImport(files, {
          now: nowIso,
          sourceVersion: await sha256(JSON.stringify(files)),
          sourceObservedAt: nowIso
        });
        const result = await this.sync.applyCompleteProviderSnapshot(batch, reconciliation);
        this.emit({ provider, outcome: result.status === "COMPLETED" ? "REFRESHED" : "FAILED", status: result.status, counts: result.counts });
      }
    } catch (e) {
      // Keep last-known-good data. Record a concise failure run without tokens/raw files.
      const message = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
      try {
        await this.catalog.recordSyncRun?.({
          runId: crypto.randomUUID(),
          source: provider === "UPSTOX" ? UPSTOX_SOURCE : FYERS_SOURCE,
          provider,
          scopeJson: JSON.stringify({ source: provider === "UPSTOX" ? UPSTOX_SOURCE : FYERS_SOURCE }),
          completeness: "COMPLETE",
          status: "FAILED",
          startedAt: nowIso,
          finishedAt: this.now().toISOString(),
          countsJson: JSON.stringify({}),
          conflictsJson: JSON.stringify([{ type: "REFRESH_FAILED", severity: "ERROR", message }]),
          error: message
        });
      } catch {
        // best effort
      }
      this.emit({ provider, outcome: "FAILED", reason: message });
    }
  }

  private async download(url: string): Promise<string> {
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Master download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("Master download was empty");
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      return await new Response(stream).text();
    }
    return new TextDecoder().decode(bytes);
  }

  private emit(event: CatalogRefreshEvent): void {
    try { this.onEvent?.(event); } catch { /* diagnostics must not affect refresh */ }
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
