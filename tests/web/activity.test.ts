import { afterEach, describe, expect, test } from "bun:test";
import type { McpActivityView } from "../../packages/contracts/src/index";
import {
  ActivityHttpError, fetchActivity, fetchActivityById, fetchActivityByOperation
} from "../../apps/web/src/lib/activity";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const view: McpActivityView = {
  id: "a1", operationId: "55555555-5555-4555-8555-555555555555", toolName: "markethub_health",
  transport: "HTTP", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.100Z",
  durationMs: 100, clientStartedAt: null, clientFinishedAt: null, clientName: null, clientVersion: null,
  status: "succeeded", errorCategory: null, errorMessage: null, summaryJson: null,
  dataResultRef: { kind: "snapshot", snapshotId: "snap-1" }
};

describe("activity web client", () => {
  test("fetchActivity validates the list envelope and forwards filters", async () => {
    let seen = "";
    fakeFetch((url) => { seen = url; return { status: 200, body: { records: [view], nextCursor: null } }; });
    const result = await fetchActivity({ toolName: "markethub_health", transport: "HTTP", status: "succeeded", limit: 25 });
    expect(result.records).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
    expect(seen).toContain("toolName=markethub_health");
    expect(seen).toContain("transport=HTTP");
    expect(seen).toContain("limit=25");
  });

  test("detail clients validate the safe view", async () => {
    fakeFetch(() => ({ status: 200, body: view }));
    expect((await fetchActivityById("a1")).operationId).toBe(view.operationId);
    expect((await fetchActivityByOperation(view.operationId)).toolName).toBe("markethub_health");
  });

  test("errors are classified and malformed payloads rejected", async () => {
    fakeFetch(() => ({ status: 403, body: { error: "forbidden", message: "local only" } }));
    await expect(fetchActivity()).rejects.toBeInstanceOf(ActivityHttpError);
    fakeFetch(() => ({ status: 200, body: { records: [{ id: "bad" }], nextCursor: null } }));
    await expect(fetchActivity()).rejects.toThrow();
  });

  test("typed dataResultRef is preserved for navigation", async () => {
    fakeFetch(() => ({ status: 200, body: view }));
    const result = await fetchActivityById("a1");
    expect(result.dataResultRef).toEqual({ kind: "snapshot", snapshotId: "snap-1" });
  });
});
