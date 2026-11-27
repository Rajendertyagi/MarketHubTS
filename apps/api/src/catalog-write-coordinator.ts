/**
 * G0-C — API-owned catalog write coordinator (plan §8, §9.4).
 *
 * This module is the single application-level authority that decides whether a
 * write may proceed while a catalog refresh owns the write permit. It
 * implements the dependency-light `CatalogWriteGuard` interface declared in
 * `@markethub/contracts`; `packages/database` consumes only that interface via
 * injection and never imports this module (no dependency inversion, §11.2).
 *
 * Owner decisions implemented here (§12.1):
 *   - interactive (`I`) writes fail fast with 503 `CATALOG_WRITE_BUSY`;
 *   - background (`B`) writes skip and retry on the next tick — no volatile
 *     queue and never a success claim;
 *   - internal (`INTERNAL`) token/diagnostic writes only outside
 *     `RELEASING`/`OWNED`/`UNKNOWN`;
 *   - `busy_timeout` is untouched (5000 ms safety fallback only);
 *   - `OWNED` is granted only after active write scopes drain; a drain timeout
 *     is a `txn-refused` refusal, never a degraded grant (revision 2026-11-27).
 *
 * No schema, migration, config, dependency or error-enum change is introduced.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  apiErrorSchema,
  type CatalogWriteGuard,
  type WritePriority,
  type WriteScope
} from "@markethub/contracts";

/** Backend-owned module constant — not a duplicated frontend literal (§8.2). */
export const CATALOG_WRITE_BUSY = "CATALOG_WRITE_BUSY";
/** Bounded, documented drain guard. Not a latency budget or a busy_timeout change. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

export type PermitState = "IDLE" | "RESERVED" | "RELEASING" | "OWNED" | "UNKNOWN";

export interface CatalogWriteBusyDetails {
  retryable: true;
  code: typeof CATALOG_WRITE_BUSY;
  provider?: "UPSTOX" | "FYERS";
}

/** Thrown by `assertWritable("I"|"INTERNAL")` and `acquireWriteScope` when busy. */
export class CatalogWriteBusyError extends Error {
  readonly code = CATALOG_WRITE_BUSY;
  readonly retryable = true;
  readonly details: CatalogWriteBusyDetails;

  constructor(
    message = "Catalog refresh owns the database write lock; retry shortly",
    provider?: "UPSTOX" | "FYERS"
  ) {
    super(message);
    this.name = "CatalogWriteBusyError";
    this.details = {
      retryable: true,
      code: CATALOG_WRITE_BUSY,
      ...(provider ? { provider } : {})
    };
  }
}

/** Existing `apiErrorSchema` envelope — no contract value change (§8.2). */
export function catalogWriteBusyBody(error?: CatalogWriteBusyError) {
  return apiErrorSchema.parse({
    error: CATALOG_WRITE_BUSY,
    message: error?.message ?? "Catalog refresh owns the database write lock; retry shortly",
    details: error?.details ?? { retryable: true, code: CATALOG_WRITE_BUSY }
  });
}

/**
 * Residual SQLite contention (e.g. an orphan child) is mapped to the SAME
 * retryable 503 contract and logged as a contention event by the caller. This
 * is a fallback only — the coordinator rejects before SQLite in normal flow.
 */
export function mapContentionError(error: unknown): unknown {
  if (error instanceof CatalogWriteBusyError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_BUSY|database is locked|database table is locked/i.test(message)) {
    return new CatalogWriteBusyError("Database write lock is busy; retry shortly");
  }
  return error;
}

export type CoordinatorEvent =
  | { type: "scope-acquired"; id: string; priority: WritePriority; active: number }
  | { type: "scope-released"; id: string; priority: WritePriority; active: number }
  | { type: "drain-start"; active: number }
  | { type: "drain-ok"; active: number }
  | { type: "drain-timeout"; active: number };

export interface CoordinatorOptions {
  /** Reads the authoritative permit state from the G0-D ownership instance. */
  getPermitState: () => PermitState;
  drainTimeoutMs?: number;
  onEvent?: (event: CoordinatorEvent) => void;
}

/**
 * Async-local scope propagation lets a multi-write operation acquire ONE scope
 * at entry and have every inner repository write (including writes made inside
 * broker adapters, which are outside this package) validated against that same
 * scope — without changing repository/adapter signatures (§8.4).
 */
const activeScope = new AsyncLocalStorage<WriteScope | undefined>();

/** Concrete seam used by API routes/services that need a single spanning scope. */
export interface ApiWriteGuard extends CatalogWriteGuard {
  withScope<T>(priority: WritePriority, fn: () => T | Promise<T>): Promise<T>;
}

