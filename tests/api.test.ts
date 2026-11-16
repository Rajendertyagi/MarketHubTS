import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../packages/database/src/index";
import { createApp, isAllowedCorsOrigin } from "../apps/api/src/app";
import { createLogger } from "../apps/api/src/lib/logger";
import { healthStatusSchema, readinessStatusSchema, systemStatusSchema } from "../packages/contracts/src/index";
import { closeDatabaseHandle, removeTempDir } from "./helpers/fs-cleanup";

function makeDeps() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-api-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const logger = createLogger("error");
  const deps = { config, db, logger, startedAt: Date.now() - 1000 };
  const cleanup = () => {
    closeDatabaseHandle(db);
    removeTempDir(dir);
  };
  return { deps, dir, db, cleanup };
}

describe("api", () => {
  test("GET /health returns compatible payload", async () => {
    const { deps, cleanup } = makeDeps();
    try {
      const app = createApp(deps);
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = healthStatusSchema.safeParse(json);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.checks.database).toBe("ok");
    } finally {
      cleanup();
    }
  });

  test("GET /ready returns readiness payload", async () => {
    const { deps, cleanup } = makeDeps();
    try {
      const app = createApp(deps);
      const res = await app.request("/ready");
      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = readinessStatusSchema.safeParse(json);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.ready).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("GET /api/status returns system status", async () => {
    const { deps, cleanup } = makeDeps();
    try {
      const app = createApp(deps);
      const res = await app.request("/api/status");
      expect(res.status).toBe(200);
      const json = await res.json();
      const parsed = systemStatusSchema.safeParse(json);
      expect(parsed.success).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("readiness reports error when database is closed", async () => {
    const { deps, dir, db } = makeDeps();
    try {
      db.close();
      const app = createApp(deps);
      const res = await app.request("/ready");
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ready).toBe(false);
      expect(json.checks.database).toBe("error");
    } finally {
      removeTempDir(dir);
    }
  });

  test("unknown route returns structured error", async () => {
    const { deps, cleanup } = makeDeps();
    try {
      const app = createApp(deps);
      const res = await app.request("/api/nope");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("not_found");
    } finally {
      cleanup();
    }
  });

  test("CORS origin validation allows loopback and valid RFC1918 LAN origins when enabled", () => {
    const cfg = { lan: true, port: 3001, webPort: 5173 };
    expect(isAllowedCorsOrigin("http://localhost:5173", cfg)).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:5173", cfg)).toBe(true);
    expect(isAllowedCorsOrigin("http://[::1]:5173", cfg)).toBe(true);
    expect(isAllowedCorsOrigin("http://10.0.0.5:5173", cfg)).toBe(true);
    expect(isAllowedCorsOrigin("http://172.16.0.10:5173", cfg)).toBe(true);
    expect(isAllowedCorsOrigin("http://172.31.255.255:5173", cfg)).toBe(true);
    expect(isAllowedCorsOrigin("http://192.168.1.20:5173", cfg)).toBe(true);
  });

  test("CORS origin validation rejects public IPs and hostname lookalikes", () => {
    const cfg = { lan: true, port: 3001, webPort: 5173 };
    expect(isAllowedCorsOrigin("http://8.8.8.8:5173", cfg)).toBe(false);
    expect(isAllowedCorsOrigin("http://1.2.3.4:5173", cfg)).toBe(false);
    expect(isAllowedCorsOrigin("http://10.attacker.com:5173", cfg)).toBe(false);
    expect(isAllowedCorsOrigin("http://192.168.attacker.com:5173", cfg)).toBe(false);
    expect(isAllowedCorsOrigin("http://172.16.attacker.com:5173", cfg)).toBe(false);
  });

  test("CORS origin validation respects LAN-disabled behavior", () => {
    const cfg = { lan: false, port: 3001, webPort: 5173 };
    expect(isAllowedCorsOrigin("http://localhost:5173", cfg)).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:5173", cfg)).toBe(true);
    expect(isAllowedCorsOrigin("http://192.168.1.20:5173", cfg)).toBe(false);
    expect(isAllowedCorsOrigin("http://10.0.0.5:5173", cfg)).toBe(false);
  });
});
