import { describe, expect, test } from "bun:test";
import {
  derivativeExpiriesQuerySchema,
  derivativeExpiriesResponseSchema,
  derivativeExpiryFreshnessSchema
} from "../../packages/contracts/src/index";

describe("WP4B shared expiry contracts", () => {
  test("query schema requires a non-empty underlying and a fixed provider", () => {
    expect(derivativeExpiriesQuerySchema.safeParse({
      underlyingCanonicalId: "v1|NSE|CASH|EQ|CODE:RELIANCE", provider: "UPSTOX"
    }).success).toBe(true);
    expect(derivativeExpiriesQuerySchema.safeParse({
      underlyingCanonicalId: "  v1|x  ", provider: "FYERS"
    }).success).toBe(true);
    expect(derivativeExpiriesQuerySchema.safeParse({ underlyingCanonicalId: "", provider: "UPSTOX" }).success).toBe(false);
    expect(derivativeExpiriesQuerySchema.safeParse({ underlyingCanonicalId: "   ", provider: "UPSTOX" }).success).toBe(false);
    expect(derivativeExpiriesQuerySchema.safeParse({ underlyingCanonicalId: "x", provider: "ZERODHA" }).success).toBe(false);
    expect(derivativeExpiriesQuerySchema.safeParse({ underlyingCanonicalId: "x" }).success).toBe(false);
  });

  test("query schema trims the underlying canonical id", () => {
    const parsed = derivativeExpiriesQuerySchema.parse({
      underlyingCanonicalId: "  v1|NSE|CASH|EQ|CODE:RELIANCE  ", provider: "UPSTOX"
    });
    expect(parsed.underlyingCanonicalId).toBe("v1|NSE|CASH|EQ|CODE:RELIANCE");
  });

  test("freshness schema allows a null last-successful time and only three states", () => {
    expect(derivativeExpiryFreshnessSchema.safeParse({ state: "UNKNOWN", lastSuccessfulSyncAt: null }).success).toBe(true);
    expect(derivativeExpiryFreshnessSchema.safeParse({
      state: "FRESH", lastSuccessfulSyncAt: "2026-11-24T01:00:00.000Z"
    }).success).toBe(true);
    expect(derivativeExpiryFreshnessSchema.safeParse({ state: "STALE" }).success).toBe(false);
    expect(derivativeExpiryFreshnessSchema.safeParse({ state: "FRESH", lastSuccessfulSyncAt: "not-a-date" }).success).toBe(false);
    expect(derivativeExpiryFreshnessSchema.safeParse({ state: "UNVERIFIED", lastSuccessfulSyncAt: null }).success).toBe(false);
  });

  test("response schema validates the full bounded envelope and rejects malformed expiries", () => {
    const ok = {
      underlyingCanonicalId: "u1",
      provider: "FYERS",
      expiries: ["2026-11-25", "2026-12-29"],
      freshness: { state: "STALE", lastSuccessfulSyncAt: "2026-11-23T10:00:00.000Z" }
    };
    expect(derivativeExpiriesResponseSchema.safeParse(ok).success).toBe(true);
    expect(derivativeExpiriesResponseSchema.safeParse({ ...ok, expiries: ["25-11-2026"] }).success).toBe(false);
    expect(derivativeExpiriesResponseSchema.safeParse({ ...ok, provider: "AUTO" }).success).toBe(false);
    expect(derivativeExpiriesResponseSchema.safeParse({ ...ok, expiries: "2026-11-25" }).success).toBe(false);
  });
});
