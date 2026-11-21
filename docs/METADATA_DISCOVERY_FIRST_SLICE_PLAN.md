# First Slice — Backend-Driven WebUI Options (Implementation Plan)

> **Status:** Bounded implementation plan. **Documentation only — no application, test, contract, manifest or API change is made by this document.** Implementation requires separate authorization.
> **Governing:** [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) (AD-025), [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md) §4.1 (Option and Metadata Impact Assessment). This plan is the **bounded first milestone** of the cross-cutting initiative in [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §4.1 (Phases 1–3); later phases cover provider identity centralization, SSE events, derivative expiry discovery, capability extensibility and configuration correctness.
> **Last updated:** 2026-11-22.

## 0. Scope and non-goals

Three increments only: (1) MCP Activity tool-name selector, (2) reusable instrument search selector adopted by Subscription/Historical/Snapshot panels, (3) historical interval selector derived from the shared contract.

**Out of scope:** provider-registry redesign, expiry/derivative discovery, indicators, alerts, scanners, a universal JSON Schema form renderer, any new dependency, migration or runtime config change. These are later work. No M6-C/M6-D/E/B4 change; no physical LAN testing.

## 1. Verified technical findings (source evidence)

### 1.1 MCP tool descriptors — no public SDK accessor
- `packages/mcp-core/src/factory.ts:13–44` builds a fresh `McpServer` per request and calls `registerTools()` / `registerResources()` / `registerPrompts()`.
- `packages/mcp-core/src/tools.ts:49` registers nine tools by direct `server.registerTool(name, { description, inputSchema, annotations }, callback)` calls; annotation constants at `tools.ts:29–30`. There is **no exported descriptor array**; `registerTools()` returns `void`.
- Installed SDK `2.4.0`: `McpServer._registeredTools` is **private** (`mcp-BCJHyo7l.d.mts:3254`); the only descriptor-adjacent public method is `toolInputSchemaJson(name)`, marked `@internal` (`:3266`). **Relying on SDK internals is rejected.**
- SDK `ToolSchema` (`@modelcontextprotocol/core` schemas, L734–747) exposes `name`, `title`, `description`, `inputSchema`, `annotations`, `outputSchema`, `_meta`. There is **no `category` field** — a category, if wanted, must be added as safe display metadata in our own descriptor contract.
- Descriptors are currently observable only via MCP `tools/list` (e.g. `tests/mcp/tools.test.ts:54–74`, which asserts the nine names and annotations).

**Conclusion:** the only non-duplicating route is to **extract the tool descriptors into one shared module** in `packages/mcp-core` that `registerTools()` iterates and that a WebUI-facing read surface can also consume. Whether that read surface must be an HTTP endpoint is an open question (§2.1) — a build-time/shared-module import into the API is also possible if the WebUI can receive the data through an existing safe response. Do **not** create a second unrelated tool-name list.

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

## 2. Increment 1 — MCP Activity tool-name selector

**Verified behavior / files:** §1.1, §1.4. Tool names come from `tools.ts` registrations; the Activity filter is free text.

**Minimal files expected to change:**
- `packages/mcp-core/src/tool-descriptors.ts` (new) — single descriptor array/definition consumed by `registerTools()`.
- `packages/mcp-core/src/tools.ts` — iterate the shared descriptors instead of inline registration metadata.
- `packages/mcp-core/src/index.ts` — export the descriptor accessor.
- `packages/contracts/src/mcp-activity.ts` or a new small contract — Zod schema for the safe descriptor response (name, title/description, annotations, availability, optional category).
- `apps/api/src/mcp-routes.ts` or a new small read-only route module — expose descriptors (only if §2.1 validation confirms an endpoint is needed).
- `apps/web/src/lib/activity.ts` (or a new `lib/tool-descriptors.ts`) — typed fetch + Zod parse.
- `apps/web/src/components/ActivityPanel.tsx` — replace free-text tool input with a searchable selector; keep "Any tool" default.
- Tests: `tests/mcp/tools.test.ts`, `tests/web/activity-panel.test.tsx`, plus a new API test for the descriptor response.

**Approach / data flow:** define descriptors once → `registerTools()` consumes them for MCP registration → the same array feeds a read-only response → WebUI fetches and parses with the shared contract → selector options. Adding a tool in `tools.ts` changes one place.

**Tests to add/update:** assert descriptor list equals `tools/list` names/annotations; assert a newly added descriptor appears without a frontend edit; assert selector renders "Any tool" plus descriptor names; assert loading/empty/error states; assert no secrets in the response.

**Acceptance criteria:** new registered tool appears in the selector without a frontend options-list edit; descriptors match actual MCP registrations; existing Activity filtering/pagination/detail tests remain green.

**Risks / unresolved:** (a) whether an HTTP endpoint is necessary vs. a shared module import into the API (§2.1); (b) descriptor response must not expose internal schemas or config; (c) `category` is not an SDK field — decide whether to add it or omit it.

### 2.1 Technical question to resolve first
Validate whether the WebUI can receive descriptors without a new endpoint. Options: (i) a small read-only Hono route returning the shared descriptor array (recommended if the WebUI needs runtime data); (ii) a shared module imported by the API and embedded in an existing safe response. Do not use `McpServer` private fields or `@internal` methods. Record the decision with evidence before implementing.

## 3. Increment 2 — Reusable instrument search selector

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

## 4. Increment 3 — Historical interval selector from shared contract

**Verified behavior / files:** §1.3.

**Minimal files expected to change:**
- `HistoricalPanel.tsx` — remove local `INTERVALS`; derive options from `candleIntervalSchema.options` (or an exported helper in `@markethub/contracts`).
- Tests: `tests/web/historical.test.ts` — assert the select offers all 16 contract intervals and that a focus value such as `30m` has a matching option.

**Approach / data flow:** direct import from `@markethub/contracts`; no HTTP request, no metadata endpoint. A contract change reaches the UI at build time.

**Acceptance criteria:** no duplicate interval literal list in React; all 16 contract intervals selectable; activity focus values always have a matching option; existing historical tests green.

**Risks / unresolved:** none material — this is a direct contract consumption with no new API.

## 5. Cross-cutting acceptance and sequencing

- Sequence: Increment 3 first (lowest risk, proves direct contract consumption), then Increment 2 (reusable component), then Increment 1 (requires the §2.1 decision). Or run 1's validation in parallel with 2/3 implementation.
- Every increment must include the Option and Metadata Impact Assessment (PROJECT_MANAGER_PROTOCOL.md §4.1) in its assignment.
- Validation for each: focused tests, `bun run typecheck`, `bun run build`, `bun test`, `git diff --check`, independent diff review.
- No milestone declared complete by this plan; no M6 scope change.
