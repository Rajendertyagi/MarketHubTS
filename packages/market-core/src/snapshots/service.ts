import type {
  CatalogWriteGuard, OptionChainCaptureConfig, OptionChainSnapshot,
  OptionChainSnapshotEnvelope, ProviderId
} from "@markethub/contracts";
import type { RetentionReader } from "../historical/service";
import {
  decodeSnapshotCursor, encodeSnapshotCursor,
  type SnapshotPageResult, type SnapshotPageSelector
} from "./page";

/** Structural seam — market-core never imports the database package. */
export interface SnapshotStore {
  putCaptureConfig(config: OptionChainCaptureConfig): void;
  getCaptureConfig(id: string): OptionChainCaptureConfig | null;
  listCaptureConfigs(): OptionChainCaptureConfig[];
  deleteCaptureConfig(id: string): void;
  putSnapshot(snapshot: OptionChainSnapshot): boolean;
  getSnapshot(id: string): OptionChainSnapshot | null;
  listSnapshots(configId?: string, fromMs?: number, toMs?: number): OptionChainSnapshot[];
  /** Newest-first bounded page; returns limit + 1 rows for lookahead. */
  listSnapshotsPage(filter: {
    selector: SnapshotPageSelector;
    limit: number;
    afterCapturedAt?: string;
    afterId?: string;
  }): OptionChainSnapshot[];
}

export interface OptionChainRequest {
  underlyingCanonicalId: string;
  expiryDate: string;
  provider?: ProviderId;
  strikeRangeJson?: string | null;
  /** Provider-native identifier/hint resolved from catalog mappings by the caller. */
  nativeIdentifier?: string;
}

/** Provider seam implemented by broker adapters; no apps/api imports. */
export interface OptionChainProvider {
  readonly id: ProviderId;
  fetchOptionChain(request: OptionChainRequest): Promise<OptionChainSnapshotEnvelope>;
}

export interface SnapshotServiceOptions {
  snapshots: SnapshotStore;
  settings: RetentionReader;
  providers: OptionChainProvider[];
  now?: () => number;
  /** G0-C: optional injected write guard for background skip/retry (§7 #26). */
  writeGuard?: CatalogWriteGuard;
}

export interface CaptureResult {
  snapshot: OptionChainSnapshot | null;
  error: string | null;
  /** G0-C #26: true when the scheduled cycle was skipped because refresh owns
   * the write permit. No DB mutation, no success status, retry on next tick. */
  skipped?: boolean;
  reason?: "CATALOG_WRITE_BUSY";
  retryable?: boolean;
}

export class OptionChainSnapshotService {
  private readonly now: () => number;
  constructor(private readonly options: SnapshotServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  putCaptureConfig(config: OptionChainCaptureConfig): void {
    this.options.snapshots.putCaptureConfig(config);
  }

  getCaptureConfig(id: string): OptionChainCaptureConfig | null {
    return this.options.snapshots.getCaptureConfig(id);
  }

  listCaptureConfigs(): OptionChainCaptureConfig[] {
    return this.options.snapshots.listCaptureConfigs();
  }

  deleteCaptureConfig(id: string): void {
    this.options.snapshots.deleteCaptureConfig(id); // snapshots retained (config_id nulled)
  }

  listSnapshots(configId?: string, fromMs?: number, toMs?: number): OptionChainSnapshot[] {
    return this.options.snapshots.listSnapshots(configId, fromMs, toMs);
  }

  /**
   * B3: newest-first bounded page over an explicit selector. The cursor is
   * opaque end-to-end; only this method decodes/encodes it. Config existence is
   * checked through the existing getCaptureConfig lookup so an unknown config
   * is a genuine not-found, distinct from a valid config with an empty page.
   */
  listSnapshotsPage(req: { selector: SnapshotPageSelector; limit: number; cursor?: string }): SnapshotPageResult {
    const limit = Math.max(1, Math.min(Math.trunc(req.limit), 100));
    if (req.selector.kind === "config" && this.getCaptureConfig(req.selector.configId) === null) {
      return { ok: false, reason: "unknown_config", message: "Unknown capture configuration" };
    }

    let after: { capturedAt: string; id: string } | undefined;
    if (req.cursor !== undefined && req.cursor !== "first") {
      const decoded = decodeSnapshotCursor(req.cursor, req.selector);
      if (decoded === null) {
        return { ok: false, reason: "invalid_cursor", message: "Invalid snapshot page cursor" };
      }
      after = decoded;
    }

    const rows = this.options.snapshots.listSnapshotsPage({
      selector: req.selector,
      limit,
      ...(after !== undefined ? { afterCapturedAt: after.capturedAt, afterId: after.id } : {})
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last !== undefined
      ? encodeSnapshotCursor({ c: last.capturedAt, i: last.id, s: req.selector })
      : null;
    return { ok: true, snapshots: page, nextCursor };
  }

  getSnapshot(id: string): OptionChainSnapshot | null {
    return this.options.snapshots.getSnapshot(id);
  }

  /**
   * On-demand capture. Takes an explicit request and NEVER reads or writes
   * option_chain_capture_configs. The result is stored with configId = null.
   */
  async captureOnDemand(request: OptionChainRequest): Promise<CaptureResult> {
    return this.capture(request, null);
  }

  /** Scheduled/manual capture through a saved config reads that config. */
  async captureScheduled(config: OptionChainCaptureConfig): Promise<CaptureResult> {
    // G0-C #26: background capture skips (never queues, never claims success)
    // when the refresh owns the write permit; the scheduler retries next tick.
    if (this.options.writeGuard?.assertWritable("B") === "SKIP") {
      return {
        snapshot: null, error: "CATALOG_WRITE_BUSY",
        skipped: true, reason: "CATALOG_WRITE_BUSY", retryable: true
      };
    }
    if (!config.captureEnabled) return { snapshot: null, error: "capture disabled" };
    return this.capture({
      underlyingCanonicalId: config.underlyingCanonicalId,
      expiryDate: config.expiryDate,
      provider: config.provider,
      strikeRangeJson: config.strikeRangeJson
    }, config.id);
  }

  private async capture(request: OptionChainRequest, configId: string | null): Promise<CaptureResult> {
    const providers = request.provider
      ? this.options.providers.filter((p) => p.id === request.provider)
      : this.options.providers;
    let lastError: string | null = null;
    for (const provider of providers) {
      try {
        const envelope = await provider.fetchOptionChain(request);
        const capturedAt = new Date(this.now()).toISOString();
        const snapshot: OptionChainSnapshot = {
          id: crypto.randomUUID(),
          configId,
          capturedAt,
          provider: provider.id,
          envelope: { ...envelope, capturedAt }, // local capture time is authoritative
          provenance: { source: "provider-feed", provider: provider.id, receivedAt: capturedAt }
        };
        if (!this.options.snapshots.putSnapshot(snapshot)) {
          // Collision on the unique id — regenerate once rather than surface a 500.
          snapshot.id = crypto.randomUUID();
          if (!this.options.snapshots.putSnapshot(snapshot)) {
            return { snapshot: null, error: "snapshot_id_collision" };
          }
        }
        return { snapshot, error: null };
      } catch (error) {
        // Try next configured provider; report sanitized error if none succeed.
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { snapshot: null, error: (lastError ?? "no provider available").slice(0, 300) };
  }
}
