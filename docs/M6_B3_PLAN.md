# M6-B3 — MCP Resources, Prompts and Cache Hints

> **Status:** Implementation plan only. Awaiting separate authorization. **No B3 source exists yet.** This document does not implement anything.
> **Last updated:** 2026-11-20
> **Depends on:** M6-A (`7860c7f`: Streamable HTTP at `/mcp`, retained STDIO, one shared factory); M6-B1 (`d50b372`, cursor fixes `6fd088d`/`be94219`: catalog-search and event-feed read seams + endpoints); M6-B2 (`0e0ec6d`, HTTP-adapter testability correction `a0e707e`: nine tools over both transports).
> **Governing design:** [`M6_PLAN.md`](M6_PLAN.md) §3.1 (C13–C15), §4.1 (shared factory / `McpServices`), §5 / §5.3 (inventory), §10 (M6-B); [`M6_B_PLAN.md`](M6_B_PLAN.md) §4.2–§4.3 (resources/prompts), §5 (seams), §7 (B3 sub-phase), §8–§9 (tests/acceptance). This document adds execution detail; it does not change that design.

## 1. Objective and boundaries

Register the **resource** and **prompt** halves of the M6 capability inventory through the **single** shared factory in `packages/mcp-core`, for **both** HTTP and STDIO, and set the mandatory 2026-07-28 cache hints. No duplicate registration, no second app/DB/provider, no new runtime dependency.

**In scope (M6-B3):**
- Register the six resources in §4 and three prompts in §5 via `registerResource` / `ResourceTemplate` / `registerPrompt` in `packages/mcp-core`, once, parameterised by `McpServices`.
- Add **one** `McpServices` method — `listSnapshotsPage` — plus the minimal store/service/repository seam and one read-only STDIO-parity endpoint it needs (§7).
- Set `cacheHints` on the `McpServer` options for all six cacheable methods and per-resource `cacheHint` overrides where justified (§6).
- Conformance items **C13** (standard resource/prompt operations, deterministic list order), **C14** (opaque pagination for the snapshot resource), **C15** (cache hints on all six cacheable results). C16/C18/C19/C20/C21 remain B4/whole-M6 verification and are **not** claimed here.

**Out of scope — do not start (explicit):**
- **M6-B4:** conformance/parity test suite (`conformance.test.ts`, `parity.test.ts`), deterministic-discovery assertions as a milestone, and final C13–C21 evidence. B3 produces the capabilities and focused tests; B4 proves conformance/parity.
- **M6-C:** `mcp_activity` table/migration, activity endpoints, WebUI inspection, `startActivity`/`completeActivity`. No activity hooks in `McpServices`.
- **M6-D:** `subscriptions/listen`, event bridge, `handler.notify` wiring, read-after-notify. B3 registers the event-feed **resource** (read side) only; no notification wiring.
- **M6-E:** broad integration, real-listener acceptance, concurrent-client/reconnect, second-device LAN verification.
- Provider activation / Stage G, new dependencies, migrations, auth/RBAC, `x-mcp-header`/`Mcp-Param-*`, futures/market-information tools, and any M6-A transport/CORS/Host-Origin/shutdown change.
- **No new tools and no changes to the nine B2 tool contracts.** B3 adds resources and prompts only.

**Fixed decisions (no further architecture review needed):**
1. **Resource URIs** are exactly those in `M6_PLAN.md` §5.3 / `M6_B_PLAN.md` §4.2 (§4 below). They are stable public identifiers; do not rename.
2. **`markethub://events/alerts`** is contract-only: discoverable in `resources/list`, but its read handler returns an explicit `unavailable` error (durable alert records are M7). It must never return an empty feed that could be mistaken for "no alerts".
3. **Snapshot resource pagination** uses the new newest-first bounded `listSnapshotsPage` seam (§7). Do **not** re-sort the capped oldest-first `listSnapshots` set at the MCP layer.
4. **Cache hints:** conservative `{ ttlMs: 0, cacheScope: "private" }` on all six methods. Per-resource `cacheHint` override is available in the SDK but **unused in B3** (no resource is provably stable/public). Document the override point for a future phase.
5. **STDIO parity:** all six resources and three prompts are registered identically over both transports. The snapshot page reaches STDIO through one new read-only endpoint (§7.3); no capability is silently dropped.
6. **Prompts are text-only guidance.** A prompt returns messages that *describe* which tool/resource to use; it must not execute tools, call services, or change operational configuration.

