import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../../packages/contracts/src/index";
import { openDatabase, SqliteCredentialStore } from "../../packages/database/src/index";
import { ProviderRegistry } from "../../packages/market-core/src/index";
import { UpstoxAdapter } from "../../packages/broker-upstox/src/index";
import { FyersAdapter } from "../../packages/broker-fyers/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

function setup() {
  const dir = join(tmpdir(), `mh-registry-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const config: ProviderConfig = {
    enabled: true,
    fyersAppId: "APP-100",
    fyersRedirectUri: "http://127.0.0.1:3001/api/provider/fyers/callback"
  };
  const registry = new ProviderRegistry({ now: () => new Date("2026-11-16T10:00:00.000Z") });
  const upstox = new UpstoxAdapter({
    credentials, config, now: () => new Date("2026-11-16T10:00:00.000Z"),
    fetchImpl: async () => new Response(JSON.stringify({ status: "success", data: { exchange: "NSE", status: "NORMAL_OPEN" } }), { status: 200 })
  });
  const fyers = new FyersAdapter({
    credentials, config, now: () => new Date("2026-11-16T10:00:00.000Z"),
    fetchImpl: async (url: string) => {
      if (url.includes("validate-authcode")) return new Response(JSON.stringify({ s: "ok", code: 200, access_token: "f-token" }), { status: 200 });
      return new Response(JSON.stringify({ s: "ok", code: 200, data: {} }), { status: 200 });
    }
  });
  registry.register(upstox);
  registry.register(fyers);
  return { registry, upstox, fyers, credentials, dir };
}

async function configureBoth(upstox: UpstoxAdapter, fyers: FyersAdapter) {
  await upstox.setToken("u-token");
  await fyers.setAppSecret("f-secret");
  const started = await fyers.startAuth();
  await fyers.completeAuth({ code: "c", state: started.state });
}

afterEach(() => {
  while (handles.length) { try { handles.pop()?.close(); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

describe("provider registry independence", () => {
  test("both providers configured and validated simultaneously", async () => {
    const { registry, upstox, fyers } = setup();
    await configureBoth(upstox, fyers);
    const statuses = await registry.validateAll();
    expect(statuses.UPSTOX.authState).toBe("AUTHENTICATED");
    expect(statuses.FYERS.authState).toBe("AUTHENTICATED");
    expect(statuses.UPSTOX.streamingState).toBe("NOT_STARTED");
    expect(statuses.FYERS.streamingState).toBe("NOT_STARTED");
  });

  test("Upstox failure does not change FYERS state", async () => {
    const { registry, upstox, fyers } = setup();
    await configureBoth(upstox, fyers);
    const before = await registry.validateAll();
    expect(before.FYERS.authState).toBe("AUTHENTICATED");
    (upstox as any).fetchImpl = async () => { throw new Error("upstox down"); };
    const after = await registry.validateAll();
    expect(after.UPSTOX.authState).toBe("ERROR");
    expect(after.FYERS.authState).toBe(before.FYERS.authState);
    expect(after.FYERS.validatedAt).toBe(before.FYERS.validatedAt);
  });

  test("FYERS failure does not change Upstox state", async () => {
    const { registry, upstox, fyers } = setup();
    await configureBoth(upstox, fyers);
    const before = await registry.validateAll();
    (fyers as any).fetchImpl = async () => { throw new Error("fyers down"); };
    const after = await registry.validateAll();
    expect(after.FYERS.authState).toBe("ERROR");
    expect(after.UPSTOX.authState).toBe(before.UPSTOX.authState);
    expect(after.UPSTOX.validatedAt).toBe(before.UPSTOX.validatedAt);
  });

  test("removing one provider preserves the other", async () => {
    const { registry, upstox, fyers, credentials } = setup();
    await configureBoth(upstox, fyers);
    await registry.remove("FYERS");
    expect(await credentials.get("FYERS", "access_token")).toBeNull();
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("u-token");
    expect((await registry.validate("UPSTOX")).authState).toBe("AUTHENTICATED");
  });

  test("neither provider configured reports honest states", async () => {
    const { registry } = setup();
    const statuses = await registry.validateAll();
    expect(statuses.UPSTOX.authState).toBe("AUTH_REQUIRED");
    expect(statuses.FYERS.authState).toBe("AUTH_REQUIRED");
    expect(statuses.UPSTOX.streamingState).toBe("NOT_STARTED");
  });

  test("restart restores encrypted credentials and status", async () => {
    const { upstox, dir } = setup();
    await upstox.setToken("persist-token");
    const handle2 = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
    handles.push(handle2);
    const credentials2 = new SqliteCredentialStore(handle2);
    expect(await credentials2.get("UPSTOX", "analytics_token")).toBe("persist-token");
    const registry2 = new ProviderRegistry();
    const upstox2 = new UpstoxAdapter({
      credentials: credentials2, config: { enabled: true },
      fetchImpl: async () => new Response(JSON.stringify({ status: "success", data: { exchange: "NSE", status: "NORMAL_OPEN" } }), { status: 200 })
    });
    registry2.register(upstox2);
    expect((await registry2.validate("UPSTOX")).authState).toBe("AUTHENTICATED");
  });
});
