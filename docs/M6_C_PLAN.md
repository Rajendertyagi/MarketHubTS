# M6-C — Durable MCP Activity History and WebUI Inspection

> **Status:** Implementation plan only. Awaiting separate authorization. **No M6-C source exists yet.** This document does not implement anything.
> **Last updated:** 2026-11-20
> **Depends on:** M6-A (`7860c7f`: Streamable HTTP at `/mcp` + retained STDIO, shared factory); M6-B1 (`d50b372`); M6-B2 (`0e0ec6d`); M6-B3 (`0d58bbb`, closeout `a789530`: resources, prompts, cache hints, snapshot pagination).
> **Governing design:** [`M6_PLAN.md`](M6_PLAN.md) §9.1 (activity persistence), §9.1.1 (STDIO activity API), §9.2 (WebUI inspection), §10 (M6-C), §13 (single migration exception); [`MCP_INTERFACE.md`](MCP_INTERFACE.md) §10 (traceability). This document adds execution detail; it does not change that design.

## 1. Objective and boundaries

Make MCP operations **durable and inspectable without terminal or SQL access**: one additive `mcp_activity` table, a repository, start/complete recording through the existing `McpServices` seam, read/write endpoints on the existing Hono app, and one "MCP / Activity" section in the existing WebUI. No second app/DB/provider, no new runtime dependency, no audit framework.

**In scope (M6-C):**
- One additive SQLite migration for `mcp_activity` (the single migration exception authorized in `M6_PLAN.md` §13).
- `McpActivityRepository` in `packages/database`; canonical view/schemas in `packages/contracts`.
- `startActivity` / `completeActivity` on `McpServices`; one thin recording wrapper applied uniformly to the existing tool/resource/prompt registrations in `packages/mcp-core`.
- STDIO write endpoints and WebUI read endpoints on the existing Hono app (`apps/api`).
- `ACTIVITY` retention class + bounded batched cleanup in the existing fail-closed retention path.
- One "MCP / Activity" tab in `apps/web` with transport availability, paginated list, filters, detail view, incomplete highlighting, and navigation to stored data.

**Out of scope — do not start (explicit):**
- **M6-B4** conformance/parity milestone; **M6-D** `subscriptions/listen`/event bridge/notification delivery; **M6-E** broad integration/LAN acceptance.
- Provider activation / Stage G, new dependencies (beyond the authorized migration), auth/RBAC, M6-A transport/CORS/Host-Origin/shutdown changes.
- Changes to the nine B2 tool contracts or the seven B3 resource contracts.
- A generic audit/telemetry framework, per-tick/per-notification rows, or storing raw arguments/full market payloads.

**Fixed decisions:**
1. **One row per operation**, unique `operation_id`; start inserts, complete updates the same row. Duplicate start is idempotent; complete for unknown `operation_id` is rejected.
2. **API-generated timestamps** (`started_at`, `finished_at`, `duration_ms`) drive ordering, retention and monotonicity. Client-supplied timestamps are diagnostics only.
3. **Best-effort recording**: activity-write failure never changes a data operation's outcome.
4. **Separate outcomes**: a succeeded data operation stays `succeeded` even if notification delivery (M6-D) later fails.
5. **STDIO never opens the DB** — it posts start/complete to the local API; HTTP MCP uses the injected repository directly.
6. **Safe-field allow-list** for summaries; no credentials, tokens, raw arguments or full payloads.
7. **Honest transport states**: HTTP MCP availability from actual API state; STDIO only "Activity observed" / "No activity observed / status unknown" — never "configured"/"connected" without a signal.

## 2. Verified baseline (checked against source at `a789530`)

| Fact | Evidence |
|---|---|
| `McpServices` has 12 operations; no activity hooks | `packages/mcp-core/src/services.ts:98-112` |
| Factory registers 9 tools + 7 resources + 3 prompts; no activity wrapper | `packages/mcp-core/src/factory.ts:15-31`; `tools.ts`, `resources.ts`, `prompts.ts` |
| WebUI has 3 tabs (Overview, Live data, History & snapshots) and 5 panels | `apps/web/src/App.tsx:145-299` |
| Retention schema has only `CANDLE`/`SNAPSHOT`; fail-closed read | `packages/contracts/src/snapshots.ts:140-150`; `packages/database/src/app-settings.ts:28-34` |
| `applyRetentionCleanup` returns `{ ran, reason, candlesDeleted, snapshotsDeleted }` | `apps/api/src/historical-routes.ts:37-56` |
| Migrations `0000`–`0005`; journal at `0005_bitter_kronos` | `packages/database/drizzle/meta/_journal.json` |
| API registers routes in `app.ts` before MCP route and SPA fallback | `apps/api/src/app.ts:172-226` |
| STDIO is a thin local-API client with `sanitizeMessage` | `apps/mcp-server/src/services.ts:12,261-268` |
| WebUI client pattern: typed fetch + Zod validation + typed error class | `apps/web/src/lib/snapshots.ts:1-103` |
| Web tests use deterministic fakes | `tests/web/*.test.ts` |

