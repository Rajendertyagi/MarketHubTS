import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../packages/database/src/index";
import { createApp } from "../apps/api/src/app";
import { createLogger } from "../apps/api/src/lib/logger";
import { healthStatusSchema, readinessStatusSchema, systemStatusSchema } from "../packages/contracts/src/index";

function safeCleanup(dir: string, close?: () => void) {
  try { close?.(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeDeps() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-api-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const logger = createLogger("error");
  const deps = { config, db, logger, startedAt: Date.now() - 1000 };
  return { deps, dir, cleanup: () => safeCleanup(dir, () => db.close()) };
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
    const { deps, dir } = makeDeps();
    try {
      deps.db.close();
      const app = createApp(deps);
      const res = await app.request("/ready");
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.ready).toBe(false);
      expect(json.checks.database).toBe("error");
    } finally {
      safeCleanup(dir);
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
});
