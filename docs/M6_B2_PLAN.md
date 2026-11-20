# M6-B2 — MCP Tool Registration over Shared Services

> **Status:** B2 implementation is complete and published (`0e0ec6d`: nine tools registered through the shared factory over both transports, HTTP/STDIO adapters, provider-status composition, service sharing). A follow-up HTTP-adapter testability correction (extract `createHttpMcpServices` into `apps/api/src/mcp-services.ts` plus focused adapter tests) is pending publication. This document remains the governing B2 design; B3/B4 and later phases are not implemented.
> **Last updated:** 2026-11-20
> **Baseline:** M6-A (transport/factory/health tool) implemented and published at `7860c7f`; M6-B1 (catalog search + event-feed seams) implemented and published at `d50b372`, with the restart-safe event-feed checkpoint and always-present `resumeCursor` fixes published at `6fd088d` and `be94219`. **Final B1 implementation baseline: `be9421911ad74766a200ef091fcacdcef8448177`.** This B2 plan was published at `9510e8e` — that documentation commit is not the B1 implementation baseline.
> **Governing design:** [`M6_B_PLAN.md`](M6_B_PLAN.md) §4.1 (tool inventory), §6 (file scope), §7 (B2 sub-phase), §8–§9 (tests/acceptance); [`M6_PLAN.md`](M6_PLAN.md) §4.1.2 (McpServices), §5.2 (side-effect annotations), §5.3 (capability inventory), §3.1 (conformance C13–C16/C18–C19). This document adds execution detail; it does not change that design.

## 1. Objective and boundaries

Register the **tool** inventory (§4.1 of `M6_B_PLAN.md`) through the single shared factory so both HTTP and STDIO expose identical tools with identical semantics. Expand `McpServices` only with the operations those tools consume, and implement the HTTP/STDIO adapters over existing services and endpoints.

**In scope (B2):**
- `McpServices` additions: `getProviderStatus`, `getLiveSnapshot`, `getCachedCandles`, `getCoverage`, `fetchHistorical`, `listSnapshots`, `getSnapshot`, `captureSnapshot`.
- Register the 9 tools in §3 (including the existing `markethub_health` and the two unavailable tools).
- HTTP adapter: direct in-process calls to the existing injected services/repositories.
- STDIO adapter: `fetch` to the existing local API endpoints.
- Shared Zod input schemas + ISO→epoch-ms helper in `packages/mcp-core/src/schemas.ts`.
- Composition change in `apps/api/src/index.ts` so historical/snapshot services are created once and shared with REST and MCP (approved in `M6_B_PLAN.md` §3.1; B1 did not need it).

**Out of scope (do not start):**
- B3: resource/prompt registration, `listSnapshotsPage`, cache hints (`McpServerOptions.cacheHints` / per-resource `cacheHint`).
- B4: parity/conformance tests (C13–C16, C18–C19), deterministic `tools/list` order verification, no-extensions/no-MRTR assertions.
- M6-C activity, M6-D subscriptions/bridge/`handler.notify`, M6-E broad integration, providers/Stage G, new runtime deps, migrations, auth/RBAC.
- Do not change M6-A transport, CORS, Host/Origin or shutdown behavior.

**Decisions fixed here:**
1. **Static annotations:** annotations are per-tool, not per-call. `historical_candles`, `option_chain_snapshot` and `on_demand_retrieval` can persist, so they get `readOnlyHint: false` with descriptions naming which modes are reads. Pure reads get `readOnlyHint: true`. All get `destructiveHint: false`; `openWorldHint: false` (local data only).
2. **Unavailable tools:** `futures_chain` and `market_information` are registered with `z.object({})` input and a handler returning `isError: true` with a sanitized "unavailable in M6 — no shared service" message. No fabricated data.
3. **No cache hints in B2** — deferred to B3 per the approved sub-phase split. B4 verifies all six cacheable results.
4. **No new workspace dependency** — `mcp-core` keeps its structural `McpFeedEvent` type; B2 adds no dependency on `realtime` or other packages.

## 2. Verified baseline (checked against source, 2026-11-20)