**Protocol re-verification (mandatory at implementation start):** before coding, re-verify the latest stable MCP specification and TypeScript SDK against official sources. Current verified baseline: spec `2026-07-28`, SDK `2.4.0` (installed and confirmed in `M6_PLAN.md` §3). If a newer stable revision/SDK exists, update the conformance matrix (`M6_PLAN.md` §3.1) and this plan before implementation. A `draft` spec is not a target.

## 2. Verified baseline (checked against source at `a0e707e`)

| Fact | Evidence |
|---|---|
| Factory registers only the nine B2 tools; no resources/prompts/cache hints | `packages/mcp-core/src/factory.ts:11-16` (`new McpServer({ name, version })`, `registerTools` only) |
| `McpServices` has 11 operations; no `listSnapshotsPage`, no activity hooks | `packages/mcp-core/src/services.ts:88-100` |
| `registerTools` registers nine tools in normative order | `packages/mcp-core/src/tools.ts:35-183` |
| Shared Zod input schemas live in `schemas.ts`; `parseRange` helper exists | `packages/mcp-core/src/schemas.ts:1-69` |
| HTTP adapter `createHttpMcpServices` is extracted and testable; uses injected instances only | `apps/api/src/mcp-services.ts:18-87` |
| STDIO adapter is a thin local-API client; `listSnapshots` calls `GET /api/snapshots` | `apps/mcp-server/src/services.ts:12,183-197` |
| `SnapshotStore.listSnapshots` is oldest-first (`capturedAt ASC`), default cap 200; no page method | `packages/market-core/src/snapshots/service.ts:7-15,66-68`; `packages/database/src/repositories/snapshots.ts:100-109` |
| Catalog search + event-feed endpoints already exist (B1) | `apps/api/src/catalog-routes.ts`, `apps/api/src/market-routes.ts` |
| SDK 2.4.0 supports `registerResource` (string + `ResourceTemplate`), `registerPrompt`, `cacheHints` | installed `dist/mcp-BCJHyo7l.d.mts:2685-2698,2847-2865,3335-3342,3421-3447,3496-3523` |
| `cacheHints` is a `ServerOptions` field (so set on `new McpServer(...)`); `server/discover` is installed on the server instance and reads the same hint map | installed `dist/mcp-BCJHyo7l.d.mts:2865,3226`; `dist/mcp-oHn3ureC.mjs:827,866-868,971` |
| `CreateMcpHandlerOptions` has **no** `cacheHints` field | installed `dist/createMcpHandler-DzlXH0KL.d.mts:254-323` |
| `ResourceMetadata = Omit<Resource, 'uri' \| 'name'>` (title/description/mimeType) | installed `dist/mcp-BCJHyo7l.d.mts:3592` |

## 3. `McpServices` expansion (B3-only)

Add exactly one method to the seam in `packages/mcp-core/src/services.ts`:

```ts
// B3 — newest-first bounded snapshot page (not in B2 scope)
listSnapshotsPage(filter: {
  configId?: string; fromMs?: number; toMs?: number;
  limit: number; afterCapturedAt?: string; afterId?: string
}): Promise<McpResult<{ snapshots: McpOptionChainSnapshot[]; nextCursor: string | null }>>;
```

- Keep `McpResult<T>` and all existing types unchanged.
- Do **not** add activity hooks (M6-C), subscription/listen methods (M6-D), or any speculative method.
- Update the barrel `packages/mcp-core/src/index.ts` only if a new exported type is introduced (none expected — reuse `McpOptionChainSnapshot`).

