# M6-C — Durable MCP Activity History and WebUI Inspection

> **Document status:** Authoritative M6-C plan **and accepted phase-closure record** (§0). Not an implementation authorization.
> **Repository baseline:** `Rajendertyagi/MarketHubTS`, branch `develop`, HEAD `32b034a38e9c0db134de13b9b51a9e12d1ffdee7` (21 November 2026).
> **Current implementation state:** M6-A and M6-B1/B2/B3 are present. **M6-C is ACCEPTED and CLOSED at `32b034a38e9c0db134de13b9b51a9e12d1ffdee7`** (durable activity history, recording wrapper, activity endpoints, retention integration and WebUI inspection, plus four reviewed fix-forward commits). This document is the authoritative M6-C plan and acceptance record.
> **Governing documents:** `docs/M6_PLAN.md` §§9.1, 9.1.1, 9.2, 10 and 13; `docs/MCP_INTERFACE.md`; `docs/PROJECT_MANAGER_PROTOCOL.md`; `docs/ENGINEERING_STANDARDS.md`.

## 0. Phase acceptance record (M6-C closed)

**Decision:** M6-C is accepted for phase closure. **Acceptance date:** 21 November 2026.

| Item | Record |
|---|---|
| Final reviewed commit | [`32b034a38e9c0db134de13b9b51a9e12d1ffdee7`](https://github.com/Rajendertyagi/MarketHubTS/commit/32b034a38e9c0db134de13b9b51a9e12d1ffdee7) — `develop` HEAD, equal to `origin/develop` at acceptance |
| Identified baseline | `5154ec9b955ae638420a1ca8f0702be0cfa18ef8` (the commit under independent review that produced the four findings) |
| Fix-forward commits (4) | `5cb971e` (comprehensive sanitization, bounded streaming reads, complete result refs, isolated diagnostics); `4f978d5` (camelCase/env-prefix credentials, read-path re-sanitization, full ref validation, UI details/tests); `8774ca0` (`appSecret`, unified STDIO sanitizer, legacy summary value sanitization, panel interaction tests); `32b034a` (numeric exemption scoped to error/status prose, multi-segment env prefixes) |
| Final independent review | **CLEAN — no outstanding findings.** The final review of `32b034a` closed the last sanitizer finding (short numeric credentials and multi-segment environment prefixes). Each earlier review round was likewise closed before the next commit. |
| Cumulative scope | 16 files across the four commits, all within M6-C (activity routes, MCP activity wrapper, contracts, database projection, WebUI panels, and their tests). No M6-D/E, B4, Stage G, migration, dependency, or lockfile changes. |
| Verification (agent-reported) | The implementing agent reported **732 passing tests**, successful `bun run typecheck`, successful `bun run build`, and a clean `git diff --check` at the final commit. Focused suites were also reported green. |
| Verification limitation | These execution results are **agent-reported**, not independently executed by the reviewer. GitHub showed **no workflow runs and no commit status checks** for any of the four SHAs; they must not be represented as independently verified CI results. The acceptance decision rests on the final independent source/diff review plus these reported local results. |
| Acceptance authority | The independent GitHub review of `32b034a` is the acceptance gate. This record documents that decision; it does not re-run or re-claim the verification. |

M6-C is closed. M6-D and M6-E remain **planned, not implemented**; see the single consolidated [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md).

## 1. Objective

Add durable, bounded, safe activity history for MCP operations and expose it in the existing WebUI. Use the existing API process, SQLite database, `McpServices` seam, shared MCP factory, and current UI. Do not create a second application, database, service layer, MCP server, or telemetry framework.

M6-C records only **executed operation callbacks**:

- `tools/call` — each registered tool callback invocation.
- `resources/read` — each registered static-resource or resource-template read callback invocation.
- `prompts/get` — each registered prompt callback invocation.

It does not record `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`, `server/discover`, or requests rejected before their callback runs. In particular, SDK input-schema validation failures do not invoke a tool/prompt callback; recording those would require a separate SDK-level middleware design and is not part of this milestone.

## 2. Scope and boundaries

### In scope

1. One additive SQLite migration for `mcp_activity`.
2. `McpActivityRepository` in `packages/database` and canonical contracts in `packages/contracts`.
3. `startActivity` and `completeActivity` on the existing `McpServices` seam.
4. One small recording wrapper in `packages/mcp-core`, applied to the existing tools, resources, and prompts without changing their public MCP names, schemas, results, or resource URIs.
5. Two local-owner write endpoints for the STDIO adapter and three LAN-readable API endpoints for the WebUI.
6. An optional `ACTIVITY` retention class using the existing fail-closed retention settings and cleanup path.
7. One “MCP / Activity” WebUI tab, plus an Activity max-age field in the existing HistoricalPanel retention editor.
8. Focused tests and regressions for existing M6-A/B1/B2/B3 behavior.

### Explicitly out of scope

- M6-B4 conformance/parity work.
- M6-D `subscriptions/listen`, event bridge, notification delivery, or notification telemetry.
- M6-E broad integration, real external-client, and in-process LAN simulation (physical LAN reachability out of revised scope).
- Stage G/provider activation, live provider driver changes, trading/orders, and market-data behavior changes.
- New runtime dependencies, another database/migration beyond the one `mcp_activity` migration, auth/RBAC framework, new application/server, or generic audit/telemetry framework.
- Changes to the nine M6-B2 tool contracts, seven M6-B3 registered resources, three prompts, or MCP transport/security/lifecycle behavior.
- Per-tick/per-event activity rows, raw MCP arguments, credentials, tokens, full market payloads, stack traces, or client IP logging.

## 3. Fixed semantics

### 3.1 One row per callback invocation

- Generate a server-side UUID `operationId` per callback invocation.
- `startActivity` inserts one row with status `started`.
- `completeActivity` updates that same row to one terminal status: `succeeded`, `failed`, or `interrupted`.
- `operation_id` is unique.
- Repeating the same start request is idempotent and returns the existing row. A repeat with conflicting immutable fields (`toolName` or `transport`) is a conflict, not an overwrite.
- Completing an unknown operation is not silently inserted; return not-found.
- Repeating completion after a successful terminal update returns the persisted terminal result without changing its timestamps. A conflicting second terminal outcome is a conflict. This makes a lost HTTP response/retry safe.

### 3.2 Define success as the MCP callback outcome

Do not classify success only by whether the callback throws. Existing MarketHubTS tool handlers often return an MCP tool result with `isError: true` instead of throwing.

- A tool result with `isError === true` is recorded as `failed`.
- A non-error tool result is `succeeded`, even when its structured business result explicitly says `status: "unavailable"`. That means the MCP operation successfully returned an unavailable-result explanation; it does **not** mean market data was retrieved.
- A resource or prompt callback that returns normally is `succeeded`.
- A callback that throws is `failed` unless the request was cancelled/aborted before completion; cancellation is `interrupted`.
- Use the callback `ServerContext.mcpReq.signal` and the thrown error to identify cancellation. Do not convert an already completed successful persistence operation into `interrupted` just because the client disconnects afterward.
- A validation error rejected by the SDK before callback execution is outside this recording boundary and must not be falsely represented as a successful invocation.

Activity status therefore reports the MCP operation's response outcome. Any domain-level outcome (for example provider data unavailable) remains a separate safe summary/result detail.

### 3.3 Best-effort recording

- Activity-write failure must never change the tool/resource/prompt result or replace its original exception.
- If start fails, report a diagnostic and execute the operation without attempting completion for a row that was never created.
- If completion fails, report a diagnostic and leave the row `started`; the WebUI presents it as incomplete.
- Keep the diagnostic callback optional on `McpServices` (or an equally small injected diagnostic seam). HTTP diagnostics use the existing API logger; STDIO diagnostics go to **stderr only**. Never write diagnostics to STDIO stdout.

### 3.4 Separate data and activity outcomes

A market-data operation that persists a snapshot or historical candles remains `succeeded` when it returned a non-error MCP result. Failure to write the activity row does not change that. M6-D notification behavior is not implemented or displayed in M6-C.

## 4. Persistence and canonical contracts

### 4.1 Table and migration

Add one table in migration `0006_...` following the existing Drizzle SQL, journal, and snapshot conventions:

| Column | Meaning |
|---|---|
| `id` | Internal record ID, primary key |
| `operation_id` | Server-generated correlation UUID, unique |
| `tool_name` | Registered MCP capability name; retain the roadmap's field name for tools/resources/prompts |
| `transport` | `HTTP` or `STDIO` |
| `started_at` | API-generated UTC ISO timestamp; authoritative ordering and retention timestamp |
| `finished_at` | Nullable API-generated UTC ISO timestamp |
| `duration_ms` | Nullable non-negative server-computed duration |
| `client_started_at`, `client_finished_at` | Optional validated diagnostic timestamps only; never used for ordering, duration, or retention |
| `client_name`, `client_version` | Optional bounded client metadata; never trusted for authorization |
| `status` | `started`, `succeeded`, `failed`, or `interrupted` |
| `error_category`, `error_message` | Optional sanitized, bounded failure detail; no stack traces |
| `summary_json` | Optional bounded allow-listed summary; never raw arguments or payloads |
| `data_result_ref` | Optional serialized discriminated reference to stored data; never the data itself |

Add database `CHECK` constraints for the status and transport enums and for non-negative duration values. Required indexes: unique `operation_id`; stable page ordering on `(started_at, id)`; indexes supporting retention cutoff and the supported status/tool/transport filters. Do not add speculative indexes or alter existing tables.

Use fixed-format UTC timestamps (`toISOString()`) so lexical ordering matches chronological ordering. On completion, clamp the persisted finish time to at least the start time and calculate `duration_ms` from those server timestamps. This prevents a backwards wall-clock adjustment from creating a negative duration or inverted interval.

### 4.2 Result-reference contract

Do not use an ambiguous free-form string for navigation. Define a canonical discriminated union in `packages/contracts/src/mcp-activity.ts`:

```ts
type McpActivityResultRef =
  | { kind: "snapshot"; snapshotId: string }
  | {
      kind: "historical";
      canonicalId: string;
      interval: CandleInterval;
      fromMs: number;
      toMs: number;
    };
```

Persist this small reference as JSON. Validate it when reading. The API returns only the reference; it does not join or expose a market-data payload. Omit it when no stored result can be linked.

### 4.3 Safe summaries

Build summaries from already validated/normalized callback inputs, using a fixed per-kind allow-list and strict size limits. Suggested fields:

- Tools: `canonicalId`, `interval`, `mode`, `kind`, `configId`, `snapshotId`, `limit`, and validated date/range values where useful.
- Resources: `canonicalId`, `interval`, `query`, `limit`, `configId`, plus a boolean indicating whether a cursor was supplied. Never store the opaque cursor itself.
- Prompts: `canonicalId`, `interval`, `from`, `to`.

Only primitive values from approved keys are serialized. Enforce a maximum field length and total summary size. Drop all other inputs. Never serialize complete `args`, URI strings containing arbitrary input, provider credentials, tokens, or market responses.

### 4.4 Contract module

Create `packages/contracts/src/mcp-activity.ts` with:

- `mcpActivityStatusSchema` and `mcpActivityTransportSchema`.
- `mcpActivityResultRefSchema` and a bounded safe-summary schema.
- `mcpActivityViewSchema` and `mcpActivityListSchema` (`{ records, nextCursor }`).
- Strict start/complete request and response schemas. Reject unknown fields and invalid enum/timestamp/length values.

Extend `retentionSettingsSchema` in `packages/contracts/src/snapshots.ts` with optional `classes.ACTIVITY.maxAgeDays`. Existing valid persisted settings without `ACTIVITY` must remain valid. Keep malformed settings fail-closed.

The existing `systemStatusSchema` is in `packages/contracts/src/index.ts`; extend it only with a truthful MCP HTTP route-mounted signal as described in §8. Do not claim a level of MCP health the API cannot observe.

## 5. MCP recording seam

### 5.1 Transport derivation

The current shared factory is `packages/mcp-core/src/factory.ts` and currently ignores its `McpRequestContext`. In the official SDK 2.4.0, `McpRequestContext.requestInfo` is the original HTTP `Request` when present; the SDK explicitly does not set it for `serveStdio`.

Derive transport once in the factory:

```ts
const transport = ctx.requestInfo ? "HTTP" : "STDIO";
```

Pass it to the registration helpers. Do not infer transport from environment variables, API URLs, package presence, or client metadata.

The SDK calls the HTTP factory per HTTP request and the STDIO factory per connection; it may also construct a discarded discovery-probe instance. **Do not create activity rows during factory construction or registration.** Rows begin only when an operation callback is actually invoked.

### 5.2 Callback context and client metadata

The official SDK callbacks receive a `ServerContext`:

- Tool callback: arguments plus context.
- Static resource callback: URI plus context.
- Resource-template callback: URI, variables, plus context.
- Prompt callback: arguments plus context.

Use the documented context's `mcpReq.signal` for cancellation. Capture client name/version only from the documented per-request metadata envelope when present. The key is exported by the SDK as `CLIENT_INFO_META_KEY` (`"io.modelcontextprotocol/clientInfo"`), and the access pattern is:

```ts
import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";

const info = ctx.mcpReq.envelope?.[CLIENT_INFO_META_KEY] as
  | { name?: string; version?: string }
  | undefined;
```

The SDK types `RequestMetaEnvelope` as `{}` in the installed 2.4.0 declarations, so this access **requires a cast** to a narrow local shape — the metadata is not strongly typed by the SDK. Validate the cast result as untrusted input (bounded strings only); never trust it for authorization. Client identity metadata is optional under the SDK/spec; missing identity is normal and must be stored as `null`. Do not inspect private SDK server fields or require the client to send identity metadata.

### 5.3 Single wrapper

Add one focused helper in `packages/mcp-core/src/activity.ts`, conceptually:

```ts
withActivity({ services, transport, toolName, context, summary, operation })
```

Responsibilities:

1. Create a UUID operation ID.
2. Attempt `startActivity`; on a failed `McpResult` or thrown error, call the optional diagnostic hook and continue.
3. Invoke the original operation exactly once.
4. Classify the completed callback using §3.2 (`isError: true`, throw, and cancellation).
5. Extract only a typed stored-result reference when the result warrants one.
6. Attempt completion. A completion failure is diagnostic-only and must not alter the returned value or rethrow/replace the original error.
7. If the original callback threw, rethrow that same error after best-effort completion.

Apply this wrapper mechanically to all existing registered tool, resource, and prompt callbacks. Do not wrap discovery/list handlers and do not change the registered names, schemas, descriptions, annotations, resource URI templates, prompt text, or underlying service calls.

Required registration signatures:

- `registerTools(server, services, transport)`.
- `registerResources(server, services, transport)`.
- `registerPrompts(server, services, transport)`.

Prompts become service-aware only for activity recording; their existing static guidance remains static and side-effect-free.

### 5.4 Adapters

**HTTP:** `apps/api/src/mcp-services.ts` implements start/complete by calling the injected `McpActivityRepository` directly. Create the repository once in the API composition root (`apps/api/src/index.ts`) and inject that same instance into both `createHttpMcpServices` and `createApp`/REST routes.

**STDIO:** `apps/mcp-server/src/services.ts` remains a thin API client. It POSTs start/complete to the local API and validates the exact canonical response envelopes. It never opens SQLite or imports the database package. The current default API URL is loopback (`http://localhost:3001`); the write endpoints are local-owner-only. A remote/non-loopback configuration may cause recording to be rejected, but that must remain a diagnostic-only failure and must not block the MCP operation.

## 6. Hono API endpoints

Add `apps/api/src/mcp-activity-routes.ts` and register it from the existing `createApp` before the MCP route and SPA fallback.

| Method and path | Contract | Access |
|---|---|---|
| `POST /api/mcp/activity/start` | Validate bounded start request; insert/idempotently return the started row | Local-owner only via existing `isLocalPeer` |
| `POST /api/mcp/activity/complete` | Validate terminal outcome and update the existing operation row | Local-owner only via existing `isLocalPeer` |
| `GET /api/mcp/activity` | Bounded `{ records, nextCursor }` list with filters | LAN read-only |
| `GET /api/mcp/activity/by-operation/:operationId` | Detail by correlation ID | LAN read-only |
| `GET /api/mcp/activity/:id` | Detail by record ID | LAN read-only |

Rules:

- The STDIO write route must only create `STDIO` rows; do not trust a local caller to label an operation as `HTTP`. HTTP MCP writes directly through the in-process repository.
- The collection path always returns the list envelope. Do not switch its response shape based on a query parameter.
- Register `/by-operation/:operationId` before `/:id`.
- Reject malformed/oversized bodies, unknown properties, invalid IDs, unsupported transport/status, invalid diagnostic timestamps, and unbounded summary/error fields.
- Complete for an unknown ID returns not-found; conflicting terminal completion returns conflict.
- No auth framework. No local-owner guard on the WebUI read endpoints; they follow the existing LAN-read model.

### 6.1 Pagination and filters

- Default page size 25; hard maximum 100.
- Keyset order: `started_at DESC, id DESC`.
- Cursor contains a versioned `(started_at, id)` key plus a fingerprint of the normalized filters (`toolName`, `transport`, `status`, `from`, `to`). Reject malformed cursors and cursors reused with different filters.
- Query filters: `toolName`, `transport`, `status`, `from`, `to`. Use an exact operation-ID lookup through the detail endpoint rather than advertising an unsupported operation-ID list filter.
- Do not use offset pagination.

## 7. Retention

Extend the existing retention path; do not create a second scheduler or settings store.

1. Add optional `ACTIVITY: { maxAgeDays: positive integer }` to the existing retention contract.
2. Add `cleanupActivities(cutoff, batchLimit)` to `McpActivityRepository`. Follow the existing bounded delete loop used by `CandleRepository.cleanupCandles` and `SnapshotRepository.cleanupSnapshots`.
3. Extend `applyRetentionCleanup` in `apps/api/src/historical-routes.ts` to receive the activity repository and return `activitiesDeleted` in addition to candle/snapshot counts.
4. Preserve fail-closed semantics: missing, malformed, or schema-invalid retention settings cause **all** cleanup to do nothing and report zero deletions.
5. Extend the current retention editor in `apps/web/src/components/HistoricalPanel.tsx` with an Activity max-age input. Its current state/save flow already handles CANDLE and SNAPSHOT; preserve those values when editing ACTIVITY. Extend `apps/web/src/lib/historical.ts` only as needed for the updated response contract, and show the activity deletion count in the cleanup result.
6. Apply the same age cutoff to all activity statuses using the authoritative API `started_at` timestamp. An operation that outlives its configured retention window may have its row removed before completion; the later completion write is diagnostic-only/not-found and must not alter the business-operation result. This keeps cleanup bounded and policy-driven without introducing process leases or heartbeats.

No new retention panel or retention endpoint is needed.

## 8. WebUI

### 8.1 Activity tab

Add one fourth “MCP / Activity” tab to `apps/web/src/App.tsx`, with `apps/web/src/components/ActivityPanel.tsx` and typed client `apps/web/src/lib/activity.ts`.

Panel behavior:

- Recent activity list, default 25 and bounded by API maximum.
- Filters for tool name, transport, status, and time window.
- Exact operation-ID lookup and detail view.
- Show transport, operation name, started/finished time, duration, status, optional client name/version, safe summary, sanitized error, and typed data-result link.
- Visually distinguish current `started` rows and terminal `interrupted` rows.
- Clear loading, empty, error, pagination, and partial-result states. Reuse existing controls and tokens; no new design system or broad navigation redesign.
- Link snapshot references to the existing SnapshotPanel record and historical references to the existing HistoricalPanel/range. Do not return or join the stored market payload in activity endpoints.

### 8.2 Truthful transport state

**HTTP MCP:** `McpHttpHandler` exposes `fetch`, `close`, `notify`, and `bus`; it has no public `isRunning`/health state. Presence of `deps.mcpHandler` proves only that the handler/route is mounted in this API process. It does not prove that a future request will succeed or that all protocol conformance tests pass.

Therefore:

- Extend `systemStatusSchema` in `packages/contracts/src/index.ts` with exactly:

  ```ts
  mcp: z.object({
    httpHandlerMounted: z.boolean()
  })
  ```

- Populate `/api/status` in `apps/api/src/app.ts` from `deps.mcpHandler !== undefined` (the handler is mounted when the dependency is present). No new endpoint and no new polling loop or MCP client merely to simulate readiness.
- Display **“HTTP handler mounted”** when true and **“HTTP handler not mounted”** when false. Do **not** label this field “healthy”, “available”, “connected”, or “configured” — it reports mounting only, not runtime health.
- Pass this value from the existing status query into ActivityPanel.
- Align the wording in `docs/M6_PLAN.md` §9.2 and `docs/WEBUI_AND_CONFIGURATION.md` with this observable contract: M6-C reports whether the handler is mounted; "available" remains gated by the separately scoped B4 conformance and E real-HTTP acceptance.

**STDIO:** show only “Activity observed” when STDIO records exist, otherwise “No activity observed / status unknown”. Since STDIO is a separate process, the API cannot infer that it is currently configured, connected, or running from the absence/presence of historical rows.

## 9. File scope

### New files

- `packages/contracts/src/mcp-activity.ts`
- `packages/database/drizzle/0006_*.sql` and corresponding Drizzle journal/snapshot updates
- `packages/database/src/repositories/mcp-activity.ts`
- `packages/mcp-core/src/activity.ts`
- `apps/api/src/mcp-activity-routes.ts`
- `apps/web/src/components/ActivityPanel.tsx`
- `apps/web/src/lib/activity.ts`
- Focused tests, e.g. `tests/database-activity.test.ts`, `tests/mcp/activity.test.ts`, `tests/mcp/activity-routes.test.ts`, and `tests/web/activity.test.ts`

### Modified files

- `packages/contracts/src/index.ts` (export activity contracts and extend system-status contract)
- `packages/contracts/src/snapshots.ts` (add optional ACTIVITY retention class)
- `packages/database/src/schema.ts`, `packages/database/src/index.ts`
- `packages/mcp-core/src/services.ts`, `factory.ts`, `tools.ts`, `resources.ts`, `prompts.ts`, `index.ts`
- `apps/api/src/index.ts`, `app.ts`, `mcp-services.ts`, `historical-routes.ts`
- `apps/mcp-server/src/services.ts`
- `apps/web/src/App.tsx`, `components/HistoricalPanel.tsx`, `lib/historical.ts`
- Relevant status/UI tests; `docs/M6_PLAN.md` §9.2 and `docs/WEBUI_AND_CONFIGURATION.md` for the mounted-versus-available wording; other governing docs only where implementation status changes

Do not modify manifests or lockfiles. No dependency changes.

## 10. Required tests

### Persistence and migration

- Apply migration to a clean database and to a database already at migration `0005`.
- Verify unique operation ID, bounded fields, status constraints, and indexes.
- Start inserts one row; duplicate identical start returns it; conflicting start is rejected.
- Completion updates the same row; unknown operation is not inserted; duplicate identical completion is stable; conflicting terminal completion is rejected.
- Finish time is never before start time and duration is never negative, including a simulated backwards clock.
- `dataResultRef` round-trips through its discriminated schema; invalid variants are rejected.
- Activity cleanup deletes in bounded batches and applies only after valid retention settings.

### MCP wrapper and SDK semantics

- All nine existing tools, all seven registered resources, and all three prompts record start/complete for invoked callbacks.
- Tool `isError: true` result becomes `failed` even though the callback did not throw.
- Non-error tool result carrying business `status: "unavailable"` remains `succeeded` and retains that distinction in safe summary/result detail.
- Callback throw becomes `failed` and the original error is rethrown.
- Cancellation/abort before completion becomes `interrupted`.
- Schema-validation failures that never invoke a callback create no row (document this expected boundary).
- Start/complete activity-write failures do not change the operation result; completion failure leaves the row visible as incomplete.
- HTTP transport is derived from `ctx.requestInfo`; STDIO is derived from its absence.
- Factory/discovery-probe construction alone creates no activity row.
- Client name/version are optional and omitted/null when metadata is absent.
- Existing tool names, tool schemas/results, resource names/URIs, prompt text, cache hints, and B3 snapshot pagination remain unchanged.

### API and adapter

- Local-owner-only start/complete: 403 for non-local peers.
- STDIO writes are always labelled `STDIO`; HTTP uses the injected repository and is labelled `HTTP`.
- STDIO adapter uses HTTP only, validates response envelopes, never opens DB, and logs diagnostics to stderr only.
- List filters, max page size, stable keyset ordering, cursor/filter mismatch rejection, both detail endpoints, and route precedence are covered.
- Responses contain only the safe view; no raw args, credentials, tokens, or full market payloads.

### Retention and UI

- Existing CANDLE/SNAPSHOT settings without ACTIVITY still validate and load.
- ACTIVITY can be added/cleared while preserving existing CANDLE/SNAPSHOT values.
- Invalid/missing settings fail closed for every data class; cleanup response includes `activitiesDeleted`.
- ActivityPanel loading/empty/error/pagination/filter/detail/incomplete states and data navigation are covered.
- `/api/status` contract returns `httpHandlerMounted: true/false` accurately; the UI labels only the mounted state.
- STDIO status never claims current running/connected/configured state.

### Regression and verification

- Existing MCP and WebUI suites pass.
- Existing M6-A route/security/lifecycle, B1/B2/B3 tests remain green.
- `bun run typecheck`, `bun run build`, `git diff --check`, focused tests, and full test suite are run and reported with exact outcomes.
- Compare full-suite failures with the known two `EBUSY` baseline failures; report any new failure separately. Do not claim CI passed unless a real CI run exists.

## 11. Execution order

1. **Baseline and contracts:** confirm HEAD/status; implement canonical activity/status/result-reference schemas; extend ACTIVITY retention contract. No runtime code yet.
2. **Persistence:** add the one migration, Drizzle schema, repository, exports, idempotency and pagination primitives; test clean and upgraded databases.
3. **MCP callback recording:** add service methods, transport derivation, one wrapper, and registration changes. Verify the `isError` path and no activity on factory construction.
4. **Adapters and API:** inject one repository into API composition, add local STDIO write/read API routes, validate requests/results, extend bounded retention cleanup.
5. **WebUI:** add the tab/client/panel, wire existing `/api/status` mounted flag, extend the existing HistoricalPanel retention editor, and add typed result navigation.
6. **Regression and review:** run the complete verification matrix, inspect the entire diff independently, verify no protected milestone work or unrelated modifications, and report actual git status/HEAD.

Keep each step within M6-C. Do not start M6-B4, M6-D, M6-E, or Stage G while implementing this plan.

## 12. Acceptance criteria

M6-C is complete only when:

- Exactly one additive `mcp_activity` migration exists; no dependency changes or existing table alterations.
- Invoked MCP tool/resource/prompt callbacks create one durable row with correct transport, safe summary, server timestamps, and correct terminal status semantics.
- Activity failure is non-fatal; STDIO remains an API client and never opens SQLite.
- All endpoints are bounded, validated, correctly guarded, and return safe contracts.
- Activity retention integrates into the existing fail-closed cleanup and HistoricalPanel settings UI.
- The Activity tab displays truthful HTTP/STDIO states, paginated history, filters, details, incomplete rows, and typed links to stored data.
- Required focused and regression tests pass; build/typecheck pass; the diff passes review.
- No M6-B4/C/D/E or M6-complete claim is made from this milestone alone.

## 13. Security and operational guardrails

- No raw args, credentials, tokens, complete payloads, stack traces, or arbitrary client metadata.
- Local-owner guard for write endpoints; LAN read-only for inspection.
- Bound record fields, request bodies, list pages, cursors, and cleanup batches.
- Keep API-generated timestamps authoritative; client timestamps are diagnostic only.
- Do not mark a remote STDIO process running/not-running based on missing recent rows.
- Do not mark all `started` rows interrupted at API startup: STDIO is a separate process and may still be executing while the API restarts. Show those rows as incomplete; retain/delete them according to the configured age policy.
- No commit, push, merge, rebase, or amend without separate authorization.

## 14. Reporting format

Report: exact HEAD and `git status` before/after; exact files changed; migration and contract details; wrapper outcome semantics (`isError`, throw, cancellation); HTTP/STDIO transport evidence; local-owner access results; pagination/filter evidence; retention behavior; WebUI screenshots or concrete UI evidence; commands and actual test outputs; full-suite failures compared with baseline; acceptance checklist; unverified items and remaining issues. Do not represent a plan or passing typecheck as implemented runtime behavior.

## 15. Official references checked

- [MCP TypeScript SDK v2.4.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0) — published 23 October 2026.
- [Official SDK `McpRequestContext` and `McpHttpHandler`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/createMcpHandler.ts) — HTTP-only `requestInfo`; `serveStdio` does not set it; handler exposes `fetch`, `close`, `notify`, and `bus`, not a public running-state property; factory lifecycle includes HTTP per-request construction and STDIO connection construction/discovery probe.
- [Official SDK tool registration and callback types](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/mcp.ts) and [Tools guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md) — tool callbacks receive `ServerContext`; tool errors are represented by `CallToolResult.isError`; input-schema failures do not invoke the callback.
- [Official SDK resource callback types and guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/resources.md) — static/template read callbacks receive context; template callback has URI, variables, and context.
- [Official SDK prompt callback types and guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/prompts.md) — prompt callbacks receive `ServerContext` and return prompt messages.
- [MCP specification, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) — current protocol context. M6-C uses existing callback seams; it does not add subscription or notification behavior.
