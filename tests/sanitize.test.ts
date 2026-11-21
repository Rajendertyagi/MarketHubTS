import { describe, expect, test } from "bun:test";
import { sanitizeSensitiveText } from "../packages/contracts/src/sanitize";
import { mcpActivitySummarySchema } from "../packages/contracts/src/mcp-activity";

describe("M6-C Finding 1 — comprehensive credential sanitization", () => {
  test("redacts bearer tokens and key=value credential forms in direct text", () => {
    const out = sanitizeSensitiveText("Bearer abc123 token=secret99 rejected");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("secret99");
    expect(out).toContain("[redacted]");
  });

  test("redacts common credential variants including client_secret and api_secret", () => {
    for (const key of [
      "access_token", "refresh_token", "client_secret", "app_secret", "api_secret",
      "api_key", "apikey", "password", "authorization", "authorization_code",
      "refresh_token", "id_token", "private_key", "signature", "session", "passwd",
      "secret", "token", "code"
    ]) {
      const out = sanitizeSensitiveText(`${key}=supersecretvalue`);
      expect(out, key).not.toContain("supersecretvalue");
      expect(out, key).toContain("[redacted]");
    }
  });

  test("redacts quoted JSON credential keys while preserving ordinary fields", () => {
    const raw = '{"client_secret":"abc123","api_secret":"xyz789","query":"NIFTY","limit":25}';
    const out = sanitizeSensitiveText(raw);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz789");
    expect(out).toContain('"query":"NIFTY"');
    expect(out).toContain('"limit":25');
    // Remains valid JSON after redaction.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("redacts nested credential-bearing JSON content", () => {
    const raw = JSON.stringify({
      kind: "option_chain",
      result: { config: { client_secret: "nested-secret", api_secret: "nested-api" }, snapshot: { id: "snap-1" } }
    });
    const out = sanitizeSensitiveText(raw, 1000);
    expect(out).not.toContain("nested-secret");
    expect(out).not.toContain("nested-api");
    expect(out).toContain("snap-1");
  });

  test("redacts authorization_code in all forms (regression)", () => {
    for (const raw of [
      '"authorization_code": "abc123secret"',
      '{"authorization_code":"abc123secret"}',
      "authorization_code=abc123secret",
      "?authorization_code=abc123secret"
    ]) {
      expect(sanitizeSensitiveText(raw), raw).not.toContain("abc123secret");
      expect(sanitizeSensitiveText(raw), raw).toContain("[redacted]");
    }
  });

  test("redacts numeric JSON credential values", () => {
    for (const raw of ['{"token": 12345}', '{"token": -12345}', '{"token": 12345.67}', '{"token": 1e10}']) {
      const out = sanitizeSensitiveText(raw);
      expect(out, raw).not.toContain("12345");
      expect(out, raw).not.toContain("1e10");
      expect(out, raw).toContain("[redacted]");
      expect(() => JSON.parse(out), raw).not.toThrow();
    }
  });

  test("preserves ordinary prose with purely numeric non-credential values", () => {
    expect(sanitizeSensitiveText("error code: 500 for NIFTY")).toBe("error code: 500 for NIFTY");
    expect(sanitizeSensitiveText("HTTP status code: 401")).toBe("HTTP status code: 401");
  });

  test("redacts URL query parameters", () => {
    const out = sanitizeSensitiveText("https://api.example.com/x?access_token=tok123&code=abc&state=ok");
    expect(out).not.toContain("tok123");
    expect(out).not.toContain("abc&");
    expect(out).toContain("state=ok");
  });

  test("redacts key: value forms", () => {
    const out = sanitizeSensitiveText("password: hunter2, api-key: abc123xyz");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123xyz");
  });

  test("does not redact market-data identifiers or ordinary descriptive text", () => {
    const ordinary = "NIFTY 50 index quote 12345.67 canonicalId=BANKNIFTY interval=1D";
    expect(sanitizeSensitiveText(ordinary)).toBe(ordinary);
  });

  test("bounds output length", () => {
    expect(sanitizeSensitiveText("x".repeat(1000), 50).length).toBe(50);
  });

  test("strict summary schema rejects unknown keys and accepts real MarketHub fields", () => {
    expect(mcpActivitySummarySchema.safeParse({ query: "NIFTY", limit: 25 }).success).toBe(true);
    expect(mcpActivitySummarySchema.safeParse({ canonicalId: "A", interval: "1D", from: "2026-01-01" }).success).toBe(true);
    expect(mcpActivitySummarySchema.safeParse({ client_secret: "abc" }).success).toBe(false);
    expect(mcpActivitySummarySchema.safeParse({ query: "NIFTY", arbitrary: "value" }).success).toBe(false);
    expect(mcpActivitySummarySchema.safeParse({ token: "abc" }).success).toBe(false);
  });
});
