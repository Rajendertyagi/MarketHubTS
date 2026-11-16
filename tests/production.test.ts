import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../packages/database/src/index";
import { createApp } from "../apps/api/src/app";
import { createLogger } from "../apps/api/src/lib/logger";

describe("production serving", () => {
  test("API routes remain functional in production mode", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "markethub-prod-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "production", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3998" } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    const deps = { config, db, logger: createLogger("error"), startedAt: Date.now() };
    try {
      const app = createApp(deps);
      const health = await app.request("/health");
      expect(health.status).toBe(200);
      const status = await app.request("/api/status");
      expect(status.status).toBe(200);
    } finally {
      try { db.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
