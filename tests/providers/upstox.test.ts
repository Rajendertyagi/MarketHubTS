import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../../packages/contracts/src/index";
import { openDatabase, SqliteCredentialStore, SqliteProviderSettings } from "../../packages/database/src/index";
import { UPSTOX_VALIDATION_URL, UpstoxAdapter } from "../../packages/broker-upstox/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

const validResponse = () => new Response(JSON.stringify({ status: "success", data: { exchange: "NSE", status: "NORMAL_OPEN" } }), { status: 200 });

function setup(enabled = true) {
  const dir = join(tmpdir(), `mh-upstox-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const settings = new SqliteProviderSettings(handle);
  const config: ProviderConfig = { enabled };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new UpstoxAdapter({
    credentials, settings, config,
    now: () => new Date("2026-11-16T10:00:00.000Z"),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return validResponse(); }
  });
  return { adapter, credentials, settings, calls, dir, handle };
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
    expect(calls.length).toBe(2); // candidate validation on set + validation on validate
    expect(calls.every((c) => c.url === UPSTOX_VALIDATION_URL)).toBe(true);
    expect(calls[0]!.url).toContain("/v2/market/status/NSE");
    expect((calls[0]!.init?.headers as any).Authorization).toBe("Bearer analytics-token-123");
    expect(calls.some((c) => c.url.includes("user/profile") || c.url.includes("orders"))).toBe(false);
  });

  test("invalid/revoked token is rejected on replacement and status reflects failure", async () => {
    const { adapter } = setup();
    (adapter as any).fetchImpl = async () => new Response("{}", { status: 401 });
    let threw = false;
    try { await adapter.setToken("bad-token"); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(adapter.getStatus().authState).toBe("ERROR");
  });

  test("network failure during replacement is reported", async () => {
    const { adapter } = setup();
    (adapter as any).fetchImpl = async () => { throw new Error("connect ENOTFOUND api.upstox.com"); };
    let threw = false;
    try { await adapter.setToken("token"); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(adapter.getStatus().error).toContain("connect");
  });

  test("rate limit maps to DEGRADED with restriction", async () => {
    const { adapter } = setup();
    (adapter as any).fetchImpl = async () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } });
    let threw = false;
    try { await adapter.setToken("token"); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(adapter.getStatus().authState).toBe("DEGRADED");
    expect(adapter.getStatus().restrictions.join(" ")).toContain("Rate limited");
  });

  test("missing token is AUTH_REQUIRED; disabled provider is DISABLED", async () => {
    const { adapter } = setup();
    expect((await adapter.validate()).authState).toBe("AUTH_REQUIRED");
    const disabled = setup(false);
    expect((await disabled.adapter.validate()).authState).toBe("DISABLED");
  });

  test("expiry metadata is persisted and survives initialize", async () => {
    const { adapter, settings, dir, handle } = setup();
    await adapter.setToken("token", "2027-06-01T00:00:00.000Z");
    expect(await settings.get("upstox.tokenExpiresAt")).toBe("2027-06-01T00:00:00.000Z");
    handle.close();
    const handle2 = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
    handles.push(handle2);
    const settings2 = new SqliteProviderSettings(handle2);
    const adapter2 = new UpstoxAdapter({ credentials: new SqliteCredentialStore(handle2), settings: settings2, config: { enabled: true }, fetchImpl: async () => validResponse() });
    await adapter2.initialize();
    expect(adapter2.getStatus().expiresAt).toBe("2027-06-01T00:00:00.000Z");
    expect(adapter2.getStatus().expiryKnown).toBe(true);
  });

  test("malformed HTTP 200 is rejected", async () => {
    const { adapter } = setup();
    (adapter as any).fetchImpl = async () => new Response("not-json", { status: 200 });
    let threw = false;
    try { await adapter.setToken("token"); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(adapter.getStatus().authState).toBe("ERROR");
  });

  test("remove deletes the encrypted credential and expiry setting", async () => {
    const { adapter, credentials, settings } = setup();
    await adapter.setToken("token", "2027-06-01T00:00:00.000Z");
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("token");
    await adapter.remove();
    expect(await credentials.get("UPSTOX", "analytics_token")).toBeNull();
    expect(await settings.get("upstox.tokenExpiresAt")).toBeNull();
    expect(adapter.getStatus().authState).toBe("AUTH_REQUIRED");
  });
});
