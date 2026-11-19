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
        return Response.json({ events: [{ event: "item-updated", id: "1", data: {} }], nextCursor: "1" });
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
