import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { afterEach, describe, expect, test } from "bun:test";
import {
  emptyProviderStatus, providerStatusesResponseSchema,
  type ProviderId, type ProviderStatusesResponse
} from "../../packages/contracts/src/index";
import { ProviderList, ProviderStatusContent } from "../../apps/web/src/components/ProviderStatus";
import { fetchProvidersStatus } from "../../apps/web/src/lib/status";

type ProviderStatusMapView = NonNullable<ProviderStatusesResponse["providers"]>;
type ProviderStatusView = ProviderStatusMapView[keyof ProviderStatusMapView];

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function makeStatus(id: string, overrides: Partial<ProviderStatusView> = {}): ProviderStatusView {
  return { ...emptyProviderStatus(id as ProviderId, true), ...overrides } as ProviderStatusView;
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

describe("provider list rendering", () => {
  test("renders every entry from the validated map by its own id", () => {
    const providers = {
      UPSTOX: makeStatus("UPSTOX", { authState: "AUTHENTICATED" }),
      FYERS: makeStatus("FYERS", { authState: "NOT_CONFIGURED" })
    } as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).toContain("UPSTOX");
    expect(html).toContain("FYERS");
    expect(html).toContain("AUTHENTICATED");
    expect(html).toContain("NOT CONFIGURED");
  });

  test("enumerates any validated provider entry, including an unexpected key", () => {
    // A third key is intentionally supplied: a hardcoded two-provider render would drop it.
    const providers = {
      UPSTOX: makeStatus("UPSTOX"),
      FYERS: makeStatus("FYERS"),
      ICICI: makeStatus("ICICI", { authState: "AUTH_REQUIRED" })
    } as unknown as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).toContain("UPSTOX");
    expect(html).toContain("FYERS");
    expect(html).toContain("ICICI");
    expect(html).toContain("AUTH REQUIRED");
  });

  test("providers: null renders an honest unavailable state, not loading", () => {
    const html = renderToStaticMarkup(createElement(ProviderStatusContent, {
      providers: null, note: undefined, isError: false, onChanged: () => {}
    }) as never);
    expect(html).toContain("Provider status is currently unavailable.");
    expect(html).not.toContain("Loading provider status...");
    expect(html).not.toContain("UPSTOX");
    expect(html).not.toContain("FYERS");
  });

  test("providers: undefined still renders the loading state", () => {
    const html = renderToStaticMarkup(createElement(ProviderStatusContent, {
      providers: undefined, note: undefined, isError: false, onChanged: () => {}
    }) as never);
    expect(html).toContain("Loading provider status...");
    expect(html).not.toContain("Provider status is currently unavailable.");
  });

  test("error state is shown independently of the provider list", () => {
    const html = renderToStaticMarkup(createElement(ProviderStatusContent, {
      providers: null, note: undefined, isError: true, onChanged: () => {}
    }) as never);
    expect(html).toContain("Unable to read provider status.");
    expect(html).not.toContain("Loading provider status...");
  });
});

describe("provider status client", () => {
  test("parses a valid response with the shared schema", async () => {
    const providers = {
      UPSTOX: makeStatus("UPSTOX", { authState: "AUTHENTICATED" }),
      FYERS: makeStatus("FYERS")
    };
    fakeFetch(() => ({ status: 200, body: { providers, localManagement: true, note: "note" } }));
    const result = await fetchProvidersStatus();
    expect(providerStatusesResponseSchema.safeParse(result).success).toBe(true);
    expect(result.providers?.UPSTOX.id).toBe("UPSTOX");
    expect(result.localManagement).toBe(true);
  });

  test("accepts a providers: null response", async () => {
    fakeFetch(() => ({ status: 200, body: { providers: null, localManagement: true, note: "note" } }));
    const result = await fetchProvidersStatus();
    expect(result.providers).toBeNull();
    expect(providerStatusesResponseSchema.safeParse(result).success).toBe(true);
  });

  test("rejects a malformed response with a stable user-safe error", async () => {
    fakeFetch(() => ({ status: 200, body: { providers: { UPSTOX: {} }, localManagement: true, note: "note" } }));
    await expect(fetchProvidersStatus()).rejects.toThrow("Received invalid provider status response from backend");
  });

  test("rejects invalid JSON with a stable user-safe error", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    await expect(fetchProvidersStatus()).rejects.toThrow("Received invalid provider status response from backend");
  });

  test("surfaces HTTP errors", async () => {
    fakeFetch(() => ({ status: 503, body: {} }));
    await expect(fetchProvidersStatus()).rejects.toThrow("Provider status request failed (503)");
  });
});

