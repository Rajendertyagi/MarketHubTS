import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../../packages/contracts/src/index";
import { openDatabase, SqliteCredentialStore } from "../../packages/database/src/index";
import {
  FYERS_AUTH_URL,
  FYERS_LOGOUT_URL,
  FYERS_PROFILE_URL,
  FYERS_TOKEN_URL,
  FyersAdapter,
  nextIstExpiry
} from "../../packages/broker-fyers/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

function setup(now = new Date("2026-11-16T10:00:00.000Z")) {
  const dir = join(tmpdir(), `mh-fyers-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const config: ProviderConfig = {
    enabled: true,
    fyersAppId: "TESTAPP-100",
    fyersRedirectUri: "http://127.0.0.1:4899/api/provider/fyers/callback"
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new FyersAdapter({
    credentials,
    config,
    now: () => now,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === FYERS_TOKEN_URL) {
        return new Response(JSON.stringify({ s: "ok", code: 200, access_token: "fyers-access-token" }), { status: 200 });
      }
      if (url === FYERS_PROFILE_URL) {
        return new Response(JSON.stringify({ s: "ok", code: 200, data: { fy_id: "X", name: "Sensitive" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ s: "ok", code: 200 }), { status: 200 });
    }
  });
  return { adapter, credentials, calls, dir, config };
}

afterEach(() => {
  while (handles.length) { try { handles.pop()?.close(); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

describe("FYERS V3 non-trading adapter", () => {
  test("authorization URL uses registered redirect URI and random state", async () => {
    const { adapter } = setup();
    const started = await adapter.startAuth();
    expect(started.authorizationUrl).toContain(FYERS_AUTH_URL);
    expect(started.authorizationUrl).toContain("client_id=TESTAPP-100");
    expect(started.authorizationUrl).toContain(encodeURIComponent("http://127.0.0.1:4899/api/provider/fyers/callback"));
    expect(started.state).toMatch(/^[a-f0-9]{32}$/);
    expect(started.expiresAt).toBe("2026-11-16T10:05:00.000Z");
  });

  test("state mismatch, replay and expiry are rejected", async () => {
    const { adapter } = setup();
    const started = await adapter.startAuth();
    expect(adapter.verifyState("wrong-state")).toBe(false);
    expect(adapter.verifyState(started.state)).toBe(true);
    expect(adapter.verifyState(started.state)).toBe(false); // replay

    const expired = setup(new Date("2026-11-16T10:00:00.000Z"));
    const s = await expired.adapter.startAuth();
    (expired.adapter as any).now = () => new Date("2026-11-16T10:06:00.000Z");
    expect(expired.adapter.verifyState(s.state)).toBe(false);
  });

  test("successful code exchange stores encrypted token and computes appIdHash", async () => {
    const { adapter, credentials, calls } = setup();
    await adapter.setAppSecret("top-secret-app-secret");
    const started = await adapter.startAuth();
    const status = await adapter.completeAuth({ code: "single-use-code", state: started.state });
    expect(status.authState).toBe("AUTHENTICATED");
    expect(await credentials.get("FYERS", "access_token")).toBe("fyers-access-token");
    const tokenCall = calls.find((c) => c.url === FYERS_TOKEN_URL)!;
    const body = JSON.parse(tokenCall.init!.body as string);
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("single-use-code");
    expect(body.appIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.appIdHash).not.toContain("top-secret-app-secret");
  });

  test("failed/single-use code exchange maps to ERROR", async () => {
    const { adapter } = setup();
    await adapter.setAppSecret("secret");
    const started = await adapter.startAuth();
    (adapter as any).fetchImpl = async () => new Response(JSON.stringify({ s: "error", code: -501, message: "invalid code" }), { status: 400 });
    const status = await adapter.completeAuth({ code: "bad", state: started.state });
    expect(status.authState).toBe("ERROR");
    expect(status.error).toContain("invalid code");
  });

  test("token validation discards profile PII and reports expiry", async () => {
    const { adapter, credentials } = setup();
    await credentials.set("FYERS", "access_token", "fyers-access-token");
    const status = await adapter.validate();
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.expiryKnown).toBe(true);
    expect(status.expiresAt).toBe(nextIstExpiry(new Date("2026-11-16T10:00:00.000Z")).toISOString());
    expect(JSON.stringify(status)).not.toContain("Sensitive");
    expect(JSON.stringify(status)).not.toContain("fy_id");
  });

  test("6:30 AM IST expiry is testable and maps to EXPIRED", async () => {
    expect(nextIstExpiry(new Date("2026-11-16T01:00:00.000Z")).toISOString()).toBe("2026-11-17T01:00:00.000Z");
    const { adapter, credentials } = setup(new Date("2026-11-16T01:00:00.000Z"));
    await credentials.set("FYERS", "access_token", "token");
    (adapter as any).tokenExpiresAt = "2026-11-16T01:00:00.000Z";
    (adapter as any).now = () => new Date("2026-11-16T01:01:00.000Z");
    const status = await adapter.validate();
    expect(status.authState).toBe("EXPIRED");
    expect(status.error).toContain("06:30");
  });

  test("rate-limit and entitlement errors map with bounded retries (no storm)", async () => {
    const { adapter, credentials, calls } = setup();
    await credentials.set("FYERS", "access_token", "token");
    (adapter as any).retrySleep = async () => {};
    (adapter as any).fetchImpl = async (url: string) => {
      calls.push({ url });
      return new Response(JSON.stringify({ s: "error", code: -429, message: "rate limit" }), { status: 429 });
    };
    const status = await adapter.validate();
    expect(status.authState).toBe("DEGRADED");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  test("logout/removal revokes remotely and deletes local credentials", async () => {
    const { adapter, credentials, calls } = setup();
    await adapter.setAppSecret("secret");
    await credentials.set("FYERS", "access_token", "token");
    await adapter.remove();
    expect(calls.some((c) => c.url === FYERS_LOGOUT_URL)).toBe(true);
    expect(await credentials.get("FYERS", "access_token")).toBeNull();
    expect(await credentials.get("FYERS", "app_secret")).toBeNull();
  });

  test("no trading endpoints are used", async () => {
    const { adapter, credentials, calls } = setup();
    await credentials.set("FYERS", "access_token", "token");
    await adapter.validate();
    expect(calls.every((c) => !c.url.includes("/orders") && !c.url.includes("/positions"))).toBe(true);
  });
});
