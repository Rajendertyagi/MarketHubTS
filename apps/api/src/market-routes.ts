import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  apiErrorSchema,
  liveSnapshotSchema,
  subscriptionReplaceRequestSchema,
  subscriptionStateViewSchema,
  type SubscriptionSelection,
  type SubscriptionStateView
} from "@markethub/contracts";
import type { MarketDataService } from "@markethub/market-core";
import type { LiveEventHub } from "@markethub/realtime";
import { isLocalPeer } from "./lib/net";
import {
  SubscriptionPersistenceError, SubscriptionValidationError,
  type StreamSupervisor
} from "./stream-supervisor";
import type { SubscriptionCoordinator } from "./subscription-coordinator";

/** Either the standalone supervisor or the shared coordinator can own the view. */
export interface SubscriptionStatePort {
  getView(): SubscriptionStateView;
  replaceSubscriptions(selections: SubscriptionSelection[]): Promise<{ view: SubscriptionStateView }>;
}

export interface MarketRouteDependencies {
  service: MarketDataService;
  hub: LiveEventHub;
  supervisor?: StreamSupervisor | undefined;
  coordinator?: SubscriptionCoordinator | undefined;
}

function subscriptionPort(deps: MarketRouteDependencies): SubscriptionStatePort {
  if (deps.coordinator) {
    const coordinator = deps.coordinator;
    return {
      getView: () => coordinator.getView(),
      replaceSubscriptions: async (selections) => ({ view: await coordinator.replaceSubscriptions(selections) })
    };
  }
  const supervisor = deps.supervisor!;
  return {
    getView: () => supervisor.getView(),
    replaceSubscriptions: async (selections) => ({ view: (await supervisor.replaceSubscriptions(selections)).view })
  };
}

/** REST/SSE consumers of the one canonical market-data service. No market logic here. */
export function registerMarketRoutes(app: Hono, deps: MarketRouteDependencies): void {
  app.get("/api/market/snapshot", (c) => {
    return c.json(liveSnapshotSchema.parse(deps.service.getSnapshot()));
  });

  app.get("/api/market/stream", (c) => {
    // Last-Event-ID is authoritative when present (including empty-but-present).
    const lastEventId = c.req.header("Last-Event-ID");
    const since = c.req.query("since");
    return streamSSE(c, async (stream) => {
      const result = deps.hub.openStream({ lastEventId, since });
      if (result.outcome === "snapshot-required") {
        await stream.writeSSE({
          event: "snapshot-required",
          data: JSON.stringify({ type: "snapshot-required", reason: result.reason })
        });
        return;
      }
      const session = result.session;
      stream.onAbort(() => deps.hub.closeSession(session));
      try {
        while (true) {
          const event = await session.next();
          if (event === null) break;
          await stream.writeSSE({
            event: event.event,
            ...(event.id !== undefined ? { id: event.id } : {}),
            data: JSON.stringify(event.data)
          });
        }
      } finally {
        deps.hub.closeSession(session);
      }
    });
  });

  app.get("/api/market/subscriptions", (c) => {
    return c.json(subscriptionStateViewSchema.parse(subscriptionPort(deps).getView()));
  });

  app.put("/api/market/subscriptions", async (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Subscription management is local-owner only" }), 403);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = subscriptionReplaceRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(apiErrorSchema.parse({ error: "invalid_request", message: "Invalid subscription payload" }), 400);
    }
    try {
      const result = await subscriptionPort(deps).replaceSubscriptions(parsed.data.selections);
      // The view exposes committed generation/selections separately from
      // runtime status (including any post-commit reconciliation error).
      return c.json(subscriptionStateViewSchema.parse(result.view));
    } catch (error) {
      if (error instanceof SubscriptionValidationError) {
        return c.json(apiErrorSchema.parse({ error: "invalid_request", message: error.message }), 400);
      }
      if (error instanceof SubscriptionPersistenceError) {
        return c.json(apiErrorSchema.parse({ error: "persistence_failed", message: error.message }), 500);
      }
      return c.json(apiErrorSchema.parse({ error: "internal_error", message: "An unexpected error occurred" }), 500);
    }
  });
}
