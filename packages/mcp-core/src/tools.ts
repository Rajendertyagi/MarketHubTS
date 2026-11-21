import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { McpActivityResultRef } from "@markethub/contracts";
import type { McpResult, McpServices } from "./services";
import { withActivity, safeSummary, type ActivityTransport } from "./activity";
import {
  catalogSearchInput, healthInput, historicalCandlesInput, marketSnapshotInput,
  onDemandRetrievalInput, optionChainSnapshotInput, parseRange, providerStatusInput,
  unavailableToolInput
} from "./schemas";

const UNAVAILABLE_MESSAGE = "unavailable in M6 — no shared service";

/** Map a failed McpResult to the standard isError tool result. */
function failure(error: Extract<McpResult<unknown>, { ok: false }>["error"]) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error }, null, 2) }],
    isError: true as const
  };
}

/** Map a successful value to text + structuredContent, matching the health tool. */
function success(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
const mayPersist = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** Record one tool callback without changing its result or exception. */
function record<T>(
  services: McpServices, transport: ActivityTransport, toolName: string,
  ctx: ServerContext, args: Record<string, unknown>, keys: readonly string[],
  operation: () => Promise<T>, resultRefHint?: () => McpActivityResultRef | undefined
): Promise<T> {
  return withActivity({
    services, transport, toolName, context: ctx,
    summary: safeSummary(args, keys), operation, resultRefHint
  });
}

/**
 * Register the nine M6-B2 tools in normative order. Pure registration only —
 * no background work, timers or process state. Called once per request/connection
 * by createMcpServer. M6-C wraps each callback for durable activity recording.
 */
export function registerTools(server: McpServer, services: McpServices, transport: ActivityTransport): void {
  // 1. markethub_health
  server.registerTool("markethub_health", {
    description: "Get MarketHubTS API and database health status via the local API.",
    inputSchema: healthInput,
    annotations: readOnly
  }, async (_args, ctx) => record(services, transport, "markethub_health", ctx, {}, [], async () => {
    const result = await services.getHealth();
    return result.ok ? success(result.value) : failure(result.error);
  }));

  // 2. catalog_search
  server.registerTool("catalog_search", {
    description: "Search the canonical instrument catalog by symbol, display name or identity key. Read-only, bounded, keyset-paginated.",
    inputSchema: catalogSearchInput,
    annotations: readOnly
  }, async (args, ctx) => record(services, transport, "catalog_search", ctx, args as Record<string, unknown>, ["query", "limit"], async () => {
    const result = await services.searchCatalog({
      text: args.query,
      limit: args.limit,
      ...(args.cursor !== undefined ? { afterCanonicalId: args.cursor } : {})
    });
    return result.ok ? success(result.value) : failure(result.error);
  }));

  // 3. provider_status
  server.registerTool("provider_status", {
    description: "Get composed UPSTOX and FYERS provider status, including runtime streaming state. Read-only.",
    inputSchema: providerStatusInput,
    annotations: readOnly
  }, async (_args, ctx) => record(services, transport, "provider_status", ctx, {}, [], async () => {
    const result = await services.getProviderStatus();
    return result.ok ? success(result.value) : failure(result.error);
  }));

  // 4. market_snapshot
  server.registerTool("market_snapshot", {
    description: "Get the canonical live market snapshot. When canonicalId is supplied, only snapshot.items are filtered; revision, capturedAtMs and connections are preserved. Read-only.",
    inputSchema: marketSnapshotInput,
    annotations: readOnly
  }, async (args, ctx) => record(services, transport, "market_snapshot", ctx, args as Record<string, unknown>, ["canonicalId"], async () => {
    const result = await services.getLiveSnapshot();
    if (!result.ok) return failure(result.error);
    const snapshot = result.value;
    if (args.canonicalId === undefined) return success(snapshot);
    return success({
      ...snapshot,
      items: snapshot.items.filter((item) => item.canonicalId === args.canonicalId)
    });
  }));

  // 5. historical_candles
  server.registerTool("historical_candles", {
    description: "Read cached candles or derived coverage for a canonical instrument and range. The onDemand mode may cache retrieved candles (a bounded persistence side effect); cached and coverage modes are read-only. Never changes saved sync configuration.",
    inputSchema: historicalCandlesInput,
    annotations: mayPersist
  }, async (args, ctx) => record(services, transport, "historical_candles", ctx, args as Record<string, unknown>, ["canonicalId", "interval", "mode", "from", "to"], async () => {
    const range = parseRange(args.from, args.to);
    if ("error" in range) return failure({ category: "validation", message: range.error });
    const request = { canonicalId: args.canonicalId, interval: args.interval, fromMs: range.fromMs, toMs: range.toMs };
    const result = args.mode === "cached"
      ? await services.getCachedCandles(request)
      : args.mode === "coverage"
        ? await services.getCoverage(request)
        : await services.fetchHistorical(request);
    return result.ok ? success(result.value) : failure(result.error);
  }, () => {
    const r = parseRange(args.from, args.to);
    if ("error" in r) return undefined;
    return { kind: "historical", canonicalId: args.canonicalId, interval: args.interval, fromMs: r.fromMs, toMs: r.toMs };
  }));

  // 6. option_chain_snapshot
  server.registerTool("option_chain_snapshot", {
    description: "List or get stored option-chain snapshots (read-only), or capture one on demand. Capture persists a snapshot with configId = null and does not read or modify saved capture configurations.",
    inputSchema: optionChainSnapshotInput,
    annotations: { ...mayPersist, idempotentHint: false }
  }, async (args, ctx) => record(services, transport, "option_chain_snapshot", ctx, args as Record<string, unknown>, ["mode", "configId", "snapshotId", "underlyingCanonicalId", "expiryDate"], async () => {
    if (args.mode === "list") {
      if (args.fromMs !== undefined && args.toMs !== undefined && args.fromMs > args.toMs) {
        return failure({ category: "validation", message: "fromMs must not be after toMs" });
      }
      const result = await services.listSnapshots({
        ...(args.configId !== undefined ? { configId: args.configId } : {}),
        ...(args.fromMs !== undefined ? { fromMs: args.fromMs } : {}),
        ...(args.toMs !== undefined ? { toMs: args.toMs } : {})
      });
      return result.ok ? success(result.value) : failure(result.error);
    }
    if (args.mode === "get") {
      const result = await services.getSnapshot(args.snapshotId);
      return result.ok ? success(result.value) : failure(result.error);
    }
    const result = await services.captureSnapshot({
      underlyingCanonicalId: args.underlyingCanonicalId,
      expiryDate: args.expiryDate,
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
      ...(args.strikeRangeJson !== undefined ? { strikeRangeJson: args.strikeRangeJson } : {}),
      ...(args.nativeIdentifier !== undefined ? { nativeIdentifier: args.nativeIdentifier } : {})
    });
    return result.ok ? success(result.value) : failure(result.error);
  }));

  // 7. on_demand_retrieval
  server.registerTool("on_demand_retrieval", {
    description: "Thin dispatch for on-demand data: historical retrieval may cache candles; option-chain capture persists a snapshot with configId = null. Never changes saved operational configuration.",
    inputSchema: onDemandRetrievalInput,
    annotations: { ...mayPersist, idempotentHint: false }
  }, async (args, ctx) => record(services, transport, "on_demand_retrieval", ctx, args as Record<string, unknown>, ["kind", "canonicalId", "interval", "from", "to", "expiryDate"], async () => {
    if (args.kind === "historical") {
      if (args.interval === undefined || args.from === undefined || args.to === undefined) {
        return failure({ category: "validation", message: "historical retrieval requires interval, from and to" });
      }
      const range = parseRange(args.from, args.to);
      if ("error" in range) return failure({ category: "validation", message: range.error });
      const result = await services.fetchHistorical({
        canonicalId: args.canonicalId, interval: args.interval, fromMs: range.fromMs, toMs: range.toMs
      });
      if (!result.ok) return success({ kind: "historical", status: "unavailable", tool: "historical_candles", error: result.error });
      return success({ kind: "historical", status: "ok", tool: "historical_candles", result: result.value });
    }
    if (args.expiryDate === undefined) {
      return failure({ category: "validation", message: "option_chain retrieval requires expiryDate" });
    }
    const result = await services.captureSnapshot({
      underlyingCanonicalId: args.canonicalId,
      expiryDate: args.expiryDate,
      ...(args.provider !== undefined ? { provider: args.provider } : {})
    });
    if (!result.ok) return success({ kind: "option_chain", status: "unavailable", tool: "option_chain_snapshot", error: result.error });
    if (result.value.snapshot === null) {
      return success({
        kind: "option_chain", status: "unavailable", tool: "option_chain_snapshot",
        error: { category: "provider", message: result.value.error ?? "Capture unavailable" }
      });
    }
    return success({ kind: "option_chain", status: "ok", tool: "option_chain_snapshot", result: result.value });
  }, () => {
    if (args.kind !== "historical" || args.interval === undefined || args.from === undefined || args.to === undefined) return undefined;
    const r = parseRange(args.from, args.to);
    if ("error" in r) return undefined;
    return { kind: "historical", canonicalId: args.canonicalId, interval: args.interval, fromMs: r.fromMs, toMs: r.toMs };
  }));

  // 8. futures_chain — unavailable in M6
  server.registerTool("futures_chain", {
    description: "Unavailable in M6 — no shared futures-chain service exists.",
    inputSchema: unavailableToolInput,
    annotations: readOnly
  }, async (_args, ctx) => record(services, transport, "futures_chain", ctx, {}, [], async () =>
    failure({ category: "unavailable", message: UNAVAILABLE_MESSAGE })));

  // 9. market_information — unavailable in M6
  server.registerTool("market_information", {
    description: "Unavailable in M6 — no shared market-information service exists.",
    inputSchema: unavailableToolInput,
    annotations: readOnly
  }, async (_args, ctx) => record(services, transport, "market_information", ctx, {}, [], async () =>
    failure({ category: "unavailable", message: UNAVAILABLE_MESSAGE })));
}