| Fact | Evidence |
|---|---|
| Factory registers only `markethub_health` today | `packages/mcp-core/src/factory.ts:11-37` |
| `McpServices` has `getHealth`, `searchCatalog`, `readEventFeed` | `packages/mcp-core/src/services.ts:37-41` |
| `ProviderRegistry.getStatuses(): ProviderStatusMap` exists | `packages/market-core/src/provider.ts:42` |
| `MarketDataService.getSnapshot(): LiveSnapshot` exists | `packages/market-core/src/live/service.ts:87-89` |
| `HistoricalCandleService`: `getCached`, `getCoverageStatus`, `fetchOnDemand` | `packages/market-core/src/historical/service.ts:72,88,101` |
| `OptionChainSnapshotService`: `listSnapshots`, `getSnapshot`, `captureOnDemand` | `packages/market-core/src/snapshots/service.ts:66,70,78` |
| `CoverageStatus { gaps, unavailableNotes }`, `HistoricalFetchResult { candles, gaps, unavailable, conflicts, providersTried }`, `CaptureResult { snapshot, error }` | `historical/service.ts:41-57`, `snapshots/service.ts:39-42` |
| Contracts available: `providerStatusMapSchema`, `liveSnapshotSchema`, `historicalCandleSchema`, `candleGapSchema`, `candleRangeNoteSchema`, `optionChainSnapshotSchema`, `optionChainCaptureRequestSchema` | `packages/contracts/src/{provider,live,historical,snapshots}.ts` |
| REST endpoints exist for all B2 data (provider status, market snapshot, historical cached/coverage/fetch, snapshot list/get/capture) | `apps/api/src/{provider,market,historical,snapshot}-routes.ts` |
| Historical/snapshot services are created **inside** `createApp` with optional `AppDependencies` overrides | `apps/api/src/app.ts:53-57,174-182` |
| SDK 2.4.0 `registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations?, ... }, cb)`; `ToolAnnotations` = `title/readOnlyHint/destructiveHint/idempotentHint/openWorldHint` | installed `dist/mcp-BCJHyo7l.d.mts:3373-3383`, core `schemas-*.d.mts` |

## 3. `McpServices` expansion (B2 target)

Add only these operations; keep `McpResult<T>` and the B1 page types unchanged. Do **not** add `startActivity`/`completeActivity` (M6-C), `listSnapshotsPage` (B3), or any speculative method.

```ts
getProviderStatus(): Promise<McpResult<ProviderStatusMap>>;
getLiveSnapshot(): Promise<McpResult<LiveSnapshot>>;
getCachedCandles(req: CandleRangeRequest): Promise<McpResult<{ candles: HistoricalCandle[] }>>;
getCoverage(req: CandleRangeRequest): Promise<McpResult<CoverageStatus>>;
fetchHistorical(req: CandleRangeRequest): Promise<McpResult<HistoricalFetchResult>>;
listSnapshots(filter: { configId?: string; fromMs?: number; toMs?: number }): Promise<McpResult<{ snapshots: OptionChainSnapshot[] }>>;
getSnapshot(id: string): Promise<McpResult<OptionChainSnapshot>>;
captureSnapshot(req: OptionChainRequest): Promise<McpResult<CaptureResult>>;
```

## 4. Tool registration contracts

All tools are registered in `packages/mcp-core/src/tools.ts` via `registerTools(server, services)` in this **normative order** (B4 may verify deterministic `tools/list`; B2 only needs to implement this sequence):

1. `markethub_health`
2. `catalog_search`
3. `provider_status`
4. `market_snapshot`
5. `historical_candles`
6. `option_chain_snapshot`
7. `on_demand_retrieval`
8. `futures_chain`
9. `market_information`

Each handler maps `McpResult` failure to `{ content: [{ type: "text", text: JSON.stringify({ ok: false, error }) }], isError: true }` and success to `{ content: [...], structuredContent: value }`, matching the existing `markethub_health` pattern.

| Tool | Input (Zod) | Service call(s) | Output / `structuredContent` | Annotations |
|---|---|---|---|---|
| `markethub_health` | `{}` | `getHealth()` | `HealthStatus` | readOnly |
| `catalog_search` | `{ query: string.min(1), limit: int 1–100 default 25, cursor?: string }` | `searchCatalog({ text: query, limit, afterCanonicalId: cursor })` | `McpCatalogPage` | readOnly |
| `provider_status` | `{}` | `getProviderStatus()` | `ProviderStatusMap` | readOnly |
| `market_snapshot` | `{ canonicalId?: string }` | `getLiveSnapshot()` then tool-side project `items` by `canonicalId`, preserving `revision`/`capturedAtMs`/`connections` | `LiveSnapshot` | readOnly |
| `historical_candles` | `{ canonicalId, interval, from, to, mode: cached\|coverage\|onDemand }` | parse `from`/`to` via shared ISO→ms helper; `getCachedCandles` / `getCoverage` / `fetchHistorical` | `{ candles }` / `CoverageStatus` / `HistoricalFetchResult` | **not readOnly** (onDemand may cache); description states which modes are reads |
| `option_chain_snapshot` | strict discriminated union on `mode` (below) | `listSnapshots` / `getSnapshot` / `captureSnapshot` per mode | `{ snapshots }` / `OptionChainSnapshot` / `CaptureResult` | **not readOnly** (capture persists `configId = null`); `idempotentHint: false` for capture |
| `on_demand_retrieval` | `{ kind: historical\|option_chain, canonicalId, interval?, from?, to?, expiryDate?, provider? }` | dispatch to `fetchHistorical` or `captureSnapshot` per `M6_B_PLAN.md` §4.1 contract | `{ kind, status, tool, result?, error? }` per §4.1 | **not readOnly**; description states delegated side effect |
| `futures_chain` | `{}` | none | `isError: true`, "unavailable in M6 — no shared service" | readOnly |
| `market_information` | `{}` | none | `isError: true`, "unavailable in M6 — no shared service" | readOnly |

