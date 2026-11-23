import { readFileSync } from "node:fs";
import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { afterEach, describe, expect, test } from "bun:test";
import { providerIdSchema, type OptionChainCaptureConfig, type OptionChainSnapshot, type ProviderId } from "../../packages/contracts/src/index";
import { SnapshotPanel } from "../../apps/web/src/components/SnapshotPanel";
import { selectedProviderOrError } from "../../apps/web/src/lib/snapshot-form";
import {
  captureSnapshot, deleteCaptureConfig, fetchCaptureConfigs, fetchSnapshot, fetchSnapshots,
  saveCaptureConfig, SnapshotHttpError, type CaptureRequest
} from "../../apps/web/src/lib/snapshots";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const snapshot: OptionChainSnapshot = {
  id: "snap-1", configId: "cap-1", capturedAt: "2026-01-01T00:00:00.000Z", provider: "FYERS",
  envelope: {
    underlyingCanonicalId: "A", expiryDate: "2026-01-29", capturedAt: "2026-01-01T00:00:00.000Z",
    observationTimestamp: null, underlyingLtp: 25000,
    strikes: [
      { strike: 25000, optionType: "CE", ltp: 100, oi: 0, greeks: { delta: 0.5, gamma: null } },
      { strike: 25000, optionType: "PE", ltp: 0 }
    ],
    providerExtensions: { fyToken: "123" }
  },
  provenance: { source: "provider-feed", provider: "FYERS", receivedAt: "2026-01-01T00:00:00.000Z" }
};

