# Backend-Driven Metadata & Capability Discovery — Detailed Implementation Plan

> **Status:** Planning document plus implementation record. **Documentation only — no application, test, contract, API, migration or configuration change is made by this document.** Every phase requires separate implementation authorization. Phase 1, Phase 3 WP 3a, Phase 3 WP 3b–3c, Phase 2 WP 2a–2c and Phase 5 WP 5A/5B/5C.1/5C.2 have been implemented, tested and published on `develop` (close-outs in the respective Phase 2/3/5 plan §12); Phases 4, 6 and 7 remain planned.
> **Governing:** [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) (AD-025, source-verified inventory §10), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §4.1 (phase table), [METADATA_DISCOVERY_FIRST_SLICE_PLAN.md](METADATA_DISCOVERY_FIRST_SLICE_PLAN.md) (bounded first slice), [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md) §4.1 (Option and Metadata Impact Assessment).
> **Last updated:** 2026-11-22.

## 0. How to read this plan

- **Phase numbers are architectural groupings, not implementation order.** The canonical increment order is defined in §1 and matches the roadmap and first-slice plan. Phase 2 is **not** the second implementation task.
- **Architecture areas A–J** are the source-verified centralization inventory in [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) §10. The coverage matrix in §10 of this plan maps every area to a phase.
- **"Planned" means not implemented.** Phase 1, Phase 3 WP 3a/WP 3b–3c, Phase 2 WP 2a–2c and Phase 5 WP 5A/5B/5C.1/5C.2 are now implemented and published on `develop`; the descriptor module, read-only metadata endpoint and provider/capability rendering exist. No universal registry or metadata database exists.
- **Endpoint decision resolved.** Phase 2 WP 2b selected a dedicated read-only `GET /api/mcp/operations` endpoint (the WebUI cannot import server-side `mcp-core`); no HTTP endpoint is a prerequisite for shared contract values, which remain direct contract imports.
- **Boundaries:** no M6-C/M6-D/E/B4 ownership change, no physical LAN testing, no universal registry/metadata database/microservice/generic form framework, no dynamic provider claim before contract/registry support, no hardcoded expiry or computed contracts.

## 1. Dependency graph and canonical implementation order

| Phase | Architectural concern | Depends on | Blocks | Implementation order |
|---|---|---|---|---|
| 0 | Architecture & contract design | Inventory (done) | 1, 2 | Design only; partially done |
| 1 | Shared contract consistency | 0 | 2, 3, 5 | **1st** (with Phase 3 WP 3a) |
| 2 | Runtime capability discovery | 0 decision, 1 types | 5, 7 | **3rd** — implemented and published on `develop` |
| 3 | Instrument discovery UX | 1 shared types, existing catalog API | 4, 6, 7 | **1st (3a) / 2nd (3b–3c)** — both implemented and published on `develop` |
| 4 | Derivative domain discovery | Populated catalog + bounded query (absent) | 7 | Deferred — blocked |
| 5 | Provider & capability extensibility | 1 identity, 2 descriptor pattern | 7 | **Implemented and published on `develop`** |
| 6 | Configuration & correctness | 1–3 | 7 | Later |
| 7 | Cross-system acceptance | All prior | — | Final |

**Canonical increment order (authoritative):**
1. **First implementation milestone** — Phase 1 shared-contract consistency + Phase 3 WP 3a (historical interval selector from `candleIntervalSchema`).
2. Phase 3 WP 3b–3c — reusable instrument picker using existing `GET /api/catalog/search` — **implemented, tested and published on `develop`** (see [METADATA_DISCOVERY_PHASE_3_PLAN.md](METADATA_DISCOVERY_PHASE_3_PLAN.md) §12).
3. Phase 2 — MCP Activity Operation selector, after the descriptor-delivery decision (WP 2b) — **implemented, tested and published on `develop`** (see [METADATA_DISCOVERY_PHASE_2_PLAN.md](METADATA_DISCOVERY_PHASE_2_PLAN.md) §12).
4. Phase 4 (blocked on catalog population) and Phase 6 as their prerequisites clear; Phase 7 last. Phase 5 is complete and published.

## 2. Phase 0 — Architecture & contract design

**Objective:** finish the dependency-safe designs that later phases implement.

**Status:** documentation/protocol and read-only inventory are **done** ([architecture doc](METADATA_AND_CAPABILITY_DISCOVERY.md) §6, §10). Remaining work is design validation only.

