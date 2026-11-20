# M6-B — MCP Capabilities over Shared Services

> **Status:** Governing plan. **M6-B1 is implemented and published** (`d50b372`, with restart-safe event-feed cursors and always-present `resumeCursor` at `6fd088d`/`be94219`); **M6-B2 is implemented and published** (`0e0ec6d`: nine tools over both transports, HTTP/STDIO adapters, provider-status composition, service sharing; a follow-up HTTP-adapter testability correction is published at `a0e707e`). **M6-B3/B4 implementation not started.** Awaiting separate authorization for each remaining sub-phase.
> **Last updated:** 2026-11-20
> **Depends on:** M6-A (implemented at `7860c7f`: Streamable HTTP at `/mcp`, retained STDIO, one shared factory, `markethub_health` only) and M6-B1 (catalog search + event-feed seams; final implementation baseline `be9421911ad74766a200ef091fcacdcef8448177`).
> **Governing design:** [`M6_PLAN.md`](M6_PLAN.md) §4.1.2 (McpServices), §4.1.3 (STDIO parity), §5 (inventory), §5.1–§5.3 (catalog search, annotations, capability table), §10 (M6-B), §11–§12 (tests/acceptance). This document adds execution detail; it does not change that design.

## 1. Objective and boundaries

Expose the full M6 capability inventory — tools, resources and prompts — through **both** transports using **one** registration implementation over the existing `McpServices` seam. No duplicate market logic, no second app/DB/provider, no new runtime dependency.

**In scope (M6-B):**
- Expand `McpServices` from `getHealth()` to the M6-B operations actually consumed by the inventory (§3).
- Register the tools, resources and prompts in §4 in `packages/mcp-core`, once, for HTTP and STDIO.
- Add the two STDIO-parity endpoints (`GET /api/catalog/search`, `GET /api/market/events`) and the minimal repository/hub seams they need (§5).
- Conformance items C13–C16, C18–C19 from `M6_PLAN.md` §3.1: standard operations, deterministic `tools/list` order, opaque pagination, cache hints on all six cacheable results, no advertised extensions, JSON Schema 2020-12 with no remote `$ref`, and no MRTR/server-initiated requests.

**Out of scope (do not start):**
- M6-C: `mcp_activity` table, activity endpoints, WebUI inspection, `startActivity`/`completeActivity`.
- M6-D: `subscriptions/listen`, event bridge, `handler.notify` wiring, read-after-notify notification flow. (M6-B implements only the **read** side of event feeds — the resource, the bounded read seam and its endpoint.)
- M6-E: broad integration, concurrent-client/reconnect acceptance, second-device LAN verification.
- Provider activation, Stage G, Tasks/Skills/MCP Apps, `x-mcp-header`/`Mcp-Param-*` headers, futures/market-information tools.