/** Build the 503 response from the existing error envelope (§8.2). */
export function busyResponse(error: CatalogWriteBusyError): Response {
  return Response.json(catalogWriteBusyBody(error), { status: 503 });
}

/**
 * Fail-fast check for a single interactive write at route entry — before any
 * adapter/network/encryption work. Returns a 503 Response when busy, else null.
 */
export function writeBusyResponse(
  guard: CatalogWriteGuard | undefined,
  priority: WritePriority = "I"
): Response | null {
  if (!guard) return null;
  try {
    if (guard.assertWritable(priority) === "SKIP") return null;
    return null;
  } catch (error) {
    if (error instanceof CatalogWriteBusyError) return busyResponse(error);
    throw error;
  }
}

/**
 * Run a multi-write interactive operation under ONE scope (§8.4). A permit
 * change cannot split it: all writes land before OWNED or none do. Returns a
 * 503 Response instead of the value when the scope cannot be admitted.
 */
export async function runInteractiveWrite<T>(
  guard: ApiWriteGuard | undefined,
  fn: () => T | Promise<T>
): Promise<T | Response> {
  if (!guard) return await fn();
  try {
    return await guard.withScope("I", fn);
  } catch (error) {
    if (error instanceof CatalogWriteBusyError) return busyResponse(error);
    throw error;
  }
}

export class CatalogWriteCoordinator implements CatalogWriteGuard {
  private readonly scopes = new Set<WriteScope>();
  private readonly getPermitState: () => PermitState;
  private readonly drainTimeoutMs: number;
  private readonly onEvent: ((event: CoordinatorEvent) => void) | undefined;
  private seq = 0;

  constructor(options: CoordinatorOptions) {
    this.getPermitState = options.getPermitState;
    this.drainTimeoutMs = Math.max(1, Math.floor(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS));
    this.onEvent = options.onEvent;
  }

  get activeScopeCount(): number { return this.scopes.size; }

  private isBusy(): boolean {
    const state = this.getPermitState();
    return state === "RELEASING" || state === "OWNED" || state === "UNKNOWN";
  }

  /**
   * Single-write convenience form. With an explicit `scope`, only validates
   * that the scope is still active (no re-acquire) — so a permit change cannot
   * split a multi-write operation. With no scope, an async-local scope (set by
   * `withScope`) is honoured; otherwise a transient scope is acquired and
   * released synchronously around the check.
   */
  assertWritable(priority: WritePriority, scope?: WriteScope): void | "SKIP" {
    if (scope !== undefined) {
      if (!this.scopes.has(scope)) {
        throw new CatalogWriteBusyError("Write scope is no longer active");
      }
      return;
    }
    const inherited = activeScope.getStore();
    if (inherited !== undefined && this.scopes.has(inherited)) return;

    if (this.isBusy()) {
      if (priority === "B") return "SKIP";
      throw new CatalogWriteBusyError();
    }
    const transient = this.acquireWriteScope(priority);
    this.releaseWriteScope(transient);
  }

  acquireWriteScope(priority: WritePriority): WriteScope {
    if (this.isBusy()) throw new CatalogWriteBusyError();
    const scope: WriteScope = { priority, id: `ws-${++this.seq}` };
    this.scopes.add(scope);
    this.onEvent?.({ type: "scope-acquired", id: scope.id, priority, active: this.scopes.size });
    return scope;
  }

  releaseWriteScope(scope: WriteScope): void {
    if (this.scopes.delete(scope)) {
      this.onEvent?.({ type: "scope-released", id: scope.id, priority: scope.priority, active: this.scopes.size });
    }
  }

  /**
   * Run a multi-write operation under ONE scope. The scope is admitted only
   * while the permit is IDLE/RESERVED; once RELEASING starts no new scope is
   * admitted and `drain()` waits for this scope to finish before OWNED.
   */
  async withScope<T>(priority: WritePriority, fn: () => T | Promise<T>): Promise<T> {
    const scope = this.acquireWriteScope(priority);
    try {
      return await activeScope.run(scope, fn);
    } finally {
      this.releaseWriteScope(scope);
    }
  }

  /**
   * Stop-admit + drain. Called by the G0-D ownership grant between RELEASING
   * and OWNED. Returns true only when zero scopes remain; on timeout returns
   * false so the caller emits `txn-refused` and NEVER sets OWNED.
   */
  async drain(): Promise<boolean> {
    this.onEvent?.({ type: "drain-start", active: this.scopes.size });
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.scopes.size > 0) {
      if (Date.now() >= deadline) {
        this.onEvent?.({ type: "drain-timeout", active: this.scopes.size });
        return false;
      }
      await Bun.sleep(1);
    }
    this.onEvent?.({ type: "drain-ok", active: 0 });
    return true;
  }
}