**Work packages (historical Phase 0 design decisions — the decisions below were made and implemented in Phases 1, 2 and 5; see §12 status):**
- **0a — Provider identity leaf module.** Decide the dependency-light module in `@markethub/contracts` holding the value schema with no value imports from `live.ts`/`market.ts`/`provider.ts`; preserve `providerIdSchema`/`ProviderId`/`providerSchema` exports; document the `live.ts:12` cycle-avoidance exception if retained.
- **0b — SSE event contract.** Decide one `as const` tuple (`LIVE_EVENT_NAMES`) including `snapshot` as transport-only; no Zod `.options`/`.shape` reflection; preserve wire behavior.
- **0c — Provider-status response.** Decide an iterable, schema-validated response shape replacing fixed-key access and the WebUI raw cast.
- **0d — Operation descriptor model.** Minimum fields (operation name, type, title/description) vs optional future metadata (annotations, availability, category, input schema). Category is MarketHub-owned, not SDK-supplied; input JSON Schema is a separate unproven concern.
- **0e — Discovery boundary.** Decide endpoint vs shared-module delivery; record evidence.

**Files:** design records only — architecture doc, AD-025, open questions. **No source files.**

**Exit criteria:** all five decisions recorded with source evidence; no unresolved dependency-direction question; endpoint decision explicitly open or resolved with evidence.

**Risks:** leaf-module import direction; `snapshot` has no payload schema; endpoint necessity.

## 3. Phase 1 — Shared contract consistency

**Objective:** one owning definition per shared value, preserving public exports and behavior.

**Prerequisites:** Phase 0 decisions. **Implementation order:** 1st.

**Work packages:**
- **1a — Provider identity (area A).** Add leaf identity module; re-export from `packages/contracts/src/index.ts`; replace inline `z.enum(["UPSTOX","FYERS"])` in `market.ts:32`, `live-components.ts:191`, `historical.ts:53,78,136,175`, `snapshots.ts:83,110,124` and the private `live.ts:12` schema with the shared leaf schema (the leaf module has no value imports from `provider.ts`/`live.ts`/`market.ts`, so no cycle remains). In WebUI `lib/status.ts:34`, replace the duplicate `ProviderStatusView.id` union with the shared `ProviderId` type — **type-only in Phase 1**; do not validate the full provider-status response or change the fixed-key `providers` shape (`:46`). Response validation, fixed-key rendering (`App.tsx:133–134`), provider enumeration and extensibility are **Phase 5** (see architecture doc §10.A).
- **1b — CE/PE and transport enums (area C).** Use `optionTypeSchema`/`OptionType` (`market.ts:29–30`) in `snapshots.ts:20,51` and `market-core/src/identity.ts:67`; use `mcpActivityTransportSchema` (`mcp-activity.ts:10`) in `mcp-core/src/activity.ts:9` and WebUI `ActivityPanel.tsx:81,134`. Keep DB SQL CHECKs (`database/src/schema.ts:97,397`) and adapter-native mappings literal.
- **1c — SSE event names (area B).** Export `LIVE_EVENT_NAMES` from contracts; type `OutboundEvent.event` (`realtime/src/types.ts:4`, currently `string`); replace `SSE_EVENT_NAMES` (`web/src/lib/live-stream.ts:23–30`) and the duplicated test list (`tests/web/live-stream.test.ts:134–137`); use named constants for hub control literals (`hub.ts:103,121,124,152,153,245,278`) and API `market-routes.ts:84–85`. Also update WebUI `lib/live.ts`: derive `LiveControlEventName` from `LIVE_EVENT.snapshotRequired`/`LIVE_EVENT.refresh` for the `control` field (`:55`) and use the constants in the `parseSseMessage()` return values (`:73`,`:76`) — type/constant substitution only, preserving parsing and recovery behavior.
- **1d — Activity filter options (area C).** Derive transport/status options in `ActivityPanel.tsx:134,138–139` from `mcpActivityTransportSchema`/`mcpActivityStatusSchema`; keep per-status tone mapping (`:26–31`) local.
- **1e — Retention classes (area C, lower priority).** Optionally iterate `retentionDataClassSchema` (`snapshots.ts:140`) keys; keep per-class labels local; preserve fail-closed cleanup (`historical-routes.ts:39–61`).

**Expected files:** `packages/contracts/src/provider-identity.ts` (new leaf module), `packages/contracts/src/{provider,market,live,live-components,historical,snapshots,mcp-activity,index}.ts`, `packages/mcp-core/src/activity.ts`, `packages/realtime/src/{types,hub}.ts`, `apps/api/src/market-routes.ts`, `apps/web/src/{lib/status.ts,lib/live.ts,lib/live-stream.ts,components/ActivityPanel.tsx}`, related tests.

