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
        if (url.searchParams.get("after") === "bad") {
          return Response.json({ events: [], nextCursor: null, snapshotRequired: { reason: "invalid-cursor" } });
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
