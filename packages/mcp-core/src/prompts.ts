import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * Register the three M6-B3 prompts. Prompts are static text-only guidance:
 * they never call services or tools and have no side effects. Registered once
 * per request/connection by createMcpServer, in deterministic order.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt("explain_market_snapshot", {
    title: "Explain a market snapshot",
    description: "Guidance for reading the canonical live market snapshot resource.",
    argsSchema: z.object({ canonicalId: z.string().min(1).optional() })
  }, ({ canonicalId }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          "Read the markethub://market/snapshot resource (or call the market_snapshot tool",
          canonicalId ? `with canonicalId ${canonicalId}` : "with an optional canonicalId filter",
          "). Explain revision, capturedAtMs, selected provider and canonical fields only.",
          "An empty snapshot is an honest state — never invent prices or depth."
        ].join(" ")
      }
    }]
  }));

  server.registerPrompt("interpret_coverage_gaps", {
    title: "Interpret coverage gaps",
    description: "Guidance for interpreting historical candle coverage and gaps.",
    argsSchema: z.object({
      canonicalId: z.string().min(1),
      interval: z.string().min(1),
      from: z.string().min(1),
      to: z.string().min(1)
    })
  }, ({ canonicalId, interval, from, to }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          `Call historical_candles with mode "coverage" for canonicalId ${canonicalId},`,
          `interval ${interval}, from ${from}, to ${to}. Explain each gap and unavailable`,
          "note using the service's own reports. Never fabricate missing candles."
        ].join(" ")
      }
    }]
  }));

  server.registerPrompt("how_to_capture_snapshot", {
    title: "How to capture an option-chain snapshot",
    description: "Guidance for on-demand option-chain capture and its persistence semantics.",
    argsSchema: z.object({})
  }, () => ({
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
  }));
}
