import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppSettings, McpActivityRepository, defaultMigrationsFolder, openDatabase, runMigrations
} from "../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "./helpers/fs-cleanup";

const OP = "11111111-1111-4111-8111-111111111111";
const OP2 = "22222222-2222-4222-8222-222222222222";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "mh-activity-"));
  const handle = openDatabase({ dbPath: join(dir, "s.sqlite"), migrate: true });
  const activities = new McpActivityRepository(handle.db, handle.sqlite);
  const settings = new AppSettings(handle.db);
  return { dir, handle, activities, settings, cleanup: () => { closeDatabaseHandle(handle); removeTempDir(dir); } };
}

function startReq(overrides: Record<string, unknown> = {}) {
  return {
    operationId: OP, toolName: "markethub_health", transport: "STDIO" as const,
    ...overrides
  } as import("../packages/contracts/src/index").McpActivityStartRequest;
}

describe("M6-C activity repository", () => {
  test("migration creates mcp_activity with constraints and indexes", () => {
    const h = harness();
    try {
      const cols = h.handle.sqlite.query("PRAGMA table_info(mcp_activity)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("operation_id");
      expect(cols.map((c) => c.name)).toContain("started_at");
      const indexes = h.handle.sqlite.query("PRAGMA index_list(mcp_activity)").all() as Array<{ name: string }>;
      expect(indexes.map((i) => i.name)).toContain("mcp_activity_operation_uq");
      expect(indexes.map((i) => i.name)).toContain("mcp_activity_started_id_idx");
      // CHECK constraints reject invalid status/transport/negative duration.
      expect(() => h.handle.sqlite.run(
        "INSERT INTO mcp_activity (id,operation_id,tool_name,transport,started_at,status) VALUES (?,?,?,?,?,?)",
        ["x", "bad-status", "t", "HTTP", "2026-01-01T00:00:00.000Z", "bogus"]
      )).toThrow();
    } finally { h.cleanup(); }
  });

  test("migration upgrades a database already at 0005", () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-activity-upgrade-"));
    const oldMigrations = join(dir, "old-migrations");
    mkdirSync(oldMigrations);
    const journal = JSON.parse(readFileSync(join(defaultMigrationsFolder, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
    for (const entry of journal.entries) {
      copyFileSync(join(defaultMigrationsFolder, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));
    }
    mkdirSync(join(oldMigrations, "meta"));
    writeFileSync(join(oldMigrations, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 5) }));
    const handle = openDatabase({ dbPath: join(dir, "upgrade.sqlite") });
    try {
      runMigrations(handle.db, oldMigrations);
      const before = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_activity'").get();
      expect(before).toBeNull();
      runMigrations(handle.db, defaultMigrationsFolder);
      const after = handle.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_activity'").get();
      expect(after).toBeDefined();
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("start is idempotent; conflicting immutable fields are rejected", () => {
    const h = harness();
    try {
      const a = h.activities.start(startReq(), () => Date.parse("2026-01-01T00:00:00.000Z"));
      expect(a.ok).toBe(true);
      const again = h.activities.start(startReq(), () => Date.parse("2026-01-02T00:00:00.000Z"));
      expect(again.ok).toBe(true);
      if (a.ok && again.ok) {
        expect(again.value.id).toBe(a.value.id);
        expect(again.value.startedAt).toBe(a.value.startedAt);
      }
      const conflict = h.activities.start(startReq({ toolName: "other" }));
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.reason).toBe("conflict");
    } finally { h.cleanup(); }
  });

  test("complete updates the same row; unknown, duplicate and conflicting outcomes", () => {
    const h = harness();
    try {
      h.activities.start(startReq(), () => Date.parse("2026-01-01T00:00:00.000Z"));
      const done = h.activities.complete({ operationId: OP, status: "succeeded" }, () => Date.parse("2026-01-01T00:00:01.000Z"));
      expect(done.ok).toBe(true);
      if (done.ok) {
        expect(done.value.durationMs).toBe(1000);
        expect(done.value.finishedAt).toBe("2026-01-01T00:00:01.000Z");
      }
      const repeat = h.activities.complete({ operationId: OP, status: "succeeded" }, () => Date.parse("2026-01-05T00:00:00.000Z"));
      expect(repeat.ok).toBe(true);
      if (repeat.ok && done.ok) expect(repeat.value.finishedAt).toBe(done.value.finishedAt);

      const conflict = h.activities.complete({ operationId: OP, status: "failed" });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.reason).toBe("conflict");

      const unknown = h.activities.complete({ operationId: OP2, status: "succeeded" });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.reason).toBe("not_found");
      expect(h.handle.sqlite.query("SELECT COUNT(*) AS n FROM mcp_activity").get()).toEqual({ n: 1 });
    } finally { h.cleanup(); }
  });

  test("backwards clock never yields negative duration or inverted interval", () => {
    const h = harness();
    try {
      h.activities.start(startReq(), () => Date.parse("2026-01-02T00:00:00.000Z"));
      const done = h.activities.complete({ operationId: OP, status: "succeeded" }, () => Date.parse("2026-01-01T00:00:00.000Z"));
      expect(done.ok).toBe(true);
      if (done.ok) {
        expect(done.value.durationMs).toBe(0);
        expect(Date.parse(done.value.finishedAt)).toBeGreaterThanOrEqual(Date.parse("2026-01-02T00:00:00.000Z"));
      }
    } finally { h.cleanup(); }
  });

  test("dataResultRef round-trips through the discriminated schema", () => {
    const h = harness();
    try {
      h.activities.start(startReq());
      const ref = { kind: "snapshot" as const, snapshotId: "snap-1" };
      h.activities.complete({ operationId: OP, status: "succeeded", dataResultRef: ref });
      const view = h.activities.getByOperationId(OP);
      expect(view?.dataResultRef).toEqual(ref);
    } finally { h.cleanup(); }
  });

  test("list is keyset-paginated, filter-fingerprinted and rejects mismatched cursors", () => {
    const h = harness();
    try {
      for (let i = 0; i < 3; i++) {
        const id = i === 0 ? OP : `00000000-0000-4000-8000-00000000000${i}`;
        h.activities.start(startReq({ operationId: id, toolName: i === 2 ? "other" : "markethub_health" }), () => Date.parse(`2026-01-0${i + 1}T00:00:00.000Z`));
      }
      const p1 = h.activities.list({ toolName: "markethub_health" }, 1);
      expect(p1.ok).toBe(true);
      if (!p1.ok) return;
      expect(p1.value.records).toHaveLength(1);
      expect(p1.value.nextCursor).not.toBeNull();
      const p2 = h.activities.list({ toolName: "markethub_health" }, 1, p1.value.nextCursor!);
      expect(p2.ok).toBe(true);
      if (p2.ok) expect(p2.value.records[0]!.operationId).not.toBe(p1.value.records[0]!.operationId);
      const mismatch = h.activities.list({ toolName: "other" }, 1, p1.value.nextCursor!);
      expect(mismatch.ok).toBe(false);
    } finally { h.cleanup(); }
  });

  test("read projection re-sanitizes legacy credential-like fields and summaries", () => {
    const h = harness();
    try {
      // Seed a record the way a pre-fix writer would: free-text fields carry
      // credential-like values and the summary has an arbitrary key.
      h.activities.start(startReq({
        toolName: "Bearer abc123",
        clientName: "token=secret99",
        clientVersion: "api_secret=versionsecret",
        summaryJson: JSON.stringify({ token: "secret123", query: "NIFTY" })
      }), () => Date.parse("2026-01-01T00:00:00.000Z"));
      h.activities.complete({
        operationId: OP, status: "failed",
        errorCategory: "provider", errorMessage: "Bearer errtoken rejected"
      });

      const view = h.activities.getByOperationId(OP);
      expect(view).not.toBeNull();
      expect(view!.toolName).not.toContain("abc123");
      expect(view!.clientName).not.toContain("secret99");
      expect(view!.clientVersion).not.toContain("versionsecret");
      expect(view!.errorMessage).not.toContain("errtoken");
      // Arbitrary summary key is dropped; the legitimate one survives.
      expect(view!.summaryJson).not.toContain("secret123");
      expect(view!.summaryJson).toContain("NIFTY");
      expect(JSON.parse(view!.summaryJson!)).toEqual({ query: "NIFTY" });
    } finally { h.cleanup(); }
  });

  test("read projection sanitizes credentials inside otherwise valid summary fields", () => {
    const h = harness();
    try {
      h.activities.start(startReq({
        summaryJson: JSON.stringify({ query: "Bearer old-secret-value", limit: 25 })
      }), () => Date.parse("2026-01-01T00:00:00.000Z"));
      const view = h.activities.getByOperationId(OP);
      expect(view).not.toBeNull();
      expect(view!.summaryJson).not.toContain("old-secret-value");
      expect(view!.summaryJson).toContain("[redacted]");
      const projected = JSON.parse(view!.summaryJson!);
      expect(projected.limit).toBe(25);
      expect(projected.query).toContain("[redacted]");
    } finally { h.cleanup(); }
  });

  test("cleanupActivities deletes in bounded batches", () => {
    const h = harness();
    try {
      for (let i = 0; i < 5; i++) {
        h.activities.start(startReq({ operationId: `00000000-0000-4000-8000-0000000000${i}` }), () => Date.parse("2026-01-01T00:00:00.000Z"));
      }
      const deleted = h.activities.cleanupActivities(Date.parse("2026-02-01T00:00:00.000Z"), 2);
      expect(deleted).toBe(5);
      expect(h.handle.sqlite.query("SELECT COUNT(*) AS n FROM mcp_activity").get()).toEqual({ n: 0 });
    } finally { h.cleanup(); }
  });
});
