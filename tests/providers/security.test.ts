import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, providerConfigFromAppConfig } from "../../packages/config/src/index";
import { openDatabase, SqliteCredentialStore } from "../../packages/database/src/index";
import { ProviderRegistry } from "../../packages/market-core/src/index";
import { UpstoxAdapter } from "../../packages/broker-upstox/src/index";
import { FyersAdapter } from "../../packages/broker-fyers/src/index";
import { createApp } from "../../apps/api/src/app";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

function setup() {
  const dir = join(tmpdir(), `mh-sec-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const config = loadConfig({ env: { MARKETHUB_DB_PATH: join(dir, "data", "markethub.sqlite") } });
  const providerConfig = providerConfigFromAppConfig(config);
  const registry = new ProviderRegistry();
  const upstox = new UpstoxAdapter({ credentials, config: providerConfig, fetchImpl: async () => new Response("{}", { status: 200 }) });
  const fyers = new FyersAdapter({ credentials, config: providerConfig, fetchImpl: async () => new Response("{}", { status: 200 }) });
  registry.register(upstox);
  registry.register(fyers);
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;
  const app = createApp({ config, db: handle, logger, startedAt: Date.now(), providerRegistry: registry, credentials, providerConfig, upstox, fyers });
  return { app, credentials, upstox, config };
}

function request(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}, ip = "127.0.0.1") {
  const server = { requestIP: () => ({ address: ip }) } as any;
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", "127.0.0.1:3001");
  return app.fetch(new Request(`http://127.0.0.1:3001${path}`, { ...init, headers }), server);
}

afterEach(() => {
  while (handles.length) { try { handles.pop()?.close(); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

describe("local-owner provider routes", () => {
  test("LAN peer cannot change credentials", async () => {
    const { app } = setup();
    const res = await request(app, "/api/provider/upstox/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "x" })
    }, "192.168.1.25");
    expect(res.status).toBe(403);
  });

  test("loopback peer can change credentials", async () => {
    const { app } = setup();
    const res = await request(app, "/api/provider/upstox/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "local-token" })
    });
    expect(res.status).toBe(200);
  });

  test("IPv6 loopback accepted; forwarded headers ignored", async () => {
    const { app } = setup();
    expect((await request(app, "/api/provider/UPSTOX/validate", { method: "POST" }, "::1")).status).toBe(200);
    const spoofed = await request(app, "/api/provider/upstox/token", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "127.0.0.1" }, body: JSON.stringify({ token: "x" })
    }, "10.0.0.5");
    expect(spoofed.status).toBe(403);
  });

  test("read-only provider status is LAN accessible and contains no secrets", async () => {
    const { app, upstox } = setup();
    await upstox.setToken("super-secret-token");
    const res = await request(app, "/api/providers/status", {}, "192.168.1.25");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("app_secret");
  });

  test("removal and reset require explicit confirmation", async () => {
    const { app } = setup();
    const headers = { "Content-Type": "application/json" };
    expect((await request(app, "/api/provider/UPSTOX/remove", { method: "POST", headers, body: "{}" })).status).toBe(400);
    expect((await request(app, "/api/credentials/reset", { method: "POST", headers, body: "{}" })).status).toBe(400);
  });

  test("FYERS callback is loopback-only", async () => {
    const { app } = setup();
    const res = await request(app, "/api/provider/fyers/callback?code=x&state=y", {}, "192.168.1.25");
    expect(res.status).toBe(403);
  });
});
