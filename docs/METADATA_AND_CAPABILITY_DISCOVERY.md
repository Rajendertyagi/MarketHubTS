# Backend-Driven Metadata and Capability Discovery

> **Status:** Authoritative architecture requirement (owner-approved). **Documentation only — no metadata API, registry, WebUI component or application change is implemented by this document.** Implementation requires separate authorization.
> **Decision:** [AD-025](ARCHITECTURE_DECISIONS.md) (backend/domain-owned metadata is authoritative).
> **Governing:** [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md), [WEBUI_AND_CONFIGURATION.md](WEBUI_AND_CONFIGURATION.md), [MCP_INTERFACE.md](MCP_INTERFACE.md).
> **Last updated:** 2026-11-22 (project-wide centralization inventory added: provider identity, SSE events, duplicated contract values, MCP operations, catalog/derivative discovery, capabilities, configuration, snapshot provider selection, WebUI status).

## 1. Requirement

Every backend-owned **identity, contract, capability, selectable option and domain-data value** must have **one authoritative source of truth**. All consumers — WebUI, MCP, REST/SSE, adapters and services — must reuse or discover that source rather than maintain independent copies. The frontend must **not** independently maintain duplicate lists of backend-owned options.

When a new MCP operation, provider, capability, indicator, enum value or supported option is introduced, the appropriate consumer must obtain it from the owning source without a second manually maintained list or a separate frontend edit.

This applies to implemented features, current WebUI forms and selectors, and all future modules — MCP, REST/SSE, providers, market data, indicators, alerts, scanners and configuration. "Centralize ownership" does **not** mean centralize everything: presentation labels, styles, layout and interaction-only state remain frontend-owned (§2.E).

This is an architecture rule, not a claim that discovery is implemented today. Section 6 records the verified current gaps; section 8 records future acceptance criteria.

### 1.1 Implemented today vs proposed

**Already implemented (verified):** shared Zod enums/schemas in `@markethub/contracts`; `GET /api/catalog/search` (bounded, paginated); MCP tool/resource/prompt registrations in `packages/mcp-core`; `ProviderRegistry` with fixed `UPSTOX`/`FYERS` typing; WebUI panels that consume the local API and shared contracts; registration-derived operation descriptors in `mcp-core/src/operation-descriptors.ts` consumed by all three registration functions; the read-only `GET /api/mcp/operations` endpoint with a strict shared contract; the reusable instrument picker adopted by three panels; the Activity panel's native grouped Operation selector; and direct WebUI consumption of shared enum options (interval, transport, status, operation type).

**Proposed, not implemented:** schema-informed basic forms where a supported derivation exists; provider/capability extensibility (Phase 5); derivative expiry discovery (Phase 4, blocked on catalog population); configuration/correctness work (Phase 6); cross-system acceptance (Phase 7). No universal metadata registry, metadata database, microservice or generic form framework exists.

## 2. Source-of-truth ownership

Ownership stays with the module that already owns the values. Do **not** create one global table or one giant registry for everything.

### 2.0 Ownership and delivery at a glance

| Information type | Source and delivery |
|---|---|
| Fixed shared enums and schemas | Import directly from `@markethub/contracts`; derive UI options from the shared Zod schema (`.options`). **No HTTP discovery request.** |
| Runtime capabilities and registrations | Discover from their owning backend module/registry through a read-only API **when the WebUI genuinely needs backend discovery**. |
| Large or changing domain data | Use existing dedicated search/paginated APIs, such as `GET /api/catalog/search`. |
| Persisted user configuration | Read and modify through its owning backend service/API. |
| Presentation-only values | May remain frontend-owned. |

This table is the delivery rule: a shared contract value is consumed directly, not fetched. A discovery endpoint is justified only for runtime metadata that cannot be derived from a shared contract or an existing domain API.

### A. Shared contract metadata

Stable enums, types and Zod schemas in `@markethub/contracts` are authoritative for fixed value sets. The WebUI consumes the shared contract or an options array derived from it — never a second literal list.

Verified examples:
- `candleIntervalSchema` — `packages/contracts/src/historical.ts:7–11` (16 intervals).
- `mcpActivityStatusSchema`, `mcpActivityTransportSchema`, `mcpActivityTerminalStatusSchema` — `packages/contracts/src/mcp-activity.ts:6,10,14`.
- `providerIdSchema`, `providerAuthStateSchema`, `capabilityStateSchema`, `capabilitySourceSchema` — `packages/contracts/src/provider.ts:5,57,75,78`.
- `retentionDataClassSchema`, `captureModeSchema` — `packages/contracts/src/snapshots.ts:140,7`.
- Market/live enums in `packages/contracts/src/market.ts` and `packages/contracts/src/live.ts`.