**`option_chain_snapshot` input — strict mode-specific schemas** (Zod discriminated union on `mode`; reject unknown modes and mode-foreign fields where practical):

- **`list`**: `{ mode: "list", configId?: string, fromMs?: number, toMs?: number }`. `fromMs`/`toMs` must be finite; reject `fromMs > toMs`. Service call: `listSnapshots({ configId, fromMs, toMs })`. Output: `{ snapshots: OptionChainSnapshot[] }`. Uses the existing `OptionChainSnapshotService.listSnapshots()` — oldest-first, 200-record default cap (see §9). No pagination in B2.
- **`get`**: `{ mode: "get", snapshotId: string.min(1) }`. Service call: `getSnapshot(snapshotId)`. Output: `OptionChainSnapshot`; a missing snapshot maps to an `unavailable` tool result (service `null` → `McpResult` failure).
- **`capture`**: `{ mode: "capture", underlyingCanonicalId: string.min(1), expiryDate: string.min(1), provider?: ProviderId, strikeRangeJson?: string, nativeIdentifier?: string }`. Service call: `captureSnapshot({ underlyingCanonicalId, expiryDate, ...(provider ? { provider } : {}), ...(strikeRangeJson !== undefined ? { strikeRangeJson } : {}), ...(nativeIdentifier ? { nativeIdentifier } : {}) })`. Output: `CaptureResult`. Capture uses `captureOnDemand()` and stores with `configId = null`; it must not read, create, modify or depend on saved capture configurations. Existing capture/retention behavior is preserved.

**ISO→epoch-ms helper** (`packages/mcp-core/src/schemas.ts`): `parseRange(from, to): { fromMs, toMs } | { error }` using `Date.parse`, rejecting non-finite values and `fromMs > toMs`. Used by `historical_candles` and `on_demand_retrieval` (historical kind). No service change.

**`on_demand_retrieval` dispatch** (normative, from `M6_B_PLAN.md` §4.1): `historical` → `fetchHistorical({ canonicalId, interval, fromMs, toMs })` → `status: "ok"` with full `HistoricalFetchResult` (empty candles + reports is still ok); `option_chain` → `captureSnapshot({ underlyingCanonicalId: canonicalId, expiryDate, ...(provider ? { provider } : {}) })` → `status: "ok"` when `snapshot !== null`, else `status: "unavailable"` with sanitized error. Any `McpResult` failure → `status: "unavailable"` with sanitized error. No new business logic — thin router only.

## 5. HTTP and STDIO adapter contracts

### 5.1 HTTP (`apps/api/src/index.ts`)
Expand `createHttpMcpServices` to accept `registry`, `service`, `historicalService`, `snapshotService` in addition to `config`, `db`, `catalog`, `hub`. Implement each B2 method by direct in-process calls to those instances. No new state, no second app/DB/provider.

**`getProviderStatus` must reuse the existing composition, not call `registry.getStatuses()` alone.** The REST route composes auth/configuration status from `ProviderRegistry.getStatuses()` with authoritative runtime streaming state from `MarketDataService.getConnectionStatus(id)?.state` via `withRuntimeStreamingState()` / `composeProviderStatuses()` (`apps/api/src/provider-routes.ts:24-45`). To avoid two implementations of the same rules, export the existing `composeProviderStatuses` (or a narrow equivalent) from `provider-routes.ts` and call it from the HTTP MCP adapter with the same `ProviderRouteDependencies` (`providerRegistry`, `service`, etc.). Return the composed `ProviderStatusMap` validated by `providerStatusMapSchema`. Do not duplicate the streaming-state overlay logic.