## 3. Data model and migration

### 3.1 `mcp_activity` table (additive migration `0006_...`)
Columns per `M6_PLAN.md` §9.1: `id` (PK), `operation_id` (unique), `tool_name`, `transport` (`HTTP`|`STDIO`), `started_at`, `finished_at` (nullable), `duration_ms` (nullable), `client_started_at`/`client_finished_at` (nullable, diagnostics), `client_name`/`client_version` (nullable), `status` (`started`|`succeeded`|`failed`|`interrupted`), `error_category` (nullable), `error_message` (nullable), `summary_json` (nullable), `data_result_ref` (nullable).

Indexes: unique on `operation_id`; indexes on `started_at`, `status`, `tool_name`, `transport` for WebUI filters/pagination and the retention cutoff scan.

**Migration mechanics:** add SQL file + journal entry + generated snapshot following the `0005` convention. No schema change to existing tables. This is the single migration authorized for M6; no other migration or index is added.

### 3.2 Canonical contracts (`packages/contracts`)
- `mcpActivityStatusSchema` = enum of the four statuses; `mcpActivityTransportSchema` = `HTTP`|`STDIO`.
- `mcpActivityViewSchema` — safe-field allow-list only (no raw args, tokens, payloads).
- `mcpActivityListSchema` = `{ records: McpActivityView[]; nextCursor: string | null }`.
- Request schemas for start/complete with bounded field lengths and strict validation (reject unknown fields).
- **Response schemas (named explicitly for STDIO envelope validation):**
  - `mcpActivityStartResultSchema` = `{ id: string; operationId: string; startedAt: string }`.
  - `mcpActivityCompleteResultSchema` = `{ id: string; status: mcpActivityStatusSchema; finishedAt: string; durationMs: number }`.
  - The API returns these exact envelopes; STDIO validates with them (no defaulting/coercion).
- Extend `retentionSettingsSchema.classes` with optional `ACTIVITY: { maxAgeDays: z.number().int().positive() }`. Existing stored values without `ACTIVITY` stay valid; malformed values still fail closed.

## 4. Service seam and recording wrapper

### 4.1 `McpServices` additions (M6-C only)
```ts
startActivity(rec: {
  operationId: string; toolName: string; transport: "HTTP" | "STDIO";
  clientName?: string; clientVersion?: string; clientStartedAt?: string;
  summaryJson?: string;
}): Promise<McpResult<{ id: string; startedAt: string }>>;

completeActivity(rec: {
  operationId: string; status: "succeeded" | "failed" | "interrupted";
  clientFinishedAt?: string; errorCategory?: string; errorMessage?: string;
  dataResultRef?: string;
}): Promise<McpResult<{ id: string; finishedAt: string; durationMs: number }>>;
```
No other methods. No subscription methods (M6-D), no speculative seams.

### 4.2 One recording wrapper in `packages/mcp-core`
A single small helper (e.g. `src/activity.ts`) wraps each existing callback:
```ts
async function withActivity<T>(
  services: McpServices,
  meta: { toolName: string; transport: "HTTP" | "STDIO" },
  op: () => Promise<T>
): Promise<T>
```
- Generates `operationId` with `crypto.randomUUID()`.
- Calls `startActivity` **before** the operation; on failure reports a diagnostic (§4.4) and continues (best-effort).
- Awaits the operation; on success calls `completeActivity(status: "succeeded")`, on throw calls `completeActivity(status: "failed")` with a sanitized error category/message, then **rethrows the original error**.
- Never lets an activity failure change the operation result or its error.
- Best-effort `dataResultRef` extraction for capture results (`snapshot.id`); omitted otherwise.

**Registration signatures (normative — no implementation-time guessing):**
- `registerTools(server, services, transport)` — currently `registerTools(server, services)` (`tools.ts:35`).
- `registerResources(server, services, transport)` — currently `registerResources(server, services)` (`resources.ts:60`).
- `registerPrompts(server, services, transport)` — currently `registerPrompts(server)` (`prompts.ts:9`); prompts become service-aware **only** for activity recording. Their guidance text stays static; they still make no data/service calls inside the guidance itself.
- The factory calls all three with the derived `transport` (below). This is a mechanical signature change, not a framework.

**Transport sourcing (verified against installed SDK 2.4.0):** `McpRequestContext` (`createMcpHandler-DzlXH0KL.d.mts:206-224`) exposes `era`, `authInfo?` and `requestInfo?` — there is **no** `transport` field. `requestInfo` is set for HTTP requests and never set by `serveStdio`. Therefore in `createMcpServer`: `const transport = ctx.requestInfo ? "HTTP" : "STDIO";` and pass it to all three registration functions. No SDK change and no adapter-side transport plumbing.

