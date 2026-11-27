import { and, desc, eq, gte, lt, lte, or, type SQL } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import { mcpActivityResultRefSchema, projectSafeSummaryJson, sanitizeSensitiveText } from "@markethub/contracts";
import type {
  CatalogWriteGuard,
  McpActivityCompleteRequest, McpActivityCompleteResult, McpActivityFilters,
  McpActivityList, McpActivityStartRequest, McpActivityStartResult,
  McpActivityStatus, McpActivityView
} from "@markethub/contracts";
import { mcpActivity } from "../schema";
import type { MarketHubDb } from "../index";

export type ActivityStartOutcome =
  | { ok: true; value: McpActivityStartResult }
  | { ok: false; reason: "conflict"; message: string };

export type ActivityCompleteOutcome =
  | { ok: true; value: McpActivityCompleteResult }
  | { ok: false; reason: "not_found" | "conflict"; message: string };

const CURSOR_PREFIX = "v1.";
const MAX_CURSOR_LENGTH = 4096;

interface CursorPayload {
  k: [string, string]; // [startedAt, id]
  f: string; // normalized filter fingerprint
}

function fingerprint(filters: McpActivityFilters): string {
  // Fixed key order makes this deterministic; JSON avoids hash collisions.
  return JSON.stringify({
    toolName: filters.toolName ?? null,
    transport: filters.transport ?? null,
    status: filters.status ?? null,
    from: filters.from ?? null,
    to: filters.to ?? null
  });
}

function encodeCursor(payload: CursorPayload): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string, expectedFingerprint: string): CursorPayload | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  if (!raw.startsWith(CURSOR_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw.slice(CURSOR_PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.k) || obj.k.length !== 2) return null;
    if (typeof obj.k[0] !== "string" || typeof obj.k[1] !== "string") return null;
    if (typeof obj.f !== "string" || obj.f !== expectedFingerprint) return null;
    return { k: [obj.k[0], obj.k[1]], f: obj.f };
  } catch {
    return null;
  }
}

/** Durable, bounded MCP activity history. The API process owns this repository. */
export class McpActivityRepository {
  /** G0-C: optional injected write guard; absent = legacy behaviour. */
  constructor(private readonly db: MarketHubDb, private readonly sqlite: Database, private readonly guard?: CatalogWriteGuard) {}

  /** Insert a started row; identical repeats are idempotent, immutable-field repeats conflict. */
  start(req: McpActivityStartRequest, now: () => number = () => Date.now()): ActivityStartOutcome {
    this.guard?.assertWritable("I"); // G0-C #27/#29: before INSERT OR IGNORE
    const id = crypto.randomUUID();
    const startedAt = new Date(now()).toISOString();
    // Atomic insert: a concurrent duplicate is ignored by the unique index rather
    // than throwing, then re-read below to decide idempotent-success vs conflict.
    const inserted = this.sqlite.run(
      `INSERT OR IGNORE INTO mcp_activity
       (id, operation_id, tool_name, transport, started_at, status, client_started_at, client_name, client_version, summary_json)
       VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?, ?)`,
      [id, req.operationId, req.toolName, req.transport, startedAt,
       req.clientStartedAt ?? null, req.clientName ?? null, req.clientVersion ?? null, req.summaryJson ?? null]
    );
    if (inserted.changes === 0) {
      const existing = this.db.select().from(mcpActivity)
        .where(eq(mcpActivity.operationId, req.operationId)).get();
      if (!existing) return { ok: false, reason: "conflict", message: "concurrent start could not be resolved" };
      if (existing.toolName !== req.toolName || existing.transport !== req.transport) {
        return { ok: false, reason: "conflict", message: "operationId already used with different immutable fields" };
      }
      return {
        ok: true,
        value: { id: existing.id, operationId: existing.operationId, startedAt: existing.startedAt }
      };
    }
    return { ok: true, value: { id, operationId: req.operationId, startedAt } };
  }

  /** Update to a terminal status; unknown -> not-found, conflicting terminal -> conflict. */
  complete(req: McpActivityCompleteRequest, now: () => number = () => Date.now()): ActivityCompleteOutcome {
    this.guard?.assertWritable("I"); // G0-C #28/#29: before conditional UPDATE
    const row = this.db.select().from(mcpActivity)
      .where(eq(mcpActivity.operationId, req.operationId)).get();
    if (!row) return { ok: false, reason: "not_found", message: "unknown operationId" };

    if (row.status !== "started") {
      if (row.status === req.status) {
        return {
          ok: true,
          value: {
            id: row.id, status: row.status,
            finishedAt: row.finishedAt ?? row.startedAt,
            durationMs: row.durationMs ?? 0
          }
        };
      }
      return { ok: false, reason: "conflict", message: "operation already completed with a different status" };
    }

    // Clamp finish to >= start so a backwards wall-clock cannot invert the interval.
    const startMs = Date.parse(row.startedAt);
    const finishedMs = Math.max(now(), Number.isFinite(startMs) ? startMs : now());
    const finishedAt = new Date(finishedMs).toISOString();
    const durationMs = Math.max(0, finishedMs - (Number.isFinite(startMs) ? startMs : finishedMs));

    // Conditional update: only the first terminal write wins. A concurrent
    // second writer sees changes=0 and re-reads to return stable/conflict.
    const updated = this.sqlite.run(
      `UPDATE mcp_activity SET status = ?, finished_at = ?, duration_ms = ?,
       client_finished_at = ?, error_category = ?, error_message = ?, data_result_ref = ?
       WHERE operation_id = ? AND status = 'started'`,
      [req.status, finishedAt, durationMs, req.clientFinishedAt ?? null,
       req.errorCategory ?? null, req.errorMessage ?? null,
       req.dataResultRef ? JSON.stringify(req.dataResultRef) : null, req.operationId]
    );
    if (updated.changes === 0) {
      const current = this.db.select().from(mcpActivity)
        .where(eq(mcpActivity.operationId, req.operationId)).get();
      if (!current) return { ok: false, reason: "not_found", message: "unknown operationId" };
      if (current.status === req.status) {
        return {
          ok: true,
          value: {
            id: current.id, status: current.status,
            finishedAt: current.finishedAt ?? current.startedAt,
            durationMs: current.durationMs ?? 0
          }
        };
      }
      return { ok: false, reason: "conflict", message: "operation already completed with a different status" };
    }

    return { ok: true, value: { id: row.id, status: req.status, finishedAt, durationMs } };
  }

