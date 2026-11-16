import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, providerConfigFromAppConfig } from "../../packages/config/src/index";
import { openDatabase, SqliteCredentialStore, SqliteProviderSettings } from "../../packages/database/src/index";
import { ProviderRegistry, fetchWithRetry } from "../../packages/market-core/src/index";
import { UpstoxAdapter } from "../../packages/broker-upstox/src/index";
import { FyersAdapter, isValidFyersRedirectUri, nextIstExpiry } from "../../packages/broker-fyers/src/index";
import { createApp } from "../../apps/api/src/app";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];
const validUpstox = () => new Response(JSON.stringify({ status: "success", data: { exchange: "NSE", status: "NORMAL_OPEN" } }), { status: 200 });
const validFyersProfile = () => new Response(JSON.stringify({ s: "ok", code: 200, data: {} }), { status: 200 });

function setup(now = new Date("2026-11-16T10:00:00.000Z")) {
  const dir = join(tmpdir(), `mh-fix-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const dbPath = join(dir, "data", "markethub.sqlite");
  const handle = openDatabase({ dbPath, migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const settings = new SqliteProviderSettings(handle);
  const config = loadConfig({ env: { MARKETHUB_DB_PATH: dbPath } });
  const providerConfig = providerConfigFromAppConfig(config);
  const registry = new ProviderRegistry({ now: () => now });
  const upstox = new UpstoxAdapter({ credentials, settings, config: providerConfig, now: () => now, fetchImpl: async () => validUpstox() });
  const fyers = new FyersAdapter({ credentials, settings, config: providerConfig, now: () => now, fetchImpl: async (url: string) => url.includes("validate-authcode")
    ? new Response(JSON.stringify({ s: "ok", code: 200, access_token: "f-token" }), { status: 200 })
    : validFyersProfile() });
  registry.register(upstox);
  registry.register(fyers);
  return { dir, dbPath, handle, credentials, settings, config, providerConfig, registry, upstox, fyers };
}

afterEach(() => {
  while (handles.length) { try { handles.pop()?.close(); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

describe("M3 independent-review corrections", () => {
  test("provider configuration survives restart", async () => {
    const { dbPath, handle, settings, fyers } = setup();
    await fyers.setConfig("APP-100", "http://127.0.0.1:3001/api/provider/fyers/callback");
    expect(await settings.get("fyers.appId")).toBe("APP-100");
    handle.close();
    const h2 = openDatabase({ dbPath, migrate: true });
    handles.push(h2);
    const s2 = new SqliteProviderSettings(h2);
    const c2 = loadConfig({ env: { MARKETHUB_DB_PATH: dbPath } });
    const pc2 = providerConfigFromAppConfig(c2);
    const f2 = new FyersAdapter({ credentials: new SqliteCredentialStore(h2), settings: s2, config: pc2 });
    await f2.initialize();
    expect(pc2.fyersAppId).toBe("APP-100");
    expect(pc2.fyersRedirectUri).toBe("http://127.0.0.1:3001/api/provider/fyers/callback");
    expect((await f2.validate()).authState).toBe("AUTH_REQUIRED");
  });

  test("FYERS expiry survives restart and remains correct after 06:30 IST", async () => {
    const { dbPath, handle, settings, fyers } = setup();
    await fyers.setConfig("APP-100", "http://127.0.0.1:3001/api/provider/fyers/callback");
    await fyers.setAppSecret("secret");
    const started = await fyers.startAuth();
    await fyers.completeAuth({ code: "c", state: started.state });
    const saved = await settings.get("fyers.tokenExpiresAt");
    expect(saved).toBe(nextIstExpiry(new Date("2026-11-16T10:00:00.000Z")).toISOString());
    handle.close();

    const h2 = openDatabase({ dbPath, migrate: true });
    handles.push(h2);
    const s2 = new SqliteProviderSettings(h2);
    const pc2 = providerConfigFromAppConfig(loadConfig({ env: { MARKETHUB_DB_PATH: dbPath } }));
    const f2 = new FyersAdapter({
      credentials: new SqliteCredentialStore(h2), settings: s2, config: pc2,
      now: () => new Date("2026-11-16T01:01:00.000Z")
    });
    await f2.initialize();
    expect(f2.getStatus().expiresAt).toBe(saved);
    expect((await f2.validate()).authState).toBe("EXPIRED");
  });

  test("invalid Upstox token replacement preserves the previous working token", async () => {
    const { upstox, credentials } = setup();
    await upstox.setToken("working-token");
    (upstox as any).fetchImpl = async () => new Response("{}", { status: 401 });
    let threw = false;
    try { await upstox.setToken("bad-token"); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("working-token");
  });

  test("network failure during replacement preserves the previous token", async () => {
    const { upstox, credentials } = setup();
    await upstox.setToken("working-token");
    (upstox as any).fetchImpl = async () => { throw new Error("ECONNRESET"); };
    let threw = false;
    try { await upstox.setToken("new-token"); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("working-token");
  });

  test("FYERS authorization-code exchange is never retried", async () => {
    const { fyers } = setup();
    await fyers.setConfig("APP-100", "http://127.0.0.1:3001/api/provider/fyers/callback");
    await fyers.setAppSecret("secret");
    let calls = 0;
    (fyers as any).fetchImpl = async (url: string) => {
      calls++;
      if (url.includes("validate-authcode")) return new Response("{}", { status: 503 });
      return validFyersProfile();
    };
    const started = await fyers.startAuth();
    await fyers.completeAuth({ code: "single-use", state: started.state });
    expect(calls).toBe(1);
  });

  test("429 Retry-After is respected; missing delay stops retries", async () => {
    let calls = 0;
    const withHeader = await fetchWithRetry(
      async () => { calls++; return new Response("{}", { status: 429, headers: { "Retry-After": "0" } }); },
      "http://example.test", {}, 100, { sleep: async () => {} }
    );
    expect(withHeader.status).toBe(429);
    expect(calls).toBe(3);

    let noHeaderCalls = 0;
    await fetchWithRetry(
      async () => { noHeaderCalls++; return new Response("{}", { status: 429 }); },
      "http://example.test", {}, 100, { sleep: async () => {} }
    );
    expect(noHeaderCalls).toBe(1);
  });

  test("malformed HTTP 200 responses are rejected for both providers", async () => {
    const { upstox, fyers } = setup();
    (upstox as any).fetchImpl = async () => new Response("not-json", { status: 200 });
    let uThrew = false;
    try { await upstox.setToken("token"); } catch { uThrew = true; }
    expect(uThrew).toBe(true);
    expect(upstox.getStatus().authState).toBe("ERROR");

    await fyers.setConfig("APP-100", "http://127.0.0.1:3001/api/provider/fyers/callback");
    await fyers.setAppSecret("secret");
    (fyers as any).fetchImpl = async (url: string) => url.includes("validate-authcode")
      ? new Response(JSON.stringify({ s: "ok", code: 200, access_token: "t" }), { status: 200 })
      : new Response("not-json", { status: 200 });
    const started = await fyers.startAuth();
    await fyers.completeAuth({ code: "c", state: started.state });
    expect((await fyers.validate()).authState).toBe("ERROR");
  });

  test("subsequent status reflects validation/storage failures", async () => {
    const { upstox, credentials } = setup();
    await upstox.setToken("working-token");
    (upstox as any).fetchImpl = async () => { throw new Error("offline"); };
    await upstox.validate();
    expect(upstox.getStatus().authState).toBe("ERROR");
    expect(upstox.getStatus().error).toContain("offline");
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("working-token");
  });

  test("non-loopback FYERS redirect URI is rejected", async () => {
    expect(isValidFyersRedirectUri("http://127.0.0.1:3001/api/provider/fyers/callback")).toBe(true);
    expect(isValidFyersRedirectUri("https://evil.example/api/provider/fyers/callback")).toBe(false);
    expect(isValidFyersRedirectUri("http://127.0.0.1:3001/other")).toBe(false);
    const { fyers } = setup();
    let threw = false;
    try { await fyers.setConfig("APP-100", "https://evil.example/api/provider/fyers/callback"); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("WebUI provider controls' API operations are available and functional", async () => {
    const { config, dbPath, handle, credentials, settings, providerConfig, registry, upstox, fyers } = setup();
    const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
    const app = createApp({ config, db: handle, logger, startedAt: Date.now(), providerRegistry: registry, credentials, settings, providerConfig, upstox, fyers });
    const server = { requestIP: () => ({ address: "127.0.0.1" }) } as any;
    const call = (path: string, body: unknown) => app.fetch(
      new Request(`http://127.0.0.1:3001${path}`, { method: "POST", headers: { "Content-Type": "application/json", host: "127.0.0.1:3001" }, body: JSON.stringify(body) }),
      server
    );
    expect((await call("/api/provider/upstox/token", { token: "ui-token", expiresAt: "2027-06-01T00:00:00.000Z" })).status).toBe(200);
    expect((await call("/api/provider/fyers/config", { appId: "APP-100", redirectUri: "http://127.0.0.1:3001/api/provider/fyers/callback" })).status).toBe(200);
    expect((await call("/api/provider/fyers/app-secret", { appSecret: "ui-secret" })).status).toBe(200);
    expect((await call("/api/provider/UPSTOX/validate", {})).status).toBe(200);
    expect((await call("/api/provider/FYERS/validate", {})).status).toBe(200);
    expect((await call("/api/provider/UPSTOX/remove", { confirm: true })).status).toBe(200);
    expect((await call("/api/provider/FYERS/remove", { confirm: true })).status).toBe(200);
  });
});
