import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { withActivity, safeSummary, type ActivityTransport } from "./activity";
import type { McpServices } from "./services";

/** Record one prompt callback. Guidance stays static; only recording uses services. */
function record<T>(
  services: McpServices, transport: ActivityTransport, toolName: string,
  ctx: ServerContext, args: Record<string, unknown>, keys: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  return withActivity({
    services, transport, toolName, context: ctx,
    summary: safeSummary(args, keys), operation
  });
}

/**
 * Register the three M6-B3 prompts. Prompts are static text-only guidance:
 * they never call data services or tools and have no side effects. M6-C wraps
 * each callback for activity recording only.
 */
export function registerPrompts(server: McpServer, services: McpServices, transport: ActivityTransport): void {
  server.registerPrompt("explain_market_snapshot", {
    title: "Explain a market snapshot",
    description: "Guidance for reading the canonical live market snapshot resource.",
    argsSchema: z.object({ canonicalId: z.string().min(1).optional() })
  }, (args, ctx) => record(services, transport, "explain_market_snapshot", ctx, args as Record<string, unknown>, ["canonicalId"], async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          "Read the markethub://market/snapshot resource (or call the market_snapshot tool",
          args.canonicalId ? `with canonicalId ${args.canonicalId}` : "with an optional canonicalId filter",
          "). Explain revision, capturedAtMs, selected provider and canonical fields only.",
          "An empty snapshot is an honest state — never invent prices or depth."
        ].join(" ")
      }
    }]
  })));

  server.registerPrompt("interpret_coverage_gaps", {
    title: "Interpret coverage gaps",
    description: "Guidance for interpreting historical candle coverage and gaps.",
    argsSchema: z.object({
      canonicalId: z.string().min(1),
      interval: z.string().min(1),
      from: z.string().min(1),
      to: z.string().min(1)
    })
  }, (args, ctx) => record(services, transport, "interpret_coverage_gaps", ctx, args as Record<string, unknown>, ["canonicalId", "interval", "from", "to"], async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          `Call historical_candles with mode "coverage" for canonicalId ${args.canonicalId},`,
          `interval ${args.interval}, from ${args.from}, to ${args.to}. Explain each gap and unavailable`,
          "note using the service's own reports. Never fabricate missing candles."
        ].join(" ")
      }
    }]
  })));

  server.registerPrompt("how_to_capture_snapshot", {
    title: "How to capture an option-chain snapshot",
    description: "Guidance for on-demand option-chain capture and its persistence semantics.",
    argsSchema: z.object({})
  }, (_args, ctx) => record(services, transport, "how_to_capture_snapshot", ctx, {}, [], async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          "Call option_chain_snapshot with mode \"capture\". On-demand capture persists a",
          "snapshot with configId = null and does not read or modify saved capture",
          "configuration. The result is visible in the WebUI Snapshot panel."
        ].join(" ")
      }
    }]
  })));
}
