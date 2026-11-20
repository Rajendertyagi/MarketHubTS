import {
  INTERNAL_ERROR, INVALID_PARAMS, ProtocolError, ResourceNotFoundError, ResourceTemplate,
  type ReadResourceResult, type ServerContext, type Variables
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { candleIntervalSchema } from "@markethub/contracts";
import { withActivity, safeSummary, type ActivityTransport } from "./activity";
import { parseRange } from "./schemas";
import type { McpServices } from "./services";

/** Explicit error helpers — a failed read is never an empty success. */
function invalid(message: string): never {
  throw new ProtocolError(INVALID_PARAMS, message);
}
function unavailable(message: string): never {
  throw new ProtocolError(INTERNAL_ERROR, message);
}
function notFound(uri: string): never {
  throw new ResourceNotFoundError(uri);
}

/** Map a failed McpResult to the appropriate protocol error. */
function mapFailure(error: { category: string; message: string }): never {
  if (error.category === "validation") invalid(error.message);
  return unavailable(error.message);
}

/** Decode a URI-template variable. match() returns raw (still encoded) values. */
function decodeVar(variables: Variables, name: string): string {
  const raw = variables[name];
  if (typeof raw !== "string" || raw.length === 0) invalid(`Missing resource variable: ${name}`);
  try {
    return decodeURIComponent(raw);
  } catch {
    return invalid(`Malformed percent-encoding in resource variable: ${name}`);
  }
}

function parseLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) invalid("limit must be an integer between 1 and 100");
  return value;
}

/** The non-empty "first" sentinel means no cursor on the first page. */
function cursorFrom(decoded: string): string | undefined {
  return decoded === "first" ? undefined : decoded;
}

function contents(uri: URL, value: unknown): ReadResourceResult {
  return {
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }]
  };
}

/** Record one resource-read callback without changing its result or exception. */
function record<T>(
  services: McpServices, transport: ActivityTransport, toolName: string,
  ctx: ServerContext, variables: Variables, keys: readonly string[],
  operation: () => Promise<T>, extra: Record<string, unknown> = {}
): Promise<T> {
  return withActivity({
    services, transport, toolName, context: ctx,
    summary: { ...safeSummary(variables as Record<string, unknown>, keys), ...safeSummary(extra, Object.keys(extra)) },
    operation
  });
}

/** Whether a cursor/after variable was supplied (never the opaque value itself). */
function hasCursor(variables: Variables, name: string): boolean {
  const raw = variables[name];
  return typeof raw === "string" && raw.length > 0 && raw !== "first";
}

/**
 * Register the six logical M6-B3 resources (2 static + 5 templates — snapshot
 * pagination is split into two templates so "none" stays a valid config ID).
 * M6-C wraps each read callback for durable activity recording.
 */
