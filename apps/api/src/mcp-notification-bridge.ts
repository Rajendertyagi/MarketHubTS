import type { ServerNotifier } from "@modelcontextprotocol/server";
import type { MarketDataService } from "@markethub/market-core";

/** Stable MCP resource URI that the M6-D bridge publishes as a change signal. */
export const MARKET_SNAPSHOT_URI = "markethub://market/snapshot";

export interface McpNotificationBridge {
  /** Subscribe once to the canonical source. Idempotent. */
  start(): void;
  /** Unsubscribe. Idempotent; never mutates canonical state or hub history. */
  stop(): void;
}

/**
 * One process-lifetime bridge from the canonical MarketDataService change stream
 * to the SDK-owned MCP notifier. Every LiveChangeEvent variant changes or
 * invalidates the live snapshot, so each maps to a single resourceUpdated signal
 * for the stable snapshot URI. Notifications carry no market payload.
 *
 * Publisher/diagnostic failures are contained: they are reported through the
 * best-effort callback and never escape into LiveStateStore or affect a
 * canonical mutation.
 */
export function createMcpNotificationBridge(
  service: MarketDataService,
  notifier: Pick<ServerNotifier, "resourceUpdated">,
  onError?: (error: unknown) => void
): McpNotificationBridge {
  let unsubscribe: (() => void) | null = null;

  const report = (error: unknown): void => {
    try { onError?.(error); } catch { /* diagnostics are best-effort */ }
  };

  return {
    start(): void {
      if (unsubscribe) return;
      unsubscribe = service.subscribe(() => {
        try {
          notifier.resourceUpdated(MARKET_SNAPSHOT_URI);
        } catch (error) {
          report(error);
        }
      });
    },
    stop(): void {
      const current = unsubscribe;
      unsubscribe = null;
      if (!current) return;
      try { current(); } catch (error) { report(error); }
    }
  };
}
