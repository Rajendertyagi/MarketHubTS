/**
 * G0-D — durable catalog-write ownership, monotonic generation and crash
 * recovery (plan §6.2/§6.3/§6.4).
 *
 * This module is the parent-side authority for the single write permit. It
 * deliberately uses SIX independent signals (§6.2 items 1–6) and never decides
 * ownership from a lease, a PID liveness check or a lock probe alone:
 *
 *   1. in-process permit (this class) — fast fail while the parent is alive;
 *   2. durable token in the existing `app_meta` table (no schema change) with a
 *      monotonic `generation` owned by the parent;
 *   3. IPC / exit liveness observed by the child manager (wired in index.ts);
 *   4. persisted run-state verification — only a committed `COMPLETED` row with
 *      the EXACT parent-generated runId is positive proof of a commit;
 *   5. a bounded `BEGIN IMMEDIATE` + `ROLLBACK` probe — supporting evidence
 *      only, NEVER an authorization mechanism;
 *   6. the in-transaction generation fence enforced by the child pipeline
 *      (see `catalog-refresh-child-pipeline.ts`) — the correctness mechanism
 *      that closes the grant → parent-crash → probe-success → old-child race.
 *
 * No schema, migration, config or dependency change is introduced here.
 */
import { Database } from "bun:sqlite";
import type { ProviderId } from "@markethub/contracts";

/** Existing `app_meta` key; no new table or column is required. */
export const OWNER_META_KEY = "catalog_refresh_owner";
/** Explicit probe parameter — NOT a change to the production busy_timeout=5000. */
export const DEFAULT_PROBE_TIMEOUT_MS = 250;

export type PermitState = "IDLE" | "RESERVED" | "RELEASING" | "OWNED" | "UNKNOWN";

/** Result of the shutdown-safe release guard (`releaseIfSafe`). */
export type ReleaseIfSafeResult =
  | { released: true; from: PermitState }
  | { released: false; from: "UNKNOWN"; reason: "UNKNOWN" };

export type OwnerPhase =
  | "INIT"
  | "DOWNLOAD"
  | "PARSE"
  | "VALIDATE"
  | "AWAIT_TXN_GRANT"
  | "TXN"
  | "SETTLED"
  | "FENCED";

const OWNER_PHASES: readonly OwnerPhase[] = [
  "INIT", "DOWNLOAD", "PARSE", "VALIDATE", "AWAIT_TXN_GRANT", "TXN", "SETTLED", "FENCED"
];

export interface OwnerToken {
  runId: string;
  provider: ProviderId;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  phase: OwnerPhase;
  generation: number;
}

/** Strict parse: a malformed token is never trusted as an ownership grant. */
export function parseOwnerToken(raw: string | null | undefined): OwnerToken | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof value.runId !== "string" || value.runId.length === 0 ||
      (value.provider !== "UPSTOX" && value.provider !== "FYERS") ||
      typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 ||
      typeof value.startedAt !== "string" ||
      typeof value.heartbeatAt !== "string" ||
      typeof value.phase !== "string" || !OWNER_PHASES.includes(value.phase as OwnerPhase) ||
      typeof value.generation !== "number" || !Number.isInteger(value.generation) || value.generation < 0
    ) return null;
    return {
      runId: value.runId,
      provider: value.provider,
      pid: value.pid,
      startedAt: value.startedAt,
      heartbeatAt: value.heartbeatAt,
      phase: value.phase as OwnerPhase,
      generation: value.generation
    };
  } catch {
    return null;
  }
}

export function serializeOwnerToken(token: OwnerToken): string {
  return JSON.stringify({
    runId: token.runId,
    provider: token.provider,
    pid: token.pid,
    startedAt: token.startedAt,
    heartbeatAt: token.heartbeatAt,
    phase: token.phase,
    generation: token.generation
  });
}

/**
 * G0 integration fix #4: a token read has FOUR distinct outcomes. Collapsing
 * malformed/unreadable into "no token" let `recover()` treat a corrupt or
 * unreadable durable token as a clean startup and admit a writer. Callers that
 * make an ownership decision MUST use this discriminated result and fail
 * closed on MALFORMED / READ_FAILED. `readOwnerToken` below is kept as a
 * convenience wrapper for diagnostics/tests that only need a valid token.
 */
