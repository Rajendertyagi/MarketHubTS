import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { afterEach, describe, expect, test } from "bun:test";
import { subscriptionStateViewSchema, type SubscriptionStateView } from "../../packages/contracts/src/index";
import { SubscriptionPanel } from "../../apps/web/src/components/SubscriptionPanel";
import {
  fetchSubscriptions, replaceSubscriptions, SubscriptionHttpError
} from "../../apps/web/src/lib/subscriptions";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function view(generation: number, lastError: string | null = null): SubscriptionStateView {
  return {
    selections: [{ canonicalId: "A", enabled: true }],
    generation,
    runtime: {
      generation, connectionState: "NOT_STARTED", resolutions: [], lastError
    }
  };
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