**Tests:** one shared provider identity definition; SSE name consistency across hub/API/WebUI; CE/PE and HTTP/STDIO parity; existing suites green.

**Acceptance:** no redundant provider enum without documented exception; no duplicated event-name list; public exports preserved; no behavior change.

**Risks:** circular imports; export compatibility; DB SQL literals must stay.

## 4. Phase 2 — Runtime capability discovery — IMPLEMENTED (WP 2a–2c; published on `develop`)

**Objective:** operation descriptors derived from actual registrations; Activity Operation selector.

**Prerequisites:** Phase 0 decision (0d, 0e), Phase 1 types. **Implementation order:** 3rd.

**Work packages:**
- **2a — Descriptor source (area D).** New `packages/mcp-core/src/operation-descriptors.ts` consumed by `registerTools()`/`registerResources()`/`registerPrompts()`; minimum fields only (stable name, type `tool|resource|prompt`, title/description). Export via `mcp-core/src/index.ts`. No SDK internals (`_registeredTools` private, `toolInputSchemaJson` `@internal`). No second list.
- **2b — Delivery decision.** Implement the Phase 0 choice: read-only Hono route with validated contract **or** shared-module import into an existing safe response. Record evidence. No endpoint for shared enum values.
- **2c — Activity Operation selector.** Replace free-text filter (`ActivityPanel.tsx:132`) with searchable Operation name selector; "Any operation" default; operation type from descriptor. **Keep `toolName` storage/API contract** — no migration or `operationType` filter. Type filtering deferred.

**Expected files:** `mcp-core/src/{operation-descriptors.ts,tools.ts,resources.ts,prompts.ts,index.ts}`, a small read-only API module (if justified), `web/src/lib/activity.ts` (or `lib/operation-descriptors.ts`), `ActivityPanel.tsx`, tests (`tests/mcp/tools.test.ts`, `resources.test.ts`, `prompts.test.ts`, `tests/web/activity-panel.test.tsx`, new API test).

**Tests:** descriptor parity with `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`; newly registered operation visible without frontend edit; selector states; no secrets.

**Acceptance:** 19 operations discoverable; no second list; existing Activity tests green; no SDK internals.

**Risks:** endpoint necessity; category not an SDK field; no-DOM test approach; operation-type filtering deferred.

## 5. Phase 3 — Instrument discovery UX — IMPLEMENTED (WP 3a, 3b–3c; published on `develop`)

**Objective:** reusable searchable instrument selector; interval selector from shared contract.

**Prerequisites:** Phase 1 shared types; existing bounded `GET /api/catalog/search`. **Implementation order:** 1st (3a) / 2nd (3b–3c).

**Work packages:**
- **3a — Historical interval selector (area C, first milestone).** Remove `HistoricalPanel.tsx:12` local `INTERVALS`; derive from `candleIntervalSchema.options` (`contracts/src/historical.ts:7–11`, 16 values). Fix the `30m` focus-value mismatch (`historicalFocusToForm` at `:38–49`). No API.
- **3b — Catalog client + picker (area E).** New `web/src/lib/catalog.ts` (typed fetch, Zod parse, typed error, reuse `lib/activity.ts:40–54` pattern) and `web/src/components/InstrumentPicker.tsx` (value `canonicalId`, label `displayName`/`canonicalSymbol` + exchange). Debounce, `AbortController` cancellation, bounded `limit` ≤100, optional cursor. No faceted filters without repository support; no full-catalogue download.
- **3c — Panel adoption.** Replace manual IDs in `SubscriptionPanel.tsx:84–91`, `HistoricalPanel.tsx:181`, `SnapshotPanel.tsx:105`; keep existing submit/config request shapes unchanged. Snapshot expiry stays manual (no authoritative source).

**Expected files:** `HistoricalPanel.tsx`, `web/src/lib/catalog.ts` (new), `web/src/components/InstrumentPicker.tsx` (new), three panels, tests (`tests/web/historical.test.ts`, `subscriptions.test.ts`, `snapshots.test.ts`, new `instrument-picker.test.ts`).

**Tests:** all 16 intervals selectable; focus value `30m` has a matching option; catalog results populate selectors; bounded pagination; debounce/cancellation; panel request shapes unchanged.

**Acceptance:** no duplicate interval list; no manual canonical-ID typing; bounded/paginated behavior; existing panel tests green.

**Risks:** faceted filters need repo/API extension; bounded Load More pagination is implemented (single-flight, 100-result cap); no-DOM test approach.

