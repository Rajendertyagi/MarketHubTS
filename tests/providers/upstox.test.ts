import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../../packages/contracts/src/index";
import { openDatabase, SqliteCredentialStore } from "../../packages/database/src/index";
import { UPSTOX_VALIDATION_URL, UpstoxAdapter } from "../../packages/broker-upstox/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

function setup(enabled = true) {
  const dir = join(tmpdir(), `mh-upstox-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const config: ProviderConfig = { enabled };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new UpstoxAdapter({
    credentials,
    config,
    now: () => new Date("2026-11-16T10:00:00.000Z"),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "success", data: { exchange: "NSE", status: "NORMAL_OPEN" } }), { status: 200 });
    }
  });
  return { adapter, credentials, calls, dir };
}

afterEach(() => {
  while (handles.length) { try { handles.pop()?.close(); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

describe("Upstox Analytics Token adapter", () => {
  test("valid token validates against the Market Information endpoint only", async () => {
    const { adapter, calls } = setup();
    await adapter.setToken("  analytics-token-123  ", "2027-06-01T00:00:00.000Z");
    const status = await adapter.validate();
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.validatedAt).toBe("2026-11-16T10:00:00.000Z");
    expect(status.expiresAt).toBe("2027-06-01T00:00:00.000Z");
    expect(status.expiryKnown).toBe(true);
    expect(status.streamingState).toBe("NOT_STARTED");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(UPSTOX_VALIDATION_URL);
    expect(calls[0]!.url).toContain("/v2/market/status/NSE");
    expect((calls[0]!.init?.headers as any).Authorization).toBe("Bearer analytics-token-123");
    expect(calls.some((c) => c.url.includes("user/profile") || c.url.includes("orders"))).toBe(false);
  });

  test("invalid/revoked token maps to EXPIRED", async () => {
    const { adapter } = setup();
    await adapter.setToken("bad-token");
    (adapter as any).fetchImpl = async () => new Response("{}", { status: 401 });
    const status = await adapter.validate();
    expect(status.authState).toBe("EXPIRED");
    expect(status.error).toContain("rejected");
  });

  test("network failure maps to ERROR with sanitized message", async () => {
    const { adapter } = setup();
    await adapter.setToken("token");
    (adapter as any).fetchImpl = async () => { throw new Error("connect ENOTFOUND api.upstox.com"); };
    const status = await adapter.validate();
    expect(status.authState).toBe("ERROR");
    expect(status.error).toContain("connect");
  });

  test("rate limit maps to DEGRADED with restriction", async () => {
    const { adapter } = setup();
    await adapter.setToken("token");
    (adapter as any).fetchImpl = async () => new Response("{}", { status: 429 });
    const status = await adapter.validate();
    expect(status.authState).toBe("DEGRADED");
    expect(status.restrictions.join(" ")).toContain("Rate limited");
  });

  test("missing token is AUTH_REQUIRED; disabled provider is DISABLED", async () => {
    const { adapter } = setup();
    expect((await adapter.validate()).authState).toBe("AUTH_REQUIRED");
    const disabled = setup(false);
    expect((await disabled.adapter.validate()).authState).toBe("DISABLED");
  });

  test("expiry metadata is unknown when not supplied and never calculated", async () => {
    const { adapter } = setup();
    const status = await adapter.setToken("token");
    expect(status.expiryKnown).toBe(false);
    expect(status.expiresAt).toBeNull();
    expect(status.restrictions.join(" ")).toContain("expiry unknown");
  });

  test("remove deletes the encrypted credential", async () => {
    const { adapter, credentials } = setup();
    await adapter.setToken("token");
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("token");
    await adapter.remove();
    expect(await credentials.get("UPSTOX", "analytics_token")).toBeNull();
    expect(adapter.getStatus().authState).toBe("AUTH_REQUIRED");
  });
});