`apps/web/package.json:13` already declares `@markethub/contracts` as a workspace dependency, so no new dependency is needed. For fixed enums, derive options from the Zod schema's `.options` at runtime so a contract change reaches the UI without editing a component.

### B. Backend capability metadata

Capabilities come from the owning backend registry/module, not from a frontend constant and not from a second unrelated backend list.

- **MCP tools, resources and prompts:** the registrations in `packages/mcp-core/src/tools.ts`, `resources.ts` and `prompts.ts` are the source of truth (see §4).
- **Providers:** `ProviderRegistry` (`packages/market-core/src/provider.ts:22–100`) and the per-adapter `ProviderStatus.capabilities` / `.limits` (`packages/contracts/src/provider.ts:81–96,106–107`) own provider identity and capability metadata. **Current limitation:** `providerIdSchema` is `z.enum(["UPSTOX", "FYERS"])`, `ProviderStatusMap` has fixed `UPSTOX`/`FYERS` keys, and `ProviderRegistry.getStatuses()` returns that fixed two-key map. Provider registration is **not** dynamically extensible today; do not describe it as such until the contract and registry design supports it.
- **Indicators and their parameters:** when implemented, their registry/module owns the descriptors. No indicator list exists today.
- **Feature operations and configuration descriptors:** owned by the service/module that performs the operation.

### C. Domain-data metadata

Instruments, canonical identifiers, exchanges, segments, derivative contracts, expiries, strikes and contract attributes come from the canonical catalog and relevant domain services.

- Use query-based, bounded, paginated APIs for large or dynamic datasets. `GET /api/catalog/search` (`apps/api/src/catalog-routes.ts:25–55`) is the existing model: `text` (required), `limit` (1–100, default 25), `cursor`; response `{ instruments, nextCursor }`.
- Never copy exchange/provider data into frontend constants. AD-009 already forbids permanent hardcoding of changing contracts, expiries, strikes, lot sizes and freezes.
- Where no authoritative source exists (for example option-chain expiry lists in the current offline build), the UI must say so — it must not invent values to fill a selector.

### D. User-managed configuration

Watchlists, historical sync configurations, snapshot capture configurations, alerts, scanners and preferences persist through the owning backend service/repository and API. The frontend is a client, not the storage or source of truth. Existing examples: `/api/historical/sync-configs`, `/api/snapshots/configs`, `/api/retention`, `/api/market/subscriptions`.

### E. Presentation-only values

Purely local UI choices may remain in frontend code where they do not represent backend capabilities or domain data — for example tab identifiers, layout density, sort direction, badge tone mapping, or a local wizard step. This rule is not a prohibition on all frontend constants. The boundary is: **if a value describes a backend capability, a shared contract value, a domain entity or a persisted user choice, the backend/contract owns it.**

## 3. Metadata and discovery API architecture

Recommended shape (to be validated and authorized before implementation). **Only item 1 is proposed; items 2 and 3 describe existing patterns or future domain work.**

1. **Proposed — one small read-only metadata/discovery endpoint** on the existing Hono API, limited strictly to **runtime metadata that genuinely requires backend discovery**: registered MCP tool/resource/prompt descriptors and, if needed, runtime capability descriptors. It must **not** return shared-enum option arrays (`candleIntervalSchema`, activity status/transport, etc.) — those are imported directly from `@markethub/contracts` (§2.0, §2.A). Use shared Zod contracts for the response. This is a read surface over existing registries, not a new source of truth. Whether this endpoint is necessary at all must be validated against the actual registrations before implementation (§4).
2. **Existing pattern — dedicated domain endpoints** for searchable and large datasets. Instrument search already uses `/api/catalog/search`; future expiry/strike/config pickers get their own bounded, paginated endpoints from the owning service. Do not put every instrument, expiry or market-data record into one giant metadata response.
3. **Caching:** shared contract values need no HTTP fetch and no polling. Runtime metadata, if an endpoint is justified, may be cached with a version/revision and refreshed on load or explicit refresh. Dynamic domain data uses query-based fetching and normal cache invalidation. Do not aggressively poll static metadata.

