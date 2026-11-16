import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../packages/database/src/index";
import { createApp } from "../apps/api/src/app";
import { createLogger } from "../apps/api/src/lib/logger";
import { healthStatusSchema } from "../packages/contracts/src/index";

describe("mcp regression", () => {
  test("health endpoint remains compatible with MCP health tool contract", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "markethub-mcp-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now() });
    try {
      const res = await app.request("/health");
      const json = await res.json();
      const parsed = healthStatusSchema.safeParse(json);
      expect(res.ok).toBe(true);
      expect(parsed.success).toBe(true);
    } finally {
      try { db.close(); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
