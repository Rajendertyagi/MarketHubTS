import { describe, expect, test } from "bun:test";
import { createStdioServices } from "../../apps/mcp-server/src/services";

/** Stub local API that records requested paths and returns canonical-shaped responses. */
function stubApi() {
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/catalog/search") {
        return Response.json({ instruments: [], nextCursor: null });
      }
      if (url.pathname === "/api/market/events") {
        const after = url.searchParams.get("after");
        if (after === "bad") {
          return Response.json({ events: [], nextCursor: null, snapshotRequired: { reason: "invalid-cursor" } });
        }
        if (after === "malformed-recovery") {
          return Response.json({ events: [], nextCursor: null, snapshotRequired: {} });
        }
        if (after === "recovery-with-events") {
          return Response.json({
            events: [{ event: "item-updated", id: "9", data: {} }],
            nextCursor: null,
            snapshotRequired: { reason: "invalid-cursor" }
          });
        }
        if (after === "recovery-with-next-cursor") {
          return Response.json({ events: [], nextCursor: "5", snapshotRequired: { reason: "invalid-cursor" } });
        }
        if (after === "recovery-with-resume-cursor") {
          return Response.json({
            events: [], nextCursor: null, resumeCursor: "runtime-1:9",
            snapshotRequired: { reason: "invalid-cursor" }
          });
        }
        if (after === "recovery-with-null-resume-cursor") {
          return Response.json({
            events: [], nextCursor: null, resumeCursor: null,
            snapshotRequired: { reason: "invalid-cursor" }
          });
        }
        if (after === "recovery-whitespace-reason") {
          return Response.json({ events: [], nextCursor: null, snapshotRequired: { reason: "   " } });
        }
        if (after === "recovery-missing-reason") {
          return Response.json({ events: [], nextCursor: null, snapshotRequired: {} });
        }
        if (after === "recovery-missing-events") {
          return Response.json({ nextCursor: null, snapshotRequired: { reason: "invalid-cursor" } });
        }
        if (after === "recovery-non-array-events") {
          return Response.json({ events: "nope", nextCursor: null, snapshotRequired: { reason: "invalid-cursor" } });
        }
        if (after === "recovery-missing-next-cursor") {
          return Response.json({ events: [], snapshotRequired: { reason: "invalid-cursor" } });
        }
        if (after === "recovery-array-snapshot-required") {
          return Response.json({ events: [], nextCursor: null, snapshotRequired: ["invalid-cursor"] });
        }
        if (after === "final") {
          return Response.json({
            events: [{ event: "item-updated", id: "2", data: {} }],
            nextCursor: null,
            resumeCursor: "runtime-1:2"
          });
        }
        if (after === "empty") {
          return Response.json({ events: [], nextCursor: null, resumeCursor: "runtime-1:2" });
        }
        if (after === "malformed-page") {
          return Response.json({ events: "not-an-array", nextCursor: null, resumeCursor: "runtime-1:2" });
        }
        return Response.json({
          events: [{ event: "item-updated", id: "1", data: {} }],
          nextCursor: "1",
          resumeCursor: "runtime-1:1"
        });
      }
      return new Response("not found", { status: 404 });
    }
  });
  return { server, paths, base: `http://127.0.0.1:${server.port}` };
}

describe("M6-C STDIO diagnostic sanitization", () => {
  test("API error messages are redacted with the shared sanitizer (appSecret)", async () => {
    // JSON-quoted appSecret is the discriminating case: the old weak STDIO
    // sanitizer (key\s*[:=]\s*\S+) cannot match through the intervening quote
    // and would leak the value, so this test fails on revert.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ message: '{"appSecret":"my-secret-value"} Bearer tok123 rejected' }, { status: 500 })
    });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.getProviderStatus();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain("my-secret-value");
        expect(result.error.message).not.toContain("tok123");
        expect(result.error.message).toContain("[redacted]");
      }
    } finally {
      await server.stop(true);
    }
  });
});