**Composition change (required):** in `index.ts`, construct `AppSettings`, `CandleRepository`, `SnapshotRepository`, `HistoricalCandleService` and `OptionChainSnapshotService` once (the objects `createApp` currently builds internally at `app.ts:174-182`), pass them to `createApp` via the existing `AppDependencies` overrides, and pass the same instances to `createHttpMcpServices`. REST routes keep using the same instances. No REST behavior change.

### 5.2 STDIO (`apps/mcp-server/src/services.ts`)
Add B2 methods using `fetch` to the existing local API. Map responses to `McpResult`:

| Method | Endpoint | Response mapping |
|---|---|---|
| `getProviderStatus` | `GET /api/providers/status` | extract `json.providers` (the REST-composed map including runtime `streamingState` for both providers), validate with `providerStatusMapSchema`; do not return the `{ providers, localManagement, note }` wrapper |
| `getLiveSnapshot` | `GET /api/market/snapshot` | validate with `liveSnapshotSchema` |
| `getCachedCandles` | `GET /api/historical/candles?canonicalId=&interval=&from=&to=` | `json.candles` |
| `getCoverage` | `GET /api/historical/coverage?...` | `{ gaps: json.gaps, unavailableNotes: json.unavailableNotes }` |
| `fetchHistorical` | `POST /api/historical/fetch` (loopback-guarded; STDIO is local) | `{ candles, gaps, unavailable, conflicts, providersTried }` |
| `listSnapshots` | `GET /api/snapshots?configId=&from=&to=` | `json.snapshots` |
| `getSnapshot` | `GET /api/snapshots/:id` | `json.snapshot`; 404 → `unavailable` |
| `captureSnapshot` | `POST /api/snapshots/capture` (loopback-guarded) | see exact 422 contract below |

**`captureSnapshot` — identical HTTP/STDIO semantics (normative):** a valid capture attempt that produces no snapshot is a **completed service operation**, not a transport failure. `OptionChainSnapshotService.captureOnDemand()` returns `CaptureResult { snapshot: null, error }` as a normal outcome; the REST route maps that outcome to HTTP 422 with `{ error: "capture_unavailable", message }` (`apps/api/src/snapshot-routes.ts:77-79`). Both adapters must expose the **same** `McpResult<CaptureResult>`:

- **HTTP direct service:** `captureSnapshot(req)` → `ok: true, value: { snapshot: null, error: <sanitized service error> }` when no provider succeeds.
- **STDIO:** a 422 response with `error === "capture_unavailable"` is translated to the **same** `ok: true, value: { snapshot: null, error: <sanitized message> }` — never `ok: false`. The MCP tool then maps `snapshot === null` to the documented `unavailable` tool outcome (§4.1 of `M6_B_PLAN.md`).
- **Genuine failures remain errors:** 400 → `ok: false` category `validation`; 403 → `ok: false` category `unavailable` (local-owner guard); other non-2xx and network errors → `ok: false` category `unavailable`. Sanitize all messages — never expose credentials, tokens, authorization headers or sensitive request data.

Exact examples:
```
HTTP direct:   captureSnapshot(validReq) -> { ok: true, value: { snapshot: null, error: "no provider available" } }
STDIO 422:     { error: "capture_unavailable", message: "no provider available" }
            -> { ok: true, value: { snapshot: null, error: "no provider available" } }
STDIO 400:     { error: "invalid_request", message: "Invalid capture request" }
            -> { ok: false, error: { category: "validation", message: "Invalid capture request" } }
STDIO 403:     { error: "forbidden", message: "Manual capture is local-owner only" }
            -> { ok: false, error: { category: "unavailable", message: "Manual capture is local-owner only" } }
```

No credential/token leakage. No new endpoints — all already exist.

## 6. File scope

**Modified in `packages/mcp-core`:**
- `src/services.ts` — B2 contract additions (§3).
- `src/factory.ts` — call `registerTools(server, services)`; keep factory pure/side-effect-free.
- `src/index.ts` — barrel updates if new types are exported.
- **New:** `src/schemas.ts` (Zod inputs + `parseRange` helper), `src/tools.ts` (all tool registrations).

**Modified in `apps/api`:**
- `src/index.ts` — composition change + B2 HTTP service methods.
- `src/provider-routes.ts` — narrowly limited to exposing or reusing the existing `composeProviderStatuses()` logic so the HTTP MCP adapter can return the same composed provider status as REST. Preserve provider registry auth/configuration information, runtime streaming state from `MarketDataService.getConnectionStatus()`, existing REST behavior, and no credential exposure. Do not move provider logic into `mcp-core`, duplicate status composition, or refactor unrelated provider routes.

**Modified in `apps/mcp-server`:**
- `src/services.ts` — B2 STDIO methods.