**Per-kind safe summary (normative — never raw args):** `withActivity` receives an already-normalized `summaryJson` string built by a small `safeSummary(kind, input)` helper with a fixed allow-list and length bounds (e.g. 200 chars per field, 1000 total):
- **Tools:** `canonicalId`, `interval`, `mode`, `kind`, `configId`, `snapshotId`, `limit` (from `tools.ts` input schemas).
- **Resources:** `canonicalId`, `interval`, `query`, `limit`, `configId`, `after`/`cursor` presence flag (never the opaque cursor value) (from `resources.ts` URI variables).
- **Prompts:** `canonicalId`, `interval`, `from`, `to` (from `prompts.ts` args schemas).
Only allow-listed keys are serialized; all other input fields are dropped. No credentials, tokens, raw arguments or full payloads.

### 4.4 Activity-failure diagnostics
`packages/mcp-core` has no logger dependency. Use an **optional callback on the seam** — `McpServices.onActivityError?: (err: unknown) => void` — invoked when `startActivity`/`completeActivity` fails. HTTP supplies a callback backed by the existing `createLogger`; STDIO supplies one that writes to **stderr only** (stdout is reserved for the MCP protocol). If no callback is supplied, failures are silently ignored — still never affecting the operation. No new dependency, no stdout writes on STDIO.

### 4.3 Adapters
- **HTTP** (`apps/api/src/mcp-services.ts`): `startActivity`/`completeActivity` call the injected `McpActivityRepository` directly (same instances as REST).
- **STDIO** (`apps/mcp-server/src/services.ts`): post to `POST /api/mcp/activity/start` and `/complete`; map failures to a logged diagnostic, never a data-operation failure; validate response envelopes with the canonical schemas.

## 5. API endpoints (`apps/api`)

New `apps/api/src/mcp-activity-routes.ts`, registered in `app.ts` before the MCP route and SPA fallback.

| Method + path | Purpose | Access |
|---|---|---|
| `POST /api/mcp/activity/start` | Insert started row; echo `operationId` + API `startedAt` | `isLocalPeer` (local-owner write) |
| `POST /api/mcp/activity/complete` | Update to terminal status; return `finishedAt`/`durationMs` | `isLocalPeer` |
| `GET /api/mcp/activity` | Paginated list `{ records, nextCursor }`; filters `toolName`, `transport`, `status`, `from`, `to`; opaque keyset cursor on API-generated `started_at`+`id`; order `started_at DESC, id DESC` | LAN read (no `isLocalPeer`) |
| `GET /api/mcp/activity/by-operation/:operationId` | Single `McpActivityView` by correlation id (404 if absent) | LAN read |
| `GET /api/mcp/activity/:id` | Single `McpActivityView` by record id (404 if absent) | LAN read |

- Register the static `/by-operation` segment **before** `/:id` so it is not captured as a record id. The collection path is always the list envelope — no response-shape switching.
- Strict validation: non-empty ids, valid ISO diagnostic timestamps, bounded summary/error fields, terminal status only, unknown `operationId` on complete → 404/validation.
- `dataResultRef` is returned as a reference only; the API does not join market payloads.

## 6. Retention

- Extend `retentionSettingsSchema.classes` with `ACTIVITY` (§3.2).
- Add `cleanupActivities(cutoffMs, batchLimit)` to `McpActivityRepository` — bounded, batched, index on `started_at`.
- **Extend `applyRetentionCleanup` with an explicit signature** (current: `(settings, candles, snapshots, now?) => { ran, reason, candlesDeleted, snapshotsDeleted }` at `apps/api/src/historical-routes.ts:37-56`):
  ```ts
  applyRetentionCleanup(
    settings: AppSettings,
    candles: CandleRepository,
    snapshots: SnapshotRepository,
    activities: McpActivityRepository,
    now: () => number = () => Date.now()
  ): { ran: boolean; reason: string | null; candlesDeleted: number; snapshotsDeleted: number; activitiesDeleted: number }
  ```
  All existing callers and tests are updated to pass the activity repository; fail-closed behavior is preserved (missing/malformed/invalid settings disable **all** cleanup and delete nothing).
- WebUI retention panel gains an activity max-age field using the existing validated save flow.

## 7. WebUI (`apps/web`)