export function registerResources(server: McpServer, services: McpServices, transport: ActivityTransport): void {
  // 1. Catalog instruments (template) — requires a non-empty query.
  server.registerResource(
    "catalog-instruments",
    new ResourceTemplate("markethub://catalog/instruments{?query,limit,cursor}", { list: undefined }),
    {
      title: "Catalog instruments",
      description: "Bounded, keyset-paginated canonical instrument search. Requires a non-empty query; no unfiltered listing.",
      mimeType: "application/json"
    },
    async (uri, variables, ctx) => record(services, transport, "catalog-instruments", ctx, variables, ["query", "limit"], async () => {
      const query = decodeVar(variables, "query");
      if (query.trim().length === 0) invalid("query must be non-empty");
      const limit = parseLimit(decodeVar(variables, "limit"));
      const cursor = cursorFrom(decodeVar(variables, "cursor"));
      const result = await services.searchCatalog({
        text: query,
        limit,
        ...(cursor !== undefined ? { afterCanonicalId: cursor } : {})
      });
      if (!result.ok) return mapFailure(result.error);
      return contents(uri, result.value);
    }, { hasCursor: hasCursor(variables, "cursor") })
  );

  // 2. Market snapshot (static).
  server.registerResource(
    "market-snapshot",
    "markethub://market/snapshot",
    {
      title: "Market snapshot",
      description: "Canonical live market snapshot (quotes/depth). Empty state is honest, never fabricated.",
      mimeType: "application/json"
    },
    async (uri, ctx) => record(services, transport, "market-snapshot", ctx, {}, [], async () => {
      const result = await services.getLiveSnapshot();
      if (!result.ok) return mapFailure(result.error);
      return contents(uri, result.value);
    })
  );

  // 3. Historical candles + coverage (template).
  server.registerResource(
    "historical-candles",
    new ResourceTemplate("markethub://historical/{canonicalId}/{interval}{?from,to}", { list: undefined }),
    {
      title: "Historical candles and coverage",
      description: "Cached candles plus derived coverage for a canonical instrument and ISO-8601 range.",
      mimeType: "application/json"
    },
    async (uri, variables, ctx) => record(services, transport, "historical-candles", ctx, variables, ["canonicalId", "interval", "from", "to"], async () => {
      const canonicalId = decodeVar(variables, "canonicalId");
      const intervalParsed = candleIntervalSchema.safeParse(decodeVar(variables, "interval"));
      if (!intervalParsed.success) invalid("invalid candle interval");
      const interval = intervalParsed.data;
      const from = decodeVar(variables, "from");
      const to = decodeVar(variables, "to");
      const range = parseRange(from, to);
      if ("error" in range) invalid(range.error);
      const req = { canonicalId, interval, fromMs: range.fromMs, toMs: range.toMs };
      const [candles, coverage] = await Promise.all([
        services.getCachedCandles(req), services.getCoverage(req)
      ]);
      if (!candles.ok) return mapFailure(candles.error);
      if (!coverage.ok) return mapFailure(coverage.error);
      return contents(uri, { candles: candles.value.candles, coverage: coverage.value });
    })
  );

  // 4a. Snapshots by real config id (template). "none" is a valid config id here.
  server.registerResource(
    "snapshots-config",
    new ResourceTemplate("markethub://snapshots/config/{configId}{?cursor}", { list: undefined }),
    {
      title: "Snapshots by capture configuration",
      description: "Newest-first bounded page of snapshots for a real capture configuration ID (including 'none'). Stored-data opaque cursor.",
      mimeType: "application/json"
    },
    async (uri, variables, ctx) => record(services, transport, "snapshots-config", ctx, variables, ["configId"], async () => {
      const configId = decodeVar(variables, "configId");
      const cursor = cursorFrom(decodeVar(variables, "cursor"));
      const result = await services.listSnapshotsPage({
        selector: { kind: "config", configId }, limit: 25,
        ...(cursor !== undefined ? { cursor } : {})
      });
      if (!result.ok) {
        if (result.error.reason === "unknown_config") notFound(uri.href);
        return mapFailure(result.error);
      }
      return contents(uri, result.value);
    }, { hasCursor: hasCursor(variables, "cursor") })
  );

  // 4b. Null-config partition (template) — on-demand + config-deleted snapshots.
  server.registerResource(
    "snapshots-null-config",
    new ResourceTemplate("markethub://snapshots/null-config{?cursor}", { list: undefined }),
    {
      title: "Null-config snapshots",
      description: "Newest-first bounded page of snapshots with no capture config: on-demand captures and snapshots retained after config deletion. Stored-data opaque cursor.",
      mimeType: "application/json"
    },
    async (uri, variables, ctx) => record(services, transport, "snapshots-null-config", ctx, variables, [], async () => {
      const cursor = cursorFrom(decodeVar(variables, "cursor"));
      const result = await services.listSnapshotsPage({
        selector: { kind: "null-config" }, limit: 25,
        ...(cursor !== undefined ? { cursor } : {})
      });
      if (!result.ok) return mapFailure(result.error);
      return contents(uri, result.value);
    }, { hasCursor: hasCursor(variables, "cursor") })
  );

  // 5. Live event feed (template) — runtime-scoped cursor, not restart-safe.
  server.registerResource(
    "events-live",
    new ResourceTemplate("markethub://events/live{?after,limit}", { list: undefined }),
    {
      title: "Live event feed",
      description: "Bounded replay page from the in-memory live event hub. Cursor is runtime-scoped and does not survive restart; snapshot-required is an explicit recovery result.",
      mimeType: "application/json"
    },
    async (uri, variables, ctx) => record(services, transport, "events-live", ctx, variables, ["limit"], async () => {
      const after = cursorFrom(decodeVar(variables, "after"));
      const limit = parseLimit(decodeVar(variables, "limit"));
      const result = await services.readEventFeed({ limit, ...(after !== undefined ? { after } : {}) });
      if (!result.ok) return mapFailure(result.error);
      return contents(uri, result.value);
    }, { hasCursor: hasCursor(variables, "after") })
  );

  // 6. Alerts feed (static) — contract-only, explicitly unavailable in M6.
  server.registerResource(
    "events-alerts",
    "markethub://events/alerts",
    {
      title: "Alert events (unavailable in M6)",
      description: "Contract-only placeholder. Durable alert records are an M7 dependency; reads return an explicit unavailable error, never an empty feed.",
      mimeType: "application/json"
    },
    async (_uri, ctx) => record(services, transport, "events-alerts", ctx, {}, [], async () =>
      unavailable("unavailable in M6 — alert events are an M7 dependency"))
  );
}