**New tests (`tests/mcp/`):**
- `tools.test.ts` — in-process tool behavior (§7).
- `tools-adapters.test.ts` — HTTP/STDIO adapter mapping via stub local API (or extend `seams.test.ts`; explain choice in report).

**No dependency changes.** No new files outside this list without explanation.

## 7. Tests

- **In-process (`handler.fetch` + pinned `2026-07-28` client):** each tool with valid input returns `structuredContent`; invalid input returns `isError: true`; unavailable tools return `isError: true` with the sanitized message; `market_snapshot` projection filters `items` and preserves other fields; `historical_candles` rejects bad ISO ranges and `fromMs > toMs`; `on_demand_retrieval` dispatches both `kind` values and maps `CaptureResult.snapshot === null` to `status: "unavailable"`.
- **Annotations:** `tools/list` shows `readOnlyHint: true` only for pure reads; persistence-capable tools are not read-only; descriptions state side effects. (Full deterministic-order and cache-hint assertions are B4/B3.)
- **Adapters:** HTTP methods call the injected instances (verify via a fake service); STDIO methods call the correct local API paths with translated params and map errors consistently. No operational config mutation.
- **Capture 422 parity (both adapters):** with a fake service returning `{ snapshot: null, error: "no provider available" }`, the HTTP adapter returns `ok: true, value: { snapshot: null, error }`; with a stub API returning 422 `{ error: "capture_unavailable", message }`, the STDIO adapter returns the identical `ok: true, value: { snapshot: null, error: message }`. Assert 400 → `validation`, 403/other non-2xx → `unavailable`, and that no credential/token/authorization header appears in any result.
- **Provider status composition (both providers):** with a fake registry returning auth status and a fake `MarketDataService.getConnectionStatus()` returning distinct runtime states for UPSTOX and FYERS, assert the HTTP adapter's `getProviderStatus()` preserves each provider's `streamingState` (not just registry auth fields); assert the STDIO adapter extracts and validates the composed `providers` map from a stub REST response containing both providers' runtime states.
- **Option-chain modes:** assert each `option_chain_snapshot` mode builds the exact service request (list filters, get id, capture fields with `configId = null` persistence), rejects `fromMs > toMs` and non-finite values, and that capture does not read/write saved capture configs.
- **Regression:** existing M6-A/M6-B1 tests must still pass unchanged.

## 8. Acceptance criteria (B2 exit)

- All 9 tools in §4 are registered through the single shared factory; no duplicate registration per transport.
- `McpServices` contains only B1 + B2 operations — no activity hooks, no `listSnapshotsPage`, no speculative methods.
- Every tool is callable over both HTTP and STDIO with identical response semantics; unavailable tools report honestly.
- Side-effect annotations and descriptions match §5.2 of `M6_PLAN.md`; on-demand operations never mutate operational config.
- ISO→ms conversion is shared and rejects invalid ranges; `on_demand_retrieval` dispatch matches the §4.1 contract.
- HTTP composition shares one set of service instances with REST; no second app/DB/provider.
- Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; full `bun test` shows no new failures versus the documented Windows baseline (two `EBUSY` cleanup failures in `stage-f-timeout.test.ts` / `supervisor.test.ts`). Independent diff review before any merge.
- No B3/B4/M6-C/D/E work, providers/Stage G, new runtime deps, migrations, auth/RBAC, or M6-A transport/CORS/shutdown changes.

## 9. Risks and implementation-time decisions

- **Static vs per-call annotations:** annotations cannot express "read-only except onDemand mode"; the plan's resolution is a non-read-only tool with a descriptive explanation. Keep it.
- **Provider status shape:** the REST endpoint wraps the map in `{ providers, localManagement, note }`; the STDIO adapter must extract `providers` and validate, not return the wrapper.
- **Loopback-guarded on-demand endpoints:** STDIO is local so `isLocalPeer` passes; do not relax those guards for LAN MCP clients — HTTP uses direct services.
- **Snapshot list bound:** B2 uses the existing non-paginated `listSnapshots` (store cap 200); the newest-first page seam is B3. Do not add it in B2.
- **Cache hints:** deferred to B3; do not set `cacheHints` in B2 even though `tools/list` is cacheable. B4 verifies.

## 10. Reporting format for the implementation assignment

Report: what was implemented; exact files added/modified; dependency changes (expected: none); tests and actual results; evidence HTTP and STDIO expose identical tools; full-suite result vs the documented baseline; acceptance-criteria checklist; remaining issues; exact `git status`, branch and HEAD. Do not claim B3/B4 or M6-B complete. No commit/push without separate authorization.
