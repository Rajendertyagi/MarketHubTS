import { healthStatusSchema } from "@markethub/contracts";
import type { McpServices } from "@markethub/mcp-core";

/**
 * STDIO reaches the canonical API through its existing local-API client pattern.
 * Exported as a factory so the adapter can be tested directly without spawning
 * the process; index.ts uses the same factory in production.
 */
export function createStdioServices(apiBase: string): McpServices {
  return {
    getHealth: async () => {
      try {
        const res = await fetch(`${apiBase}/health`);
        const json = await res.json();
        const parsed = healthStatusSchema.safeParse(json);
        if (!res.ok || !parsed.success) {
          return {
            ok: false,
            error: { category: "unavailable", message: `API health check failed (status ${res.status})` }
          };
        }
        return { ok: true, value: parsed.data };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { category: "unavailable", message } };
      }
    },
    searchCatalog: async (req) => {
      try {
        const params = new URLSearchParams({ text: req.text, limit: String(req.limit) });
        if (req.afterCanonicalId !== undefined) params.set("cursor", req.afterCanonicalId);
        const res = await fetch(`${apiBase}/api/catalog/search?${params}`);
        const json = await res.json();
        if (!res.ok) {
          return {
            ok: false,
            error: { category: res.status === 400 ? "validation" : "unavailable", message: String(json?.message ?? `status ${res.status}`) }
          };
        }
        return { ok: true, value: { instruments: json.instruments ?? [], nextCursor: json.nextCursor ?? null } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { category: "unavailable", message } };
      }
    },
    readEventFeed: async (req) => {
      try {
        const params = new URLSearchParams({ limit: String(req.limit) });
        if (req.after !== undefined) params.set("after", req.after);
        const res = await fetch(`${apiBase}/api/market/events?${params}`);
        const json = await res.json();
        if (!res.ok) {
          return {
            ok: false,
            error: { category: res.status === 400 ? "validation" : "unavailable", message: String(json?.message ?? `status ${res.status}`) }
          };
        }
        // Snapshot-recovery results carry no checkpoint; successful pages must
        // carry a string resumeCursor. Validate rather than defaulting.
        if (json.snapshotRequired) {
          return {
            ok: true,
            value: {
              events: [],
              nextCursor: null,
              snapshotRequired: { reason: String(json.snapshotRequired.reason) }
            }
          };
        }
        if (typeof json.resumeCursor !== "string") {
          return {
            ok: false,
            error: { category: "unavailable", message: "Invalid feed response: missing resumeCursor" }
          };
        }
        return {
          ok: true,
          value: {
            events: json.events ?? [],
            nextCursor: json.nextCursor ?? null,
            resumeCursor: json.resumeCursor
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { category: "unavailable", message } };
      }
    }
  };
}
