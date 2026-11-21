# Backend-Driven Metadata and Capability Discovery

> **Status:** Authoritative architecture requirement (owner-approved). **Documentation only — no metadata API, registry, WebUI component or application change is implemented by this document.** Implementation requires separate authorization.
> **Decision:** [AD-025](ARCHITECTURE_DECISIONS.md) (backend/domain-owned metadata is authoritative).
> **Governing:** [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md), [WEBUI_AND_CONFIGURATION.md](WEBUI_AND_CONFIGURATION.md), [MCP_INTERFACE.md](MCP_INTERFACE.md).
> **Last updated:** 2026-11-22 (ownership/delivery boundaries clarified; provider limitation preserved; implemented vs proposed separated).

## 1. Requirement

The backend and shared domain contracts are the **source of truth** for selectable options, capabilities, metadata and domain entities consumed by the WebUI. The frontend must **not** independently maintain duplicate lists of backend-owned options.

When a new MCP tool, provider, capability, indicator or supported option is introduced, the appropriate WebUI selector must discover it from the owning backend source without a second manually maintained frontend list.

This applies to implemented features, current WebUI forms and selectors, and all future modules — MCP, REST/SSE, providers, market data, indicators, alerts, scanners and configuration.

This is an architecture rule, not a claim that discovery is implemented today. Section 6 records the verified current gaps; section 8 records future acceptance criteria.

### 1.1 Implemented today vs proposed

**Already implemented (verified):** shared Zod enums/schemas in `@markethub/contracts`; `GET /api/catalog/search` (bounded, paginated); MCP tool/resource/prompt registrations in `packages/mcp-core`; `ProviderRegistry` with fixed `UPSTOX`/`FYERS` typing; WebUI panels that consume the local API and shared contracts.

**Proposed, not implemented:** a read-only runtime metadata endpoint; registration-derived tool descriptors exposed to the WebUI; reusable instrument/tool selectors; direct WebUI consumption of shared enum options; schema-informed basic forms. No metadata API, registry, WebUI component, dependency or migration exists for this requirement yet.

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

## 4. MCP tool discovery — the concrete example

`packages/mcp-core/src/tools.ts:49` `registerTools()` registers nine tools by direct `server.registerTool(name, { description, inputSchema, annotations }, callback)` calls. The registrations are the source of truth; there is currently **no** exported descriptor array and no WebUI-facing metadata contract. Descriptors are observable only through MCP protocol `tools/list` (used by tests).

Future architecture must make these fields discoverable to the WebUI from that same registration source:

- tool identifier and display name;
- description and category;
- input JSON Schema (from the existing `inputSchema`);
- read-only / side-effect annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint` — see `tools.ts:29–30`);
- availability / supported status where grounded (two tools are explicitly unavailable in M6 — `futures_chain`, `market_information` at `tools.ts:194–207`);
- safe display metadata needed by the UI.

**Critical requirement:** tool metadata must not be separately hardcoded in the frontend or maintained in a second unrelated backend list. The WebUI-facing descriptors must be derived from the actual MCP registrations so they cannot drift.

The Activity panel's tool-name filter (`apps/web/src/components/ActivityPanel.tsx:132`, currently a free-text input) should become a searchable/populated selector sourced from those descriptors. New registered tools must appear automatically.

Future WebUI tool discovery and schema-informed basic forms should reuse the same descriptors. A simple tool should not require a new hand-written React form. This does **not** mandate a universal JSON Schema form generator for complex workflows (see §5).

Distinguish three things:
- `server/discover` — protocol-level discovery (version, capabilities); it does **not** supply all tool descriptors.
- MCP `tools/list` — protocol-level tool descriptors for MCP clients.
- A WebUI-facing read-only metadata endpoint — the proposed safe, contract-validated surface for the browser.

## 5. Dynamic WebUI components

Supported reusable patterns for future implementation:

- **Searchable/autocomplete instrument selector** — backed by `/api/catalog/search`; replaces manual canonical-ID typing.
- **Metadata-driven dropdown/select** — options derived from a shared Zod enum or a read-only metadata endpoint.
- **Provider and capability selector** — when provider identity becomes dynamically extensible, iterate backend-provided provider descriptors rather than a hardcoded array. **Today** `ProviderId`/`ProviderStatusMap`/`getStatuses()` are fixed around `UPSTOX`/`FYERS` (§2.B), so a provider selector must reflect that fixed contract honestly; do not claim dynamic discovery until the contract and registry support it.
- **MCP tool selector** — populated from the registration-derived descriptors (§4).
- **Schema-informed basic form fields** — for simple tools, derive basic inputs from the input JSON Schema.
- **Domain-specific custom components** — use a custom renderer when a workflow needs domain semantics, validation, conditional fields or layout that a generic form cannot express honestly. A universal JSON Schema form generator is **not** required for every complex workflow.

Every such component must define: loading, empty, unavailable, error, stale and refresh states. "Unavailable" and "unknown" are honest outcomes — never fabricate a value to populate a control.

Caching: static metadata is cached and refreshed on load/explicit refresh; dynamic domain data uses query-based fetching with appropriate invalidation. No aggressive polling of static metadata.

## 6. Verified current gaps (not implemented)

| Area | Verified current state |
|---|---|
| Instrument search | `GET /api/catalog/search` exists (`apps/api/src/catalog-routes.ts:25`); the WebUI never calls it. `SubscriptionPanel.tsx:84–91`, `HistoricalPanel.tsx:181` and `SnapshotPanel.tsx:105` still ask for manual canonical IDs. |
| Candle intervals | Shared `candleIntervalSchema` has 16 values (`packages/contracts/src/historical.ts:7–11`); `HistoricalPanel.tsx:12` duplicates a 7-value `INTERVALS` array, omitting 9 valid intervals. |
| Providers | `ProviderRegistry` exists (`packages/market-core/src/provider.ts:22`); `providerIdSchema` and `ProviderStatusMap` have fixed `UPSTOX`/`FYERS` typing (`packages/contracts/src/provider.ts:5,113–116`). `App.tsx:133–134` and `SnapshotPanel.tsx:107–110` reference both explicitly. |
| MCP tools | Registered in `packages/mcp-core/src/tools.ts`; no separate WebUI metadata discovery contract or endpoint exists. |
| MCP Activity | Tool-name filter is free text (`ActivityPanel.tsx:132`); transport (`L133–135`) and status (`L136–140`) options are hardcoded despite shared schemas. |
| Snapshot capture | Underlying and expiry are manually entered (`SnapshotPanel.tsx:105–106`); provider is a hardcoded select (`L107–110`). Do not invent dynamic expiry data where no authoritative source is available. |
| Future indicators/alerts/scanners | Must follow metadata discovery when their backend services and registries are introduced. |

No metadata/discovery endpoint exists in `apps/api/src`, and no options/metadata contract exists in `packages/contracts`. The untracked local note `docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` records the same pending requirement; it is not an implementation.

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

The cross-cutting initiative **Backend-Driven Metadata and Capability Discovery** is recorded in [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md). Sequence: documentation/protocol → read-only audit → minimal discovery API and component plan → first slice (MCP tool discovery + canonical instrument pickers) → progressive adoption → acceptance proving new backend-registered options appear without a second frontend list.

This initiative does not change M6-C acceptance, M6-D/E/B4 ownership, or reopen physical LAN testing.