## 6. Phase 4 — Derivative domain discovery

**Objective:** expiry read API from real derivative records.

**Prerequisites:** a populated catalog and a bounded query — **currently absent** (DB has 0 rows; `findDerivativeContracts` uses unbounded `q.all()` at `database/src/repositories/catalog.ts:313`; no production sync). **Implementation order:** deferred/blocked.

**Work packages:**
- **4a — Unblock data.** Establish an authoritative population path (catalog sync or verified source). No weekday-derived expiries, no hardcoded dates.
- **4b — Bounded query.** Add limit/order/cursor to `findDerivativeContracts` (`market-core/src/types.ts:52`, `catalog.ts:307–315`).
- **4c — Read API.** New read-only expiry endpoint from real records; contract availability/filtering; strikes/exact contracts only where data supports them.
- **4d — WebUI expiry selector.** Replace manual `SnapshotPanel.tsx:106` expiry field when authoritative data exists; honest empty/unavailable state until then.

**Expected files:** `market-core` repository/service, new read-only API module, `SnapshotPanel.tsx`, tests.

**Tests:** expiry options from real records; bounded query; honest empty/unavailable state.

**Acceptance:** no invented expiry data; bounded responses; no speculative strikes.

**Risks:** DB empty; unbounded query; no population path; authoritative data unverified. **Do not start this phase until prerequisites clear.**

## 7. Phase 5 — Provider & capability extensibility — IMPLEMENTED (WP 5A/5B/5C.1/5C.2; published on `develop`)

**Objective:** enumerable provider status and honest capability rendering.

**Prerequisites:** Phase 1 identity, Phase 2 descriptor pattern. **Implementation order:** later.

**Work packages:**
- **5a — Enumerable provider status (area A/G).** Iterable validated response replacing fixed-key access (`App.tsx:133–134`, `lib/status.ts:33–49`); keep `UPSTOX`/`FYERS` fixed until contract/registry extended.
- **5b — Capability rendering (area G).** Surface `capabilities`/`limits` from `providerStatusSchema` (`provider.ts:135–153`) into WebUI; distinguish SUPPORTED/LIMITED/UNSUPPORTED/UNAVAILABLE and `entitlementUnverified`; keep `API` vs `DOCUMENTATION` source distinction (`provider.ts:78`). No frontend hardcoded capability list.
- **5c — Custom auth workflows retained.** No universal credential-form renderer.

**Expected files:** `contracts/src/provider.ts`, `market-core/src/provider.ts`, `api/src/provider-routes.ts`, `web/src/lib/status.ts`, `App.tsx`, tests.

**Tests:** WebUI iterates validated provider status; capability states honest; no hardcoded capability list.

**Acceptance:** no dynamic extensibility claim before contract/registry support; entitlements distinct from published docs.

**Risks / resolution:** fixed provider contract retained (no dynamic extensibility claim); three capability vocabularies kept strictly separate; all provider-wide and runtime capability metadata now rendered honestly in the WebUI. See [METADATA_DISCOVERY_PHASE_5_PLAN.md](METADATA_DISCOVERY_PHASE_5_PLAN.md) §4 for per-package completion evidence.

## 8. Phase 6 — Configuration & correctness

**Objective:** retention consistency, snapshot provider semantics, accurate overview text.

**Prerequisites:** Phases 1–3. **Implementation order:** later.

**Work packages:**
- **6a — Retention controls (area H).** Preserve `retentionDataClassSchema` validation and fail-closed cleanup; keep small presentation mapping.
- **6b — Snapshot provider semantics (area I).** Resolve automatic vs explicit preference: explicit = exclusive filter no fallback (`snapshots/service.ts:139–141`); omitted = try configured providers in order (`:143–167`). Decide whether UI offers "automatic/default". Do not silently change service ordering or invent fallback.
- **6c — Overview status text (area J).** Correct four stale statements in `App.tsx:211,219,281,282` distinguishing implemented foundation, implemented-but-locked, unavailable provider-backed/live, and genuinely planned.

**Expected files:** `HistoricalPanel.tsx`, `SnapshotPanel.tsx`, `App.tsx`, related contracts/routes, tests.

**Tests:** retention validation preserved; snapshot provider semantics tested; stale text corrected.

**Acceptance:** no silent service-order change; no invented fallback; honest status messaging.

**Risks:** explicit vs omitted semantics unresolved; presentation-only mapping boundary.

## 9. Phase 7 — Cross-system acceptance

