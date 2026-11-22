import { describe, expect, test } from "bun:test";
import {
  mcpOperationDescriptorSchema, mcpOperationListSchema, mcpOperationTypeSchema
} from "../../packages/contracts/src/index";
import {
  listMcpOperationDescriptors, TOOL_DESCRIPTORS, RESOURCE_DESCRIPTORS, PROMPT_DESCRIPTORS
} from "../../packages/mcp-core/src/index";

const SAFE_KEYS = ["name", "type", "title", "description"];

describe("MCP operation descriptors", () => {
  test("contains exactly 19 descriptors with unique stable names", () => {
    const all = listMcpOperationDescriptors();
    expect(all).toHaveLength(19);
    expect(new Set(all.map((d) => d.name)).size).toBe(19);
  });

  test("has the expected type counts (9 tools, 7 resources, 3 prompts)", () => {
    expect(TOOL_DESCRIPTORS).toHaveLength(9);
    expect(RESOURCE_DESCRIPTORS).toHaveLength(7);
    expect(PROMPT_DESCRIPTORS).toHaveLength(3);
    const all = listMcpOperationDescriptors();
    expect(all.filter((d) => d.type === "tool")).toHaveLength(9);
    expect(all.filter((d) => d.type === "resource")).toHaveLength(7);
    expect(all.filter((d) => d.type === "prompt")).toHaveLength(3);
  });

  test("every descriptor passes the shared strict schema", () => {
    for (const descriptor of listMcpOperationDescriptors()) {
      expect(mcpOperationDescriptorSchema.safeParse(descriptor).success).toBe(true);
    }
    expect(mcpOperationListSchema.safeParse({ operations: listMcpOperationDescriptors() }).success).toBe(true);
  });

  test("strict validation drops no extra fields because none exist", () => {
    for (const descriptor of listMcpOperationDescriptors()) {
      const parsed = mcpOperationDescriptorSchema.parse(descriptor);
      expect(Object.keys(parsed).sort()).toEqual(Object.keys(descriptor).sort());
    }
  });

  test("list ordering is deterministic across calls", () => {
    expect(listMcpOperationDescriptors()).toEqual(listMcpOperationDescriptors());
    expect(listMcpOperationDescriptors().map((d) => d.name)).toEqual([
      "markethub_health", "catalog_search", "provider_status", "market_snapshot",
      "historical_candles", "option_chain_snapshot", "on_demand_retrieval",
      "futures_chain", "market_information",
      "catalog-instruments", "market-snapshot", "historical-candles",
      "snapshots-config", "snapshots-null-config", "events-live", "events-alerts",
      "explain_market_snapshot", "interpret_coverage_gaps", "how_to_capture_snapshot"
    ]);
  });

  test("descriptors contain only safe display metadata", () => {
    for (const descriptor of listMcpOperationDescriptors()) {
      for (const key of Object.keys(descriptor)) {
        expect(SAFE_KEYS).toContain(key);
      }
      expect(mcpOperationTypeSchema.safeParse(descriptor.type).success).toBe(true);
      // Tools have no title; resources and prompts always have one.
      expect("title" in descriptor).toBe(descriptor.type !== "tool");
    }
  });

  test("strict schema rejects a tool title and a missing resource title", () => {
    const tool = listMcpOperationDescriptors().find((d) => d.type === "tool")!;
    expect(mcpOperationDescriptorSchema.safeParse({ ...tool, title: "extra" }).success).toBe(false);
    const resource = listMcpOperationDescriptors().find((d) => d.type === "resource")!;
    const { title: _title, ...withoutTitle } = resource;
    expect(mcpOperationDescriptorSchema.safeParse(withoutTitle).success).toBe(false);
  });
});