## 4. Resource inventory (six resources)

Register in `packages/mcp-core/src/resources.ts` via `registerResources(server, services)`. Use a shared helper to serialise a value into `ReadResourceResult` (`{ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] }`) and a shared helper to map a failed `McpResult` to an explicit error (throw an SDK resource error such as `ResourceNotFoundError` with the sanitized message — confirm the constructor at implementation time). **Never return an empty success for an unavailable or failed read.**

| # | URI | Kind | Inputs | Service call | Success body | Failure / special |
|---|---|---|---|---|---|---|
| 1 | `markethub://catalog/instruments` | `ResourceTemplate` (`query`, `limit`, `cursor`) | non-empty `query`, `limit` 1–100 (default 25), opaque `cursor` | `searchCatalog({ text: query, limit, afterCanonicalId: cursor })` | `{ instruments, nextCursor }` | empty query → validation error; reuse B1 catalog contract |
| 2 | `markethub://market/snapshot` | direct (string URI) | none | `getLiveSnapshot()` | `liveSnapshotSchema` value | service failure → explicit error |
| 3 | `markethub://historical/{canonicalId}/{interval}` | `ResourceTemplate` | `from`, `to` (ISO-8601) | `getCachedCandles` + `getCoverage` (same range) | `{ candles, coverage }` | invalid/non-finite range or `from > to` → validation error via shared `parseRange` |
| 4 | `markethub://snapshots/{configId?}` | `ResourceTemplate` | optional `configId`, `limit`, opaque `cursor` | `listSnapshotsPage(...)` (§7) | `{ snapshots, nextCursor }` | invalid/expired cursor → explicit error; newest-first |
| 5 | `markethub://events/live{?after,limit}` | `ResourceTemplate` (query form) | `after` (opaque), `limit` | `readEventFeed({ after, limit })` | discriminated `McpFeedPage` value | `snapshotRequired` is a **valid** body (return the envelope as-is, no `resumeCursor`); service failure → explicit error |
| 6 | `markethub://events/alerts` | direct (string URI) | none | none | — | **contract-only:** always throw explicit `unavailable` error ("unavailable in M6 — alert events are an M7 dependency"); discoverable, never empty |

**Notes:**
- `ResourceTemplate` requires a `list` callback in its constructor even if it is `undefined` (SDK `dist/mcp-BCJHyo7l.d.mts:3499-3510`). For templates whose full instance set is not enumerable (catalog, historical, snapshots, events/live), pass `list: undefined` and rely on `resources/templates/list` for discovery; document this choice.
- **Why `events/live` is a template, not a static resource:** static string-URI resources are matched by exact `uri.toString()` (SDK `dist/mcp-oHn3ureC.mjs:1742`), so a fixed URI cannot carry variable `after`/`limit` inputs. Register it with the concrete, stable URI template `markethub://events/live{?after,limit}` (RFC 6570 query expansion) and read the variables from the template callback. The governing inventory (`M6_PLAN.md` §5.3, `M6_B_PLAN.md` §4.2) lists the base URI `markethub://events/live`; the template form is its implementation encoding and does not change the resource identity or cursor semantics. Confirm the exact template string against the installed `UriTemplate` at implementation time and keep it stable.
- Resource descriptions must state the cursor kind: catalog/snapshot resources use stored-data keyset cursors; `events/live` uses a **runtime-scoped** cursor that does **not** survive restart (per `M6_PLAN.md` §6.1).
- Deterministic order: register resources and templates in the fixed order above; assert it in tests (C13).
- No unfiltered catalog listing resource (per `M6_PLAN.md` §5.1).

## 5. Prompt inventory (three prompts)

Register in `packages/mcp-core/src/prompts.ts` via `registerPrompts(server, services)`. Each prompt returns `GetPromptResult` (`{ messages: [{ role: "user", content: { type: "text", text } }] }`) with plain-language guidance that names the relevant tool/resource. **Prompts do not call services or tools and have no side effects.**