- Add a fourth tab **"MCP / Activity"** in `App.tsx` (alongside Overview, Live data, History & snapshots) and an `ActivityPanel` component.
- New `apps/web/src/lib/activity.ts`: typed fetch client following `lib/snapshots.ts` pattern (typed error class, Zod validation of `mcpActivityViewSchema`/`mcpActivityListSchema`).
- **Transport availability states:**
  - HTTP MCP: `Configured` / `Available` / `Unavailable (error)` derived from **the existing `/api/status` endpoint**, extended with an `mcp` field computed from `deps.mcpHandler` presence and handler state (`apps/api/src/app.ts:60,203-226`). No new endpoint. Never derived from package installation alone.
  - STDIO: only `Activity observed` / `No activity observed / status unknown`, derived from presence of STDIO activity records. No "configured"/"connected" claims.
- **Recent calls:** bounded paginated list with tool name, transport, timestamp, duration, status, client name/version.
- **Filters:** tool/operation, time window, outcome (`succeeded`/`failed`/`interrupted`/`started`).
- **Detail view:** operation id, sanitized error category/message, safe summary, and whether data was stored despite notification failure.
- **Incomplete operations:** visually highlight `started`/`interrupted` rows.
- **Navigation:** `dataResultRef` links to the Snapshot panel record or Historical panel range (client-side; API returns only the reference).
- Clear loading/empty/error/partial states; reuse existing tokens/components. No raw logs as the only interface.

## 8. File scope

**New:** `packages/database/drizzle/0006_*.sql` (+ journal/snapshot), `packages/database/src/repositories/mcp-activity.ts`, `packages/mcp-core/src/activity.ts`, `apps/api/src/mcp-activity-routes.ts`, `apps/web/src/components/ActivityPanel.tsx`, `apps/web/src/lib/activity.ts`, tests (below).
**Modified:** `packages/contracts/src/snapshots.ts` (+ index), `packages/database/src/{schema.ts,index.ts,app-settings.ts}`, `apps/api/src/{app.ts,historical-routes.ts,mcp-services.ts}`, `apps/mcp-server/src/services.ts`, `packages/mcp-core/src/{services.ts,factory.ts,tools.ts,resources.ts,prompts.ts,index.ts}`, `apps/web/src/App.tsx`, relevant docs.
**No dependency changes.**

## 9. Required focused tests

- **Repository/migration:** clean-install migration; start inserts; duplicate start idempotent; complete updates same row; complete unknown id rejected; monotonicity; bounded summary/error truncation; `cleanupActivities` bounded and fail-closed.
- **API routes:** start/complete local-owner only (403 remote); list pagination + filters + deterministic order; both detail forms; static `/by-operation` before `/:id`; strict validation (400/404); no raw args/tokens in responses.
- **MCP recording:** wrapper records start/complete for tools/resources/prompts; success → `succeeded`; throw → `failed` with sanitized error; activity failure does not change operation result; HTTP uses injected repository; STDIO posts to local API and validates envelopes.
- **Retention:** `ACTIVITY` class optional; existing values without it remain valid; malformed values fail closed; `activitiesDeleted` reported.
- **WebUI:** activity client validation; panel loading/empty/error/partial states; filters; incomplete highlighting; transport availability states; navigation links.
- **Regression:** nine B2 tools and seven B3 resources unchanged; no M6-A transport/security/lifecycle regression.

## 10. Acceptance criteria

- One additive migration; no other schema/index/dependency change.
- Activity recorded durably for MCP operations with correct correlation, API-generated timestamps, and terminal statuses.
- Activity failures never change data-operation outcomes; notification failures never flip data status.
- STDIO never opens the DB; HTTP uses injected services; both forward through one `McpServices` seam.
- Endpoints strictly validated; static routes ordered correctly; safe-field views only.
- WebUI activity section with honest transport states, filters, detail, incomplete highlighting, navigation, and retention field.
- Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; full suite shows no new failures vs the documented two `EBUSY` baseline failures.
- Independent diff review before merge; no commit/push without separate authorization.

## 11. Failure cases and security boundaries

- No credentials, tokens, raw arguments or full market payloads in activity records, responses or logs.
- Local-owner guard on write endpoints; LAN read-only; no new auth framework.
- Best-effort writes; incomplete rows detectable after restart; no stronger durability claim than implemented.
- Bounded writes (one row per operation), bounded pagination, bounded cleanup batches.

## 12. Non-goals and separate authorization boundaries

- B4 conformance/parity, M6-D subscriptions/notifications, M6-E integration/LAN, Stage G/provider activation — all excluded.
- The `mcp_activity` migration is the single authorized schema change; any further migration needs separate justification.
- No commit/push without separate authorization.

## 13. Reporting format for the implementation assignment

Report: what was implemented; exact files added/modified; migration details; tests and actual results (including full-suite failure list vs baseline); activity-recording evidence; HTTP/STDIO parity evidence; WebUI evidence; acceptance-criteria checklist; remaining issues; exact `git status` and HEAD. Do not claim M6-B4/C/D/E or M6 complete. No commit/push without separate authorization.
