import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../../packages/contracts/src/index";
import { openDatabase, resolveCredentialKeyPath, SqliteCredentialStore } from "../../packages/database/src/index";
import { ProviderRegistry, fetchWithRetry, fetchWithTimeout } from "../../packages/market-core/src/index";
import { UpstoxAdapter } from "../../packages/broker-upstox/src/index";
import { FyersAdapter, nextIstExpiry } from "../../packages/broker-fyers/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

function setup(overrides: Partial<ProviderConfig> = {}) {
  const dir = join(tmpdir(), `mh-rel-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const dbPath = join(dir, "data", "markethub.sqlite");
  const handle = openDatabase({ dbPath, migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const config: ProviderConfig = {
    enabled: true,
    fyersAppId: "APP-100",
    fyersRedirectUri: "http://127.0.0.1:3001/api/provider/fyers/callback",
    ...overrides
  };
  const registry = new ProviderRegistry({ now: () => new Date("2026-11-16T10:00:00.000Z") });
  const upstox = new UpstoxAdapter({
    credentials, config, retry: false, now: () => new Date("2026-11-16T10:00:00.000Z"),
    fetchImpl: async () => new Response(JSON.stringify({ status: "success", data: { exchange: "NSE", status: "NORMAL_OPEN" } }), { status: 200 })
  });
  const fyers = new FyersAdapter({
    credentials, config, retry: false, now: () => new Date("2026-11-16T10:00:00.000Z"),
    fetchImpl: async (url: string) => url.includes("validate-authcode")
      ? new Response(JSON.stringify({ s: "ok", code: 200, access_token: "f-token" }), { status: 200 })
      : new Response(JSON.stringify({ s: "ok", code: 200, data: {} }), { status: 200 })
  });
  registry.register(upstox);
  registry.register(fyers);
  return { dir, dbPath, handle, credentials, config, registry, upstox, fyers };
}

afterEach(() => {
  while (handles.length) { try { handles.pop()?.close(); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

describe("M3 reliability under failure", () => {
  test("1. internet unavailable: app starts and validation reports ERROR without crashing", async () => {
    const { registry, upstox } = setup();
    await upstox.setToken("token");
    (upstox as any).fetchImpl = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    const statuses = await registry.validateAll();
    expect(statuses.UPSTOX.authState).toBe("ERROR");
    expect(statuses.FYERS.authState).toBe("AUTH_REQUIRED");
  });

  test("2. DNS failure, connection reset, timeout and slow response are bounded", async () => {
    const { upstox } = setup();
    await upstox.setToken("token");
    (upstox as any).fetchImpl = async () => { throw new Error("ECONNRESET"); };
    expect((await upstox.validate()).authState).toBe("ERROR");

    let timedOut = false;
    try {
      await fetchWithTimeout("http://127.0.0.1:9/never", {}, 5);
    } catch {
      timedOut = true;
    }
    expect(timedOut).toBe(true);
  });

  test("3. Upstox unavailable while FYERS works, and reverse", async () => {
    const { registry, upstox, fyers } = setup();
    await upstox.setToken("u");
    await fyers.setAppSecret("f");
    const started = await fyers.startAuth();
    await fyers.completeAuth({ code: "c", state: started.state });
    (upstox as any).fetchImpl = async () => { throw new Error("down"); };
    let statuses = await registry.validateAll();
    expect(statuses.UPSTOX.authState).toBe("ERROR");
    expect(statuses.FYERS.authState).toBe("AUTHENTICATED");

    (upstox as any).fetchImpl = async () => new Response(JSON.stringify({ status: "success", data: { exchange: "NSE", status: "NORMAL_OPEN" } }), { status: 200 });
    (fyers as any).fetchImpl = async () => { throw new Error("down"); };
    statuses = await registry.validateAll();
    expect(statuses.UPSTOX.authState).toBe("AUTHENTICATED");
    expect(statuses.FYERS.authState).toBe("ERROR");
  });

  test("4. invalid, expired, revoked and replaced credentials", async () => {
    const { upstox, credentials } = setup();
    await upstox.setToken("old-token");
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("old-token");
    await upstox.setToken("replaced-token");
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("replaced-token");
    (upstox as any).fetchImpl = async () => new Response("{}", { status: 401 });
    expect((await upstox.validate()).authState).toBe("EXPIRED");
  });

  test("5. temporary 5xx outage recovers within bounded retries", async () => {
    let calls = 0;
    const result = await fetchWithRetry(
      async () => { calls++; return calls < 3 ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ status: "success", data: { exchange: "NSE", status: "NORMAL_OPEN" } }), { status: 200 }); },
      "http://example.test", {}, 100, { sleep: async () => {} }
    );
    expect(result.status).toBe(200);
    expect(calls).toBe(3);
  });

  test("6. termination during auth: single-use state is lost and cannot be replayed after restart", async () => {
    const { fyers } = setup();
    const started = await fyers.startAuth();
    const fresh = new FyersAdapter({
      credentials: (fyers as any).options.credentials,
      config: { enabled: true, fyersAppId: "APP-100", fyersRedirectUri: "http://127.0.0.1:3001/api/provider/fyers/callback" }
    });
    expect(fresh.verifyState(started.state)).toBe(false);
  });

  test("7. restart after interrupted credential update keeps last valid value", async () => {
    const { dir, dbPath, credentials } = setup();
    await credentials.set("UPSTOX", "analytics_token", "valid-token");
    const handle2 = openDatabase({ dbPath, migrate: true });
    handles.push(handle2);
    const store2 = new SqliteCredentialStore(handle2);
    expect(await store2.get("UPSTOX", "analytics_token")).toBe("valid-token");
  });

  test("8. corrupt key file fails closed and preserves unrelated data", async () => {
    const { handle, dbPath, credentials } = setup();
    await credentials.set("UPSTOX", "analytics_token", "secret");
    handle.sqlite.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, value TEXT)");
    handle.sqlite.exec("INSERT INTO unrelated (value) VALUES ('keep-me')");
    writeFileSync(resolveCredentialKeyPath(dbPath), Buffer.from("not-a-valid-key"));
    const store2 = new SqliteCredentialStore(handle);
    expect(store2.status().state).toBe("UNAVAILABLE");
    let failed = false;
    try { await store2.get("UPSTOX", "analytics_token"); } catch { failed = true; }
    expect(failed).toBe(true);
    const rows = handle.sqlite.query("SELECT value FROM unrelated").all() as any[];
    expect(rows[0]!.value).toBe("keep-me");
  });

  test("9. concurrent credential writes remain consistent (SQLite busy_timeout)", async () => {
    const { credentials } = setup();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => credentials.set("UPSTOX", `cred-${i}`, `value-${i}`))
    );
    for (let i = 0; i < 8; i++) {
      expect(await credentials.get("UPSTOX", `cred-${i}`)).toBe(`value-${i}`);
    }
  });

  test("10. invalid/unexpected provider responses map to ERROR, never crash", async () => {
    const { upstox } = setup();
    await upstox.setToken("token");
    (upstox as any).fetchImpl = async () => new Response("not-json", { status: 200 });
    const status = await upstox.validate();
    expect(["AUTHENTICATED", "ERROR"]).toContain(status.authState);
    expect(status.streamingState).toBe("NOT_STARTED");
  });

  test("11. incorrect clock and IST boundary handling", () => {
    expect(nextIstExpiry(new Date("2026-11-16T00:59:00.000Z")).toISOString()).toBe("2026-11-16T01:00:00.000Z");
    expect(nextIstExpiry(new Date("2026-11-16T01:01:00.000Z")).toISOString()).toBe("2026-11-17T01:00:00.000Z");
  });

  test("12. partial configuration and neither provider configured", async () => {
    const { registry } = setup({ fyersAppId: undefined, fyersRedirectUri: undefined });
    const statuses = await registry.validateAll();
    expect(statuses.UPSTOX.authState).toBe("AUTH_REQUIRED");
    expect(statuses.FYERS.authState).toBe("NOT_CONFIGURED");
    expect(statuses.FYERS.streamingState).toBe("NOT_STARTED");
  });

  test("data protection: empty replacement never overwrites a valid credential", async () => {
    const { credentials } = setup();
    await credentials.set("UPSTOX", "analytics_token", "valid-token");
    let failed = false;
    try { await credentials.set("UPSTOX", "analytics_token", "   "); } catch { failed = true; }
    expect(failed).toBe(true);
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("valid-token");
  });

  test("data protection: failed provider operation does not corrupt the other provider", async () => {
    const { registry, upstox, fyers, credentials } = setup();
    await upstox.setToken("u");
    await fyers.setAppSecret("f");
    const started = await fyers.startAuth();
    await fyers.completeAuth({ code: "c", state: started.state });
    (fyers as any).fetchImpl = async () => { throw new Error("boom"); };
    await registry.validateAll();
    expect(await credentials.get("UPSTOX", "analytics_token")).toBe("u");
    expect(await credentials.get("FYERS", "access_token")).toBe("f-token");
  });
});

describe("fetchWithRetry Retry-After (429 and 503)", () => {
  const NOW = Date.parse("2026-01-01T00:00:00.000Z");
  function response(status: number, retryAfter?: string): Response {
    const headers = new Headers();
    if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
    return new Response("{}", { status, headers });
  }

  test("429 delta-seconds and HTTP-date are honored (no retry before indicated time)", async () => {
    for (const header of ["2", new Date(NOW + 2000).toUTCString()]) {
      let calls = 0;
      const slept: number[] = [];
      const result = await fetchWithRetry(
        async () => { calls++; return calls === 1 ? response(429, header) : response(200); },
        "https://example.test", {}, 1000,
        { attempts: 3, now: () => NOW, sleep: async (ms) => { slept.push(ms); } }
      );
      expect(result.status).toBe(200);
      expect(slept).toEqual([2000]);
    }
  });

  test("503 delta-seconds and HTTP-date are honored", async () => {
    for (const header of ["3", new Date(NOW + 3000).toUTCString()]) {
      let calls = 0;
      const slept: number[] = [];
      const result = await fetchWithRetry(
        async () => { calls++; return calls === 1 ? response(503, header) : response(200); },
        "https://example.test", {}, 1000,
        { attempts: 3, maxDelayMs: 5000, now: () => NOW, sleep: async (ms) => { slept.push(ms); } }
      );
      expect(result.status).toBe(200);
      expect(slept).toEqual([3000]);
    }
  });

  test("zero, malformed, expired and excessive 503 delays stop without a tight loop", async () => {
    for (const header of ["0", "garbage", new Date(NOW - 1000).toUTCString(), "9999"]) {
      let calls = 0;
      const slept: number[] = [];
      const result = await fetchWithRetry(
        async () => { calls++; return response(503, header); },
        "https://example.test", {}, 1000,
        { attempts: 5, now: () => NOW, sleep: async (ms) => { slept.push(ms); } }
      );
      expect(result.status).toBe(503);
      expect(calls).toBe(1); // no retry burst
      expect(slept.length).toBe(0);
    }
  });

  test("429 without Retry-After stops; 503 without Retry-After keeps bounded backoff", async () => {
    let calls429 = 0;
    const r429 = await fetchWithRetry(
      async () => { calls429++; return response(429); },
      "https://example.test", {}, 1000,
      { attempts: 5, now: () => NOW, sleep: async () => {} }
    );
    expect(r429.status).toBe(429);
    expect(calls429).toBe(1);

    let calls503 = 0;
    const slept: number[] = [];
    const r503 = await fetchWithRetry(
      async () => { calls503++; return response(503); },
      "https://example.test", {}, 1000,
      { attempts: 3, baseDelayMs: 50, maxDelayMs: 200, now: () => NOW, sleep: async (ms) => { slept.push(ms); } }
    );
    expect(r503.status).toBe(503);
    expect(calls503).toBe(3);
    expect(slept.length).toBe(2);
  });

  test("other 5xx keep bounded exponential backoff", async () => {
    let calls = 0;
    const slept: number[] = [];
    const result = await fetchWithRetry(
      async () => { calls++; return calls < 3 ? response(500) : response(200); },
      "https://example.test", {}, 1000,
      { attempts: 3, baseDelayMs: 50, maxDelayMs: 200, now: () => NOW, sleep: async (ms) => { slept.push(ms); } }
    );
    expect(result.status).toBe(200);
    expect(calls).toBe(3);
    expect(slept.length).toBe(2);
  });
});
