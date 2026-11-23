# First Slice — Backend-Driven WebUI Options (Implementation Plan)

> **Status:** Bounded implementation plan — **all three increments implemented, tested and published on `develop`** (increment 3 = Phase 1 + interval selector; increment 2 = Phase 3 WP 3b–3c instrument picker; increment 1 = Phase 2 WP 2a–2c operation selector). This document is now a historical implementation record as well as the original plan. It did not itself authorize implementation; that required separate authorization.
> **Governing:** [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) (AD-025), [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md) §4.1 (Option and Metadata Impact Assessment). This plan is the **bounded first milestone** of the cross-cutting initiative in [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §4.1 (Phases 1–3); all three increments are complete and published. Phase 5 (provider status and capability rendering) is also complete and published; derivative expiry discovery (Phase 4) and cross-system acceptance (Phase 7) remain separately gated; Phase 6 WP6A (retention consistency) and WP6B (snapshot provider selection) are implemented, audited KEEP and published on `develop`, while WP6C (Overview accuracy) remains pending, so Phase 6 is not complete.
> **Last updated:** 2026-11-22 (operation scope reconciled to all 19 MCP operations; sequence aligned with roadmap; first milestone narrowed to the interval selector).

## 0. Scope and non-goals

Three increments only: (1) MCP Activity **operation** selector covering all activity-producing operations (tools, resources and prompts), (2) reusable instrument search selector adopted by Subscription/Historical/Snapshot panels, (3) historical interval selector derived from the shared contract. All three are now **implemented and published on `develop`**; the implementation order was increment 3 → increment 2 → increment 1.

**Out of scope:** provider-registry redesign, expiry/derivative discovery, indicators, alerts, scanners, a universal JSON Schema form renderer, any new dependency, migration or runtime config change. These are later work. No M6-C/M6-D/E/B4 change; no physical LAN testing.

## 1. Verified technical findings (source evidence)

> These are the **baseline findings at plan-writing time** that motivated the increments. Several gaps listed here have since been closed by the completed implementation; the resolution is noted where applicable.

### 1.1 MCP operation descriptors — no public SDK accessor
- `packages/mcp-core/src/factory.ts:13–44` builds a fresh `McpServer` per request and calls `registerTools()` / `registerResources()` / `registerPrompts()`.
- At baseline, registrations were inline and returned `void`: nine tools (`tools.ts:49+`), seven resource registrations / six logical resources (`resources.ts:75+`), three prompts (`prompts.ts:18+`), with **no exported descriptor array**. Phase 2 WP 2a since added `mcp-core/src/operation-descriptors.ts`, consumed by all three registration functions.
- All **19 operations** produce activity through the shared `withActivity()` mechanism using the same `toolName` field (`tools.ts:33–42`, `resources.ts:57–67`, `prompts.ts:7–16` → `activity.ts:168–227`). Activity contracts and filters expose `toolName` only (`mcp-activity.ts:94,143,169`); there is **no persisted `operationType` field or operation-type API filter**.
- Installed SDK `2.4.0`: `McpServer._registeredTools` is **private** (`mcp-BCJHyo7l.d.mts:3254`); the only descriptor-adjacent public method is `toolInputSchemaJson(name)`, marked `@internal` (`:3266`). **Relying on SDK internals is rejected.**
- SDK `ToolSchema` (`@modelcontextprotocol/core` schemas, L734–747) exposes `name`, `title`, `description`, `inputSchema`, `annotations`, `outputSchema`, `_meta`. There is **no `category` field** — category is optional MarketHub-owned display metadata, not SDK-supplied. Browser-facing input JSON Schema is **not promised**: a supported derivation path without SDK internals has not been identified.
- At baseline, descriptors were observable only via MCP protocol list methods (`tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`; e.g. `tests/mcp/tools.test.ts:54–74`) — protocol surfaces, not a WebUI metadata contract. Phase 2 WP 2b added the read-only `GET /api/mcp/operations` endpoint with a strict shared contract.

**Conclusion:** the only non-duplicating route is to **extract operation descriptors into one shared module** in `packages/mcp-core` that all three registration functions consume and that a WebUI-facing read surface can also consume. The §2.1 question was resolved in favor of a dedicated read-only `GET /api/mcp/operations` endpoint (implemented in Phase 2). Do **not** create a second unrelated operation-name list.

### 1.2 Catalog search already exists
- `apps/api/src/catalog-routes.ts:25–55`: `GET /api/catalog/search` with `text` (required, non-empty), `limit` (1–100, default 25), `cursor`; response `{ instruments, nextCursor }`; read-only, no `isLocalPeer` guard.
- `packages/contracts/src/market.ts:113–136`: `canonicalInstrumentSchema` provides `canonicalId`, `canonicalSymbol`, `displayName`, `exchange`, `segment`, `marketType`, `instrumentCategory`, `derivative`, etc. — enough for a search result label and value.
- WebUI never calls this endpoint. Manual canonical-ID inputs: `SubscriptionPanel.tsx:84–91`, `HistoricalPanel.tsx:181`, `SnapshotPanel.tsx:105`.
- WebUI client pattern: `apps/web/src/lib/activity.ts:40–54` builds `URLSearchParams`, fetches, parses with a shared Zod schema, and throws a typed `HttpError` classified by status. Reuse this pattern.

### 1.3 Shared interval schema is directly importable
- `packages/contracts/src/historical.ts:7–11`: `candleIntervalSchema` has 16 values; `apps/web/package.json:13` already depends on `@markethub/contracts`.
- `HistoricalPanel.tsx:12` duplicates a 7-value `INTERVALS` array; `HistoricalPanel.tsx:182–184` renders it. `historicalFocusToForm` (`:38–49`) already validates with `candleIntervalSchema.safeParse`, so an activity focus value like `30m` can be set in state but has no matching `<option>` — a concrete bug the increment fixes.
- `tests/web/historical.test.ts:144–147` already asserts contract-based interval validation.

### 1.4 Activity panel structure
- `ActivityPanel.tsx` separates a pure `ActivityPanelView` (`:97`) from a data-loading container; tests call the view directly with `renderToStaticMarkup` (`tests/web/activity-panel.test.tsx:27–31`). Tool-name filter is a free-text input at `ActivityPanel.tsx:132`; transport/status options hardcoded at `:133–140`.
- Activity contracts: `packages/contracts/src/mcp-activity.ts:6,10` (`mcpActivityStatusSchema`, `mcpActivityTransportSchema`); routes `apps/api/src/mcp-activity-routes.ts` expose list/by-operation endpoints only.

## 2. Increment 1 — MCP Activity operation selector — IMPLEMENTED (Phase 2 WP 2a–2c)

**Verified behavior / files:** §1.1, §1.4. All 19 operations (tools, resources, prompts) produce activity under `toolName`; the Activity filter is free text.

**Minimal files expected to change:**
- `packages/mcp-core/src/operation-descriptors.ts` (new) — single descriptor array/definition consumed by `registerTools()`, `registerResources()` and `registerPrompts()`; each descriptor carries stable operation name, operation type (`tool|resource|prompt`), title/description, availability where grounded, and optional MarketHub-owned display metadata.
- `packages/mcp-core/src/{tools,resources,prompts}.ts` — iterate the shared descriptors instead of inline registration metadata.
- `packages/mcp-core/src/index.ts` — export the descriptor accessor.
- `packages/contracts/src/mcp-activity.ts` or a new small contract — Zod schema for the safe descriptor response.
- `apps/api/src/mcp-routes.ts` or a new small read-only route module — expose descriptors (only if §2.1 validation confirms an endpoint is needed).
- `apps/web/src/lib/activity.ts` (or a new `lib/operation-descriptors.ts`) — typed fetch + Zod parse.
- `apps/web/src/components/ActivityPanel.tsx` — replace free-text tool input with a searchable **Operation name** selector; keep "Any operation" default.
- Tests: `tests/mcp/tools.test.ts`, `tests/mcp/resources.test.ts`, `tests/mcp/prompts.test.ts`, `tests/web/activity-panel.test.tsx`, plus a new API test for the descriptor response.

**Approach / data flow:** define descriptors once → all three registration functions consume them for MCP registration → the same array feeds a read-only response → WebUI fetches and parses with the shared contract → selector options. Descriptors distinguish tool/resource/prompt for display. **Keep the existing `toolName` storage and filter contract for this increment** — do not add a database migration or API filter for `operationType` without a demonstrated requirement. Operation-type filtering needs additional API/data design and is explicitly deferred.

**Descriptor scope for this increment:** the selector needs only stable operation name, operation type (from the owning registration) and display title/description. Annotations, availability and optional display metadata are **not required** for the selector and are deferred. **Category is not an SDK field** (`ToolSchema` has no `category`); it may be optional MarketHub-owned presentation metadata but is not added for decoration. **Input JSON Schema / schema-informed forms are a separate future concern** — expose input metadata only if it can be safely derived from the same registration definitions without SDK internals; no such path is established, and no universal form generator is required.

**Tests to add/update:** assert descriptor list matches the actual MCP registrations across `tools/list`, `resources/list`, `resources/templates/list` and `prompts/list`; assert operation type is derived from the descriptor, not a second list; assert a newly registered operation appears without a frontend edit; assert selector renders "Any operation" plus descriptor names; assert loading/empty/error states; assert no secrets in the response.

**Acceptance criteria:** a newly registered operation (tool, resource or prompt) appears in the selector without a frontend options-list edit; descriptors match actual MCP registrations; existing Activity filtering/pagination/detail tests remain green.

**Risks / resolution:** (a) resolved — a dedicated read-only endpoint was implemented (§2.1); (b) enforced — the response exposes only `name`/`type`/`title?`/`description` via a strict contract; (c) `category` remains deferred (not an SDK field); (d) operation-type filtering remains deferred — it needs API/data design beyond the `toolName` contract.

### 2.1 Technical question — RESOLVED
The WebUI cannot import server-side `mcp-core` (MCP SDK bound), so option (i) was selected: a small read-only Hono route `GET /api/mcp/operations` returning the shared descriptor array, validated by a strict shared contract. Implemented in Phase 2 WP 2b. No `McpServer` private fields or `@internal` methods were used.

## 3. Increment 2 — Reusable instrument search selector — IMPLEMENTED (Phase 3 WP 3b–3c)

**Verified behavior / files:** §1.2. `GET /api/catalog/search` is bounded/paginated; three panels use manual IDs.

**Minimal files expected to change:**
- `apps/web/src/lib/catalog.ts` (new) — typed `searchInstruments({ text, limit, cursor })` client using the existing fetch/Zod/error pattern; parse with `canonicalInstrumentSchema` (or a bounded list schema).
- `apps/web/src/components/InstrumentPicker.tsx` (new) — reusable searchable selector with value = `canonicalId`, label = `displayName`/`canonicalSymbol` + exchange.
- `SubscriptionPanel.tsx`, `HistoricalPanel.tsx`, `SnapshotPanel.tsx` — replace manual ID inputs with the picker; keep existing submit/config behavior unchanged.
- Tests: new `tests/web/instrument-picker.test.ts` (pure view rendering), updates to `tests/web/subscriptions.test.ts`, `tests/web/historical.test.ts`, `tests/web/snapshots.test.ts`.

**Approach / data flow:** user types → debounced query (e.g. 250–300 ms) → `AbortController` cancels stale requests → results rendered as options → selection sets `canonicalId` in existing state. `limit` bounded (≤100); `nextCursor` drives "load more" only if needed. No expiry or derivative data is invented — Snapshot expiry stays a manual field until an authoritative source exists.

**Tests to add/update:** query building and cancellation; loading/empty/error/no-results states; selection sets the canonical ID; each panel still submits the same request shape; pagination bounded.

**Acceptance criteria:** catalog results populate selectors in all three panels; no manual canonical-ID typing required; bounded/paginated behavior; stale requests cancelled; existing panel tests green.

**Risks / unresolved:** debounce/cancellation behavior in a no-DOM test environment (use pure helpers + `renderToStaticMarkup` as existing tests do); whether "load more" is needed for the first slice or a single bounded page suffices.

## 4. Increment 3 — Historical interval selector from shared contract — IMPLEMENTED (Phase 1 + Phase 3 WP 3a)

**Verified behavior / files:** §1.3.

**Minimal files expected to change:**
- `HistoricalPanel.tsx` — remove local `INTERVALS`; derive options from `candleIntervalSchema.options` (or an exported helper in `@markethub/contracts`).
- Tests: `tests/web/historical.test.ts` — assert the select offers all 16 contract intervals and that a focus value such as `30m` has a matching option.

**Approach / data flow:** direct import from `@markethub/contracts`; no HTTP request, no metadata endpoint. A contract change reaches the UI at build time.

**Acceptance criteria:** no duplicate interval literal list in React; all 16 contract intervals selectable; activity focus values always have a matching option; existing historical tests green.

**Risks / unresolved:** none material — this is a direct contract consumption with no new API.

## 5. Cross-cutting acceptance and sequencing

- Sequence (matches [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §4.1), all completed: **increment 3** (shared-contract centralization + historical interval selector, lowest risk, proved direct contract consumption) → **increment 2** (reusable instrument picker using the existing catalog API) → **increment 1** (MCP operation selector, after the §2.1 descriptor-delivery decision). All three are implemented and published on `develop`.
- Every increment must include the Option and Metadata Impact Assessment (PROJECT_MANAGER_PROTOCOL.md §4.1) in its assignment.
- Validation for each: focused tests, `bun run typecheck`, `bun run build`, `bun test`, `git diff --check`, independent diff review.
- No milestone declared complete by this plan; no M6 scope change.
