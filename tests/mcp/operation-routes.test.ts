import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpOperationListSchema } from "../../packages/contracts/src/index";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const OPERATIONS_PATH = "/api/mcp/operations";
const ALLOWED_KEYS = ["description", "name", "title", "type"];
const FORBIDDEN_KEYS = [
  "inputSchema", "annotations", "config", "secrets", "handler", "arguments",
  "token", "credential", "credentials", "provider", "permissions", "availability"
];

function harness() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "mh-operation-route-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const app = createApp({ config, db, logger: createLogger("error"), startedAt: Date.now() });
  const localEnv = { requestIP: () => ({ address: "127.0.0.1" }) };
  return { app, localEnv, cleanup: () => { closeDatabaseHandle(db); removeTempDir(dir); } };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return await res.json() as Record<string, unknown>;
}

describe("MCP operation discovery API route", () => {
  test("GET returns 200 with the exact {operations} envelope and passes the strict schema", async () => {
    const h = harness();
    try {
      const res = await h.app.request(OPERATIONS_PATH);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(Object.keys(body).sort()).toEqual(["operations"]);
      expect(Array.isArray(body.operations)).toBe(true);
      expect(() => mcpOperationListSchema.parse(body)).not.toThrow();
    } finally { h.cleanup(); }
  });

  test("returns all 19 descriptors with 9 tools, 7 resources and 3 prompts", async () => {
    const h = harness();
    try {
      const body = await json(await h.app.request(OPERATIONS_PATH));
      const operations = body.operations as Array<{ type: string }>;
      expect(operations).toHaveLength(19);
      const counts = operations.reduce<Record<string, number>>((acc, op) => {
        acc[op.type] = (acc[op.type] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts).toEqual({ tool: 9, resource: 7, prompt: 3 });
    } finally { h.cleanup(); }
  });

  test("raw JSON exposes only safe display keys with the correct title rule", async () => {
    const h = harness();
    try {
      const body = await json(await h.app.request(OPERATIONS_PATH));
      const operations = body.operations as Array<Record<string, unknown>>;
      expect(operations.length).toBeGreaterThan(0);
      for (const entry of operations) {
        const keys = Object.keys(entry);
        for (const key of keys) expect(ALLOWED_KEYS).toContain(key);
        expect(keys).toContain("description");
        expect(keys).toContain("name");
        expect(keys).toContain("type");
        expect("title" in entry).toBe(entry.type !== "tool");
      }
    } finally { h.cleanup(); }
  });

  test("no unapproved fields (input schemas, annotations, config, secrets, etc.) are exposed", async () => {
    const h = harness();
    try {
      const body = await json(await h.app.request(OPERATIONS_PATH));
      const operations = body.operations as Array<Record<string, unknown>>;
      for (const entry of operations) {
        for (const key of FORBIDDEN_KEYS) expect(Object.keys(entry)).not.toContain(key);
      }
    } finally { h.cleanup(); }
  });

  test("response carries Cache-Control: no-store", async () => {
    const h = harness();
    try {
      const res = await h.app.request(OPERATIONS_PATH);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally { h.cleanup(); }
  });

  test("route is read-only: POST, PUT and DELETE return 404", async () => {
    const h = harness();
    try {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const res = await h.app.request(OPERATIONS_PATH, { method });
        expect(res.status).toBe(404);
      }
    } finally { h.cleanup(); }
  });

  test("does not alter /api/mcp/activity behavior", async () => {
    const h = harness();
    try {
      const started = await h.app.request("/api/mcp/activity/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: "55555555-5555-4555-8555-555555555555",
          toolName: "markethub_health", transport: "HTTP"
        })
      }, h.localEnv);
      expect(started.status).toBe(200);

      // Fetching operations must not disturb activity reads.
      expect((await h.app.request(OPERATIONS_PATH)).status).toBe(200);

      const list = await h.app.request("/api/mcp/activity?toolName=markethub_health", {}, h.localEnv);
      expect(list.status).toBe(200);
      const body = await json(list);
      const records = body.records as Array<{ toolName: string }>;
      expect(records).toHaveLength(1);
      expect(records[0]!.toolName).toBe("markethub_health");
    } finally { h.cleanup(); }
  });
});