describe("M6-B1 STDIO adapter", () => {
  test("searchCatalog calls the local catalog endpoint with translated params", async () => {
    const { server, paths, base } = stubApi();
    try {
      const services = createStdioServices(base);
      const result = await services.searchCatalog({ text: "NIFTY", limit: 10, afterCanonicalId: "id-1" });
      expect(result.ok).toBe(true);
      expect(paths[0]).toContain("/api/catalog/search");
      expect(paths[0]).toContain("text=NIFTY");
      expect(paths[0]).toContain("limit=10");
      expect(paths[0]).toContain("cursor=id-1");
    } finally {
      await server.stop(true);
    }
  });

  test("readEventFeed calls the local events endpoint and preserves snapshotRequired", async () => {
    const { server, paths, base } = stubApi();
    try {
      const services = createStdioServices(base);
      const ok = await services.readEventFeed({ after: "1", limit: 5 });
      expect(ok.ok).toBe(true);
      expect(paths[0]).toContain("/api/market/events");
      expect(paths[0]).toContain("after=1");
      expect(paths[0]).toContain("limit=5");

      const bad = await services.readEventFeed({ after: "bad", limit: 5 });
      expect(bad.ok).toBe(true);
      if (bad.ok) expect(bad.value.snapshotRequired?.reason).toBe("invalid-cursor");
    } finally {
      await server.stop(true);
    }
  });

  test("readEventFeed enforces the discriminated page contract", async () => {
    const { server, base } = stubApi();
    try {
      const services = createStdioServices(base);

      // Successful non-empty page: resumeCursor present, no snapshotRequired.
      const page = await services.readEventFeed({ limit: 5 });
      expect(page.ok).toBe(true);
      if (page.ok) {
        expect(typeof page.value.resumeCursor).toBe("string");
        expect(page.value.snapshotRequired).toBeUndefined();
        expect(page.value.events.length).toBe(1);
      }

      // Snapshot-recovery result: no resumeCursor, empty events, null nextCursor.
      const recovery = await services.readEventFeed({ after: "bad", limit: 5 });
      expect(recovery.ok).toBe(true);
      if (recovery.ok) {
        expect(recovery.value.events).toEqual([]);
        expect(recovery.value.nextCursor).toBeNull();
        expect(recovery.value.snapshotRequired?.reason).toBe("invalid-cursor");
        expect("resumeCursor" in recovery.value ? recovery.value.resumeCursor : undefined).toBeUndefined();
      }
    } finally {
      await server.stop(true);
    }
  });

  test("readEventFeed preserves resumeCursor on final and empty caught-up pages", async () => {
    const { server, base } = stubApi();
    try {
      const services = createStdioServices(base);

      // Final page: nextCursor null but resumeCursor still present.
      const final = await services.readEventFeed({ after: "final", limit: 5 });
      expect(final.ok).toBe(true);
      if (final.ok) {
        expect(final.value.nextCursor).toBeNull();
        expect(final.value.resumeCursor).toBe("runtime-1:2");
        expect(final.value.events.length).toBe(1);
        expect(final.value.snapshotRequired).toBeUndefined();
      }

      // Empty caught-up page: events empty, nextCursor null, resumeCursor present.
      const empty = await services.readEventFeed({ after: "empty", limit: 5 });
      expect(empty.ok).toBe(true);
      if (empty.ok) {
        expect(empty.value.events).toEqual([]);
        expect(empty.value.nextCursor).toBeNull();
        expect(empty.value.resumeCursor).toBe("runtime-1:2");
        expect(empty.value.snapshotRequired).toBeUndefined();
      }
    } finally {
      await server.stop(true);
    }
  });

  test("readEventFeed rejects malformed recovery and success envelopes", async () => {
    const { server, base } = stubApi();
    try {
      const services = createStdioServices(base);

      const malformedRecovery = await services.readEventFeed({ after: "malformed-recovery", limit: 5 });
      expect(malformedRecovery.ok).toBe(false);
      if (!malformedRecovery.ok) expect(malformedRecovery.error.message).toBe("Invalid feed response: malformed snapshot-recovery envelope");

      const malformedPage = await services.readEventFeed({ after: "malformed-page", limit: 5 });
      expect(malformedPage.ok).toBe(false);
      if (!malformedPage.ok) expect(malformedPage.error.message).toContain("malformed page envelope");
    } finally {
      await server.stop(true);
    }
  });

  test("readEventFeed accepts a valid snapshot-recovery envelope", async () => {
    const { server, base } = stubApi();
    try {
      const services = createStdioServices(base);
      const result = await services.readEventFeed({ after: "bad", limit: 5 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toEqual([]);
        expect(result.value.nextCursor).toBeNull();
        expect(result.value.snapshotRequired?.reason).toBe("invalid-cursor");
        expect("resumeCursor" in result.value).toBe(false);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("readEventFeed rejects contradictory snapshot-recovery envelopes", async () => {
    const { server, base } = stubApi();
    const cases = [
      "recovery-with-events",
      "recovery-with-next-cursor",
      "recovery-with-resume-cursor",
      "recovery-with-null-resume-cursor",
      "recovery-whitespace-reason",
      "recovery-missing-reason",
      "recovery-missing-events",
      "recovery-non-array-events",
      "recovery-missing-next-cursor",
      "recovery-array-snapshot-required"
    ];
    try {
      const services = createStdioServices(base);
      for (const after of cases) {
        const result = await services.readEventFeed({ after, limit: 5 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.category).toBe("unavailable");
          expect(result.error.message).toBe("Invalid feed response: malformed snapshot-recovery envelope");
          // Fixed message must not echo any payload data.
          expect(result.error.message).not.toContain("runtime-1");
          expect(result.error.message).not.toContain("invalid-cursor");
        }
      }
    } finally {
      await server.stop(true);
    }
  });

  test("readEventFeed rejects a successful response missing resumeCursor", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ events: [], nextCursor: null })
    });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.readEventFeed({ limit: 5 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("unavailable");
    } finally {
      await server.stop(true);
    }
  });

  test("HTTP errors map to consistent unavailable/validation results", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ message: "bad request" }, { status: 400 }) });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.searchCatalog({ text: "", limit: 25 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("validation");
    } finally {
      await server.stop(true);
    }
  });
});
