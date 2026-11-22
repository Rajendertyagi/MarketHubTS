import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { afterEach, describe, expect, test } from "bun:test";
import { subscriptionStateViewSchema, type SubscriptionStateView } from "../../packages/contracts/src/index";
import { RefreshErrorNotice, SubscriptionPanel } from "../../apps/web/src/components/SubscriptionPanel";
import { useLiveStore } from "../../apps/web/src/store/live-store";
import {
  fetchSubscriptions, replaceSubscriptions, SubscriptionHttpError
} from "../../apps/web/src/lib/subscriptions";
import { createSubscriptionPoller, isAbortError } from "../../apps/web/src/lib/subscription-poller";

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

// --- Bounded refresh controller (framework-free, no DOM) -------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Sleep that only advances when the test says so, or when aborted. */
function makeControlledSleep() {
  const waiters: Array<{ done: () => void; settled: boolean }> = [];
  const intervals: number[] = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    intervals.push(ms);
    return new Promise<void>((resolve) => {
      const entry = { settled: false, done: () => {} };
      entry.done = () => {
        if (entry.settled) return;
        entry.settled = true;
        signal?.removeEventListener("abort", entry.done);
        resolve();
      };
      waiters.push(entry);
      signal?.addEventListener("abort", entry.done, { once: true });
    });
  };
  return {
    sleep,
    intervals,
    advance: () => {
      while (waiters.length > 0) {
        const entry = waiters.shift()!;
        if (!entry.settled) { entry.done(); return; }
      }
    },
    pending: () => waiters.filter((w) => !w.settled).length
  };
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function rejectingFetchOnAbort(signal?: AbortSignal): Promise<SubscriptionStateView> {
  return new Promise<SubscriptionStateView>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

describe("subscription poller", () => {
  test("MANDATORY RACE: a stale GET resolving after a successful PUT does not overwrite the PUT view", async () => {
    const applied: SubscriptionStateView[] = [];
    let writeGen = 0;
    let writePending = false;
    const staleGet = deferred<SubscriptionStateView>();
    const clock = makeControlledSleep();

    const poller = createSubscriptionPoller({
      // Ignores the signal on purpose: this models a response that parses
      // before the abort is observed, so only the generation guard can save us.
      fetchView: () => staleGet.promise,
      getWriteGeneration: () => writeGen,
      isWritePending: () => writePending,
      applyView: (next) => applied.push(next),
      onRefreshError: () => {},
      sleep: clock.sleep
    });

    poller.start();
    clock.advance(); // first sleep -> loadOnce starts, GET in flight
    await Bun.sleep(0);
    expect(applied).toHaveLength(0);

    // A write starts and completes; the component applies the PUT view.
    writeGen++;
    writePending = true;
    const putView = view(2);
    applied.push(putView); // authoritative PUT result applied by the component
    writePending = false;

    // The older GET now resolves with stale generation-1 data.
    staleGet.resolve(view(1));
    await Bun.sleep(0);

    expect(applied).toEqual([putView]);
    expect(applied[0]?.generation).toBe(2);
    poller.dispose();
  });

  test("does not start a second load while the first is in flight", async () => {
    const clock = makeControlledSleep();
    let calls = 0;
    const gets: Array<ReturnType<typeof deferred<SubscriptionStateView>>> = [];
    const poller = createSubscriptionPoller({
      fetchView: () => {
        calls++;
        const d = deferred<SubscriptionStateView>();
        gets.push(d);
        return d.promise;
      },
      getWriteGeneration: () => 0,
      isWritePending: () => false,
      applyView: () => {},
      onRefreshError: () => {},
      sleep: clock.sleep
    });

    poller.start();
    clock.advance();
    await Bun.sleep(0);
    expect(calls).toBe(1);

    clock.advance(); // loop iterates while GET #1 is still pending
    await Bun.sleep(0);
    expect(calls).toBe(1); // single-flight

    gets[0]!.resolve(view(1));
    await Bun.sleep(0);

    clock.advance();
    await Bun.sleep(0);
    expect(calls).toBe(2);
    poller.dispose();
  });

  test("suspend aborts the in-flight fetch and stops scheduling; resume restarts", async () => {
    const clock = makeControlledSleep();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const poller = createSubscriptionPoller({
      fetchView: (signal) => {
        calls++;
        signals.push(signal!);
        return rejectingFetchOnAbort(signal);
      },
      getWriteGeneration: () => 0,
      isWritePending: () => false,
      applyView: () => {},
      onRefreshError: () => {},
      sleep: clock.sleep
    });

    poller.start();
    clock.advance();
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(signals[0]!.aborted).toBe(false);

    poller.suspend();
    expect(signals[0]!.aborted).toBe(true);
    await Bun.sleep(0);

    clock.advance(); // suspended: must not start a new fetch
    await Bun.sleep(0);
    expect(calls).toBe(1);

    poller.resume();
    clock.advance();
    await Bun.sleep(0);
    expect(calls).toBe(2);
    poller.dispose();
  });

  test("dispose aborts in-flight work and stops scheduling", async () => {
    const clock = makeControlledSleep();
    let calls = 0;
    let captured: AbortSignal | null = null;
    const poller = createSubscriptionPoller({
      fetchView: (signal) => {
        calls++;
        captured = signal!;
        return rejectingFetchOnAbort(signal);
      },
      getWriteGeneration: () => 0,
      isWritePending: () => false,
      applyView: () => {},
      onRefreshError: () => {},
      sleep: clock.sleep
    });

    poller.start();
    clock.advance();
    await Bun.sleep(0);
    expect(calls).toBe(1);

    poller.dispose();
    expect(captured!.aborted).toBe(true);
    await Bun.sleep(0);

    const intervalsBefore = clock.intervals.length;
    clock.advance();
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(clock.intervals.length).toBe(intervalsBefore); // no new sleep scheduled
    poller.dispose(); // idempotent
  });

  test("forwards the same AbortSignal object to fetchView", async () => {
    const clock = makeControlledSleep();
    let captured: AbortSignal | undefined;
    const poller = createSubscriptionPoller({
      fetchView: (signal) => { captured = signal; return new Promise(() => {}); },
      getWriteGeneration: () => 0,
      isWritePending: () => false,
      applyView: () => {},
      onRefreshError: () => {},
      sleep: clock.sleep
    });

    poller.start();
    clock.advance();
    await Bun.sleep(0);
    expect(captured).toBeInstanceOf(AbortSignal);
    const same = captured;
    poller.suspend();
    expect(same!.aborted).toBe(true);
    poller.dispose();
  });

  test("refresh failure reports an error, keeps last-known-good, and a later success clears it", async () => {
    const clock = makeControlledSleep();
    const applied: SubscriptionStateView[] = [];
    const errors: Array<string | null> = [];
    let shouldFail = true;
    const poller = createSubscriptionPoller({
      fetchView: async () => {
        if (shouldFail) throw new Error("network down");
        return view(3);
      },
      getWriteGeneration: () => 0,
      isWritePending: () => false,
      applyView: (next) => applied.push(next),
      onRefreshError: (message) => errors.push(message),
      sleep: clock.sleep
    });

    poller.start();
    clock.advance();
    await Bun.sleep(0);
    expect(errors).toEqual(["network down"]);
    expect(applied).toHaveLength(0); // never cleared / never applied a null

    shouldFail = false;
    clock.advance();
    await Bun.sleep(0);
    expect(errors).toEqual(["network down", null]);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.generation).toBe(3);
    poller.dispose();
  });

  test("results from a superseded generation are discarded", async () => {
    const clock = makeControlledSleep();
    const applied: SubscriptionStateView[] = [];
    const stale = deferred<SubscriptionStateView>();
    const poller = createSubscriptionPoller({
      fetchView: () => stale.promise, // ignores abort
      getWriteGeneration: () => 0,
      isWritePending: () => false,
      applyView: (next) => applied.push(next),
      onRefreshError: () => {},
      sleep: clock.sleep
    });

    poller.start();
    clock.advance();
    await Bun.sleep(0);

    poller.resume(); // bumps generation; old fetch still pending
    stale.resolve(view(9));
    await Bun.sleep(0);
    expect(applied).toHaveLength(0);
    poller.dispose();
  });

  test("uses a bounded default interval of 10000ms and honours an override", async () => {
    const clock = makeControlledSleep();
    const poller = createSubscriptionPoller({
      fetchView: () => new Promise(() => {}),
      getWriteGeneration: () => 0,
      isWritePending: () => false,
      applyView: () => {},
      onRefreshError: () => {},
      sleep: clock.sleep
    });
    poller.start();
    expect(clock.intervals[0]).toBe(10000);
    poller.dispose();

    const custom = makeControlledSleep();
    const poller2 = createSubscriptionPoller({
      fetchView: () => new Promise(() => {}),
      getWriteGeneration: () => 0,
      isWritePending: () => false,
      applyView: () => {},
      onRefreshError: () => {},
      intervalMs: 2500,
      sleep: custom.sleep
    });
    poller2.start();
    expect(custom.intervals[0]).toBe(2500);
    poller2.dispose();
  });

  test("isAbortError recognises only Error objects named AbortError", () => {
    expect(isAbortError(abortError())).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
    expect(isAbortError({ name: "AbortError" })).toBe(false);
  });
});

describe("subscription refresh error presentation", () => {
  test("GET forwards the same AbortSignal object to fetch and propagates AbortError", async () => {
    const controller = new AbortController();
    let captured: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init?.signal ?? undefined;
      throw abortError();
    }) as typeof fetch;
    await expect(fetchSubscriptions(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(captured).toBe(controller.signal);
  });

  test("refresh error notice renders separately from the write/runtime error", () => {
    const html = renderToStaticMarkup(
      createElement(RefreshErrorNotice, { message: "network down", onRetry: () => {} }) as never
    );
    expect(html).toContain("Refresh unavailable — showing last known state");
    expect(html).toContain("network down");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Desired state saved");
    expect(html).not.toContain("Persistence failure");
  });

  test("panel write/runtime error does not render the refresh notice", () => {
    const initial = useLiveStore.getInitialState();
    const previous = { ...initial };
    initial.subscriptionError = {
      kind: "runtime", message: "Desired state saved; runtime reconciliation failed"
    };
    try {
      const html = renderToStaticMarkup(createElement(SubscriptionPanel, {}) as never);
      expect(html).toContain("Desired state saved");
      expect(html).not.toContain("Refresh unavailable");
    } finally {
      Object.assign(initial, previous);
    }
  });
});
