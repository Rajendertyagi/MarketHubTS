import { readFileSync } from "node:fs";
import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { afterEach, describe, expect, test } from "bun:test";
import {
  optionChainCaptureConfigSchema,
  type DerivativeExpiriesResponse,
  type OptionChainCaptureConfig
} from "../../packages/contracts/src/index";
import { ExpirySelectorView, SnapshotPanel } from "../../apps/web/src/components/SnapshotPanel";
import {
  buildExpiriesQuery, ExpiriesHttpError, fetchDerivativeExpiries
} from "../../apps/web/src/lib/expiries";
import {
  CATALOGUE_ORIGIN_LABEL, MANUAL_ORIGIN_LABEL, createExpiryController,
  expiryOrigin, expiryOriginLabel, expiryStatusInfo, initialExpiryState,
  isValidExpiryDate, type ExpiryFetchQuery, type ExpiryState
} from "../../apps/web/src/lib/expiry-form";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function response(
  underlyingCanonicalId: string,
  provider: "UPSTOX" | "FYERS",
  expiries: string[],
  state: "FRESH" | "STALE" | "UNKNOWN" = "FRESH"
): DerivativeExpiriesResponse {
  return {
    underlyingCanonicalId,
    provider,
    expiries,
    freshness: { state, lastSuccessfulSyncAt: state === "UNKNOWN" ? null : "2026-01-01T00:00:00.000Z" }
  };
}

function renderView(state: ExpiryState) {
  return renderToStaticMarkup(ExpirySelectorView({
    state,
    status: expiryStatusInfo(state.loadState, state.response, state.error),
    onValue: () => {},
    onRetry: () => {}
  }) as never);
}

function withState(patch: Partial<ExpiryState>): ExpiryState {
  return { ...initialExpiryState(), ...patch };
}

// --- Typed client -----------------------------------------------------------