const config: OptionChainCaptureConfig = {
  id: "cap-1", underlyingCanonicalId: "A", expiryDate: "2026-01-29", strikeRangeJson: null,
  captureEnabled: true, captureMode: "MANUAL", scheduleJson: null, streamingEnabled: false,
  provider: "FYERS", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("snapshot web client", () => {
  test("panel renders the underlying picker; expiry and provider stay manual", () => {
    const html = renderToStaticMarkup(createElement(SnapshotPanel, {}) as never);
    expect(html).toContain("picker-value");
    expect(html).not.toContain('aria-label="Underlying canonical ID"');
    expect(html).toContain('aria-label="Expiry"');
    expect(html).toContain('aria-label="Provider"');
  });

  test("stored snapshots preserve null, zero and observation semantics", async () => {
    fakeFetch(() => ({ status: 200, body: { snapshots: [snapshot] } }));
    const list = await fetchSnapshots();
    expect(list.length).toBe(1);
    expect(list[0]!.envelope.observationTimestamp).toBeNull();
    expect(list[0]!.envelope.strikes[0]!.greeks!.gamma).toBeNull();
    expect(list[0]!.envelope.strikes[0]!.oi).toBe(0);
    expect(list[0]!.envelope.strikes[1]!.ltp).toBe(0);
    expect(list[0]!.envelope.providerExtensions.fyToken).toBe("123");
  });

  test("single snapshot retrieval and 404 classification", async () => {
    fakeFetch(() => ({ status: 200, body: { snapshot } }));
    expect((await fetchSnapshot("snap-1")).id).toBe("snap-1");

    fakeFetch(() => ({ status: 404, body: { error: "not_found", message: "missing" } }));
    try {
      await fetchSnapshot("missing");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotHttpError);
      expect((error as SnapshotHttpError).kind).toBe("not-found");
    }
  });

  test("capture config CRUD round-trips and 403 is forbidden", async () => {
    fakeFetch(() => ({ status: 200, body: { configs: [config] } }));
    expect((await fetchCaptureConfigs()).length).toBe(1);

    fakeFetch(() => ({ status: 200, body: { config } }));
    expect((await saveCaptureConfig(config)).id).toBe("cap-1");

    fakeFetch(() => ({ status: 200, body: { ok: true } }));
    await expect(deleteCaptureConfig("cap-1")).resolves.toBeUndefined();

    fakeFetch(() => ({ status: 403, body: { error: "forbidden", message: "local only" } }));
    try {
      await saveCaptureConfig(config);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotHttpError);
      expect((error as SnapshotHttpError).kind).toBe("forbidden");
    }
  });

  test("manual capture unavailable (no provider wired) is classified", async () => {
    fakeFetch(() => ({ status: 422, body: { error: "capture_unavailable", message: "no provider available" } }));
    try {
      await captureSnapshot({ underlyingCanonicalId: "A", expiryDate: "2026-01-29" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotHttpError);
      expect((error as SnapshotHttpError).kind).toBe("unavailable");
    }
  });

  test("invalid snapshot payload is rejected", async () => {
    fakeFetch(() => ({ status: 200, body: { snapshots: [{ id: "x" }] } }));
    await expect(fetchSnapshots()).rejects.toBeDefined();
  });

  // --- WP6B: explicit, contract-derived provider selection ---

  const componentSource = readFileSync(
    new URL("../../apps/web/src/components/SnapshotPanel.tsx", import.meta.url), "utf8"
  );
  const clientSource = readFileSync(
    new URL("../../apps/web/src/lib/snapshots.ts", import.meta.url), "utf8"
  );

  function selectMarkup(html: string): string {
    return html.match(/<select aria-label="Provider"[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
  }

  test("initial render has no provider preselected (placeholder is selected)", () => {
    const html = renderToStaticMarkup(createElement(SnapshotPanel, {}) as never);
    const select = selectMarkup(html);
    expect(select).toContain("Choose provider");
    const placeholder = select.match(/<option[^>]*>Choose provider<\/option>/)?.[0] ?? "";
    expect(placeholder).toContain("selected");
    expect(select).not.toMatch(/<option[^>]*value="FYERS"[^>]*selected/);
    expect(select).not.toMatch(/<option[^>]*value="UPSTOX"[^>]*selected/);
  });

  test("UI contains the placeholder and all schema provider values in schema definition order", () => {
    const html = renderToStaticMarkup(createElement(SnapshotPanel, {}) as never);
    const select = selectMarkup(html);
    expect(select).toContain('value=""');
    for (const id of providerIdSchema.options) expect(select).toContain(`value="${id}"`);
    expect(providerIdSchema.options).toEqual(["UPSTOX", "FYERS"]);
    expect(select.indexOf('value="UPSTOX"')).toBeLessThan(select.indexOf('value="FYERS"'));
    expect(select.indexOf('value=""')).toBeLessThan(select.indexOf('value="UPSTOX"'));
  });

  test("selectedProviderOrError validates empty, both IDs and invalid input", () => {
    expect(selectedProviderOrError("")).toBeNull();
    expect(selectedProviderOrError("   ")).toBeNull();
    expect(selectedProviderOrError("NOPE")).toBeNull();
    expect(selectedProviderOrError("UPSTOX")).toBe("UPSTOX");
    expect(selectedProviderOrError("FYERS")).toBe("FYERS");
  });

  test("both handlers validate the provider before calling their API client", () => {
    const guards = [...componentSource.matchAll(/selectedProviderOrError\(provider\)/g)];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    const firstGuard = guards[0]!.index!;
    const secondGuard = guards[1]!.index!;
    expect(firstGuard).toBeLessThan(componentSource.indexOf("saveCaptureConfig(config)"));
    expect(secondGuard).toBeLessThan(componentSource.indexOf("captureSnapshot({"));
    expect(componentSource).toContain("Choose a provider");
  });

  test("no duplicated provider literal list in component or client source", () => {
    // Primary positive signals: options derive from the shared schema and the
    // client uses the shared type.
    expect(componentSource).toContain("providerIdSchema.options");
    expect(clientSource).toContain("ProviderId");

    // Defense in depth. Allowed: providerIdSchema.options, JSX labels/text with
    // a provider name, and equality comparisons against a ProviderId value.
    // Forbidden: a literal union or an array/tuple literal holding both IDs.
    const union = /["']UPSTOX["']\s*\|\s*["']FYERS["']|["']FYERS["']\s*\|\s*["']UPSTOX["']/;
    const tuple = /\[[^\]\n]*["']UPSTOX["'][^\]\n]*["']FYERS["'][^\]\n]*\]|\[[^\]\n]*["']FYERS["'][^\]\n]*["']UPSTOX["'][^\]\n]*\]/;
    for (const source of [componentSource, clientSource]) {
      expect(union.test(source)).toBe(false);
      expect(tuple.test(source)).toBe(false);
    }
  });

  test("copy documents manual, exclusive/no-fallback selection and honest unavailability", () => {
    const html = renderToStaticMarkup(createElement(SnapshotPanel, {}) as never);
    expect(html).toContain("manual");
    expect(html).toContain("no fallback");
    expect(html).toContain("Only the provider you choose is attempted");
    expect(html).toContain("unavailable");
  });

  test("capture and config creation require a provider selection", () => {
    const html = renderToStaticMarkup(createElement(SnapshotPanel, {}) as never);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Add config<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Capture now<\/button>/);
    // Handler-level validation is retained even though the buttons are disabled.
    expect(componentSource).toContain("disabled={!provider}");
    expect(componentSource).toContain("disabled={loading || !provider}");
  });

  test("client request typing accepts shared ProviderId without changing the optional-provider wire contract", async () => {
    const withProvider: CaptureRequest = {
      underlyingCanonicalId: "A", expiryDate: "2026-01-29", provider: "UPSTOX" as ProviderId
    };
    expect(withProvider.provider).toBe("UPSTOX");
    const withoutProvider: CaptureRequest = { underlyingCanonicalId: "A", expiryDate: "2026-01-29" };
    expect(withoutProvider.provider).toBeUndefined();

    let body: Record<string, unknown> | null = null;
    const captureBody = (init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { status: 200, body: { snapshot } };
    };
    fakeFetch((_url, init) => captureBody(init));
    await captureSnapshot(withProvider);
    expect(body!.provider).toBe("UPSTOX");

    fakeFetch((_url, init) => captureBody(init));
    await captureSnapshot(withoutProvider);
    expect("provider" in body!).toBe(false);
  });
});
