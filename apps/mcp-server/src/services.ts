import {
  healthStatusSchema, providerStatusMapSchema, liveSnapshotSchema, historicalCandleSchema,
  candleGapSchema, candleRangeNoteSchema, optionChainSnapshotSchema,
  mcpActivityStartResultSchema, mcpActivityCompleteResultSchema
} from "@markethub/contracts";
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
    },
    getProviderStatus: async () => {
      try {
        const res = await fetch(`${apiBase}/api/providers/status`);
        const json = await res.json();
        if (!res.ok) {
          return { ok: false, error: { category: "unavailable", message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        }
        const parsed = providerStatusMapSchema.safeParse(json?.providers);
        return parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, error: { category: "unavailable", message: "Invalid provider status response" } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    getLiveSnapshot: async () => {
      try {
        const res = await fetch(`${apiBase}/api/market/snapshot`);
        const json = await res.json();
        if (!res.ok) return { ok: false, error: { category: "unavailable", message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        const parsed = liveSnapshotSchema.safeParse(json);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: { category: "unavailable", message: "Invalid snapshot response" } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    getCachedCandles: async (req) => {
      try {
        const params = new URLSearchParams({
          canonicalId: req.canonicalId, interval: req.interval, from: String(req.fromMs), to: String(req.toMs)
        });
        const res = await fetch(`${apiBase}/api/historical/candles?${params}`);
        const json = await res.json();
        if (!res.ok) return { ok: false, error: { category: res.status === 400 ? "validation" : "unavailable", message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        const parsed = zArray(json?.candles, historicalCandleSchema);
        return parsed.ok ? { ok: true, value: { candles: parsed.value } } : { ok: false, error: { category: "unavailable", message: "Invalid candles response" } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    getCoverage: async (req) => {
      try {
        const params = new URLSearchParams({
          canonicalId: req.canonicalId, interval: req.interval, from: String(req.fromMs), to: String(req.toMs)
        });
        const res = await fetch(`${apiBase}/api/historical/coverage?${params}`);
        const json = await res.json();
        if (!res.ok) return { ok: false, error: { category: res.status === 400 ? "validation" : "unavailable", message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        const gaps = zArray(json?.gaps, candleGapSchema);
        const notes = zArray(json?.unavailableNotes, candleRangeNoteSchema);
        return gaps.ok && notes.ok
          ? { ok: true, value: { gaps: gaps.value, unavailableNotes: notes.value } }
          : { ok: false, error: { category: "unavailable", message: "Invalid coverage response" } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    fetchHistorical: async (req) => {
      try {
        const res = await fetch(`${apiBase}/api/historical/fetch`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canonicalId: req.canonicalId, interval: req.interval, fromMs: req.fromMs, toMs: req.toMs })
        });
        const json = await res.json();
        if (!res.ok) return { ok: false, error: { category: res.status === 400 ? "validation" : "unavailable", message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        const candles = zArray(json?.candles, historicalCandleSchema);
        const gaps = zArray(json?.gaps, candleGapSchema);
        if (!candles.ok || !gaps.ok || !Array.isArray(json?.unavailable) || typeof json?.conflicts !== "number" || !Array.isArray(json?.providersTried)) {
          return { ok: false, error: { category: "unavailable", message: "Invalid historical fetch response" } };
        }
        return { ok: true, value: { candles: candles.value, gaps: gaps.value, unavailable: json.unavailable, conflicts: json.conflicts, providersTried: json.providersTried } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    listSnapshots: async (filter) => {
      try {
        const params = new URLSearchParams();
        if (filter.configId !== undefined) params.set("configId", filter.configId);
        if (filter.fromMs !== undefined) params.set("from", String(filter.fromMs));
        if (filter.toMs !== undefined) params.set("to", String(filter.toMs));
        const res = await fetch(`${apiBase}/api/snapshots?${params}`);
        const json = await res.json();
        if (!res.ok) return { ok: false, error: { category: "unavailable", message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        const parsed = zArray(json?.snapshots, optionChainSnapshotSchema);
        return parsed.ok ? { ok: true, value: { snapshots: parsed.value } } : { ok: false, error: { category: "unavailable", message: "Invalid snapshots response" } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    listSnapshotsPage: async (req) => {
      try {
        const params = new URLSearchParams({ scope: req.selector.kind, limit: String(req.limit) });
        if (req.selector.kind === "config") params.set("configId", req.selector.configId);
        if (req.cursor !== undefined) params.set("cursor", req.cursor);
        const res = await fetch(`${apiBase}/api/snapshots/page?${params}`);
        const json = await res.json();
        if (res.status === 404) {
          return { ok: false, error: { category: "unavailable", message: "Unknown capture configuration", reason: "unknown_config" } };
        }
        if (!res.ok) {
          const category = res.status === 400 ? "validation" : "unavailable";
          return { ok: false, error: { category, message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        }
        const parsed = zArray(json?.snapshots, optionChainSnapshotSchema);
        if (!parsed.ok || !(json.nextCursor === null || typeof json.nextCursor === "string")) {
          return { ok: false, error: { category: "unavailable", message: "Invalid snapshot page response" } };
        }
        return { ok: true, value: { snapshots: parsed.value, nextCursor: json.nextCursor } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    getSnapshot: async (id) => {
      try {
        const res = await fetch(`${apiBase}/api/snapshots/${encodeURIComponent(id)}`);
        const json = await res.json();
        if (res.status === 404) return { ok: false, error: { category: "unavailable", message: "Snapshot not found" } };
        if (!res.ok) return { ok: false, error: { category: "unavailable", message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        const parsed = optionChainSnapshotSchema.safeParse(json?.snapshot);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: { category: "unavailable", message: "Invalid snapshot response" } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    },
    startActivity: async (req) => {
      try {
        const res = await fetchWithTimeout(`${apiBase}/api/mcp/activity/start`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req)
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          activityDiagnostic(`activity start failed (status ${res.status})`);
          return { ok: false, error: { category: "unavailable", message: `activity start failed (status ${res.status})` } };
        }
        const parsed = mcpActivityStartResultSchema.safeParse(json);
        if (!parsed.success) {
          activityDiagnostic("invalid activity start response");
          return { ok: false, error: { category: "unavailable", message: "Invalid activity start response" } };
        }
        return { ok: true, value: parsed.data };
      } catch (error) {
        activityDiagnostic(error instanceof Error ? error.message : String(error));
        return { ok: false, error: { category: "unavailable", message: "activity start unavailable" } };
      }
    },
    completeActivity: async (req) => {
      try {
        const res = await fetchWithTimeout(`${apiBase}/api/mcp/activity/complete`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req)
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          activityDiagnostic(`activity complete failed (status ${res.status})`);
          return { ok: false, error: { category: "unavailable", message: `activity complete failed (status ${res.status})` } };
        }
        const parsed = mcpActivityCompleteResultSchema.safeParse(json);
        if (!parsed.success) {
          activityDiagnostic("invalid activity complete response");
          return { ok: false, error: { category: "unavailable", message: "Invalid activity complete response" } };
        }
        return { ok: true, value: parsed.data };
      } catch (error) {
        activityDiagnostic(error instanceof Error ? error.message : String(error));
        return { ok: false, error: { category: "unavailable", message: "activity complete unavailable" } };
      }
    },
    captureSnapshot: async (req) => {
      try {
        const body: Record<string, unknown> = { underlyingCanonicalId: req.underlyingCanonicalId, expiryDate: req.expiryDate };
        if (req.provider !== undefined) body.provider = req.provider;
        if (req.strikeRangeJson !== undefined) body.strikeRangeJson = req.strikeRangeJson;
        if (req.nativeIdentifier !== undefined) body.nativeIdentifier = req.nativeIdentifier;
        const res = await fetch(`${apiBase}/api/snapshots/capture`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const json = await res.json();
        if (res.status === 422 && json?.error === "capture_unavailable") {
          return { ok: true, value: { snapshot: null, error: sanitizeMessage(json?.message, "Capture unavailable") } };
        }
        if (!res.ok) {
          const category = res.status === 400 ? "validation" : "unavailable";
          return { ok: false, error: { category, message: sanitizeMessage(json?.message, `status ${res.status}`) } };
        }
        const parsed = optionChainSnapshotSchema.safeParse(json?.snapshot);
        return parsed.success
          ? { ok: true, value: { snapshot: parsed.data, error: null } }
          : { ok: false, error: { category: "unavailable", message: "Invalid capture response" } };
      } catch (error) {
        return { ok: false, error: { category: "unavailable", message: error instanceof Error ? error.message : String(error) } };
      }
    }
  };
}

/** Bounded activity write so a slow API cannot indefinitely delay a tool operation. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Activity diagnostics go to stderr only — stdout is reserved for the MCP protocol. */
function activityDiagnostic(message: string): void {
  try {
    process.stderr.write(`[markethub-activity] ${sanitizeMessage(message, "activity diagnostic").slice(0, 300)}\n`);
  } catch { /* diagnostics are best-effort */ }
}

/** Strip credentials/tokens from an API error message before surfacing it. */
function sanitizeMessage(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 300);
}

/** Validate an array of canonical values from an untrusted API response. */
function zArray<T>(value: unknown, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): { ok: true; value: T[] } | { ok: false } {
  if (!Array.isArray(value)) return { ok: false };
  const out: T[] = [];
  for (const item of value) {
    const parsed = schema.safeParse(item);
    if (!parsed.success) return { ok: false };
    out.push(parsed.data);
  }
  return { ok: true, value: out };
}
