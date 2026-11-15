import { describe, expect, test } from "bun:test";
import { healthStatusSchema } from "../packages/contracts/src/index";

describe("healthStatusSchema", () => {
  test("accepts valid health payload", () => {
    const result = healthStatusSchema.safeParse({
      status: "ok",
      service: "markethub-api",
      timestamp: new Date().toISOString(),
      version: "0.1.0",
      checks: { api: "ok", database: "ok" }
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid payload", () => {
    const result = healthStatusSchema.safeParse({ status: "bad" });
    expect(result.success).toBe(false);
  });
});
