import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, resetConfigCache } from "../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../packages/database/src/index";
import { createApp } from "../apps/api/src/app";
import { createLogger } from "../apps/api/src/lib/logger";

function findBuiltAsset(distDir: string): string {
  const assetsDir = join(distDir, "assets");
  if (!existsSync(assetsDir)) throw new Error(`Missing assets directory: ${assetsDir}`);
  const files = readdirSync(assetsDir);
  const js = files.find((f) => f.endsWith(".js"));
  const css = files.find((f) => f.endsWith(".css"));
  const pick = js ?? css;
  if (!pick) throw new Error("No built JS/CSS asset found in dist/assets");
  return `/assets/${pick}`;
}

describe("production serving", () => {
  test("serves WebUI root HTML and built assets while keeping API endpoints", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "markethub-prod-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "production", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3998" } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    const deps = { config, db, logger: createLogger("error"), startedAt: Date.now() };
    const distDir = resolve(import.meta.dir, "../apps/web/dist");
    try {
      expect(existsSync(join(distDir, "index.html"))).toBe(true);
      const app = createApp(deps);

      const root = await app.request("/");
      expect(root.status).toBe(200);
      const html = await root.text();
      expect(root.headers.get("content-type") ?? "").toContain("text/html");
      expect(html).toContain("<div id=\"root\">");
      expect(html).not.toContain("\"name\":\"MarketHubTS API\"");

      const assetPath = findBuiltAsset(distDir);
      const asset = await app.request(assetPath);
      expect(asset.status).toBe(200);
      const assetType = asset.headers.get("content-type") ?? "";
      expect(assetType.includes("javascript") || assetType.includes("css") || assetType.includes("text/plain")).toBe(true);

      const health = await app.request("/health");
      expect(health.status).toBe(200);
      const status = await app.request("/api/status");
      expect(status.status).toBe(200);
    } finally {
      try {
        db.close();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});
