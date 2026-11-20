import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { AppSettings, McpActivityRepository, defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { applyRetentionCleanup } from "../../apps/api/src/historical-routes";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const OP = "33333333-3333-4333-8333-333333333333";

function harness() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "mh-activity-route-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const activities = new McpActivityRepository(db.db, db.sqlite);
  const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now(), activityRepo: activities });
  const localEnv = { requestIP: () => ({ address: "127.0.0.1" }) };
  const remoteEnv = { requestIP: () => ({ address: "8.8.8.8" }) };
  return { app, activities, localEnv, remoteEnv, cleanup: () => { closeDatabaseHandle(db); removeTempDir(dir); } };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

function startBody(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OP, toolName: "markethub_health", transport: "HTTP",
    ...overrides
  };
}

describe("M6-C activity API routes", () => {
  test("start/complete are local-owner only", async () => {
    const h = harness();
    try {
      const remote = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(startBody())
      }, h.remoteEnv);
      expect(remote.status).toBe(403);
      const local = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(startBody())
      }, h.localEnv);
      expect(local.status).toBe(200);
    } finally { h.cleanup(); }
  });

  test("STDIO writes are always labelled STDIO regardless of caller transport", async () => {
    const h = harness();
    try {
      await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(startBody({ transport: "HTTP" }))
      }, h.localEnv);
      const view = h.activities.getByOperationId(OP);
      expect(view?.transport).toBe("STDIO");
    } finally { h.cleanup(); }
  });

  test("complete unknown -> 404, conflicting terminal -> 409", async () => {
    const h = harness();
    try {
      const unknown = await h.app.request("/api/mcp/activity/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: OP, status: "succeeded" })
      }, h.localEnv);
      expect(unknown.status).toBe(404);

      await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(startBody())
      }, h.localEnv);
      const first = await h.app.request("/api/mcp/activity/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: OP, status: "succeeded" })
      }, h.localEnv);
      expect(first.status).toBe(200);
      const conflict = await h.app.request("/api/mcp/activity/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: OP, status: "failed" })
      }, h.localEnv);
      expect(conflict.status).toBe(409);
    } finally { h.cleanup(); }
  });

  test("list is bounded, filtered and rejects mismatched cursors; both detail forms work", async () => {
    const h = harness();
    try {
      for (let i = 0; i < 3; i++) {
        await h.app.request("/api/mcp/activity/start", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(startBody({ operationId: `44444444-4444-4444-8444-44444444444${i}`, toolName: i === 2 ? "other" : "markethub_health" }))
        }, h.localEnv);
      }
      const list = await h.app.request("/api/mcp/activity?toolName=markethub_health&limit=1", {}, h.remoteEnv);
      expect(list.status).toBe(200);
      const body = await json(list);
      expect((body.records as unknown[]).length).toBe(1);
      expect(body.nextCursor).not.toBeNull();

      const mismatch = await h.app.request(`/api/mcp/activity?toolName=other&limit=1&cursor=${encodeURIComponent(body.nextCursor as string)}`, {}, h.remoteEnv);
      expect(mismatch.status).toBe(400);

      const byOp = await h.app.request(`/api/mcp/activity/by-operation/${OP}`, {}, h.remoteEnv);
      expect(byOp.status).toBe(404); // OP not used in this test's seeds
      const firstId = (body.records as Array<{ id: string }>)[0]!.id;
      const byId = await h.app.request(`/api/mcp/activity/${firstId}`, {}, h.remoteEnv);
      expect(byId.status).toBe(200);
      const view = await json(byId);
      expect(Object.keys(view).sort()).toEqual([
        "clientFinishedAt", "clientName", "clientStartedAt", "clientVersion", "dataResultRef",
        "durationMs", "errorCategory", "errorMessage", "finishedAt", "id", "operationId",
        "startedAt", "status", "summaryJson", "toolName", "transport"
      ].sort());
    } finally { h.cleanup(); }
  });

  test("malformed bodies and unknown fields are rejected", async () => {
    const h = harness();
    try {
      const bad = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: "not-a-uuid", toolName: "x", transport: "HTTP", extra: 1 })
      }, h.localEnv);
      expect(bad.status).toBe(400);
    } finally { h.cleanup(); }
  });

  test("applyRetentionCleanup deletes ACTIVITY rows and fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-activity-retention-"));
    const dbPath = join(dir, "test.sqlite");
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    const activities = new McpActivityRepository(db.db, db.sqlite);
    const settings = new AppSettings(db.db);
    const candles = { cleanupCandles: () => 0 } as never;
    const snapshots = { cleanupSnapshots: () => 0 } as never;
    try {
      // Missing settings -> fail closed, nothing deleted.
      const missing = applyRetentionCleanup(settings, candles, snapshots, activities, () => Date.parse("2026-03-01T00:00:00.000Z"));
      expect(missing.ran).toBe(false);
      expect(missing.activitiesDeleted).toBe(0);

      activities.start({ operationId: OP, toolName: "t", transport: "STDIO" }, () => Date.parse("2026-01-01T00:00:00.000Z"));
      settings.setRetention({ version: 1, classes: { ACTIVITY: { maxAgeDays: 7 } } });
      const result = applyRetentionCleanup(settings, candles, snapshots, activities, () => Date.parse("2026-03-01T00:00:00.000Z"));
      expect(result.ran).toBe(true);
      expect(result.activitiesDeleted).toBe(1);
      expect(activities.getByOperationId(OP)).toBeNull();
    } finally { closeDatabaseHandle(db); removeTempDir(dir); }
  });

  test("/api/status reports httpHandlerMounted truthfully", async () => {
    const h = harness();
    try {
      const without = await json(await h.app.request("/api/status"));
      expect((without.mcp as { httpHandlerMounted: boolean }).httpHandlerMounted).toBe(false);
    } finally { h.cleanup(); }
  });

  test("/api/status reports httpHandlerMounted true when a handler is mounted", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "mh-activity-status-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    const fakeHandler = {
      fetch: async () => new Response("ok"), close: async () => {},
      notify: {}, bus: {}
    } as never;
    const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now(), mcpHandler: fakeHandler });
    try {
      const payload = await json(await app.request("/api/status"));
      expect((payload.mcp as { httpHandlerMounted: boolean }).httpHandlerMounted).toBe(true);
    } finally { closeDatabaseHandle(db); removeTempDir(dir); }
  });
});
