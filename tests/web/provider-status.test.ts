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