No universal metadata database, no generic options framework, no new service, no separate server or microservice, and no new runtime dependency. The endpoint name and exact response contract are recommendations only; they must be designed against the actual registrations during an authorized implementation task.

## 4. MCP operation discovery — the concrete example

`packages/mcp-core/src/factory.ts:13–44` registers nine tools (`tools.ts:49+`), seven resource registrations / six logical resources (`resources.ts:75+`) and three prompts (`prompts.ts:18+`). All **19 operations** produce activity through the shared `withActivity()` mechanism using the same `toolName` field (`tools.ts:33–42`, `resources.ts:57–67`, `prompts.ts:7–16` → `activity.ts:168–227`). The registrations are the source of truth. **Implemented:** `packages/mcp-core/src/operation-descriptors.ts` is the single registration-owned descriptor source, consumed by all three registration functions and exposed to the WebUI through the read-only `GET /api/mcp/operations` endpoint with a strict shared contract (`contracts/src/mcp-operations.ts`). MCP protocol list methods (`tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`) remain the protocol-level observation surface and are used by parity tests.

Descriptors must be split into a **minimum set required for operation discovery** and **optional future metadata**:

- **Minimum for the initial Activity Operation selector:** stable operation name, operation type (`tool|resource|prompt`) derived from the owning registration, and a display title/description. This is the only metadata the first selector needs.
- **Optional, only when separately justified:** read-only / side-effect annotations where applicable (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint` — see `tools.ts:29–30`); availability / supported status where grounded (two tools are explicitly unavailable in M6 — `futures_chain`, `market_information` at `tools.ts:194–207`); and safe display metadata. **Category is not an SDK field** (`ToolSchema` has no `category`); it may be optional MarketHub-owned presentation metadata but must not be added merely for abstraction or decoration.
- **Separate future concern — input metadata / JSON Schema:** browser-facing input JSON Schema is **not promised**. It may be exposed only if it can be safely derived from the same definitions used by registration without SDK internals; no supported derivation path has been identified. This does **not** require a universal JSON Schema form generator.

**Critical requirement:** operation metadata must not be separately hardcoded in the frontend or maintained in a second unrelated backend list. WebUI-facing descriptors must be derived from the actual MCP registrations so they cannot drift.

The Activity panel's former free-text filter is now a native grouped **Operation name** selector (`apps/web/src/components/ActivityPanel.tsx`) sourced from those descriptors, with operation type shown as an option group (not a filter). The existing `toolName` storage and filter contract are preserved; there is no persisted `operationType` field or API filter. Operation-type filtering remains explicitly deferred — no migration solely for type filtering without a demonstrated requirement. New registered operations appear automatically.

Future WebUI operation discovery and schema-informed basic forms should reuse the same descriptors where a supported derivation exists. A simple operation should not require a new hand-written React form. This does **not** mandate a universal JSON Schema form generator for complex workflows (see §5).

Distinguish three things:
- `server/discover` — protocol-level discovery (version, capabilities); it does **not** supply operation descriptors.
- MCP protocol list methods (`tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`) — protocol-level descriptors for MCP clients, not a WebUI contract.
- A WebUI-facing read-only metadata surface — **implemented** as `GET /api/mcp/operations` (Phase 2 WP 2b). The WebUI cannot import server-side `mcp-core`, so a dedicated read-only endpoint was selected over embedding descriptors in an existing response (§3, first-slice plan §2.1 resolved).

## 5. Dynamic WebUI components

Supported reusable patterns for future implementation:

- **Searchable/autocomplete instrument selector** — backed by `/api/catalog/search`; replaces manual canonical-ID typing.
- **Metadata-driven dropdown/select** — options derived from a shared Zod enum or a read-only metadata endpoint.
- **Provider and capability selector** — when provider identity becomes dynamically extensible, iterate backend-provided provider descriptors rather than a hardcoded array. **Today** `ProviderId`/`ProviderStatusMap`/`getStatuses()` are fixed around `UPSTOX`/`FYERS` (§2.B), so a provider selector must reflect that fixed contract honestly; do not claim dynamic discovery until the contract and registry support it.
- **MCP operation selector** — populated from the registration-derived descriptors for tools, resources and prompts (§4); operation type comes from the descriptor, not a second list.
- **Schema-informed basic form fields** — for simple operations, derive basic inputs from the input JSON Schema **only where a supported derivation path exists without SDK internals**; this is not yet established (§4).
- **Domain-specific custom components** — use a custom renderer when a workflow needs domain semantics, validation, conditional fields or layout that a generic form cannot express honestly. A universal JSON Schema form generator is **not** required for every complex workflow.

Every such component must define: loading, empty, unavailable, error, stale and refresh states. "Unavailable" and "unknown" are honest outcomes — never fabricate a value to populate a control.

Caching: static metadata is cached and refreshed on load/explicit refresh; dynamic domain data uses query-based fetching with appropriate invalidation. No aggressive polling of static metadata.

## 6. Verified current state (gaps closed by Phases 1–3)

| Area | Verified current state |
|---|---|
| Instrument search | `GET /api/catalog/search` exists (`apps/api/src/catalog-routes.ts:25`) and is consumed by a reusable `InstrumentPicker` adopted by `SubscriptionPanel`, `HistoricalPanel` and `SnapshotPanel` (Phase 3 WP 3b–3c). No manual canonical-ID entry remains in those controls. |
| Candle intervals | `HistoricalPanel` derives all 16 values from shared `candleIntervalSchema` (`packages/contracts/src/historical.ts:7–11`); the duplicated local `INTERVALS` array is gone (Phase 3 WP 3a). |
| Providers | `ProviderRegistry` exists (`packages/market-core/src/provider.ts:22`); `providerIdSchema` and `ProviderStatusMap` have fixed `UPSTOX`/`FYERS` typing (`packages/contracts/src/provider.ts:5,113–116`). Enumerable provider status and capability rendering remain Phase 5 work. |
| MCP tools / operations | Registered in `packages/mcp-core/src/{tools,resources,prompts}.ts`; descriptors are owned by `mcp-core/src/operation-descriptors.ts` and exposed through the read-only `GET /api/mcp/operations` endpoint with a strict shared contract (Phase 2 WP 2a–2b). |
| MCP Activity | The free-text tool filter is replaced by a native grouped Operation selector sourced from descriptors; transport, status and operation-type options derive from shared contract schemas (`ActivityPanel.tsx`, Phase 2 WP 2c). |
| Snapshot capture | Underlying uses the instrument picker; expiry remains manual and provider remains an explicit select. Do not invent dynamic expiry data where no authoritative source is available — derivative expiry discovery is Phase 4 and blocked on catalog population. |
| Future indicators/alerts/scanners | Must follow metadata discovery when their backend services and registries are introduced. |

The read-only `GET /api/mcp/operations` endpoint exists in `apps/api/src`, and the strict `mcp-operations` contract exists in `packages/contracts`. The untracked local note `docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` records the original pending requirement; it is not an implementation and is preserved as historical context.

## 7. Security and correctness

- Metadata APIs are **read-only** and expose only safe, public-facing descriptions.
- Never return credentials, tokens, secrets, internal provider identifiers or sensitive configuration values. Provider management routes already use `isLocalPeer` (`apps/api/src/provider-routes.ts:58–72`); read-only metadata must not bypass that boundary for sensitive fields.
- Metadata is **not** an authorization mechanism. Backend validation and permission enforcement remain authoritative.
- UI validation is for usability, not a replacement for backend validation.
- Provider capability and market-data availability must remain honest and source-attributed (`capabilityStateSchema`, `capabilitySourceSchema` in `packages/contracts/src/provider.ts:75–79`).
- Never invent unavailable values just to populate a selector.

## 8. Future acceptance criteria (not implemented here)

A future implementation must prove:

- a newly registered MCP tool appears in the WebUI selector without a frontend options-list edit;
- existing catalog results populate instrument selectors;
- shared interval/status enums are not duplicated in React;
- provider UI reflects the owning backend contract — currently the fixed `UPSTOX`/`FYERS` `ProviderId`/`ProviderStatusMap`; dynamic provider descriptors are a later contract/registry change, not part of this requirement's current acceptance;
- unknown/unavailable metadata is handled honestly;
- metadata responses contain no secrets;
- backend schema validation remains authoritative;
- query-based lists are bounded/paginated where required.

Tests must prove the actual source-to-API-to-WebUI relationship, not merely match planned filenames.

## 9. Roadmap

The cross-cutting initiative **Backend-Driven Metadata and Capability Discovery** is recorded in [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §4.1 (Phases 0–7). Documentation/protocol and the read-only source-of-truth inventory are **done**. The implementation sequence — (1) shared-contract centralization + historical interval selector, (2) reusable instrument picker using the existing catalog API, (3) MCP operation selector after the descriptor-delivery decision — is **complete and published on `develop`**. The descriptor-delivery question was resolved in favor of a dedicated read-only `GET /api/mcp/operations` endpoint. See [METADATA_DISCOVERY_FIRST_SLICE_PLAN.md](METADATA_DISCOVERY_FIRST_SLICE_PLAN.md) for the bounded increments and the Phase 2/Phase 3 plan §12 close-outs for evidence.

This initiative does not change M6-C acceptance, M6-D/E/B4 ownership, or reopen physical LAN testing.

## 10. Centralization inventory (source-verified)

For each candidate: current definition → owner → duplicators/consumers → existing solution → new API/refactor needed → dependency risk → future-addition path. "Centralize" means one owning definition, not one universal registry.

### A. Provider identity — high priority
- **Current:** `providerIdSchema = z.enum(["UPSTOX","FYERS"])` at `packages/contracts/src/provider.ts:5`; `ProviderId` derived at `:6`. `ProviderStatusMap` has fixed keys (`provider.ts:113–116`, Zod mirror `:150–153`); `ProviderRegistry.getStatuses()` hardcodes both (`packages/market-core/src/provider.ts:38–71`).
- **Duplicators:** `market.ts:32` (`providerSchema`, a second exported name), `live.ts:12` (private `liveProviderIdSchema`), `live-components.ts:191`, `historical.ts:53,78,136,175`, `snapshots.ts:83,110,124`. WebUI `status.ts:33–49` uses literal unions and casts without Zod validation; `App.tsx:133–134` renders `providers.UPSTOX`/`providers.FYERS` explicitly.
- **Existing solution:** `providerIdSchema` is canonical but only `provider.ts:136` uses it as a runtime validator; no other contracts file imports it.
- **Dependency risk:** `provider.ts:2` imports `providerConnectionStateSchema` from `live.ts` (value); `live.ts:2` imports `ProviderId` type-only and inlines its own enum specifically to keep the runtime graph acyclic (`live.ts:9–12`). Moving identity into `live.ts` would create a cycle; moving into `provider.ts` is safe only if consumers keep `import type`.
- **Decision:** introduce a dependency-light **leaf identity module** in `@markethub/contracts` with the value schema and no value imports from `live.ts`/`market.ts`/`provider.ts`; re-export from `index.ts` preserving `providerIdSchema`/`ProviderId`/`providerSchema` names. Consumers import the value schema where validation is needed and `import type` elsewhere. Keep `live.ts:12` local only if the leaf module cannot be introduced without a cycle — document the exception.
- **Provider status response:** plan a shared `ProviderStatusMap` response that the WebUI can **iterate** (array or validated record) instead of accessing fixed keys; validate with `providerStatusMapSchema` in `lib/status.ts` (currently a raw cast). Do **not** claim dynamic provider extensibility while `ProviderId`/`ProviderStatusMap`/`getStatuses()` remain fixed to UPSTOX/FYERS. Provider-specific auth workflows stay custom — no universal credential-form renderer.

### B. Shared SSE event definitions — high priority
- **Current:** five `z.literal` payload types in `packages/contracts/src/live.ts:178–209` (`item-updated`, `item-removed`, `provider-connection-changed`, `snapshot-required`, `refresh`); **no payload schema for `snapshot`** (transport-only, validated by `liveSnapshotSchema` at `:170–175`).
- **Duplicators:** `packages/realtime/src/types.ts:3` (unenforced comment list), `hub.ts:103,121,124,152,153,245,278` (scattered literals), `apps/web/src/lib/live-stream.ts:23–30` (`SSE_EVENT_NAMES`), `tests/web/live-stream.test.ts:134–137` (full duplicated list), plus individual test literals.
- **Existing solution:** `hub.ts:227` derives data event names from `event.type`, so schema literals and SSE names agree by construction; `apps/web/src/lib/live.ts:64–97` already classifies by payload schema (`.safeParse`), not by event name — no fragile runtime introspection today.
- **Decision:** export one `as const` tuple (e.g. `LIVE_EVENT_NAMES`) from `@markethub/contracts`, including `snapshot` explicitly as transport-only. Use it to type `OutboundEvent.event` (currently plain `string`), replace `SSE_EVENT_NAMES` and the duplicated test list, and provide named constants for hub/API control literals. No Zod `.options`/`.shape` reflection. Preserve current SSE wire behavior and event semantics.

### C. Other duplicated contract values
- **CE/PE:** `optionTypeSchema`/`OptionType` canonical at `market.ts:29–30`; duplicates at `snapshots.ts:20,51` and `packages/market-core/src/identity.ts:67`. Import the shared type/schema. DB SQL CHECK (`packages/database/src/schema.ts:97`) and adapter-native mappings (`broker-upstox/src/option-chain.ts:96`, `broker-fyers/src/option-chain.ts:168`) stay local — SQL cannot import TS and adapters translate at the boundary.
- **HTTP/STDIO transport:** `mcpActivityTransportSchema` canonical at `mcp-activity.ts:10`; `ActivityTransport` at `packages/mcp-core/src/activity.ts:9` is a pure duplicate — import the shared type. WebUI `ActivityPanel.tsx:81,134` can derive from the schema; DB CHECK (`schema.ts:397`) stays literal.
- **Provider IDs:** see A. `live.ts:12` is the one duplicate with a documented cycle-avoidance reason.
- **Activity status/transport filters:** `ActivityPanel.tsx:81,134,138–139` duplicate `mcpActivityStatusSchema`/`mcpActivityTransportSchema`; `:82` already uses the contract-derived pattern. Derive option lists from shared schemas; keep per-status tone mapping (`:26–31`) local presentation logic.
- **Retention classes:** `retentionDataClassSchema` canonical at `snapshots.ts:140`; object keys in `retentionSettingsSchema` (`:143–150`), `HistoricalPanel.tsx:268–304` and `historical-routes.ts:52` are type-checked against `RetentionSettings`, so drift is caught at compile time. Lower priority; keep per-class labels local, optionally iterate keys from the shared list.
- **Not centralized:** presentation labels, colors, CSS classes, formatting and local interaction state remain frontend-owned.

### D. MCP operation discovery — high priority
- **Current:** 9 tools (`tools.ts:49+`), 7 resource registrations / 6 logical resources (`resources.ts:75+`), 3 prompts (`prompts.ts:18+`), all registered through `createMcpServer` (`factory.ts:13–44`). All **19 operations** are recorded through one `toolName` field (`tools.ts:33–42`, `resources.ts:57–67`, `prompts.ts:7–16` → `activity.ts:168–227` → `mcp-activity.ts:143`). Descriptors are owned by `mcp-core/src/operation-descriptors.ts` and exposed via `GET /api/mcp/operations`; the WebUI uses a native grouped Operation selector (`ActivityPanel.tsx`).
- **SDK constraint:** `McpServer._registeredTools` is private (`mcp-BCJHyo7l.d.mts:3254`); `toolInputSchemaJson()` is `@internal` (`:3266`). No public enumeration API — SDK internals are rejected.
- **Decision (implemented in Phase 2):** operation descriptors are defined once in `packages/mcp-core/src/operation-descriptors.ts` (stable operation name, operation type `tool|resource|prompt` derived from the owning group, display title for resources/prompts, description) and consumed by all three registration functions. They are exposed to the WebUI through the validated read-only `GET /api/mcp/operations` endpoint. The Activity panel uses a native grouped **Operation name** selector; operation-type filtering is deferred. MCP `tools/list`/resource/prompt listing, `server/discover`, and WebUI REST metadata discovery remain separate. No universal form engine. See [METADATA_DISCOVERY_PHASE_2_PLAN.md](METADATA_DISCOVERY_PHASE_2_PLAN.md) §12.

### E. Catalog and instrument discovery
- **Current:** `GET /api/catalog/search` (`apps/api/src/catalog-routes.ts:25–55`) supports only `text`, `limit` (1–100), `cursor`; response `{ instruments, nextCursor }`. Repository `searchInstruments` (`packages/database/src/repositories/catalog.ts:237–255`) matches symbol/displayName/identityKey with keyset pagination — **no exchange/category/segment/underlying predicates**. `canonicalInstrumentSchema` (`market.ts:113–136`) carries those fields. WebUI panels now use the reusable `InstrumentPicker` backed by this endpoint (Phase 3 WP 3b–3c); no manual canonical-ID entry remains in those controls.
- **Decision:** reusable searchable selector backed by the existing bounded API. Context-aware filters (exchange/category/segment/underlying/product scope/lifecycle) require a repository/API extension first — they are **not** available today; do not add filters for appearance. Never load the full catalogue into the browser.

### F. Derivative expiry and contract discovery
- **Current:** `findDerivativeContracts({ underlyingCanonicalId?, expiryDate?, derivativeClass? })` exists (`packages/market-core/src/types.ts:52`; `packages/database/src/repositories/catalog.ts:307–315`) but is **unbounded** (`q.all()`, no limit/order/cursor). `DerivativeContractRecord` (`market-core/src/types.ts:12–32`) stores `expiryDate`, `derivativeClass`, per-strike `strikeNormalized`/`strikeKey`. Write paths exist in catalog sync (`catalog.ts:45–71`, `sync/apply.ts:219–221,301–322`) but **no production/offline catalog sync runs**; the current DB has **0 derivative and 0 instrument rows**. No expiry API, MCP operation or WebUI flow exists; `SnapshotPanel.tsx:106` uses a manual expiry text field.
- **Decision:** distinguish implemented data model / current empty offline state / missing bounded read API / unverified authoritative data. Plan an expiry read API from real derivative records only after (a) a population path exists and (b) the query is made bounded. Never compute expiries from weekdays or hardcode dates. Strikes/exact contracts only where actual data supports them.

### G. Provider capability and availability metadata
- **Current:** three vocabularies — `capabilityStateSchema` (`provider.ts:75`), `capabilityStatusSchema` (`live-components.ts:159`), `availabilityStateSchema` (`market.ts:36`). Adapters emit `SUPPORTED`/`LIMITED`/`UNSUPPORTED` with `reason` and `entitlementUnverified` (`broker-upstox/src/components.ts:203–224`, `broker-fyers/src/stream.ts:376–393`). `capabilitySourceSchema` (`provider.ts:78`) separates `API` (verified) from `DOCUMENTATION`/`USER`/`UNKNOWN`.
- **Gap:** WebUI `ProviderStatusView` (`status.ts:33–43`) omits `capabilities`/`limits`; `SubscriptionPanel.tsx:130–134` renders only connection state and last error. Capability metadata is visible via REST/MCP but not rendered in WebUI.
- **Decision:** consumers must distinguish supported / limited / unavailable / unverified from the owning contract; never present a type-level or documentation-only capability as available. Keep entitlements and live verification distinct from published docs. No frontend hardcoded capability list.

### H. User-managed configuration
- **Current:** streaming subscriptions (`/api/market/subscriptions`), historical sync configs (`/api/historical/sync-configs`), snapshot capture configs (`/api/snapshots/configs`), retention (`/api/retention`), provider settings/credentials (`/api/provider/*`, local-owner guarded).
- **Decision:** persisted by the owning backend service/repository; WebUI reads and updates through that API. MCP on-demand operations must not silently modify WebUI-owned operational config. Secrets never appear in metadata responses. Retention controls may keep a small explicit presentation mapping (§C).

### I. Snapshot provider selection behavior
- **Current:** UI defaults to FYERS and always sends an explicit provider (`SnapshotPanel.tsx:27,86`; `lib/snapshots.ts:86–99`). Contract allows omission (`snapshots.ts:110`); route preserves it (`snapshot-routes.ts:73`). Service semantics differ: explicit provider = **exclusive filter, no fallback** (`market-core/src/snapshots/service.ts:139–141`); omitted = try all configured providers in order (`:143–167`). Historical service uses prefer-then-fallback (`historical/service.ts:206–213`). Production has empty provider collections → 422.
- **Decision (to resolve before implementation):** define automatic vs explicit preference semantics, unavailable-provider behavior, and whether the UI offers an "automatic/default" choice. Do not silently change service ordering or invent fallback behavior.

### J. WebUI status and presentation accuracy
- **Current:** four stale statements in `apps/web/src/App.tsx:211,219,281,282` claim market data/providers/catalog/MCP HTTP are not implemented, contradicting implemented provider status/auth (`:21–144`), market-data panels (`:290–301`), and the mounted `/mcp` route (`app.ts:235–238`, `mcp-routes.ts:57–63`). Other panel "not available" statements are accurate.
- **Decision:** correct this presentation text in a later implementation slice (Phase 6), distinguishing implemented foundation, implemented-but-locked functionality, unavailable provider-backed/live behavior, and genuinely planned features. No source change in this documentation task.
