import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../packages/database/src/index";
import { createApp } from "../apps/api/src/app";
import { createLogger } from "../apps/api/src/lib/logger";
import { closeDatabaseHandle, removeTempDir } from "./helpers/fs-cleanup";

function createWebDistFixture(baseDir: string): { distDir: string; assetPath: string } {
  const distDir = join(baseDir, "dist");
  const assetsDir = join(distDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  const assetPath = "/assets/app-test.js";
  writeFileSync(join(assetsDir, "app-test.js"), "console.log('markethub-test-asset');\n", "utf8");
  writeFileSync(
    join(distDir, "index.html"),
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>MarketHubTS Test</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"/assets/app-test.js\"></script></body></html>",
    "utf8"
  );
  return { distDir, assetPath };
}

describe("production serving", () => {
  test("serves WebUI root HTML and built assets while keeping API endpoints", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "markethub-prod-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "production", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3998" } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    const { distDir, assetPath } = createWebDistFixture(dir);
    const deps = { config, db, logger: createLogger("error"), startedAt: Date.now(), webDistDir: distDir };
    try {
      const app = createApp(deps);

      const root = await app.request("/");
      expect(root.status).toBe(200);
      const html = await root.text();
      expect(root.headers.get("content-type") ?? "").toContain("text/html");
      expect(html).toContain("<div id=\"root\">");
      expect(html).not.toContain("\"name\":\"MarketHubTS API\"");

      const asset = await app.request(assetPath);
      expect(asset.status).toBe(200);
      const assetType = asset.headers.get("content-type") ?? "";
      expect(assetType.includes("javascript") || assetType.includes("text/plain")).toBe(true);

      const health = await app.request("/health");
      expect(health.status).toBe(200);
      const status = await app.request("/api/status");
      expect(status.status).toBe(200);
    } finally {
      closeDatabaseHandle(db);
      removeTempDir(dir);
    }
  });
});