| # | Name | Args (`argsSchema`) | Guidance content |
|---|---|---|---|
| 1 | `explain_market_snapshot` | `{ canonicalId?: string }` | How to read `market_snapshot` / `markethub://market/snapshot`: revision, capturedAtMs, selected provider, canonical fields, honest empty state |
| 2 | `interpret_coverage_gaps` | `{ canonicalId: string, interval: string, from: string, to: string }` | How to use `historical_candles` mode `coverage` and interpret gaps/unavailable notes; never invent missing candles |
| 3 | `how_to_capture_snapshot` | `{}` | How to use `option_chain_snapshot` mode `capture`; states it persists with `configId = null` and does not change saved capture config |

- Use Zod `argsSchema` (wrapped with `z.object`) per SDK `registerPrompt` (`dist/mcp-BCJHyo7l.d.mts:3421-3447`).
- Deterministic `prompts/list` order = the table order; assert in tests (C13).
- Invalid args → SDK validation error; no hidden actions, no operational changes.

## 6. Cache hints (C15)

Set `cacheHints` on the `McpServer` constructor options in `packages/mcp-core/src/factory.ts`:

```ts
const server = new McpServer({
  name: "markethubts",
  version: "0.1.0",
  cacheHints: {
    "server/discover":        { ttlMs: 0, cacheScope: "private" },
    "tools/list":             { ttlMs: 0, cacheScope: "private" },
    "prompts/list":           { ttlMs: 0, cacheScope: "private" },
    "resources/list":         { ttlMs: 0, cacheScope: "private" },
    "resources/templates/list": { ttlMs: 0, cacheScope: "private" },
    "resources/read":         { ttlMs: 0, cacheScope: "private" }
  }
});
```

- The six methods above are the **closed** cacheable set (`CACHEABLE_RESULT_METHODS`, SDK `dist/mcp-BCJHyo7l.d.mts:2696`). No other operation receives cache fields.
- `ttlMs` must be a non-negative safe integer; invalid values throw `RangeError` at construction (SDK `dist/mcp-oHn3ureC.mjs:866-868`).
- `server/discover` is installed on the server instance and reads the same hint map (`dist/mcp-oHn3ureC.mjs:827,971`) — setting it here is sufficient; `CreateMcpHandlerOptions` has no cache-hint field.
- Per-resource override point: `registerResource(..., { cacheHint })` takes precedence field-by-field for that resource's `resources/read` (SDK `dist/mcp-BCJHyo7l.d.mts:2854-2858,3335-3342`). **B3 sets no per-resource overrides**; all reads inherit the conservative server-level hint. Document the override point for a future phase with provably stable/public data.
- Same `cacheScope` across all pages of a paginated list (C15). With a single private scope everywhere, this holds by construction.
- MRTR retries are not cached; B3 uses no MRTR (C16 remains N/A and is asserted in B4).
- 2025-era responses must remain unaffected (cache fields are 2026-wire-only, symbol-keyed internally). Assert if dual-era is retained.

## 7. Supporting seam: newest-first snapshot page

### 7.1 Store / service (`packages/market-core`)
- Add to `SnapshotStore` (`src/snapshots/service.ts:7-15`):
  `listSnapshotsPage(filter): { snapshots: OptionChainSnapshot[]; nextCursor: string | null }`.
- Add `OptionChainSnapshotService.listSnapshotsPage(filter)` delegating to the store (mirror `listSnapshots` at `:66-68`). Leave `listSnapshots` unchanged for REST/WebUI.

### 7.2 Repository (`packages/database/src/repositories/snapshots.ts`)
- Implement `listSnapshotsPage` with `ORDER BY captured_at DESC, id DESC`, `LIMIT limit + 1` (lookahead), and keyset predicate `(captured_at < afterCapturedAt) OR (captured_at = afterCapturedAt AND id < afterId)` when a cursor is supplied.
- `limit` default 25, max 100 (clamp explicitly). Reuse the existing `(configId, capturedAt)` index; no new table or migration.
- Return only the first `limit` rows; set `nextCursor` from the last returned `(capturedAt, id)` **iff** the `(limit + 1)`-th row exists, else `null`. Discard the lookahead row.
- Cursor encoding: opaque, e.g. base64url of `${capturedAt}|${id}`. Malformed/undecodable cursors → explicit validation error, never a silent empty page.