describe("WP4C — typed derivative-expiry client", () => {
  test("builds the exact provider-aware query with no native identifier", () => {
    const qs = buildExpiriesQuery({ underlyingCanonicalId: "  NIFTY  ", provider: "UPSTOX" });
    const params = new URLSearchParams(qs);
    expect(params.get("underlyingCanonicalId")).toBe("NIFTY");
    expect(params.get("provider")).toBe("UPSTOX");
    expect([...params.keys()].sort()).toEqual(["provider", "underlyingCanonicalId"]);
  });

  test("fetches and validates a response with the shared schema", async () => {
    let url = "";
    fakeFetch((u) => {
      url = u;
      return { status: 200, body: response("NIFTY", "UPSTOX", ["2026-01-29", "2026-02-26"]) };
    });
    const result = await fetchDerivativeExpiries({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
    expect(url).toContain("/api/catalog/derivative-expiries?");
    expect(result.expiries).toEqual(["2026-01-29", "2026-02-26"]);
    expect(result.freshness.state).toBe("FRESH");
  });

  test("rejects malformed payloads and classifies HTTP errors", async () => {
    fakeFetch(() => ({ status: 200, body: { expiries: ["not-a-date"] } }));
    await expect(fetchDerivativeExpiries({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" })).rejects.toBeDefined();

    fakeFetch(() => ({ status: 400, body: { message: "bad provider" } }));
    try {
      await fetchDerivativeExpiries({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ExpiriesHttpError);
      expect((error as ExpiriesHttpError).kind).toBe("validation");
    }

    fakeFetch(() => ({ status: 500, body: { message: "boom" } }));
    try {
      await fetchDerivativeExpiries({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as ExpiriesHttpError).kind).toBe("internal");
    }
  });

  test("forwards an AbortSignal and rejects an empty underlying locally", async () => {
    let signal: AbortSignal | undefined;
    fakeFetch((_u, init) => {
      signal = init?.signal as AbortSignal | undefined;
      return { status: 200, body: response("NIFTY", "FYERS", []) };
    });
    const controller = new AbortController();
    await fetchDerivativeExpiries({ underlyingCanonicalId: "NIFTY", provider: "FYERS", signal: controller.signal });
    expect(signal).toBe(controller.signal);

    await expect(fetchDerivativeExpiries({ underlyingCanonicalId: "   ", provider: "FYERS" })).rejects.toBeDefined();
  });
});

// --- Pure form helpers ------------------------------------------------------

describe("WP4C — expiry form helpers", () => {
  test("valid manual values are real YYYY-MM-DD calendar dates", () => {
    for (const valid of ["2026-01-29", "2024-02-29", "2000-02-29", "2026-12-31"]) {
      expect(isValidExpiryDate(valid)).toBe(true);
    }
    for (const invalid of [
      "2026-02-30", "2025-02-29", "1900-02-29", "2026-04-31", "2026-00-10",
      "2026-13-10", "2026-01-00", "2026-01-32", "29-01-2026", "2026/01/29", "", "  "
    ]) {
      expect(isValidExpiryDate(invalid)).toBe(false);
    }
  });

  test("origin is Catalogue only for an exact match in the current list", () => {
    expect(expiryOrigin("2026-01-29", ["2026-01-29", "2026-02-26"])).toBe("Catalogue");
    expect(expiryOrigin(" 2026-01-29 ", ["2026-01-29"])).toBe("Catalogue");
    expect(expiryOrigin("2026-03-01", ["2026-01-29"])).toBe("Manual");
    expect(expiryOrigin("", ["2026-01-29"])).toBe("Manual");
    expect(expiryOrigin("2026-01-29", [])).toBe("Manual");
    expect(expiryOriginLabel("Catalogue")).toBe(CATALOGUE_ORIGIN_LABEL);
    expect(expiryOriginLabel("Manual")).toBe(MANUAL_ORIGIN_LABEL);
    expect(MANUAL_ORIGIN_LABEL).toContain("not verified");
  });

  test("status info pins loading, empty, error, stale, unknown and fresh states", () => {
    expect(expiryStatusInfo("loading", null, null).kind).toBe("loading");
    expect(expiryStatusInfo("error", null, "upstream down").kind).toBe("error");
    expect(expiryStatusInfo("error", null, "upstream down").text).toContain("enter a date manually");

    const empty = expiryStatusInfo("loaded", response("NIFTY", "UPSTOX", []), null);
    expect(empty.kind).toBe("empty");
    expect(empty.text).toContain("No catalogue expiries");
    expect(empty.manualAvailable).toBe(true);

    const stale = expiryStatusInfo("loaded", response("NIFTY", "UPSTOX", ["2026-01-29"], "STALE"), null);
    expect(stale.kind).toBe("stale");
    expect(stale.stale).toBe(true);
    expect(stale.text).toContain("stale");
    expect(stale.text).toContain("not confirmed fresh");

    const unknown = expiryStatusInfo("loaded", response("NIFTY", "UPSTOX", ["2026-01-29"], "UNKNOWN"), null);
    expect(unknown.kind).toBe("unknown");
    expect(unknown.stale).toBe(true);

    const fresh = expiryStatusInfo("loaded", response("NIFTY", "UPSTOX", ["2026-01-29"]), null);
    expect(fresh.kind).toBe("fresh");
    expect(fresh.text).toBe("");
    expect(fresh.manualAvailable).toBe(true);
  });
});

// --- Controller: states, invalidation and races -----------------------------

describe("WP4C — expiry controller", () => {
  test("loading then successful suggestions come only from the response", async () => {
    const states: ExpiryState[] = [];
    const c = createExpiryController({
      fetchExpiries: async () => response("NIFTY", "UPSTOX", ["2026-01-29", "2026-02-26"]),
      onState: (s) => states.push(s)
    });
    c.load({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
    expect(states[0]!.loadState).toBe("loading");
    await flush();
    expect(c.getState().loadState).toBe("loaded");
    expect(c.getState().options).toEqual(["2026-01-29", "2026-02-26"]);
    expect(c.getState().response?.provider).toBe("UPSTOX");
  });

  test("empty, error and retry states keep the manual fallback", async () => {
    let fail = true;
    const c = createExpiryController({
      fetchExpiries: async () => {
        if (fail) throw new Error("upstream down");
        return response("NIFTY", "UPSTOX", []);
      },
      onState: () => {}
    });
    c.load({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
    await flush();
    expect(c.getState().loadState).toBe("error");
    expect(c.getState().error).toBe("upstream down");
    c.setValue("2026-01-29");
    expect(c.getState().value).toBe("2026-01-29");
    expect(c.getState().origin).toBe("Manual");

    fail = false;
    c.retry();
    await flush();
    expect(c.getState().loadState).toBe("loaded");
    expect(c.getState().options).toEqual([]);
    expect(c.getState().value).toBe("2026-01-29"); // manual value survives retry
    expect(expiryStatusInfo(c.getState().loadState, c.getState().response, c.getState().error).kind).toBe("empty");
  });

  test("a manual date absent from the list stays unverified; a later match is relabelled Catalogue", async () => {
    let expiries = ["2026-02-01"];
    const c = createExpiryController({
      fetchExpiries: async () => response("NIFTY", "UPSTOX", expiries),
      onState: () => {}
    });
    c.load({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
    await flush();
    c.setValue("2026-01-29");
    expect(c.getState().origin).toBe("Manual");

    expiries = ["2026-01-29", "2026-02-01"];
    c.retry();
    await flush();
    expect(c.getState().origin).toBe("Catalogue");

    expiries = ["2026-02-01"];
    c.retry();
    await flush();
    expect(c.getState().origin).toBe("Manual");
  });

  test("a fetch failure drops a stale Catalogue label but preserves the manual value", async () => {
    let fail = false;
    const c = createExpiryController({
      fetchExpiries: async () => {
        if (fail) throw new Error("upstream down");
        return response("NIFTY", "UPSTOX", ["2026-01-29"]);
      },
      onState: () => {}
    });
    c.load({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
    await flush();
    c.setValue("2026-01-29");
    expect(c.getState().origin).toBe("Catalogue");

    fail = true;
    c.retry();
    await flush();
    expect(c.getState().loadState).toBe("error");
    expect(c.getState().value).toBe("2026-01-29");
    expect(c.getState().origin).toBe("Manual");
    expect(c.getState().options).toEqual([]);
    expect(c.getState().response).toBeNull();

    const html = renderView(c.getState());
    expect(html).toContain("Could not load expiries: upstream down");
    expect(html).toContain("Retry expiries");
    expect(html).toContain('aria-label="Expiry"');
    expect(html).toContain(MANUAL_ORIGIN_LABEL);
  });

  test("changing provider or underlying clears value and marker synchronously and queries the new pair", async () => {
    const queries: ExpiryFetchQuery[] = [];
    const c = createExpiryController({
      fetchExpiries: async (q) => {
        queries.push(q);
        return response(q.underlyingCanonicalId, q.provider, ["2026-01-29"]);
      },
      onState: () => {}
    });
    c.load({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
    await flush();
    c.setValue("2026-01-29");
    expect(c.getState().origin).toBe("Catalogue");

    // Provider change: cleared before the new fetch resolves.
    c.load({ underlyingCanonicalId: "NIFTY", provider: "FYERS" });
    expect(c.getState().value).toBe("");
    expect(c.getState().origin).toBeNull();
    expect(c.getState().loadState).toBe("loading");
    await flush();
    expect(queries[1]).toMatchObject({ underlyingCanonicalId: "NIFTY", provider: "FYERS" });

    c.setValue("2026-01-29");
    // Underlying change: cleared again.
    c.load({ underlyingCanonicalId: "BANKNIFTY", provider: "FYERS" });
    expect(c.getState().value).toBe("");
    expect(c.getState().origin).toBeNull();
    await flush();
    expect(queries[2]).toMatchObject({ underlyingCanonicalId: "BANKNIFTY", provider: "FYERS" });
    expect(c.getState().response?.underlyingCanonicalId).toBe("BANKNIFTY");
  });

  test("a late response for an older selection cannot overwrite the newer one", async () => {
    let resolveFirst!: (value: DerivativeExpiriesResponse) => void;
    const first = new Promise<DerivativeExpiriesResponse>((resolve) => { resolveFirst = resolve; });
    const queries: ExpiryFetchQuery[] = [];
    const c = createExpiryController({
      fetchExpiries: async (q) => {
        queries.push(q);
        if (queries.length === 1) return first;
        return response("BANKNIFTY", "FYERS", ["2026-03-01"]);
      },
      onState: () => {}
    });
    c.load({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
    await flush();
    c.setValue("2026-01-29");
    c.load({ underlyingCanonicalId: "BANKNIFTY", provider: "FYERS" });
    await flush();
    expect(c.getState().options).toEqual(["2026-03-01"]);
    expect(c.getState().selection).toEqual({ underlyingCanonicalId: "BANKNIFTY", provider: "FYERS" });

    resolveFirst(response("NIFTY", "UPSTOX", ["2026-02-01"]));
    await flush();
    expect(c.getState().options).toEqual(["2026-03-01"]);
    expect(c.getState().selection).toEqual({ underlyingCanonicalId: "BANKNIFTY", provider: "FYERS" });
    expect(c.getState().value).toBe("");
    expect(c.getState().origin).toBeNull();
  });

  test("clear() drops value, marker and in-flight work", async () => {
    const c = createExpiryController({
      fetchExpiries: async () => response("NIFTY", "UPSTOX", ["2026-01-29"]),
      onState: () => {}
    });
    c.load({ underlyingCanonicalId: "NIFTY", provider: "UPSTOX" });
    await flush();
    c.setValue("2026-01-29");
    c.clear();
    expect(c.getState()).toEqual(initialExpiryState());
  });
});

// --- Static-render view states ----------------------------------------------

describe("WP4C — expiry selector static rendering", () => {
  test("loading shows honest status and keeps the manual input", () => {
    const html = renderView(withState({ loadState: "loading" }));
    expect(html).toContain("Loading expiries from the catalogue");
    expect(html).toContain('aria-label="Expiry"');
    expect(html).toContain('aria-label="Expiry suggestions"');
    expect(html).not.toContain("data-testid=\"expiry-origin\"");
  });

  test("successful suggestions render only the API-provided options", () => {
    const html = renderView(withState({
      loadState: "loaded",
      response: response("NIFTY", "UPSTOX", ["2026-05-01", "2026-06-01"]),
      options: ["2026-05-01", "2026-06-01"]
    }));
    expect(html).toContain('<option value="2026-05-01">2026-05-01</option>');
    expect(html).toContain('<option value="2026-06-01">2026-06-01</option>');
    expect(html).not.toContain('<option value="2026-01-29">');
    expect(html).toContain("Choose a suggested expiry (optional)");
  });

  test("empty, error/retry and stale states never hide manual entry", () => {
    const empty = renderView(withState({ loadState: "loaded", response: response("NIFTY", "UPSTOX", []), options: [] }));
    expect(empty).toContain("No catalogue expiries");
    expect(empty).toContain('aria-label="Expiry"');

    const error = renderView(withState({ loadState: "error", error: "upstream down" }));
    expect(error).toContain("Could not load expiries: upstream down");
    expect(error).toContain("Retry expiries");
    expect(error).toContain('aria-label="Expiry"');

    const stale = renderView(withState({
      loadState: "loaded", response: response("NIFTY", "UPSTOX", ["2026-01-29"], "STALE"), options: ["2026-01-29"]
    }));
    expect(stale).toContain("stale");
    expect(stale).toContain('aria-label="Expiry"');
  });

  test("origin marker is visible and distinguishes Catalogue from Manual", () => {
    const catalogue = renderView(withState({ value: "2026-01-29", origin: "Catalogue" }));
    expect(catalogue).toContain("data-testid=\"expiry-origin\"");
    expect(catalogue).toContain(CATALOGUE_ORIGIN_LABEL);
    expect(catalogue).not.toContain(MANUAL_ORIGIN_LABEL);

    const manual = renderView(withState({ value: "2026-03-01", origin: "Manual" }));
    expect(manual).toContain(MANUAL_ORIGIN_LABEL);
    expect(manual).not.toContain(`>${CATALOGUE_ORIGIN_LABEL}<`);
  });

  test("no hardcoded expiry options: an empty response yields only the placeholder", () => {
    const html = renderView(withState({ loadState: "loaded", response: response("NIFTY", "UPSTOX", []), options: [] }));
    const options = html.match(/<option[^>]*>[^<]*<\/option>/g) ?? [];
    expect(options).toHaveLength(1);
    expect(options[0]).toContain("Choose a suggested expiry");
  });
});

// --- Regressions ------------------------------------------------------------

describe("WP4C — regressions", () => {
  const componentSource = readFileSync(
    new URL("../../apps/web/src/components/SnapshotPanel.tsx", import.meta.url), "utf8"
  );
  const clientSource = readFileSync(
    new URL("../../apps/web/src/lib/snapshots.ts", import.meta.url), "utf8"
  );

  test("a valid manual date remains saveable with the unchanged config schema", () => {
    const config: OptionChainCaptureConfig = {
      id: "cap-1", underlyingCanonicalId: "NIFTY", expiryDate: "2026-01-29", strikeRangeJson: null,
      captureEnabled: true, captureMode: "MANUAL", scheduleJson: null, streamingEnabled: false,
      provider: "UPSTOX", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    };
    expect(optionChainCaptureConfigSchema.safeParse(config).success).toBe(true);
    expect(componentSource).toContain("isValidExpiryDate(expiryValue)");
    const guard = componentSource.indexOf("isValidExpiryDate(expiryValue)");
    expect(guard).toBeLessThan(componentSource.indexOf("saveCaptureConfig(config)"));
    expect(guard).toBeLessThan(componentSource.indexOf("captureSnapshot({"));
  });

  test("component wires expiry discovery to underlying/provider changes", () => {
    expect(componentSource).toContain("fetchExpiries: fetchDerivativeExpiries");
    expect(componentSource).toContain("controller.load({ underlyingCanonicalId: id, provider: selected })");
    expect(componentSource).toContain("controller.clear()");
    expect(componentSource).toContain("}, [underlying, provider]);");
    expect(componentSource).toContain("controller.dispose()");
  });

  test("nativeIdentifier stays unused and is never rendered or accepted by the UI", () => {
    expect(clientSource).toContain("nativeIdentifier?: string");
    expect(componentSource).not.toContain("nativeIdentifier");
    const html = renderToStaticMarkup(createElement(SnapshotPanel, {}) as never);
    expect(html).not.toContain("nativeIdentifier");
  });

  test("WP6B explicit provider selection is preserved (no Automatic, no default)", () => {
    const html = renderToStaticMarkup(createElement(SnapshotPanel, {}) as never);
    const select = html.match(/<select aria-label="Provider"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
    expect(select).toContain("Choose provider");
    expect(select).toContain('value="" selected');
    expect(select).not.toContain("Automatic");
    expect(select).not.toMatch(/value="FYERS"[^>]*selected/);
    expect(componentSource).toContain("providerIdSchema.options");
    expect(componentSource).toContain("disabled={!provider}");
    expect(componentSource).toContain("disabled={loading || !provider}");
    expect(html).toContain("no fallback");
    expect(html).toContain("Only the provider you choose is attempted");
    expect(html).toContain("unavailable");
  });

  test("existing SnapshotPanel behavior is preserved", () => {
    const html = renderToStaticMarkup(createElement(SnapshotPanel, {}) as never);
    expect(html).toContain("picker-value");
    expect(html).not.toContain('aria-label="Underlying canonical ID"');
    expect(html).toContain('aria-label="Expiry"');
    expect(html).toContain('aria-label="Provider"');
    expect(html).toContain("Option-chain snapshots");
    expect(html).toContain("Capture configurations");
    expect(html).toContain("Stored snapshots");
    expect(html).toContain("Add config");
    expect(html).toContain("Capture now");
  });
});
