import { describe, expect, test, beforeEach } from "bun:test";
import { ConfigError, loadConfig, redactConfigForLog, resetConfigCache, toPublicConfig } from "../packages/config/src/index";

beforeEach(() => resetConfigCache());

describe("config", () => {
  test("loads defaults", () => {
    const cfg = loadConfig({ env: {} });
    expect(cfg.env).toBe("development");
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(3001);
    expect(cfg.lan).toBe(false);
    expect(cfg.dbPath).toBe("./data/markethub.sqlite");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.webPort).toBe(5173);
  });

  test("supports PORT compatibility and MARKETHUB_PORT precedence", () => {
    const cfg = loadConfig({ env: { PORT: "4000", MARKETHUB_PORT: "4100" } });
    expect(cfg.port).toBe(4100);
  });

  test("LAN mode defaults host to 0.0.0.0 when not explicitly set", () => {
    const cfg = loadConfig({ env: { MARKETHUB_LAN: "true" } });
    expect(cfg.lan).toBe(true);
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.webHost).toBe("0.0.0.0");
  });

  test("explicit host overrides LAN default", () => {
    const cfg = loadConfig({ env: { MARKETHUB_LAN: "true", MARKETHUB_HOST: "192.168.1.10" } });
    expect(cfg.host).toBe("192.168.1.10");
  });

  test("rejects invalid port", () => {
    expect(() => loadConfig({ env: { MARKETHUB_PORT: "99999" } })).toThrow();
    try {
      loadConfig({ env: { MARKETHUB_PORT: "abc" } });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
    }
  });

  test("rejects invalid log level", () => {
    expect(() => loadConfig({ env: { MARKETHUB_LOG_LEVEL: "loud" } })).toThrow();
  });

  test("public config redacts raw db path", () => {
    const cfg = loadConfig({ env: { MARKETHUB_DB_PATH: "C:/secret/path/db.sqlite" } });
    const pub = toPublicConfig(cfg);
    expect(pub.dbPathConfigured).toBe(true);
    expect((pub as Record<string, unknown>).dbPath).toBeUndefined();
  });

  test("logged config does not include raw db path or api url credentials", () => {
    const cfg = loadConfig({
      env: {
        MARKETHUB_DB_PATH: "C:/secret/path/db.sqlite",
        MARKETHUB_API_URL: "http://user:pass@example.local:3001"
      }
    });
    const logged = redactConfigForLog(cfg);
    expect(logged.dbPath).toBeUndefined();
    expect(logged.dbPathConfigured).toBe(true);
    expect(String(logged.apiUrl)).not.toContain("user:pass");
    expect(String(logged.apiUrl)).not.toContain("user");
    expect(String(logged.apiUrl)).toContain("example.local");
  });
});