### 7.3 STDIO parity endpoint (`apps/api`)
- Add one read-only endpoint **`GET /api/snapshots/page`** with query `configId?`, `from?`, `to?`, `limit`, `cursor`; response `{ snapshots, nextCursor }`. Register it in `snapshot-routes.ts` **before the dynamic `GET /api/snapshots/:id` handler** (which is ordered last and would otherwise capture `/page` as an id), and register the router before the SPA fallback in `app.ts`. No `isLocalPeer` requirement (read-only under the existing LAN model), consistent with the B1 parity endpoints.
- `McpServicesStdio.listSnapshotsPage` calls this endpoint and validates the response with `optionChainSnapshotSchema` (same pattern as `listSnapshots` at `apps/mcp-server/src/services.ts:183-197`).
- `McpServicesHttp.listSnapshotsPage` calls `snapshotService.listSnapshotsPage` directly (in-process, same instances as REST) — never through the guarded REST routes.
- Rationale for a dedicated endpoint: keeps the existing `GET /api/snapshots` (used by WebUI) and its response shape untouched. If the implementer prefers extending that endpoint with optional `cursor`/`limit`, it must remain backward-compatible and be recorded as a deviation here before coding.

## 8. File scope

**Modified in `packages/mcp-core`:**
- `src/factory.ts` — pass `cacheHints` to `new McpServer(...)`; call `registerResources` and `registerPrompts` (after `registerTools`).
- `src/services.ts` — add `listSnapshotsPage` (§3).
- `src/index.ts` — barrel updates for the two new registration functions.
- **New:** `src/resources.ts`, `src/prompts.ts`. (Split justified: six resources + three prompts in `tools.ts` would violate one-responsibility.)

**Modified in `apps/api`:**
- `src/mcp-services.ts` — implement `listSnapshotsPage` via injected `snapshotService`.
- **New or extended:** `src/snapshot-routes.ts` — add `GET /api/snapshots/page` before the dynamic `/api/snapshots/:id` route (§7.3); register the router in `src/app.ts` before SPA fallback.

**Modified in `apps/mcp-server`:**
- `src/services.ts` — implement `listSnapshotsPage` via `GET /api/snapshots/page`.

**Modified in other packages:**
- `packages/market-core/src/snapshots/service.ts` — `listSnapshotsPage` on `SnapshotStore` + service.
- `packages/database/src/repositories/snapshots.ts` — implement `listSnapshotsPage`.

**New tests (`tests/mcp/`):** `resources.test.ts`, `prompts.test.ts`, `cache-hints.test.ts`, `snapshot-page.test.ts`; extend `tools-adapters.test.ts` (HTTP/STDIO `listSnapshotsPage` delegation) and `http-smoke.test.ts` (read one resource + get one prompt over the real listener).

**No dependency changes.** `@modelcontextprotocol/client` stays dev-only. No migration, no auth, no M6-A transport change.

## 9. Tests