  /** Bounded keyset page with filter-fingerprinted cursor. */
  list(filters: McpActivityFilters, limit: number, cursor?: string): { ok: true; value: McpActivityList } | { ok: false; message: string } {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100));
    const fp = fingerprint(filters);
    let key: [string, string] | undefined;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor, fp);
      if (!decoded) return { ok: false, message: "invalid or filter-mismatched cursor" };
      key = decoded.k;
    }

    const conditions: SQL[] = [];
    if (filters.toolName !== undefined) conditions.push(eq(mcpActivity.toolName, filters.toolName));
    if (filters.transport !== undefined) conditions.push(eq(mcpActivity.transport, filters.transport));
    if (filters.status !== undefined) conditions.push(eq(mcpActivity.status, filters.status));
    if (filters.from !== undefined) conditions.push(gte(mcpActivity.startedAt, filters.from));
    if (filters.to !== undefined) conditions.push(lte(mcpActivity.startedAt, filters.to));
    if (key) {
      conditions.push(or(
        lt(mcpActivity.startedAt, key[0]),
        and(eq(mcpActivity.startedAt, key[0]), lt(mcpActivity.id, key[1]))
      )!);
    }

    const rows = this.db.select().from(mcpActivity)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(mcpActivity.startedAt), desc(mcpActivity.id))
      .limit(bounded + 1)
      .all();
    const page = rows.slice(0, bounded);
    const last = page[page.length - 1];
    const nextCursor = rows.length > bounded && last
      ? encodeCursor({ k: [last.startedAt, last.id], f: fp })
      : null;
    return { ok: true, value: { records: page.map((r) => this.toView(r)), nextCursor } };
  }

  getById(id: string): McpActivityView | null {
    const row = this.db.select().from(mcpActivity).where(eq(mcpActivity.id, id)).get();
    return row ? this.toView(row) : null;
  }

  getByOperationId(operationId: string): McpActivityView | null {
    const row = this.db.select().from(mcpActivity).where(eq(mcpActivity.operationId, operationId)).get();
    return row ? this.toView(row) : null;
  }

  /** Bounded, batched cleanup by authoritative started_at. */
  cleanupActivities(cutoffMs: number, batchLimit = 500): number {
    this.guard?.assertWritable("I"); // G0-C #18: before any batched DELETE
    const limit = Math.max(1, Math.min(batchLimit, 10000));
    const cutoff = new Date(cutoffMs).toISOString();
    let deleted = 0;
    while (true) {
      const result = this.sqlite.run(
        "DELETE FROM mcp_activity WHERE rowid IN (SELECT rowid FROM mcp_activity WHERE started_at <= ? LIMIT ?)",
        [cutoff, limit]
      );
      deleted += result.changes;
      if (result.changes < limit) break;
    }
    return deleted;
  }

  private toView(r: typeof mcpActivity.$inferSelect): McpActivityView {
    let ref: McpActivityView["dataResultRef"] = null;
    if (r.dataResultRef) {
      try {
        const parsed = mcpActivityResultRefSchema.safeParse(JSON.parse(r.dataResultRef) as unknown);
        ref = parsed.success ? parsed.data : null;
      } catch {
        ref = null;
      }
    }
    return {
      id: r.id,
      operationId: r.operationId,
      // Re-sanitize on read: records written before the strict schema may
      // contain credential-like values in any of these free-text fields.
      toolName: sanitizeSensitiveText(r.toolName, 200),
      transport: r.transport as McpActivityView["transport"],
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      clientStartedAt: r.clientStartedAt,
      clientFinishedAt: r.clientFinishedAt,
      clientName: r.clientName === null ? null : sanitizeSensitiveText(r.clientName, 120),
      clientVersion: r.clientVersion === null ? null : sanitizeSensitiveText(r.clientVersion, 120),
      status: r.status as McpActivityStatus,
      errorCategory: r.errorCategory === null ? null : sanitizeSensitiveText(r.errorCategory, 64),
      errorMessage: r.errorMessage === null ? null : sanitizeSensitiveText(r.errorMessage, 300),
      summaryJson: r.summaryJson === null ? null : projectSafeSummaryJson(r.summaryJson),
      dataResultRef: ref
    };
  }
}
