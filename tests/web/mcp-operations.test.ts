import { afterEach, describe, expect, test } from "bun:test";
import type { McpOperationDescriptor } from "../../packages/contracts/src/index";
import { fetchMcpOperations, McpOperationsHttpError } from "../../apps/web/src/lib/mcp-operations";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const descriptors: McpOperationDescriptor[] = [
  { name: "markethub_health", type: "tool", description: "Health" },
  { name: "catalog-instruments", type: "resource", title: "Catalog instruments", description: "Instruments" },
  { name: "explain_market_snapshot", type: "prompt", title: "Explain a market snapshot", description: "Explain" }
];

/** Structural fake AbortSignal so identity forwarding can be asserted. */
class FakeSignal {
  aborted = false;
  addEventListener(): void {}
  removeEventListener(): void {}
}
function asSignal(fake: FakeSignal): AbortSignal {
  return fake as unknown as AbortSignal;
}

describe("mcp-operations web client", () => {
  test("fetchMcpOperations validates the envelope and returns descriptors", async () => {
    let seen = "";
    fakeFetch((url) => { seen = url; return { status: 200, body: { operations: descriptors } }; });
    const result = await fetchMcpOperations();
    expect(result).toEqual(descriptors);
    expect(seen).toBe("/api/mcp/operations");
  });

  test("forwards the exact signal object to fetch", async () => {
    const signal = asSignal(new FakeSignal());
    let received: RequestInit | undefined;
    fakeFetch((_url, init) => {
      received = init;
      return { status: 200, body: { operations: descriptors } };
    });
    await fetchMcpOperations(signal);
    expect(received?.signal).toBe(signal);
  });

  test("omits the signal key when no signal is supplied", async () => {
    let received: RequestInit | undefined;
    fakeFetch((_url, init) => {
      received = init;
      return { status: 200, body: { operations: descriptors } };
    });
    await fetchMcpOperations();
    expect(received).not.toHaveProperty("signal");
  });

  test("AbortError propagates unchanged", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    globalThis.fetch = (async () => { throw abortError; }) as typeof fetch;
    await expect(fetchMcpOperations()).rejects.toBe(abortError);
  });

  test("HTTP errors are classified into the typed error", async () => {
    fakeFetch(() => ({ status: 403, body: { message: "local only" } }));
    await expect(fetchMcpOperations()).rejects.toBeInstanceOf(McpOperationsHttpError);
    fakeFetch(() => ({ status: 500, body: {} }));
    const rejection = await fetchMcpOperations().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(McpOperationsHttpError);
    expect((rejection as McpOperationsHttpError).kind).toBe("internal");
    expect((rejection as McpOperationsHttpError).message).toContain("MCP operations request failed (500)");
  });

  test("malformed and drifted descriptor responses are rejected by the shared schema", async () => {
    // Missing envelope.
    fakeFetch(() => ({ status: 200, body: { wrong: [] } }));
    await expect(fetchMcpOperations()).rejects.toThrow();

    // Tool carrying a title (producer drift) is rejected by the strict union.
    fakeFetch(() => ({
      status: 200,
      body: { operations: [{ name: "markethub_health", type: "tool", title: "Health", description: "Health" }] }
    }));
    await expect(fetchMcpOperations()).rejects.toThrow();

    // Resource missing its required title is rejected.
    fakeFetch(() => ({
      status: 200,
      body: { operations: [{ name: "catalog-instruments", type: "resource", description: "Instruments" }] }
    }));
    await expect(fetchMcpOperations()).rejects.toThrow();

    // Unknown field is rejected by strict objects.
    fakeFetch(() => ({
      status: 200,
      body: { operations: [{ name: "markethub_health", type: "tool", description: "Health", secret: "x" }] }
    }));
    await expect(fetchMcpOperations()).rejects.toThrow();

    // Over the 100-entry bound is rejected.
    fakeFetch(() => ({
      status: 200,
      body: { operations: Array.from({ length: 101 }, (_, i) => ({ name: `op_${i}`, type: "tool", description: "d" })) }
    }));
    await expect(fetchMcpOperations()).rejects.toThrow();
  });
});