**Objective:** prove source-to-consumer consistency and forward compatibility.

**Prerequisites:** all prior phases. **Implementation order:** final.

**Acceptance scenarios:**
- new MCP operation discoverable without frontend list edit;
- new shared enum value available via shared contracts without duplicated frontend maintenance;
- new provider follows documented backend contract/registry extension process;
- catalog results populate all intended selectors with bounded pagination;
- metadata responses contain no credentials/secrets;
- unavailable capabilities never presented as available;
- backend validation and permission enforcement remain authoritative;
- existing API compatibility and persisted-data behavior correct.

**Tests:** cross-package tests across contracts, API, MCP, WebUI; no new production behavior.

**Risks:** full cross-package test coordination.

## 10. Architecture area coverage matrix

| Area | Phase(s) | Work package |
|---|---|---|
| A — Provider identity | 0, 1, 5 | 0a, 1a, 5a |
| B — SSE event definitions | 0, 1 | 0b, 1c |
| C — Duplicated contract values | 1, 3 | 1b, 1d, 1e, 3a |
| D — MCP operation discovery | 0, 2 | 0d, 0e, 2a–2c |
| E — Catalog/instrument discovery | 3 | 3b, 3c |
| F — Derivative expiry | 4 | 4a–4d |
| G — Provider capability metadata | 5 | 5a, 5b |
| H — User-managed configuration | 6 | 6a |
| I — Snapshot provider selection | 6 | 6b |
| J — WebUI status accuracy | 6 | 6c |

Every area A–J is covered; no area is orphaned.

## 11. Test strategy summary

Three consistency paths (from [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md) §7.1): direct shared-contract→WebUI; backend-registration→metadata-surface→WebUI (only if justified); domain-search-API→WebUI. Tests must verify real ownership relationships, not file/constant existence. No tests are added in this planning document.

## 12. Audit of this plan

An audit was performed against the governing documents and actual source. Results:

| Check | Result |
|---|---|
| Phase numbers vs implementation order | **Pass** — §1 and roadmap §4.1 both state Phase 2 ≠ second task; canonical order explicit |
| All 19 operations covered | **Pass** — 9 tools + 7 resource registrations + 3 prompts verified against `tools.ts`, `resources.ts`, `prompts.ts` |
| `toolName` compatibility preserved | **Pass** — WP 2c keeps storage/filter contract; no migration; type filtering deferred |
| Category / input-schema treatment | **Pass** — WP 0d/2a treat category as optional MarketHub metadata; input JSON Schema separate and unproven |
| Endpoint decision resolved | **Pass** — WP 0e/2b selected a dedicated read-only `GET /api/mcp/operations` endpoint for registered MCP descriptors (implemented in Phase 2); shared contract enum values continue to be imported directly from `@markethub/contracts`, not fetched over HTTP |
| Ownership model unchanged | **Pass** — five categories preserved; no universal registry/DB/microservice/form framework |
| Provider identity fixed | **Pass** — WP 5a keeps UPSTOX/FYERS until contract/registry extended |
| Catalog search bounded | **Pass** — WP 3b uses existing bounded API; no full-catalogue download |
| Derivative expiry blocked | **Pass** — Phase 4 explicitly deferred on populated data + bounded query |
| M6 scope / LAN untouched | **Pass** — no M6 ownership change; no physical LAN testing |
| Proposed vs implemented | **Pass** — Phase 1, Phase 3 WP 3a/WP 3b–3c, Phase 2 WP 2a–2c and Phase 5 WP 5A/5B/5C.1/5C.2 are marked implemented/published; Phases 4, 6 and 7 remain planned |
| Area coverage A–J | **Pass** — §10 matrix covers all ten areas |
| Dependencies acyclic | **Pass** — §1 graph has no cycles; Phase 4 blocked, not looping |
| File paths plausible | **Pass** — all paths match source verified in architecture doc §10 |

**Findings requiring attention during implementation (not plan defects):**
1. Phase 4 cannot start until a catalog population path and bounded query exist — treat as a hard gate, not a scheduling preference.
2. Phase 2 WP 2b recorded its evidence and selected a dedicated read-only endpoint; it is now implemented and published.
3. Phase 6 WP 6b needs a product decision on automatic vs explicit provider preference before code changes.
4. No-DOM test approach for debounce/cancellation must be validated in Phase 3 (pure helpers + `renderToStaticMarkup` pattern already used in `tests/web/`).

**Audit verdict:** the plan is internally consistent, covers all architecture areas, respects all documented boundaries, and is ready for per-phase authorization. No contradictions found.