**Decisions fixed here (no further architecture review needed):**
1. **STDIO parity:** add both parity endpoints (the plan's default option (a)). No capability is silently dropped.
2. **`x-mcp-header`:** not used by any M6-B tool; no `Mcp-Param-*` CORS change. Revisit only if a tool later needs it.
3. **`futures_chain` / `market_information`:** registered as tools that return an explicit `unavailable` result (`isError: true`, sanitized message "unavailable in M6 — no shared service"), so clients can discover them and get an honest answer. No fabricated data, no new service.
4. **Event feeds:** M6-B registers `markethub://events/live` and implements `readEventFeed`; `markethub://events/alerts` is registered as a **contract-only resource whose handler reports unavailable** (M7 dependency) — it must be discoverable and return an explicit unavailable error, not be absent and not return an empty feed. Notification wiring stays in M6-D.
5. **Cache hints:** set via `McpServerOptions.cacheHints` in the factory (SDK 2.4.0 `McpServerOptions = ServerOptions & {...}`, `ServerOptions.cacheHints?: Partial<Record<CacheableResultMethod, CacheHint>>`). Use `ttlMs: 0` / `cacheScope: "private"` as the conservative default; override per-resource with `cacheHint` where data is stable/public.

## 2. Verified baseline (checked against source, 2026-11-19)

| Fact | Evidence |
|---|---|
| `McpServices` currently has only `getHealth()` | `packages/mcp-core/src/services.ts` |
| Factory registers only `markethub_health` | `packages/mcp-core/src/factory.ts` |
| `CatalogRepository` has `listInstruments()` (unbounded), `findAlias`, `findIdentifiers`; **no** paginated search | `packages/market-core/src/types.ts:34-50` |
| Catalog table has `canonical_id` (PK), `canonical_symbol`, `display_name`; indexes on symbol and underlying | `packages/database/src/schema.ts:16-47` |
| `HistoricalCandleService`: `getCached`, `getCoverageStatus`, `fetchOnDemand` (caches via `upsertCandles`) | `packages/market-core/src/historical/service.ts:72,88,101` |
| `OptionChainSnapshotService`: `listSnapshots`, `getSnapshot`, `captureOnDemand` (`configId = null`) | `packages/market-core/src/snapshots/service.ts:66,70,78` |
| `ProviderRegistry.getStatuses(): ProviderStatusMap` exists | `packages/market-core/src/provider.ts:42` |
| `MarketDataService.getSnapshot(): LiveSnapshot` exists | `packages/contracts/src/live.ts` (`LiveSnapshot`) |
| `LiveEventHub` has bounded in-memory `history` + `openStream`; **no** stateless read-after method | `packages/realtime/src/hub.ts:139-285` |
| REST endpoints already exist for provider status, market snapshot, historical cached/coverage/fetch, snapshot list/get/capture | `apps/api/src/{provider,market,historical,snapshot}-routes.ts` |
| SDK 2.4.0 supports `registerTool` (annotations), `registerResource`/`ResourceTemplate`, `registerPrompt`, `cacheHints` | installed `dist/mcp-BCJHyo7l.d.mts` |

## 3. `McpServices` expansion (M6-B target)

Add only operations consumed by §4. Keep `McpResult<T>` unchanged. All methods return canonical contract types; `unavailable` is used for gated/absent capabilities, never fabricated data.

```ts
// packages/mcp-core/src/services.ts — M6-B additions
getProviderStatus(): Promise<McpResult<ProviderStatusMap>>;
searchCatalog(req: { text: string; limit: number; afterCanonicalId?: string }):
  Promise<McpResult<{ instruments: CanonicalInstrument[]; nextCursor: string | null }>>;
getLiveSnapshot(): Promise<McpResult<LiveSnapshot>>;
getCachedCandles(req: CandleRangeRequest): Promise<McpResult<{ candles: HistoricalCandle[] }>>;
getCoverage(req: CandleRangeRequest): Promise<McpResult<CoverageStatus>>;
fetchHistorical(req: CandleRangeRequest): Promise<McpResult<HistoricalFetchResult>>;
// B2 — existing non-paginated read (oldest-first, 200-record default cap)
listSnapshots(filter: { configId?: string; fromMs?: number; toMs?: number }):
  Promise<McpResult<{ snapshots: OptionChainSnapshot[] }>>;
// B3 — separate newest-first bounded page seam (not in B2 scope)
listSnapshotsPage(filter: { configId?: string; fromMs?: number; toMs?: number; limit: number; afterCapturedAt?: string; afterId?: string }):
  Promise<McpResult<{ snapshots: OptionChainSnapshot[]; nextCursor: string | null }>>;
getSnapshot(id: string): Promise<McpResult<OptionChainSnapshot>>;
captureSnapshot(req: OptionChainRequest): Promise<McpResult<CaptureResult>>;
// Discriminated: successful pages always carry resumeCursor; recovery never does.
readEventFeed(req: { after?: string; limit: number }): Promise<McpResult<
  | { events: OutboundEvent[]; nextCursor: string | null; resumeCursor: string; snapshotRequired?: never }
  | { events: []; nextCursor: null; snapshotRequired: { reason: string }; resumeCursor?: never }
>>;
```

**Implementations:**
- `McpServicesHttp` (`apps/api/src/index.ts`): direct in-process calls to the existing injected services/repositories. No new state.
- `McpServicesStdio` (`apps/mcp-server/src/index.ts`): thin `fetch` calls to the existing local API. On-demand fetch/capture use the loopback-guarded endpoints (STDIO is local). Where an endpoint does not exist, report `unavailable` — never reimplement locally.

### 3.1 HTTP composition change (required, not optional)

`createHttpMcpServices(config, db)` in `apps/api/src/index.ts` currently builds only health. M6-B needs the **same instances** used by REST/SSE/WebUI. `AppDependencies` already exposes optional overrides (`appSettings`, `candleRepo`, `snapshotRepo`, `historicalService`, `snapshotService` — `apps/api/src/app.ts:53-57`), so no new seam is needed:

1. In `apps/api/src/index.ts`, construct `AppSettings`, `CandleRepository`, `SnapshotRepository`, `HistoricalCandleService` and `OptionChainSnapshotService` once (the same objects `createApp` currently builds internally at `app.ts:170-178`), using the existing `db`/`config`.
2. Pass them into `createApp({...})` via those overrides so REST routes and MCP services share one instance.
3. Build `createHttpMcpServices(config, db, { registry, service, hub, catalog, historicalService, snapshotService })` from those same objects. `ProviderRegistry`, `MarketDataService` and `LiveEventHub` are already created in `index.ts` and available.
4. Do **not** construct a second DB, service, repository or provider. Do not change the existing REST route behavior.

This is a composition-only change; it must not alter M6-A transport, CORS, Host/Origin or shutdown behavior.

## 4. Capability inventory to register

### 4.1 Tools

| Tool | Input | Output | Side-effect class | Notes |
|---|---|---|---|---|
| `markethub_health` | none | `healthStatusSchema` | read | existing (M6-A) |
| `catalog_search` | `query` (non-empty), `limit` (1–100, default 25), `cursor?` | instruments + `nextCursor` | read | `readOnlyHint: true`; keyset cursor = last `canonical_id` |
| `provider_status` | none | `providerStatusMapSchema` | read | `readOnlyHint: true`; surface restrictions honestly |
| `market_snapshot` | `canonicalId?` | `liveSnapshotSchema` | read | `readOnlyHint: true`; canonical fields only. Service returns the full snapshot; the tool applies an optional **tool-side projection** over `snapshot.items` filtered by `canonicalId`, preserving `revision`/`capturedAtMs`/`connections`. No service change |
| `historical_candles` | `canonicalId`, `interval`, `from`/`to` (ISO-8601 strings), `mode: cached\|coverage\|onDemand` | candles / gaps / coverage | read for cached+coverage; **persistence** for onDemand | tool parses `from`/`to` to epoch ms (`Date.parse`), rejects invalid/non-finite values and `fromMs > toMs` with a validation error, then calls the service with `CandleRangeRequest { canonicalId, interval, fromMs, toMs }`; onDemand: `readOnlyHint: false`, description states "may cache retrieved candles" |
| `option_chain_snapshot` | `configId?`, `snapshotId?`, `mode: list\|get\|capture`, capture fields | snapshot envelope(s) | read for list/get; **persistence** for capture | capture: `readOnlyHint: false`, description states "persists a snapshot with no capture config" |
| `on_demand_retrieval` | see contract below | dispatch result (see below) | persistence (delegates) | never mutates config; no new business logic |

**`on_demand_retrieval` concrete contract:**
- Input: `{ kind: "historical" | "option_chain", canonicalId: string, interval?: CandleInterval, from?: string, to?: string, expiryDate?: string, provider?: ProviderId }`. `kind` is the only dispatch discriminator; `historical` requires `interval`+`from`+`to` (ISO-8601 strings), `option_chain` requires `expiryDate`.
- Dispatch: `historical` → parse `from`/`to` with `Date.parse` (reject invalid/non-finite and `fromMs > toMs` as validation errors), then `McpServices.fetchHistorical({ canonicalId, interval, fromMs, toMs })`; `option_chain` → `McpServices.captureSnapshot({ underlyingCanonicalId: canonicalId, expiryDate, ...(provider ? { provider } : {}) })`. No new service logic — it is a thin router over the two existing operations. The same ISO→epoch-ms conversion is used by the `historical_candles` tool; share one helper in `packages/mcp-core/src/schemas.ts`.
- Output: `{ kind, status: "ok" | "unavailable", tool: "historical_candles" | "option_chain_snapshot", result: HistoricalFetchResult | CaptureResult, error?: { category, message } }`. Mapping from delegated results (normative): `fetchHistorical` → `status: "ok"`, `result` = the full `HistoricalFetchResult` (empty `candles` plus `unavailable`/`gaps` reports is still a completed attempt, not an error); `captureSnapshot` → `status: "ok"` with `result` = `CaptureResult` when `snapshot !== null`, otherwise `status: "unavailable"`, `result` omitted, `error` = sanitized `CaptureResult.error` (category `provider` or `unavailable`). A `McpResult` failure from either service maps to `status: "unavailable"` with the sanitized error. `readOnlyHint: false` (delegates to persistence operations); description states the side effect of the delegated kind.

`futures_chain`, `market_information`: **registered as unavailable tools** (decision 3).

### 4.2 Resources

| URI | Kind | Query | Notes |
|---|---|---|---|
| `markethub://catalog/instruments` | template | `query`, `limit`, `cursor` | requires non-empty query; no unfiltered listing |
| `markethub://market/snapshot` | direct | none | `liveSnapshotSchema` |
| `markethub://historical/{canonicalId}/{interval}` | template | `from`, `to` | candles + coverage |
| `markethub://snapshots/{configId?}` | template | `cursor` | stored snapshot page (contract below) |
| `markethub://events/live` | direct | `after`, `limit` | bounded replay page or `snapshot-required` |
| `markethub://events/alerts` | direct | none | contract-only; handler returns explicit `unavailable` (M7) |

**Snapshot resource pagination contract (bounded newest-first seam):** the existing `SnapshotStore.listSnapshots(configId?, fromMs?, toMs?)` (`packages/market-core/src/snapshots/service.ts:8-15`) and its repository implementation order by `capturedAt ASC` with a default cap of 200 — re-sorting that oldest-first subset cannot surface the newest snapshots. M6-B therefore adds one bounded page method, symmetric with the catalog search extension:
- `SnapshotStore.listSnapshotsPage(filter: { configId?, fromMs?, toMs?, limit, afterCapturedAt?, afterId? }): { snapshots: OptionChainSnapshot[]; nextCursor: string | null }` in `packages/market-core/src/snapshots/service.ts`, implemented in `packages/database/src/repositories/snapshots.ts` with `ORDER BY captured_at DESC, id DESC`, `LIMIT ?` (default 25, max 100), and keyset predicate `(captured_at < afterCapturedAt) OR (captured_at = afterCapturedAt AND id < afterId)`. `nextCursor` encodes the last returned `(capturedAt, id)` pair opaquely when more rows exist.
- `OptionChainSnapshotService.listSnapshotsPage(...)` delegates to the store; the existing `listSnapshots` stays unchanged for REST/WebUI.
- **B2** uses only `McpServices.listSnapshots` (no pagination) over the existing `OptionChainSnapshotService.listSnapshots()` — oldest-first with a 200-record default cap; it is not described as returning the latest snapshots. **B3** adds `McpServices.listSnapshotsPage` and the resource handler decodes/encodes its opaque cursor and returns `nextCursor`. No MCP-layer re-sorting of a capped oldest-first set. An invalid/expired cursor returns an explicit `unavailable`/`snapshot-required` result, never a silent empty page.

### 4.3 Prompts

`explain_market_snapshot`, `interpret_coverage_gaps`, `how_to_capture_snapshot` — read-only guidance that calls the tools above; no hidden actions, no operational changes.

## 5. Supporting seams and endpoints (minimal)

1. **Catalog search repository method** — add `searchInstruments({ text, limit, afterCanonicalId? }): Promise<CanonicalInstrument[]>` to `CatalogRepository` and `SqliteCatalogRepository`. Bounded `LIKE` over `canonical_symbol` / `display_name` / `identity_key` (all columns on `canonical_instruments`), `ORDER BY canonical_id ASC`, `LIMIT ?`, `canonical_id > afterCanonicalId` keyset predicate. No new table/migration/service layer.
2. **`GET /api/catalog/search`** — query `text`, `limit`, `cursor`; response `{ instruments, nextCursor }`. Read-only under existing LAN model; no `isLocalPeer`. New `apps/api/src/catalog-routes.ts`, registered in `app.ts` before SPA fallback.
3. **`LiveEventHub.readAfter(cursor, limit)`** — bounded read from retained in-memory history; returns events with revision > cursor, or explicit `snapshot-required` (invalid/expired/future cursor, cursor from a previous hub instance, empty history after restart). Must not create a client session or consume the SSE stream. No new storage. Cursors are runtime-scoped (`<runtimeId>:<revision>`); every page outcome returns an always-present `resumeCursor` checkpoint (last returned revision, or current revision for an empty caught-up page) distinct from the lookahead-only `nextCursor`. SSE `Last-Event-ID` stays bare numeric and unchanged.
4. **`GET /api/market/events`** — query `after`, `limit`; response `{ events, nextCursor, resumeCursor, snapshotRequired? }` (`resumeCursor` absent on `snapshot-required`). Read-only under existing LAN model. Add to `apps/api/src/market-routes.ts`.
5. **Snapshot page seam** — add `listSnapshotsPage` to `SnapshotStore` (`packages/market-core/src/snapshots/service.ts`), `OptionChainSnapshotService` and `SqliteSnapshotRepository` (`packages/database/src/repositories/snapshots.ts`) per §4.2. No new table/migration; the existing `(configId, capturedAt)` index supports the ordered scan.

Parameter translation (normative, from `M6_PLAN.md` §5.1): tool/resource `query` → service/repo `text`; external opaque `cursor`/`nextCursor` ↔ `afterCanonicalId` (last returned `canonical_id`); `limit` identical across layers.

**Next-page detection (normative, all paginated seams):** catalog search, snapshot pages and event-feed reads use a **`limit + 1` lookahead** to decide whether `nextCursor` exists — never infer it from `results.length === limit`. Each seam fetches at most `limit + 1` rows/events in its declared order, returns only the first `limit` to the client, and sets `nextCursor` from the last returned item **iff** the extra `(limit + 1)`-th row exists; otherwise `nextCursor` is `null`. The lookahead row is discarded, not returned. This applies uniformly to:
- `searchInstruments` (SQL `LIMIT limit + 1`, keyset on `canonical_id`);
- `listSnapshotsPage` (SQL `LIMIT limit + 1`, keyset on `(capturedAt, id)`);
- `readEventFeed` (bounded replay read of `limit + 1` events from retained history, keyset on revision).

An empty page with `nextCursor: null` means end-of-results; a `snapshot-required` outcome is distinct and never conflated with an empty page. Tests must assert both cases: a full page with a following row yields `nextCursor`, and a full page that is the last yields `nextCursor: null`.

## 6. File scope

**Modified in `packages/mcp-core`:**
- `src/services.ts` — expand contract (§3).
- `src/factory.ts` — call the three registration functions; pass `cacheHints` to `McpServer`.
- `src/index.ts` — barrel updates.
- **New:** `src/schemas.ts` (Zod input schemas + shared output shapes), `src/tools.ts`, `src/resources.ts`, `src/prompts.ts`. Split is justified: ~7 tools + 5 resources + 3 prompts in one file would violate the one-responsibility rule.

**Modified in `apps/api`:**
- `src/index.ts` — expand `createHttpMcpServices` with M6-B methods.
- `src/app.ts` — register the two new routes before SPA fallback.
- **New:** `src/catalog-routes.ts`; `src/market-routes.ts` gains the events endpoint.

**Modified in `apps/mcp-server`:**
- `src/index.ts` — expand `stdioServices` with M6-B local-API calls.

**Modified in other packages:**
- `packages/market-core/src/types.ts` — `searchInstruments` on `CatalogRepository` (+ `CatalogRepositoryTx` if required by the implementation).
- `packages/database/src/repositories/catalog.ts` — implement `searchInstruments`.
- `packages/realtime/src/hub.ts` — add `readAfter(cursor, limit)`.
- `packages/market-core/src/snapshots/service.ts` — add `listSnapshotsPage` to `SnapshotStore` and `OptionChainSnapshotService`.
- `packages/database/src/repositories/snapshots.ts` — implement `listSnapshotsPage`.

**New tests (`tests/mcp/`):**
- `tools.test.ts`, `resources.test.ts`, `prompts.test.ts`, `parity.test.ts`, `catalog-search.test.ts`.

**No dependency changes.** `@modelcontextprotocol/client` remains dev-only (M6-A).

## 7. Suggested bounded sub-assignments (each separately authorized)

| Sub-phase | Scope | Exit condition |
|---|---|---|
| **M6-B1** | `McpServices` expansion + catalog repository method + `GET /api/catalog/search` + `LiveEventHub.readAfter` + `GET /api/market/events` | Both parity endpoints work over HTTP; repository/hub seams covered by unit tests |
| **M6-B2** | Tool registration (§4.1) + `McpServicesHttp`/`Stdio` implementations for those tools | All tools callable over both transports; annotations and side-effect descriptions correct |
| **M6-B3** | Resource + prompt registration (§4.2–4.3) + cache hints | All resources/prompts discoverable and readable; cache hints present on six cacheable results |
| **M6-B4** | Parity + conformance tests (C13–C16, C18–C19) | `parity.test.ts` passes; no extensions advertised; no MRTR/server-initiated requests |

Do not start a sub-phase without its own authorization. M6-B is not complete until all four pass.

## 8. Tests

- **In-process (`handler.fetch` + pinned modern client):** each tool with valid/invalid input; `unavailable` paths including `futures_chain`, `market_information` and `markethub://events/alerts`; `on_demand_retrieval` dispatch for both `kind` values; `market_snapshot` canonicalId projection; deterministic `tools/list` order; pagination cursor round-trip (catalog and snapshots); cache hints on `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`; no `resultType: input_required`; no server-initiated requests.
- **Repository/endpoint unit tests:** `searchInstruments` ordering, bound, keyset, empty-query rejection; `listSnapshotsPage` newest-first ordering, bound, keyset, invalid-cursor handling; `readAfter` cursor cases including `snapshot-required`.
- **Parity:** HTTP direct services and STDIO local-API client reach the same capabilities with identical response semantics; `catalog_search` and `events/live` are available over both (decision 1).
- **Real HTTP:** extend the M6-A smoke test to call at least one M6-B tool and read one resource over the real listener. Broad integration/concurrency/LAN remains M6-E.

## 9. Acceptance criteria (M6-B exit)

- All tools/resources/prompts in §4 are registered through the single shared factory; no duplicate registration per transport.
- `McpServices` contains only M6-B operations (no M6-C activity hooks, no speculative methods).
- Both parity endpoints exist and work over HTTP and STDIO; no capability silently dropped.
- Side-effect annotations and descriptions match §5.2 of `M6_PLAN.md`; on-demand operations never mutate operational config.
- Cache hints present on all six cacheable results; deterministic `tools/list` order; opaque cursors; no extensions advertised; no MRTR/server-initiated requests.
- `futures_chain`, `market_information` and `markethub://events/alerts` are discoverable and return an explicit `unavailable` result (no fabricated data, no empty success); they are documented as deferred to M7/later services.
- Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; independent diff review before any merge.
- **Full-suite acceptance (`bun test`):** require **no new failures compared with the documented Windows baseline**, not a zero-failure run. The verified baseline at the M6-A commit (`7860c7f`) has two unrelated `EBUSY` temp-dir cleanup failures in `tests/market/stage-f-timeout.test.ts` and `tests/market/supervisor.test.ts` (confirmed present on the parent commit `58036b7` too; those files contain no MCP imports and pass in isolation). M6-B passes this criterion when the full suite shows no failures beyond that baseline. Any new failure must be fixed before exit; fixing the baseline `EBUSY` failures is a separate, optional task and is not required for M6-B. Report the exact failure list and compare it to the baseline in the implementation report.
- No provider activation, Stage G, M6-C/D/E work, new runtime dependency, or new infrastructure.

## 10. Risks and implementation-time decisions

- **Catalog search SQL:** confirm the `LIKE` filter and keyset predicate against the actual Drizzle query API; keep it bounded and indexed. No full-catalog reads.
- **Event feed cursor semantics:** define the opaque cursor encoding for `readAfter` and the exact `snapshot-required` reasons; keep it consistent between the resource and the endpoint.
- **Cache hint values:** choose per-operation TTLs; default to `ttlMs: 0`, `cacheScope: "private"` unless data is provably stable/public.
- **Resource URI templates:** finalize exact template strings against `ResourceTemplate` syntax; keep them stable and documented.
- **STDIO on-demand endpoints:** they are loopback-guarded (`isLocalPeer`); STDIO is local so this is fine. Do not relax those guards for LAN MCP clients — HTTP uses direct services (M6_PLAN.md §8.1).

## 11. Reporting format for the implementation assignment

Report: what was implemented; exact files added/modified; dependency changes (expected: none); tests and actual results; parity evidence; acceptance-criteria checklist; remaining issues; exact `git status` and HEAD. Do not claim M6-C/D/E complete. No commit/push without separate authorization.