export type OwnerTokenRead =
  | { state: "ABSENT" }
  | { state: "VALID"; token: OwnerToken }
  | { state: "MALFORMED"; raw: string }
  | { state: "READ_FAILED"; reason: string };

export function inspectOwnerToken(sqlite: Database): OwnerTokenRead {
  let row: { value: string } | null;
  try {
    row = sqlite
      .query("SELECT value FROM app_meta WHERE key = ?")
      .get(OWNER_META_KEY) as { value: string } | null;
  } catch (error) {
    return {
      state: "READ_FAILED",
      reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    };
  }
  if (!row) return { state: "ABSENT" };
  const token = parseOwnerToken(row.value);
  if (!token) return { state: "MALFORMED", raw: String(row.value).slice(0, 300) };
  return { state: "VALID", token };
}

/** Convenience wrapper: a valid token or null. Ownership decisions must use
 * `inspectOwnerToken` so malformed/unreadable states are not mistaken for
 * "no token" (G0 integration fix #4). */
export function readOwnerToken(sqlite: Database): OwnerToken | null {
  const inspected = inspectOwnerToken(sqlite);
  return inspected.state === "VALID" ? inspected.token : null;
}

export function writeOwnerToken(sqlite: Database, token: OwnerToken): void {
  sqlite.query(
    "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(OWNER_META_KEY, serializeOwnerToken(token), Date.now());
}

export function deleteOwnerToken(sqlite: Database): void {
  sqlite.query("DELETE FROM app_meta WHERE key = ?").run(OWNER_META_KEY);
}

/**
 * Generation currently recorded in `app_meta`.
 *   0  = no token (only possible before the first G0-D grant);
 *  -1  = malformed token — a value no legitimate grant can match, so the child
 *        fence fails closed.
 */
export function readGeneration(sqlite: Database): number {
  try {
    const row = sqlite
      .query("SELECT value FROM app_meta WHERE key = ?")
      .get(OWNER_META_KEY) as { value: string } | null;
    if (!row) return 0;
    const token = parseOwnerToken(row.value);
    return token ? token.generation : -1;
  } catch {
    return -1;
  }
}

export interface WriterProbe {
  ok: boolean;
  error?: string;
}

/**
 * Bounded live-writer probe on a DEDICATED connection. A failed probe means a
 * writer may still be active; a successful probe is necessary but NOT
 * sufficient to authorize recovery (the generation fence is the mechanism).
 */
export function probeWriter(dbPath: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): WriterProbe {
  let sqlite: Database | null = null;
  try {
    sqlite = new Database(dbPath, { create: false, strict: true });
    sqlite.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`);
    sqlite.exec("BEGIN IMMEDIATE");
    sqlite.exec("ROLLBACK");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    };
  } finally {
    try { sqlite?.close(); } catch {}
  }
}

/**
 * Positive proof of commit: a COMPLETED row located by the EXACT parent-generated
 * runId from the durable token. A FAILED/CANCELLED row or absence is NOT proof.
 */
export function findCommittedRun(
  sqlite: Database,
  runId: string
): { runId: string; status: string } | null {
  try {
    const row = sqlite
      .query("SELECT run_id, status FROM catalog_sync_runs WHERE run_id = ? AND status = 'COMPLETED' LIMIT 1")
      .get(runId) as { run_id: string; status: string } | null;
    return row ? { runId: row.run_id, status: row.status } : null;
  } catch {
    return null;
  }
}

export type RecoveryDecision =
  | { decision: "NO_TOKEN" }
  | { decision: "COMMITTED"; runId: string; generation: number }
  | { decision: "RESUME"; generation: number }
  | { decision: "RETRY"; generation: number; reason: string }
  /** G0 integration fix #4: the durable token is malformed or unreadable. The
   * permit stays UNKNOWN and the token is retained; no writer may be admitted. */
  | { decision: "REFUSED"; generation: number; reason: string };

/**
 * Fail-closed post-bump verification decision. This is deliberately a LOCAL
 * type (no new shared contract enum): it is an internal ownership signal, not
 * a wire/API value.
 *
 *   COMMITTED            — a COMPLETED row with the EXACT parent-generated
 *                          runId exists; the prior refresh settled, do not
 *                          re-apply.
 *   NOT_COMMITTED_FENCED — no such row; the generation bump fences any old
 *                          child, so a fresh reserve may proceed.
 *   LOOKUP_FAILED_REFUSE — the run-state lookup itself failed. Unlike the
 *                          ordinary startup freshness check
 *                          (packages/market-core/src/sync/refresh.ts:333-350),
 *                          which FAILS OPEN on lookup error, this ambiguous
 *                          recovery path FAILS CLOSED: a prior commit cannot
 *                          be ruled out, so no refresh may be dispatched.
 */
export type RecoveryAfterBumpDecision =
  | { decision: "COMMITTED"; runId: string; generation: number }
  | { decision: "NOT_COMMITTED_FENCED"; runId: string; generation: number }
  | { decision: "LOOKUP_FAILED_REFUSE"; runId: string; generation: number; reason: string };

/**
 * Fail-closed verification of the EXACT parent-generated runId AFTER the
 * generation bump. `findCommittedRun` above intentionally swallows lookup
 * errors (it is used by the ordinary, fail-open recovery path); this function
 * does NOT — a lookup failure is a distinct, refusing decision.
 *
 * The caller must keep the permit UNKNOWN, retain the token and refuse any
 * refresh when this returns LOOKUP_FAILED_REFUSE. No new shared contract enum
 * is introduced; the decision is observable through the existing ownership
 * event/diagnostic seams.
 */
export function verifyRecoveryAfterBump(
  sqlite: Database,
  runId: string,
  generation: number
): RecoveryAfterBumpDecision {
  let row: { run_id: string; status: string } | null;
  try {
    row = sqlite
      .query("SELECT run_id, status FROM catalog_sync_runs WHERE run_id = ? AND status = 'COMPLETED' LIMIT 1")
      .get(runId) as { run_id: string; status: string } | null;
  } catch (error) {
    return {
      decision: "LOOKUP_FAILED_REFUSE",
      runId,
      generation,
      reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    };
  }
  if (row) return { decision: "COMMITTED", runId, generation };
  return { decision: "NOT_COMMITTED_FENCED", runId, generation };
}

/**
 * Decision returned by the actual startup/recovery entry point
 * (`CatalogWriteOwnership.recoverForStartup`). It reuses the ordinary
 * `RecoveryDecision` variants and adds two fail-closed outcomes:
 *   RESUME_FENCED — ambiguous case verified safe after the bump; dispatch OK.
 *   REFUSED       — post-bump lookup failed; dispatch is forbidden.
 */
export type StartupRecoveryDecision =
  | { decision: "NO_TOKEN" }
  | { decision: "COMMITTED"; runId: string; generation: number }
  | { decision: "RETRY"; generation: number; reason: string }
  | { decision: "RESUME_FENCED"; runId: string; generation: number }
  | { decision: "REFUSED"; runId: string; generation: number; reason: string };

export interface OwnershipEvent {
  type: "state";
  from: PermitState;
  to: PermitState;
  generation: number;
}

export interface ReserveParams {
  runId: string;
  provider: ProviderId;
  pid: number;
  startedAt: string;
}

/**
 * Parent-owned write permit. Serialized children (plan §5.1) mean a single
 * permit and a single durable token are sufficient — there is never a second
 * live child that needs its own record.
 */
export class CatalogWriteOwnership {
  private state: PermitState = "IDLE";
  private generation: number;
  private token: OwnerToken | null;
  /** G0-C owns real write scopes; G0-D keeps the drain structurally present. */
  private activeScopes = 0;
  /** G0-C additive wiring: a real scope drain installed by the composition root. */
  private drainHook: (() => Promise<boolean>) | undefined;

  constructor(
    private readonly sqlite: Database,
    private readonly dbPath: string,
    private readonly onEvent?: (event: OwnershipEvent) => void
  ) {
    // G0 integration fix #4: a malformed or unreadable durable token is NOT a
    // clean startup. Start UNKNOWN so no reserve/grant is possible until
    // recovery has verified state; a valid token keeps its generation.
    const inspected = inspectOwnerToken(sqlite);
    if (inspected.state === "VALID") {
      this.token = inspected.token;
      this.generation = inspected.token.generation;
    } else {
      this.token = null;
      this.generation = 0;
      if (inspected.state === "MALFORMED" || inspected.state === "READ_FAILED") {
        this.state = "UNKNOWN";
      }
    }
  }

  get currentState(): PermitState { return this.state; }
  get currentGeneration(): number { return this.generation; }
  get currentToken(): OwnerToken | null { return this.token; }
  get activeScopeCount(): number { return this.activeScopes; }

  /**
   * G0-C additive gate wiring. When installed, `grant()` awaits this real
   * write-scope drain between RELEASING and OWNED. A `false` result is a
   * refusal (drain timeout) — OWNED is never granted with a live scope.
   * Without a hook the G0-D behaviour is unchanged (legacy drain below).
   */
  setDrainHook(hook: () => Promise<boolean>): void {
    this.drainHook = hook;
  }

  private transition(to: PermitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    try { this.onEvent?.({ type: "state", from, to, generation: this.generation }); } catch {}
  }

  /**
   * IDLE → RESERVED. Bumps the monotonic generation and writes the durable
   * token BEFORE dispatch, so it cannot contend with the child's transaction.
   *
   * Known narrow window (implementer-disclosed): an old child may COMMIT in the
   * gap between a parent crash and this reserve write, i.e. before the new
   * parent has bumped the generation. The durable token alone cannot detect
   * that commit because it still names the old runId. The parent-side, read-only
   * freshness check at `packages/market-core/src/sync/refresh.ts:333-350`
   * backstops it by skipping a provider already refreshed on the current
   * India-market date, so the committed snapshot is not re-applied. That check
   * lives outside this state machine; the in-transaction generation fence
   * remains the correctness mechanism once a child is dispatched.
   */
  reserve(params: ReserveParams): { ok: true; generation: number } | { ok: false; reason: string } {
    if (this.state !== "IDLE") {
      return { ok: false, reason: `cannot reserve from ${this.state}` };
    }
    const next = this.generation + 1;
    const token: OwnerToken = {
      runId: params.runId,
      provider: params.provider,
      pid: params.pid,
      startedAt: params.startedAt,
      heartbeatAt: params.startedAt,
      phase: "INIT",
      generation: next
    };
    try {
      writeOwnerToken(this.sqlite, token);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      };
    }
    this.generation = next;
    this.token = token;
    this.transition("RESERVED");
    return { ok: true, generation: next };
  }

  /**
   * RESERVED → RELEASING → OWNED. `RELEASING` is the drain state: no new write
   * scopes are admitted and in-flight scopes are awaited before OWNED. G0-D has
   * no scopes (G0-C owns them), so the drain completes immediately; a future
   * G0-C scope registration reuses this exact state machine.
   */
  async grant(): Promise<{ granted: true; generation: number } | { granted: false; reason: string }> {
    if (this.state !== "RESERVED") {
      return { granted: false, reason: `cannot grant from ${this.state}` };
    }
    this.transition("RELEASING");
    const drained = this.drainHook
      ? await this.drainHook()
      : await this.drainLegacy();
    if (!drained) {
      // Absolute refusal: stay in RELEASING (still refusing new scopes) and
      // never set OWNED while a write scope is active (revision 2026-11-27).
      return { granted: false, reason: "write-scope drain timeout" };
    }
    this.transition("OWNED");
    return { granted: true, generation: this.generation };
  }

  /** G0-D legacy drain (no scopes in G0-D); preserved when no G0-C hook is set. */
  private async drainLegacy(): Promise<boolean> {
    while (this.activeScopes > 0) await Bun.sleep(1);
    return true;
  }

  /**
   * Parent-side phase update driven by validated child `progress` messages.
   *
   * G0 integration fix #2: once the permit is OWNED (or draining/unknown) the
   * child may already hold `BEGIN IMMEDIATE`. A synchronous `app_meta` write
   * here would contend with that transaction and block the parent event loop
   * for up to `busy_timeout` (5 s). Phase is diagnostic only, so while the
   * permit is not IDLE/RESERVED we keep the in-memory token current but do NOT
   * touch SQLite. Progress messages are still observable via the manager event
   * seam; only the durable mirror is suppressed.
   */
  updatePhase(phase: OwnerPhase): void {
    if (!this.token) return;
    const updated: OwnerToken = {
      ...this.token,
      phase,
      heartbeatAt: new Date().toISOString()
    };
    if (this.state === "OWNED" || this.state === "RELEASING" || this.state === "UNKNOWN") {
      this.token = updated;
      return;
    }
    try {
      writeOwnerToken(this.sqlite, updated);
      this.token = updated;
    } catch {}
  }

  /** Unexpected child exit: no new child may be granted until verification. */
  markUnknown(): void {
    this.transition("UNKNOWN");
  }

  /** OWNED/UNKNOWN → IDLE; delete the durable token after settlement. */
  release(): void {
    try { deleteOwnerToken(this.sqlite); } catch {}
    this.token = null;
    this.transition("IDLE");
  }

  /**
   * Shutdown-safe release. Deletes the durable token ONLY when the permit is
   * not UNKNOWN. An UNKNOWN permit means child termination was unobserved or
   * recovery could not positively establish that release is safe; deleting the
   * token there would erase the evidence the next process needs to verify the
   * prior run and would admit a second writer while the old child may still be
   * alive. Ordinary clean shutdown (IDLE/RESERVED/OWNED with confirmed exit)
   * keeps the exact previous `release()` behaviour.
   */
  releaseIfSafe(): ReleaseIfSafeResult {
    if (this.state === "UNKNOWN") {
      return { released: false, from: "UNKNOWN", reason: "UNKNOWN" };
    }
    const from = this.state;
    this.release();
    return { released: true, from };
  }

  /**
   * Startup / post-unexpected-exit verification. Order matters:
   *   1. committed COMPLETED row with the token's exact runId ⇒ do NOT re-apply;
   *   2. lock probe failure ⇒ RETRY (a writer may still be active);
   *   3. probe success ⇒ RESUME, but the token is KEPT so the next reserve()
   *      bumps the generation in-place before dispatch — an old child is then
   *      fenced inside its own BEGIN IMMEDIATE. Probe success alone never
   *      authorizes a write.
   */
  recover(): RecoveryDecision {
    // G0 integration fix #4: distinguish ABSENT from MALFORMED / READ_FAILED.
    // Only a genuinely absent token permits a normal startup; a corrupt or
    // unreadable token fails closed (UNKNOWN, token retained, no dispatch).
    const inspected = inspectOwnerToken(this.sqlite);
    if (inspected.state === "ABSENT") {
      this.token = null;
      this.transition("IDLE");
      return { decision: "NO_TOKEN" };
    }
    if (inspected.state === "MALFORMED" || inspected.state === "READ_FAILED") {
      this.transition("UNKNOWN");
      return {
        decision: "REFUSED",
        generation: this.generation,
        reason: inspected.state === "MALFORMED"
          ? `malformed owner token: ${inspected.raw}`
          : `owner token read failed: ${inspected.reason}`
      };
    }
    const token = inspected.token;
    this.generation = Math.max(this.generation, token.generation);
    this.token = token;

    if (findCommittedRun(this.sqlite, token.runId)) {
      try { deleteOwnerToken(this.sqlite); } catch {}
      this.token = null;
      this.transition("IDLE");
      return { decision: "COMMITTED", runId: token.runId, generation: token.generation };
    }

    const probe = probeWriter(this.dbPath);
    if (!probe.ok) {
      this.transition("UNKNOWN");
      return {
        decision: "RETRY",
        generation: token.generation,
        reason: probe.error ?? "writer probe failed"
      };
    }

    // Keep the stale token; reserve() overwrites it with generation + 1 before
    // any new child is dispatched. This is the monotonic fence the old child
    // observes inside its transaction.
    this.transition("IDLE");
    return { decision: "RESUME", generation: token.generation };
  }

  /**
   * Ambiguous-recovery path (FAIL-CLOSED). Bumps the durable generation to
   * fence any old child, then re-checks the EXACT parent-generated runId from
   * the PRE-bump token. This closes the race where an old child commits after
   * the pre-bump completion check but before the new parent takes ownership:
   *
   *   old child commits -> parent crashes before ack -> pre-bump check finds
   *   nothing -> old child commits -> generation bump -> post-bump lookup
   *   FAILS -> ordinary fail-open freshness would allow a second refresh.
   *
   * Here a failed lookup is a REFUSAL (not fail-open): the permit stays UNKNOWN
   * and the token is retained, so no reserve()/grant() can dispatch a writer.
   * This is intentionally distinct from the ordinary startup freshness check
   * at packages/market-core/src/sync/refresh.ts:333-350, which fails open and
   * is NOT modified by this correction.
   */
  recoverAfterBump(): RecoveryAfterBumpDecision | { decision: "NO_TOKEN" } {
    // G0 integration fix #4: fail closed on a malformed/unreadable token here
    // too. Reuse the existing refusing decision so `recoverForStartup` maps it
    // to REFUSED without a new wire value.
    const inspected = inspectOwnerToken(this.sqlite);
    if (inspected.state === "ABSENT") {
      this.token = null;
      this.transition("IDLE");
      return { decision: "NO_TOKEN" };
    }
    if (inspected.state === "MALFORMED" || inspected.state === "READ_FAILED") {
      this.transition("UNKNOWN");
      return {
        decision: "LOOKUP_FAILED_REFUSE",
        runId: "unknown",
        generation: this.generation,
        reason: inspected.state === "MALFORMED"
          ? `malformed owner token: ${inspected.raw}`
          : `owner token read failed: ${inspected.reason}`
      };
    }
    const token = inspected.token;

    const nextGeneration = Math.max(this.generation, token.generation) + 1;
    const bumped: OwnerToken = { ...token, generation: nextGeneration };
    try {
      // Bump in place while KEEPING the exact parent-generated runId, so the
      // post-bump verification can still locate a commit made by the old child.
      writeOwnerToken(this.sqlite, bumped);
    } catch (error) {
      // Cannot persist the fence: refuse, stay UNKNOWN, keep the original token.
      this.transition("UNKNOWN");
      return {
        decision: "LOOKUP_FAILED_REFUSE",
        runId: token.runId,
        generation: token.generation,
        reason: `generation bump failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`
      };
    }
    this.generation = nextGeneration;
    this.token = bumped;

    const decision = verifyRecoveryAfterBump(this.sqlite, token.runId, nextGeneration);
    if (decision.decision === "COMMITTED") {
      // Positive proof after the bump: the prior refresh settled. Do not re-apply.
      try { deleteOwnerToken(this.sqlite); } catch {}
      this.token = null;
      this.transition("IDLE");
    } else if (decision.decision === "LOOKUP_FAILED_REFUSE") {
      // Fail closed: keep the bumped token and the UNKNOWN permit. No dispatch.
      this.transition("UNKNOWN");
    } else {
      // NOT_COMMITTED_FENCED: the bump fences the old child inside its own
      // BEGIN IMMEDIATE; a fresh reserve may proceed safely.
      this.transition("IDLE");
    }
    return decision;
  }

  /**
   * Actual startup/recovery entry point used by the composition root. Runs the
   * ordinary pre-bump verification first; ONLY the ambiguous RESUME case
   * (stale token, no committed row pre-bump, writer probe succeeded) enters the
   * fail-closed post-bump verification. A REFUSED decision means the caller
   * must NOT schedule a refresh — the permit stays UNKNOWN and the token is
   * retained for a later, verifiable restart.
   */
  recoverForStartup(): StartupRecoveryDecision {
    const pre = this.recover();
    if (pre.decision === "REFUSED") {
      // Malformed/unreadable token: fail closed with the full startup decision
      // shape (the permit is already UNKNOWN and the token retained).
      return {
        decision: "REFUSED",
        runId: this.token?.runId ?? "unknown",
        generation: pre.generation,
        reason: pre.reason
      };
    }
    if (pre.decision !== "RESUME") return pre;
    const post = this.recoverAfterBump();
    if (post.decision === "NO_TOKEN") return { decision: "NO_TOKEN" };
    if (post.decision === "LOOKUP_FAILED_REFUSE") {
      return {
        decision: "REFUSED", runId: post.runId, generation: post.generation, reason: post.reason
      };
    }
    if (post.decision === "COMMITTED") {
      return { decision: "COMMITTED", runId: post.runId, generation: post.generation };
    }
    return { decision: "RESUME_FENCED", runId: post.runId, generation: post.generation };
  }
}