describe("provider capability metadata rendering", () => {
  test("renders all three capability states distinctly", () => {
    const providers = {
      UPSTOX: makeStatus("UPSTOX", {
        capabilities: [
          { name: "cap_available", state: "AVAILABLE", source: "API" },
          { name: "cap_unavailable", state: "UNAVAILABLE", source: "API" },
          { name: "cap_unknown", state: "UNKNOWN", source: "DOCUMENTATION" }
        ]
      })
    } as unknown as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).toContain('data-state="AVAILABLE"');
    expect(html).toContain('data-state="UNAVAILABLE"');
    expect(html).toContain('data-state="UNKNOWN"');
    expect(html).toContain("AVAILABLE");
    expect(html).toContain("UNAVAILABLE");
    expect(html).toContain("UNKNOWN");
    // Distinct badge tones: ok (emerald), error (rose), warn (amber).
    expect(html).toContain("bg-emerald-500/15");
    expect(html).toContain("bg-rose-500/15");
    expect(html).toContain("bg-amber-500/15");
  });

  test("renders all four capability sources accurately and distinctly", () => {
    const providers = {
      UPSTOX: makeStatus("UPSTOX", {
        capabilities: [
          { name: "c1", state: "UNKNOWN", source: "API" },
          { name: "c2", state: "UNKNOWN", source: "DOCUMENTATION" },
          { name: "c3", state: "UNKNOWN", source: "USER" },
          { name: "c4", state: "UNKNOWN", source: "UNKNOWN" }
        ]
      })
    } as unknown as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).toContain('data-source="API"');
    expect(html).toContain('data-source="DOCUMENTATION"');
    expect(html).toContain('data-source="USER"');
    expect(html).toContain('data-source="UNKNOWN"');
    expect(html).toContain("Source: API");
    expect(html).toContain("Source: DOCUMENTATION");
    expect(html).toContain("Source: USER");
    expect(html).toContain("Source: UNKNOWN");
  });

  test("capability asOf and note appear only when supplied", () => {
    const withOptional = {
      UPSTOX: makeStatus("UPSTOX", {
        capabilities: [{ name: "c_with", state: "AVAILABLE", source: "API", asOf: "2026-11-20", note: "checked today" }]
      })
    } as unknown as ProviderStatusMapView;
    const withHtml = renderToStaticMarkup(createElement(ProviderList, { providers: withOptional }) as never);
    expect(withHtml).toContain("As of: 2026-11-20");
    expect(withHtml).toContain("checked today");

    const withoutOptional = {
      UPSTOX: makeStatus("UPSTOX", {
        capabilities: [{ name: "c_without", state: "AVAILABLE", source: "API" }]
      })
    } as unknown as ProviderStatusMapView;
    const withoutHtml = renderToStaticMarkup(createElement(ProviderList, { providers: withoutOptional }) as never);
    expect(withoutHtml).not.toContain("As of:");
    expect(withoutHtml).not.toContain("checked today");
  });

  test("limit publishedAt and note appear only when supplied", () => {
    const withOptional = {
      UPSTOX: makeStatus("UPSTOX", {
        limits: [{ name: "l_with", value: 1, state: "AVAILABLE", source: "API", publishedAt: "2026-10-01", note: "limit note" }]
      })
    } as unknown as ProviderStatusMapView;
    const withHtml = renderToStaticMarkup(createElement(ProviderList, { providers: withOptional }) as never);
    expect(withHtml).toContain("Published: 2026-10-01");
    expect(withHtml).toContain("limit note");

    const withoutOptional = {
      UPSTOX: makeStatus("UPSTOX", {
        limits: [{ name: "l_without", value: 1, state: "AVAILABLE", source: "API" }]
      })
    } as unknown as ProviderStatusMapView;
    const withoutHtml = renderToStaticMarkup(createElement(ProviderList, { providers: withoutOptional }) as never);
    expect(withoutHtml).not.toContain("Published:");
    expect(withoutHtml).not.toContain("limit note");
  });

  test("marks a documentation-derived numeric UNKNOWN limit as unverified", () => {
    const providers = {
      UPSTOX: makeStatus("UPSTOX", {
        limits: [{
          name: "other_standard_apis_per_second", value: 50, state: "UNKNOWN", source: "DOCUMENTATION",
          publishedAt: "2026-11-16", note: "Documentation figure, not verified account limit"
        }]
      })
    } as unknown as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).toContain('data-unverified="true"');
    expect(html).toContain("Unverified");
    expect(html).toContain("documentation-derived");
    expect(html).toContain("not a confirmed account entitlement");
    expect(html).toContain("50");
    expect(html).toContain("Published: 2026-11-16");
    expect(html).toContain("Documentation figure, not verified account limit");
  });

  test("does not mark an API-sourced AVAILABLE limit as unverified", () => {
    const providers = {
      UPSTOX: makeStatus("UPSTOX", {
        limits: [{ name: "verified_limit", value: 10, state: "AVAILABLE", source: "API" }]
      })
    } as unknown as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).not.toContain('data-unverified="true"');
    expect(html).not.toContain("Unverified");
  });

  test("empty capability and limit arrays render a neutral no-metadata state", () => {
    const providers = {
      UPSTOX: makeStatus("UPSTOX", { capabilities: [], limits: [] })
    } as unknown as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).toContain("No capability metadata reported");
    expect(html).toContain("No limit metadata reported");
    expect(html).not.toContain("data-capability-name=");
    expect(html).not.toContain("data-limit-name=");
  });

  test("renders capability and limit names from supplied state, not a frontend inventory", () => {
    const novelCapability = "NOVEL_CAPABILITY_XYZ_123";
    const novelLimit = "NOVEL_LIMIT_ABC_456";
    const providers = {
      UPSTOX: makeStatus("UPSTOX", {
        capabilities: [{ name: novelCapability, state: "UNKNOWN", source: "USER" }],
        limits: [{ name: novelLimit, value: "custom", state: "UNKNOWN", source: "USER" }]
      })
    } as unknown as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).toContain(novelCapability);
    expect(html).toContain(novelLimit);
    expect(html).toContain(`data-capability-name="${novelCapability}"`);
    expect(html).toContain(`data-limit-name="${novelLimit}"`);
  });

  test("auth, streaming, capability and limit dimensions render independently", () => {
    const providers = {
      UPSTOX: makeStatus("UPSTOX", {
        authState: "AUTHENTICATED",
        streamingState: "STREAMING",
        capabilities: [{ name: "cap", state: "AVAILABLE", source: "API" }],
        limits: [{ name: "lim", value: 5, state: "AVAILABLE", source: "API" }]
      })
    } as unknown as ProviderStatusMapView;
    const html = renderToStaticMarkup(createElement(ProviderList, { providers }) as never);
    expect(html).toContain("AUTHENTICATED");
    expect(html).toContain("STREAMING");
    expect(html).toContain("cap");
    expect(html).toContain("lim");
    expect(html).toContain("Capabilities");
    expect(html).toContain("Limits");
  });

  test("component source contains no hardcoded adapter capability or limit names", async () => {
    const source = await Bun.file("apps/web/src/components/ProviderStatus.tsx").text();
    for (const name of [
      "market_quote", "historical_data", "option_chain", "market_information",
      "market_data", "other_standard_apis_per_second", "data_api_per_second"
    ]) {
      expect(source).not.toContain(name);
    }
  });
});
