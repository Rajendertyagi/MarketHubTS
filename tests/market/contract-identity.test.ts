import { describe, expect, test } from "bun:test";
import {
  LIVE_EVENT, LIVE_EVENT_NAMES,
  mcpActivityStatusSchema, mcpActivityTransportSchema,
  optionTypeSchema, providerIdSchema, providerSchema
} from "../../packages/contracts/src/index";

describe("Phase 1 shared contract identity", () => {
  test("provider identity has one canonical schema with compatibility aliases", () => {
    expect(providerIdSchema.options).toEqual(["UPSTOX", "FYERS"]);
    expect(providerSchema).toBe(providerIdSchema);
    expect(providerIdSchema.safeParse("UPSTOX").success).toBe(true);
    expect(providerIdSchema.safeParse("FYERS").success).toBe(true);
    expect(providerIdSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  test("option type and activity transport keep their canonical values", () => {
    expect(optionTypeSchema.options).toEqual(["CE", "PE"]);
    expect(mcpActivityTransportSchema.options).toEqual(["HTTP", "STDIO"]);
    expect(mcpActivityStatusSchema.options).toEqual(["started", "succeeded", "failed", "interrupted"]);
  });

  test("SSE event names are pinned to the exact six wire names in order", () => {
    expect(LIVE_EVENT_NAMES).toEqual([
      "snapshot",
      "item-updated",
      "item-removed",
      "provider-connection-changed",
      "snapshot-required",
      "refresh"
    ]);
    expect(LIVE_EVENT.snapshot).toBe("snapshot");
    expect(LIVE_EVENT.itemUpdated).toBe("item-updated");
    expect(LIVE_EVENT.itemRemoved).toBe("item-removed");
    expect(LIVE_EVENT.providerConnectionChanged).toBe("provider-connection-changed");
    expect(LIVE_EVENT.snapshotRequired).toBe("snapshot-required");
    expect(LIVE_EVENT.refresh).toBe("refresh");
  });
});
