import type {
  OptionChainCaptureConfig, OptionChainSnapshot, OptionChainSnapshotEnvelope, ProviderId
} from "@markethub/contracts";
import type { RetentionReader } from "../historical/service";

/** Structural seam — market-core never imports the database package. */
export interface SnapshotStore {
  putCaptureConfig(config: OptionChainCaptureConfig): void;
  getCaptureConfig(id: string): OptionChainCaptureConfig | null;
  listCaptureConfigs(): OptionChainCaptureConfig[];
  deleteCaptureConfig(id: string): void;
  putSnapshot(snapshot: OptionChainSnapshot): void;
  getSnapshot(id: string): OptionChainSnapshot | null;
  listSnapshots(configId?: string, fromMs?: number, toMs?: number): OptionChainSnapshot[];
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
}

export interface CaptureResult {
  snapshot: OptionChainSnapshot | null;
  error: string | null;
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
          id: `snap-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
          configId,
          capturedAt,
          provider: provider.id,
          envelope: { ...envelope, capturedAt }, // local capture time is authoritative
          provenance: { source: "provider-feed", provider: provider.id, receivedAt: capturedAt }
        };
        this.options.snapshots.putSnapshot(snapshot);
        return { snapshot, error: null };
      } catch (error) {
        // Try next configured provider; report sanitized error if none succeed.
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { snapshot: null, error: (lastError ?? "no provider available").slice(0, 300) };
  }
}
