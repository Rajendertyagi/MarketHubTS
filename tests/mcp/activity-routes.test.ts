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

/** Build a chunked streaming body with no Content-Length, tracking cancellation. */
function streamingBody(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(enc.encode(chunks[i++]!));
    },
    cancel() { onCancel?.(); }
  });
}

function streamRequest(path: string, body: ReadableStream<Uint8Array>): Request {
  // A ReadableStream body means the runtime does not set Content-Length.
  return new Request(`http://localhost${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body
  });
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

  test("summaryJson must be a bounded safe-summary JSON object", async () => {
    const h = harness();
    try {
      const bad = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startBody({ summaryJson: "not-json" }))
      }, h.localEnv);
      expect(bad.status).toBe(400);
      const unsafe = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startBody({ summaryJson: JSON.stringify({ token: "secret123" }) }))
      }, h.localEnv);
      // Strict allow-list rejects arbitrary summary keys (Finding 1).
      expect(unsafe.status).toBe(400);
      const allowed = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startBody({ summaryJson: JSON.stringify({ query: "NIFTY" }) }))
      }, h.localEnv);
      expect(allowed.status).toBe(200);
    } finally { h.cleanup(); }
  });

  test("complete error fields are redacted before persistence", async () => {
    const h = harness();
    try {
      await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(startBody())
      }, h.localEnv);
      await h.app.request("/api/mcp/activity/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId: OP, status: "failed", errorCategory: "provider", errorMessage: "Bearer abc123 token=secret99 rejected" })
      }, h.localEnv);
      const view = h.activities.getByOperationId(OP);
      expect(view?.errorMessage).not.toContain("abc123");
      expect(view?.errorMessage).not.toContain("secret99");
      expect(view?.errorMessage).toContain("[redacted]");
    } finally { h.cleanup(); }
  });

  test("oversized request bodies are rejected", async () => {
    const h = harness();
    try {
      const huge = "x".repeat(5000);
      const res = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startBody({ toolName: huge }))
      }, h.localEnv);
      expect(res.status).toBe(400);
    } finally { h.cleanup(); }
  });

  test("oversized body without Content-Length is rejected while streaming (start)", async () => {
    const h = harness();
    try {
      // 10 chunks x 1000 bytes = 10,000 bytes, streamed with no Content-Length.
      const chunks = Array.from({ length: 10 }, () => "x".repeat(1000));
      let cancelled = false;
      const req = streamRequest("/api/mcp/activity/start", streamingBody(chunks, () => { cancelled = true; }));
      expect(req.headers.get("content-length")).toBeNull();
      const res = await h.app.request(req, undefined, h.localEnv);
      expect(res.status).toBe(400);
      // The stream was cancelled early rather than fully buffered/consumed.
      expect(cancelled).toBe(true);
    } finally { h.cleanup(); }
  });

  test("oversized body without Content-Length is rejected while streaming (complete)", async () => {
    const h = harness();
    try {
      const chunks = Array.from({ length: 10 }, () => "y".repeat(1000));
      let cancelled = false;
      const req = streamRequest("/api/mcp/activity/complete", streamingBody(chunks, () => { cancelled = true; }));
      expect(req.headers.get("content-length")).toBeNull();
      const res = await h.app.request(req, undefined, h.localEnv);
      expect(res.status).toBe(400);
      expect(cancelled).toBe(true);
    } finally { h.cleanup(); }
  });

  test("multibyte body exceeding 4096 UTF-8 bytes is rejected even when JS length is under the limit", async () => {
    const h = harness();
    try {
      // "é" is 1 JS char but 2 UTF-8 bytes. 3000 chars => JS length ~3060 (< 4096)
      // but ~6000 UTF-8 bytes (> 4096). The old string-length check would accept it.
      const toolName = "é".repeat(3000);
      const body = JSON.stringify(startBody({ toolName }));
      expect(body.length).toBeLessThan(4096);
      expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4096);
      const res = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body
      }, h.localEnv);
      expect(res.status).toBe(400);
    } finally { h.cleanup(); }
  });

  test("split chunks that total under the limit are accepted", async () => {
    const h = harness();
    try {
      const payload = JSON.stringify(startBody());
      const mid = Math.floor(payload.length / 2);
      const req = streamRequest("/api/mcp/activity/start", streamingBody([payload.slice(0, mid), payload.slice(mid)]));
      const res = await h.app.request(req, undefined, h.localEnv);
      expect(res.status).toBe(200);
      expect(h.activities.getByOperationId(OP)).not.toBeNull();
    } finally { h.cleanup(); }
  });

  test("declared oversized Content-Length is rejected early", async () => {
    const h = harness();
    try {
      const req = new Request("http://localhost/api/mcp/activity/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "99999" },
        body: streamingBody([JSON.stringify(startBody())])
      });
      expect(req.headers.get("content-length")).toBe("99999");
      const res = await h.app.request(req, undefined, h.localEnv);
      expect(res.status).toBe(400);
    } finally { h.cleanup(); }
  });

  test("a body of exactly 4096 bytes is accepted", async () => {
    const h = harness();
    try {
      // Pad with trailing JSON whitespace (ignored by JSON.parse) so the body
      // is exactly 4096 bytes while still parsing to a schema-valid request.
      const base = JSON.stringify(startBody());
      const body = base + " ".repeat(4096 - base.length);
      expect(new TextEncoder().encode(body).byteLength).toBe(4096);
      const res = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body
      }, h.localEnv);
      expect(res.status).toBe(200);
    } finally { h.cleanup(); }
  });

  test("toolName is sanitized on the STDIO write path", async () => {
    const h = harness();
    try {
      await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startBody({ toolName: "Bearer abc123" }))
      }, h.localEnv);
      const view = h.activities.getByOperationId(OP);
      expect(view?.toolName).not.toContain("abc123");
      expect(view?.toolName).toContain("[redacted]");
    } finally { h.cleanup(); }
  });

  test("empty and malformed bodies are rejected generically", async () => {
    const h = harness();
    try {
      const empty = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: ""
      }, h.localEnv);
      expect(empty.status).toBe(400);
      const malformed = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json"
      }, h.localEnv);
      expect(malformed.status).toBe(400);
      const body = await json(malformed);
      expect(body.message).toBe("Invalid activity start request"); // generic, no echo
    } finally { h.cleanup(); }
  });

  test("default createApp composition wires activity retention cleanup", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "mh-activity-default-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now() });
    const localEnv = { requestIP: () => ({ address: "127.0.0.1" }) };
    try {
      const started = await app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startBody())
      }, localEnv);
      expect(started.status).toBe(200);
      const settings = new AppSettings(db.db);
      settings.setRetention({ version: 1, classes: { ACTIVITY: { maxAgeDays: 1 } } });
      const cleanup = await app.request("/api/retention/cleanup", { method: "POST" }, localEnv);
      expect(cleanup.status).toBe(200);
      const body = await json(cleanup);
      expect(typeof body.activitiesDeleted).toBe("number");
    } finally { closeDatabaseHandle(db); removeTempDir(dir); }
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
