import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { afterEach, describe, expect, test } from "bun:test";
import { subscriptionStateViewSchema, type SubscriptionStateView } from "../../packages/contracts/src/index";
import { SubscriptionPanel } from "../../apps/web/src/components/SubscriptionPanel";
import { useLiveStore } from "../../apps/web/src/store/live-store";
import {
  fetchSubscriptions, replaceSubscriptions, SubscriptionHttpError
} from "../../apps/web/src/lib/subscriptions";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  useLiveStore.getState().reset();
});

function view(generation: number, lastError: string | null = null): SubscriptionStateView {
  return {
    selections: [{ canonicalId: "A", enabled: true }],
    generation,
    runtime: {
      generation, connectionState: "NOT_STARTED", resolutions: [], lastError
    }
  };
}

function renderPanelWith(subscriptionView: SubscriptionStateView): string {
  // Zustand 5 uses getInitialState() as the useSyncExternalStore server
  // snapshot, so static rendering reads the initial state rather than the
  // live state. Seed it temporarily and restore it afterwards. This relies on
  // that v5 invariant; if it changes, these SSR render tests must be revisited.
  const initial = useLiveStore.getInitialState();
  const previousInitial = { ...initial };
  initial.subscriptions = subscriptionView;
  try {
    return renderToStaticMarkup(createElement(SubscriptionPanel, {}) as never);
  } finally {
    Object.assign(initial, previousInitial);
  }
}

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
}

describe("subscription client", () => {
  test("panel renders the instrument picker, not a manual canonical-ID input", () => {
    const html = renderToStaticMarkup(createElement(SubscriptionPanel, {}) as never);
    expect(html).toContain("picker-value");
    expect(html).not.toContain('aria-label="Canonical instrument ID"');
  });

  test("GET validates the view with the contracts schema", async () => {
    fakeFetch(() => ({ status: 200, body: view(1) }));
    const result = await fetchSubscriptions();
    expect(subscriptionStateViewSchema.safeParse(result).success).toBe(true);
    expect(result.generation).toBe(1);
  });

  test("GET rejects an invalid payload", async () => {
    fakeFetch(() => ({ status: 200, body: { generation: "bad" } }));
    await expect(fetchSubscriptions()).rejects.toBeDefined();
  });

  test("PUT success returns the view and exposes post-commit runtime error separately", async () => {
    fakeFetch(() => ({ status: 200, body: view(2, "mapping resolution failed") }));
    const result = await replaceSubscriptions([{ canonicalId: "A", enabled: true }]);
    expect(result.view?.generation).toBe(2);
    expect(result.runtimeError).toBe("mapping resolution failed");
    // Committed desired state is not hidden by the runtime error.
    expect(result.view?.selections).toEqual([{ canonicalId: "A", enabled: true }]);
  });

  test("PUT 403 is classified as forbidden", async () => {
    fakeFetch(() => ({ status: 403, body: { error: "forbidden", message: "local only" } }));
    try {
      await replaceSubscriptions([]);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionHttpError);
      expect((error as SubscriptionHttpError).kind).toBe("forbidden");
    }
  });

  test("PUT 400 is classified as validation", async () => {
    fakeFetch(() => ({ status: 400, body: { error: "invalid_request", message: "unknown id" } }));
    try {
      await replaceSubscriptions([{ canonicalId: "unknown", enabled: true }]);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SubscriptionHttpError).kind).toBe("validation");
    }
  });

  test("PUT 500 persistence_failed is classified as persistence", async () => {
    fakeFetch(() => ({ status: 500, body: { error: "persistence_failed", message: "disk write failed" } }));
    try {
      await replaceSubscriptions([]);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SubscriptionHttpError).kind).toBe("persistence");
    }
  });

  test("PUT other 500 is classified as internal, not validation", async () => {
    fakeFetch(() => ({ status: 500, body: { error: "internal_error", message: "oops" } }));
    try {
      await replaceSubscriptions([]);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SubscriptionHttpError).kind).toBe("internal");
    }
  });

  test("PUT writes are serialized and only the latest generation applies", async () => {
    const resolvers: Array<(body: unknown) => void> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Promise<Response>((resolve) => {
        resolvers.push((responseBody) => resolve(new Response(JSON.stringify(responseBody), {
          status: 200, headers: { "Content-Type": "application/json" }
        })));
        void body;
      });
    }) as typeof fetch;

    const first = replaceSubscriptions([{ canonicalId: "A", enabled: true }]);
    const second = replaceSubscriptions([{ canonicalId: "B", enabled: true }]);
    await Bun.sleep(0); // let the first queued write reach fetch
    expect(resolvers.length).toBe(1); // second write queued behind first

    resolvers[0]!(view(1));
    await Bun.sleep(0);
    expect(resolvers.length).toBe(2); // second write now reaches fetch
    resolvers[1]!(view(2));
    await Bun.sleep(0);

    const firstResult = await first;
    const secondResult = await second;
    expect(firstResult.view).toBeNull(); // superseded
    expect(secondResult.view?.generation).toBe(2);
  });

  test("manual canonical-ID entry rejects empty IDs at the request schema", async () => {
    await expect(replaceSubscriptions([{ canonicalId: "", enabled: true }])).rejects.toBeDefined();
  });
});

