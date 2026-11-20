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
        // Validate the complete discriminated envelope before returning ok:true.
        // A snapshot-recovery result must be internally consistent: a non-null
        // object reason, zero events, an explicitly null nextCursor and no
        // resumeCursor property at all (even null). A successful page must have
        // an events array, a string|null nextCursor, a string resumeCursor and
        // no snapshotRequired. No defaulting, casts or coercion; fixed messages
        // so malformed payload data is never echoed back.
        const recoveryMessage = "Invalid feed response: malformed snapshot-recovery envelope";
        if (json.snapshotRequired !== undefined) {
          const recovery = json.snapshotRequired;
          const reason = recovery !== null && typeof recovery === "object" && !Array.isArray(recovery)
            ? recovery.reason
            : undefined;
          if (
            typeof reason !== "string" ||
            reason.trim().length === 0 ||
            !Array.isArray(json.events) ||
            json.events.length !== 0 ||
            json.nextCursor !== null ||
            Object.prototype.hasOwnProperty.call(json, "resumeCursor")
          ) {
            return { ok: false, error: { category: "unavailable", message: recoveryMessage } };
          }
          return {
            ok: true,
            value: { events: [], nextCursor: null, snapshotRequired: { reason } }
          };
        }
        if (
          !Array.isArray(json.events) ||
          !(json.nextCursor === null || typeof json.nextCursor === "string") ||
          typeof json.resumeCursor !== "string"
        ) {
          return {
            ok: false,
            error: { category: "unavailable", message: "Invalid feed response: malformed page envelope" }
          };
        }
        return {
          ok: true,
          value: { events: json.events, nextCursor: json.nextCursor, resumeCursor: json.resumeCursor }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { category: "unavailable", message } };
      }
    }
  };
}