- **Resources (`resources.test.ts`):** `resources/list` shows the two direct resources (`markethub://market/snapshot`, `markethub://events/alerts`) and `resources/templates/list` shows the four templates (`catalog/instruments`, `historical/{canonicalId}/{interval}`, `snapshots/{configId?}`, `events/live{?after,limit}`), each in fixed order; read each with valid input → JSON `contents` matching the canonical shape; catalog resource rejects empty query; historical resource rejects invalid/reversed range via `parseRange`; snapshot resource cursor round-trip (newest-first, `nextCursor` present with a following row and `null` on the last page, invalid cursor → error); `events/live` template read returns a normal page with `resumeCursor` and a `snapshotRequired` envelope without one; `events/alerts` returns an explicit unavailable error (not empty success); service failures map to explicit errors, never empty success.
- **Prompts (`prompts.test.ts`):** `prompts/list` shows the three prompts in fixed order; `prompts/get` for each returns user text messages; assert **no service calls** (prompts are text-only); invalid args → validation error.
- **Cache hints (`cache-hints.test.ts`):** wire assertions on 2026-07-28 responses that `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read` all carry `ttlMs: 0` and `cacheScope: "private"`; same scope across pages; no cache fields on non-cacheable operations; 2025-era responses unaffected if dual-era retained.
- **Snapshot page (`snapshot-page.test.ts`):** repository/service newest-first ordering, bound (default/max), keyset predicate, `limit + 1` lookahead (`nextCursor` present vs `null`), malformed cursor rejection; no change to `listSnapshots`.
- **Adapters (`tools-adapters.test.ts`):** HTTP and STDIO `listSnapshotsPage` delegate to the injected service/endpoint with correct cursor/limit translation; STDIO validates the response envelope.
- **Real HTTP smoke (`http-smoke.test.ts`):** extend the M6-A smoke test to read one resource and get one prompt over the real listener (broad acceptance stays M6-E).

## 10. Acceptance criteria (M6-B3 exit)

- All six resources and three prompts are registered through the single shared factory; identical over HTTP and STDIO; no duplicate registration per transport.
- `McpServices` contains only the B3 addition (`listSnapshotsPage`) beyond B2 — no activity hooks, no subscription methods, no speculative seams.
- Snapshot resource uses the newest-first bounded seam with an opaque cursor and `limit + 1` lookahead; no MCP-layer re-sorting of a capped oldest-first set.
- `markethub://events/alerts` is discoverable and returns an explicit `unavailable` error; no fabricated or empty data.
- Cache hints present on all six cacheable results with conservative values; per-resource override point documented but unused; 2025-era responses unaffected.
- Prompts are text-only guidance with no hidden tool calls or operational changes.
- STDIO parity holds: all resources/prompts reachable; snapshot page via the new read-only endpoint; no capability silently dropped.
- Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; independent diff review before any merge.
- **Full-suite acceptance (`bun test`):** no new failures compared with the documented Windows baseline — two unrelated `EBUSY` temp-dir cleanup failures in `tests/market/stage-f-timeout.test.ts` and `tests/market/supervisor.test.ts`. Report the exact failure list and compare to baseline. Fixing those baseline failures is a separate task.
- No B4/C/D/E work, provider activation/Stage G, new dependency, migration, auth/RBAC, or M6-A transport/CORS/Host-Origin/shutdown change.
- No commit/push without separate authorization.

## 11. Risks and implementation-time decisions

- **`ResourceTemplate` list callback:** confirm the `list: undefined` behavior for non-enumerable templates against the installed SDK; ensure `resources/templates/list` still advertises them.
- **Unavailable-resource error type:** confirm the `ResourceNotFoundError` constructor/signature; the requirement is an explicit error, never an empty success.
- **Snapshot endpoint shape:** dedicated `GET /api/snapshots/page` (default) vs extending `GET /api/snapshots`; record any deviation before coding.
- **Cache-hint wire verification:** confirm the `server/discover` hint reaches the 2026 wire result (SDK installs discover on the server instance); assert on the wire in `cache-hints.test.ts`.
- **Cursor encoding:** keep snapshot cursors opaque and stable; reject malformed values explicitly; do not expose raw `(capturedAt, id)` as a documented contract.
- **STDIO on-demand endpoints:** unchanged from B2 — loopback-guarded REST routes are not used by HTTP MCP; do not relax those guards for LAN clients.

## 12. Reporting format for the implementation assignment

Report: what was implemented; exact files added/modified; dependency changes (expected: none); tests and actual results (including the full-suite failure list vs baseline); resource/prompt/cache-hint evidence; STDIO parity evidence; acceptance-criteria checklist; remaining issues; exact `git status` and HEAD. Do not claim M6-B4/C/D/E or M6 complete. No commit/push without separate authorization.