describe("subscription runtime presentation", () => {
  test("a populated runtimes map renders each provider under its own key", () => {
    const subscriptionView = view(1);
    subscriptionView.runtimes = {
      UPSTOX: {
        generation: 1, connectionState: "STREAMING", resolutions: [], lastError: "upstream-a-error"
      },
      FYERS: {
        generation: 1, connectionState: "DEGRADED", resolutions: [], lastError: "upstream-b-error"
      }
    };
    const html = renderPanelWith(subscriptionView);
    expect(html).toContain("UPSTOX");
    expect(html).toContain("FYERS");
    expect(html).toContain("upstream-a-error");
    expect(html).toContain("upstream-b-error");
    expect(html).toContain("STREAMING");
    expect(html).toContain("DEGRADED");
    expect(html.match(/Connection:/g)?.length).toBe(2);
  });

  test("a legacy payload without runtimes renders the runtime once", () => {
    const html = renderPanelWith(view(1, "legacy-only-error"));
    expect(html).toContain("legacy-only-error");
    expect(html.match(/Connection:/g)?.length).toBe(1);
  });

  test("runtimes: {} falls back to the legacy runtime", () => {
    const subscriptionView = view(1, "legacy-empty-error");
    subscriptionView.runtimes = {};
    const html = renderPanelWith(subscriptionView);
    expect(html).toContain("legacy-empty-error");
    expect(html.match(/Connection:/g)?.length).toBe(1);
  });

  test("a populated runtimes map does not render the legacy runtime alias again", () => {
    const subscriptionView = view(1, "legacy-alias-error");
    subscriptionView.runtimes = {
      UPSTOX: {
        generation: 1, connectionState: "STREAMING", resolutions: [], lastError: "runtime-upstox"
      },
      FYERS: {
        generation: 1, connectionState: "STREAMING", resolutions: [], lastError: "runtime-fyers"
      }
    };
    const html = renderPanelWith(subscriptionView);
    expect(html).not.toContain("legacy-alias-error");
    expect(html.match(/Connection:/g)?.length).toBe(2);
  });

  test("all four capability statuses render with their own distinct tone", () => {
    // Render each status in isolation so the assertion pins the status→tone
    // pairing, not merely the presence of four labels and four tone classes.
    const expectedTone: Record<string, string> = {
      SUPPORTED: "bg-emerald-500/15",
      UNSUPPORTED: "bg-rose-500/15",
      LIMITED: "bg-amber-500/15",
      UNAVAILABLE: "bg-slate-500/15"
    };
    for (const [status, tone] of Object.entries(expectedTone)) {
      const subscriptionView = view(1);
      subscriptionView.runtime.capabilities = [
        { component: "quote", provider: "UPSTOX", status: status as "SUPPORTED" | "UNSUPPORTED" | "LIMITED" | "UNAVAILABLE" }
      ];
      const html = renderPanelWith(subscriptionView);
      expect(html).toContain(status);
      expect(html).toContain(tone);
      // The badge for this status carries the expected tone in the same element.
      expect(html).toMatch(new RegExp(`bg-${tone.split("bg-")[1].split("/")[0]}[^>]*>${status}<`));
    }
  });

  test("fields, levels, reason and entitlementUnverified render only when supplied", () => {
    const withDetails = view(1);
    withDetails.runtime.capabilities = [{
      component: "quote", provider: "UPSTOX", status: "LIMITED",
      fields: ["ltp", "oi"], levels: 5, reason: "plan limit", entitlementUnverified: true
    }];
    const detailed = renderPanelWith(withDetails);
    expect(detailed).toContain("ltp");
    expect(detailed).toContain("Levels: 5");
    expect(detailed).toContain("plan limit");
    expect(detailed).toContain("Entitlement not verified");

    const withoutDetails = view(1);
    withoutDetails.runtime.capabilities = [
      { component: "quote", provider: "UPSTOX", status: "SUPPORTED" }
    ];
    const plain = renderPanelWith(withoutDetails);
    expect(plain).not.toContain("Fields:");
    expect(plain).not.toContain("Levels:");
    expect(plain).not.toContain("Reason:");
    expect(plain).not.toContain("Entitlement not verified");
  });

  test("absent or empty capabilities render a neutral no-report state", () => {
    const absent = renderPanelWith(view(1));
    expect(absent).toContain("No runtime capability report");
    expect(absent).not.toContain("SUPPORTED");

    const emptyView = view(1);
    emptyView.runtime.capabilities = [];
    const empty = renderPanelWith(emptyView);
    expect(empty).toContain("No runtime capability report");
    expect(empty).not.toContain("SUPPORTED");
  });
});
