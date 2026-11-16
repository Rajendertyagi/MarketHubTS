import type {
  LiveItem,
  LiveSnapshot,
  LiveStateOptions,
  ProviderConnectionState,
  ProviderConnectionStatus,
  ProviderId,
  SelectedObservation
} from "@markethub/contracts";
import { normalizeObservation, type NormalizeObservationInput } from "./normalize";
import { LiveStateStore } from "./store";

/** Single canonical market-data service facade for all future consumers. */
export class MarketDataService {
  private readonly store: LiveStateStore;

  constructor(options: LiveStateOptions) {
    this.store = new LiveStateStore(options);
  }

  get revision(): number {
    return this.store.revision;
  }

  track(canonicalId: string, pinned = false): void {
    this.store.track(canonicalId, pinned);
  }

  untrack(canonicalId: string): boolean {
    return this.store.untrack(canonicalId);
  }

  applyProviderUpdate(input: NormalizeObservationInput): void {
    this.store.applyObservation(normalizeObservation(input));
  }

  setProviderConnection(provider: ProviderId, state: ProviderConnectionState, error: string | null = null): void {
    this.store.setConnectionState(provider, state, error);
  }

  getConnectionStatus(provider: ProviderId): ProviderConnectionStatus | undefined {
    return this.store.getConnectionStatus(provider);
  }

  allConnectionStatuses(): ProviderConnectionStatus[] {
    return this.store.allConnectionStatuses();
  }

  getItem(canonicalId: string): LiveItem | undefined {
    return this.store.getItem(canonicalId);
  }

  getSelected(canonicalId: string): SelectedObservation | undefined {
    return this.store.getItem(canonicalId)?.selected;
  }

  getSnapshot(): LiveSnapshot {
    return this.store.getSnapshot();
  }
}
