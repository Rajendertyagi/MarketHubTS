# Phase 2 — MCP Operation Discovery and Activity Selector

> **Status:** Proposed, bounded implementation plan. **Planning only:** this document does not authorize implementation, commits, pushes, merges, migrations, or runtime changes. Implementation requires separate product-owner authorization.
>
> **Repository baseline reviewed:** `Rajendertyagi/MarketHubTS`, branch `develop`, HEAD `b5ab9458c7bce7180f806ba5e1db72864991ba5c` (2026-11-22).
>
> **Governing documents:** [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md) §§2–4; [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) (AD-025); [METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md](METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md) §4; [MCP_INTERFACE.md](MCP_INTERFACE.md).

## Review Focus

These are the inputs and failure modes the governing docs imply but no single happy-path test fully exercises. Each is pinned to a test in §9.

1. **A newly registered operation** — must appear in the selector without a frontend options-list edit; pinned by §9.1/§9.2 parity and §9.4 synthetic-descriptor test.
2. **A descriptor that drifts from its registration** — names and descriptions must match the MCP list methods exactly, and titles where present (resources/prompts); pinned by §9.2 parity assertions.
3. **Sensitive metadata leakage** — only `name`, `type`, `title`, `description` may appear; pinned by §9.3 raw-key assertion and strict schema.
4. **Descriptor fetch failure** — must not break Activity history, refresh, pagination or details; pinned by §9.4 failure-isolation test.
5. **A stale selection after a successful refresh** — if the selected operation is no longer registered, reset to `Any operation`; pinned by §9.4 stale-selection test.

---

## 1. Objective and product outcome

Provide the WebUI Activity panel with a reliable **Operation name** selector that automatically reflects the operations actually registered by MarketHubTS MCP.

The selector must cover all current registrations:

- 9 MCP tools
- 7 MCP resource registrations (including resource templates)
- 3 MCP prompts
- **19 registered operations in total**

A user should be able to select an operation by its stable MCP name, understand whether it is a tool, resource, or prompt, and filter activity history using the existing `toolName` field. When a new MCP operation is added to the real application, it should become available in the selector without a separate WebUI options-list edit.

This is an operation-discovery and Activity-filter improvement. It is **not** a redesign of the MCP runtime, the activity database, or the wider metadata architecture.

## 2. Verified current state

### 2.1 Repository and dependency state

- The plan is based on `develop` at `b5ab9458c7bce7180f806ba5e1db72864991ba5c`.
- Phase 3 WP 3b–3c has been published on `develop`; its documentation close-out is recorded in `METADATA_DISCOVERY_PHASE_3_PLAN.md` §12.
- `apps/api` already depends on `@markethub/mcp-core`.
- `apps/web` depends on `@markethub/contracts`, React and the existing UI/data libraries, but **does not depend on `@markethub/mcp-core`**. Keep it that way: `mcp-core` depends on the server-side MCP SDK and should not be imported into the browser bundle.
- No new dependency is required for this phase.

### 2.2 Current MCP registrations

`packages/mcp-core/src/factory.ts` creates the MCP server and invokes `registerTools()`, `registerResources()` and `registerPrompts()`.

The registration functions currently define their names and display metadata inline:

| Type | Current registered names | Count |
|---|---|---:|
| Tool | `markethub_health`, `catalog_search`, `provider_status`, `market_snapshot`, `historical_candles`, `option_chain_snapshot`, `on_demand_retrieval`, `futures_chain`, `market_information` | 9 |
| Resource | `catalog-instruments`, `market-snapshot`, `historical-candles`, `snapshots-config`, `snapshots-null-config`, `events-live`, `events-alerts` | 7 |
| Prompt | `explain_market_snapshot`, `interpret_coverage_gaps`, `how_to_capture_snapshot` | 3 |

All 19 registrations create activity using the shared `withActivity()` path. Activity stores the registration name in the existing `toolName` field; there is no persisted operation-type field.

There is currently no exported descriptor registry and no WebUI-facing operation metadata endpoint. MCP clients can discover registrations through the protocol list methods; that is not itself a WebUI contract.

### 2.3 Proposed display inventory

The following inventory makes the first implementation concrete. Every title and description below is carried forward verbatim from the current SDK registration metadata — **no MCP-visible metadata is added or changed**. Tools have no `title` today, so their descriptors omit it and the selector falls back to the stable operation name as the label.

| Type | Stable name | Current title (tools: none) | Description to retain in the descriptor |
|---|---|---|---|
| Tool | `markethub_health` | — (use `markethub_health`) | Get MarketHubTS API and database health status via the local API. |
| Tool | `catalog_search` | — (use `catalog_search`) | Search the canonical instrument catalog by symbol, display name or identity key. Read-only, bounded, keyset-paginated. |
| Tool | `provider_status` | — (use `provider_status`) | Get composed UPSTOX and FYERS provider status, including runtime streaming state. Read-only. |
| Tool | `market_snapshot` | — (use `market_snapshot`) | Get the canonical live market snapshot. When canonicalId is supplied, only snapshot.items are filtered; revision, capturedAtMs and connections are preserved. Read-only. |
| Tool | `historical_candles` | — (use `historical_candles`) | Read cached candles or derived coverage for a canonical instrument and range. The onDemand mode may cache retrieved candles (a bounded persistence side effect); cached and coverage modes are read-only. Never changes saved sync configuration. |
| Tool | `option_chain_snapshot` | — (use `option_chain_snapshot`) | List or get stored option-chain snapshots (read-only), or capture one on demand. Capture persists a snapshot with configId = null and does not read or modify saved capture configurations. |
| Tool | `on_demand_retrieval` | — (use `on_demand_retrieval`) | Thin dispatch for on-demand data: historical retrieval may cache candles; option-chain capture persists a snapshot with configId = null. Never changes saved operational configuration. |
| Tool | `futures_chain` | — (use `futures_chain`) | Unavailable in M6 — no shared futures-chain service exists. |
| Tool | `market_information` | — (use `market_information`) | Unavailable in M6 — no shared market-information service exists. |
| Resource | `catalog-instruments` | Catalog instruments | Bounded, keyset-paginated canonical instrument search. Requires a non-empty query; no unfiltered listing. |
| Resource | `market-snapshot` | Market snapshot | Canonical live market snapshot (quotes/depth). Empty state is honest, never fabricated. |
| Resource | `historical-candles` | Historical candles and coverage | Cached candles plus derived coverage for a canonical instrument and ISO-8601 range. |
| Resource | `snapshots-config` | Snapshots by capture configuration | Newest-first bounded page of snapshots for a real capture configuration ID (including 'none'). Stored-data opaque cursor. |
| Resource | `snapshots-null-config` | Null-config snapshots | Newest-first bounded page of snapshots with no capture config: on-demand captures and snapshots retained after config deletion. Stored-data opaque cursor. |
| Resource | `events-live` | Live event feed | Bounded replay page from the in-memory live event hub. Cursor is runtime-scoped and does not survive restart; snapshot-required is an explicit recovery result. |
| Resource | `events-alerts` | Alert events (unavailable in M6) | Contract-only placeholder. Durable alert records are an M7 dependency; reads return an explicit unavailable error, never an empty feed. |
| Prompt | `explain_market_snapshot` | Explain a market snapshot | Guidance for reading the canonical live market snapshot resource. |
| Prompt | `interpret_coverage_gaps` | Interpret coverage gaps | Guidance for interpreting historical candle coverage and gaps. |
| Prompt | `how_to_capture_snapshot` | How to capture an option-chain snapshot | Guidance for on-demand option-chain capture and its persistence semantics. |

### 2.4 Current Activity implementation

- `apps/api/src/mcp-activity-routes.ts` owns the Activity read/write routes. `GET /api/mcp/activity` already filters by `toolName`; activity reads follow the existing LAN-readable model, while STDIO activity writes are local-owner-only.
- `packages/contracts/src/mcp-activity.ts` owns the Activity schemas and filter contract.
- `apps/web/src/lib/activity.ts` contains typed fetch functions, Zod response validation and `ActivityHttpError` handling.
- `apps/web/src/components/ActivityPanel.tsx` has a free-text tool-name input. Its filter builder maps that value to the existing `toolName` query parameter.
- The panel separates a presentational `ActivityPanelView` from its data-loading controller. `tests/web/activity-panel.test.tsx` renders the view with `renderToStaticMarkup` and tests the controller without a browser-DOM test framework.
- Transport and status options already come from shared contract schemas; do not reintroduce duplicate values.

### 2.5 Confirmed SDK boundary

The installed MCP server SDK is pinned at `2.4.0` in the repository. Its internal registration collection is private, and the adjacent schema accessor is marked internal in the source investigation already recorded by the first-slice plan. This phase must **not** inspect `_registeredTools`, call internal SDK accessors, or depend on undocumented runtime state.

The official MCP `server/discover` method reports protocol versions and server capabilities; it is not an operation catalogue. Tools, resources and prompts have separate protocol registration/list surfaces. The SDK registration APIs accept names and safe display metadata, so MarketHub can maintain one explicit definition that its own registration functions and WebUI metadata route consume. See the official MCP and SDK references in §11.

## 3. Selected architectural decisions

The following choices resolve the open Phase 2 design points for this bounded increment.

### 3.1 One registration-owned descriptor definition

Create `packages/mcp-core/src/operation-descriptors.ts` as the single owner of the operation names and safe display metadata.

The registry is grouped by registration type (`tools`, `resources`, `prompts`) so operation type is derived from the owning group rather than separately maintained on every registration. Each entry contains only:

- `name`: stable MCP registration name; also the value stored in the existing activity `toolName` field.
- `title`: optional human-readable label for the Activity selector. Present only for resources and prompts, which set it today; **tools omit it** so no MCP-visible metadata changes. The selector falls back to `name` when absent.
- `description`: safe, user-facing explanation of the operation.

A read-only accessor returns a deterministic ordered list with the derived `type: "tool" | "resource" | "prompt"` included for the API response.

**The registration functions must consume these definitions.** For each registration, use the descriptor's `name` and `description`, plus `title` where the descriptor defines it (resources/prompts only); pass the same `name` to `withActivity()`. Do not keep another literal name/title/description beside the descriptor. The operation-specific callback, input schema, URI/template, MIME type, annotations and business behavior stay in their current registration function.

**Concrete consumption mechanism (required — do not leave this implicit):** export one named descriptor constant per operation from the descriptor module (e.g. `healthDescriptor`, `catalogSearchDescriptor`, …), and have each registration function reference that constant directly:

```ts
// operation-descriptors.ts
export const healthDescriptor = {
  name: "markethub_health",
  description: "Get MarketHubTS API and database health status via the local API."
} as const; // no `title` — tools have none today
// ... one named export per operation
export const TOOL_DESCRIPTORS = [healthDescriptor, /* ... */] as const;
export const RESOURCE_DESCRIPTORS = [/* ... */] as const;
export const PROMPT_DESCRIPTORS = [/* ... */] as const;

// tools.ts — no name/title/description literal remains at the call site
server.registerTool(healthDescriptor.name, {
  description: healthDescriptor.description,
  inputSchema: healthInput,
  annotations: readOnly
}, async (_args, ctx) => record(services, transport, healthDescriptor.name, ctx, {}, [], async () => {
  /* existing handler body, moved verbatim */
}));
```

The accessor derives `type` from the owning group:

```ts
export function listMcpOperationDescriptors(): McpOperationDescriptor[] {
  return [
    ...TOOL_DESCRIPTORS.map((d) => ({ ...d, type: "tool" as const })),
    ...RESOURCE_DESCRIPTORS.map((d) => ({ ...d, type: "resource" as const })),
    ...PROMPT_DESCRIPTORS.map((d) => ({ ...d, type: "prompt" as const }))
  ];
}
```

This keeps registrations inline (minimal churn, no config/handler maps), removes duplicate name/title/description literals, and makes the descriptor module the only place those strings are defined. A missing or renamed descriptor is a compile error at the registration call site.

Tools keep their current registration metadata exactly — no `title` is added. Resources and prompts reuse the title and description their SDK registration configuration already accepts. The selector displays `title ?? name`, so tools render their stable name as the label.

Keep the current registration order deterministic. Grouping in the WebUI must not change registration order or MCP protocol behavior. **Operation names, activity storage, the database schema and existing MCP registration behavior are not changed to support the selector.**

### 3.2 Dedicated read-only API surface

Add:

`GET /api/mcp/operations`

Response shape:

```json
{
  "operations": [
    {
      "name": "markethub_health",
      "type": "tool",
      "description": "Get MarketHubTS API and database health status via the local API."
    }
  ]
}
```

The example shows the shape, not the complete 19-entry response.

The route will read the descriptor accessor from `@markethub/mcp-core` and validate the outgoing payload against a shared contract schema. It will not query the MCP SDK, use a second options list, or modify the existing `/api/mcp/activity` response.

**Why an endpoint:** the WebUI does not and should not import the MCP server package. The API already depends on `@markethub/mcp-core`, so the API can expose the same registration-owned definitions through a small read-only HTTP contract. `server/discover` and MCP list methods are designed for MCP protocol clients, not for the Activity panel's ordinary WebUI data client.

**Route ownership:** add a small `apps/api/src/mcp-operation-routes.ts` route module and register it from `apps/api/src/app.ts`. Keeping operation discovery separate from the activity-history route module gives each route module one responsibility. Do not create another server, service layer, registry service, database table or metadata store.

### 3.3 Small, strict shared response contract

Add `packages/contracts/src/mcp-operations.ts` and export it from `packages/contracts/src/index.ts`.

The contract should define:

- `mcpOperationTypeSchema`: `tool | resource | prompt`.
- `mcpOperationDescriptorSchema`: a strict discriminated union on `type` — tool = `{ name, type: "tool", description }` with **no** `title` key; resource/prompt = `{ name, type: "resource" | "prompt", title, description }` with **required** `title`. (Equivalently: one strict object plus a `superRefine` enforcing `("title" in entry) === (type !== "tool")`.) This makes the schema itself reject a missing resource/prompt title or an added tool title, matching the §9.3 raw-key assertion.
- `mcpOperationListSchema`: strict `{ operations: [...] }` response with a conservative upper bound (proposed maximum: 100 entries).

Use bounded strings and reject unknown fields. There is no need for cursor pagination: this is a small, code-defined registration list (19 today), not a changing domain-data catalogue.

Do **not** add input schemas, argument values, SDK annotations, categories, provider metadata, permissions, configuration, availability flags or handler details. These are not needed by the selector and some would expand the exposure surface. The unavailable M6 registrations remain discoverable because they are registered operations; their current descriptions already state their unavailable status.

### 3.4 WebUI selector behavior

- Fetch descriptors once when the Activity panel mounts; support an explicit retry if discovery fails. The client signature is `fetchMcpOperations(signal?: AbortSignal): Promise<McpOperationDescriptor[]>`; forward the optional signal to `fetch` and abort/ignore stale work on unmount (matching the `lib/catalog.ts` pattern).
- Reuse the existing typed API-client and Zod parsing patterns in `apps/web/src/lib/activity.ts` (or a tiny focused client file if implementation shows that separation is cleaner).
- Use a native accessible `<select>` with `Any operation` as the empty/default value and grouped options for **Tools**, **Resources** and **Prompts**. Native keyboard type-ahead is sufficient for the current 19 entries; do not add a custom combobox framework or dependency.
- Each option shows the stable operation name; resources and prompts may additionally show their existing title, for example `catalog-instruments — Catalog instruments`. Tools show only their stable name (e.g. `catalog_search`).
- Display the type through the option group, not as a new filter dimension.
- Selecting an operation sets the existing Activity `toolName` filter. **Apply behavior:** changing the Operation select updates `toolName` state and immediately applies the filter (reset to page 1 and load with the new query), matching the existing Apply-filters behavior — the free-text input's deferred-apply model is not retained for the select. The API query, filter schema, database query and persisted activity rows remain unchanged.
- Keep descriptor loading/error state separate from activity-history loading. If descriptor retrieval fails, show an honest inline error and Retry action; do not block refresh, pagination, details or other Activity filters. Keep `Any operation` available.
- If a **descriptor fetch or retry** succeeds and the selected operation is no longer registered, reset the operation filter to `Any operation`, return to the first activity page, and omit `toolName` from the next query. Otherwise preserve the current selection. (This refers to descriptor loading, not the Activity Refresh button.)
- No background polling. Fetch at mount and on explicit retry only.

**Explicit ActivityPanel state/action delta** (current definitions at `ActivityPanel.tsx:42–75,204–226`):

- `ActivityPanelViewState` gains `operations: McpOperationDescriptor[]`, `operationsLoading: boolean`, `operationsError: string | null`.
- `ActivityPanelViewActions` gains `onRetryOperations: () => void`; `toolName`/`onToolName` are unchanged.
- The controller gains a mount fetch via `fetchMcpOperations(signal)`; its failure sets **only** `operationsError` and leaves activity records, `loading` and `error` untouched. Following the existing `fetchActivity`/`fetchActivityByOperation` pattern (`ActivityPanel.tsx:204–226`, `tests/web/activity-panel.test.tsx:123–156`), the controller must accept `fetchMcpOperations` as an injectable dependency so tests can make it reject and prove isolation through the real code path.
- The view renders the grouped native `<select>` in place of the free-text input at `:135`, sourcing options entirely from `state.operations` (no component constant).

## 4. Exact implementation scope and work packages

### WP 2A — Central descriptor definitions

1. Add the grouped descriptor registry, named per-operation constants and deterministic list accessor in `packages/mcp-core/src/operation-descriptors.ts`.
2. Add entries for all 19 existing registrations.
3. Update `registerTools()`, `registerResources()` and `registerPrompts()` to source registration names/descriptions (and titles where present) from the named descriptor constants and pass the descriptor name to activity recording. Keep callbacks, schemas, URI/templates, MIME types, annotations and runtime semantics unchanged.
4. Export the public descriptor accessor/type from `packages/mcp-core/src/index.ts`.

### WP 2B — Validated read-only API

1. Add the strict response contract in `packages/contracts/src/mcp-operations.ts` and export it from the contracts barrel.
2. Add `GET /api/mcp/operations` in `apps/api/src/mcp-operation-routes.ts`.
3. Source the response exclusively from `listMcpOperationDescriptors()` (or the final equivalent accessor) exported by `@markethub/mcp-core`.
4. Validate the response with `mcpOperationListSchema` before returning it.
5. Return `Cache-Control: no-store` so a browser reload observes the deployed registration set. No periodic polling is needed.
6. Register this route in the existing Hono application. No new server, middleware framework, storage or authentication mechanism.

The response contains only public-facing registration descriptions and is read-only. It may follow the current LAN-readable model used by Activity reads. It must not expose credentials, access tokens, provider secrets, input schemas, raw SDK metadata, handlers or internal runtime details. This endpoint is **not** an authorization mechanism.

### WP 2C — Activity selector

1. Add a typed `fetchMcpOperations(signal?: AbortSignal)` client using the shared Zod contract and existing HTTP error conventions.
2. Load descriptors once when `ActivityPanel` mounts; abort or ignore stale work on unmount; expose a Retry action.
3. Replace the free-text tool-name filter with the grouped native Operation selector.
4. Keep mapping the selected descriptor `name` to the existing `toolName` filter query.
5. Preserve transport/status/date filters, operation-ID lookup, pagination, details, snapshot/historical links and Activity refresh behavior.
6. Keep the option list and Activity records independent: a descriptor API failure must not make Activity history unusable.

## 5. Files allowed to change

The implementation assignment may change only the following files unless the investigator demonstrates a concrete necessity and obtains approval before expanding scope.

**Core and contracts**

- `packages/mcp-core/src/operation-descriptors.ts` — new descriptor owner.
- `packages/mcp-core/src/tools.ts` — use tool descriptors for registration metadata and activity name.
- `packages/mcp-core/src/resources.ts` — use resource descriptors for registration metadata and activity name.
- `packages/mcp-core/src/prompts.ts` — use prompt descriptors for registration metadata and activity name.
- `packages/mcp-core/src/index.ts` — export the descriptor accessor/types.
- `packages/contracts/src/mcp-operations.ts` — new strict response schema/types.
- `packages/contracts/src/index.ts` — export the new contract.

**API and WebUI**

- `apps/api/src/mcp-operation-routes.ts` — new read-only route module.
- `apps/api/src/app.ts` — register the route.
- `apps/web/src/lib/activity.ts` — typed descriptor fetch client, or a small dedicated `apps/web/src/lib/mcp-operations.ts` (or similarly named) client file if justified.
- `apps/web/src/components/ActivityPanel.tsx` — selector, load/retry states and existing filter wiring.

**Tests**

- `tests/mcp/operation-descriptors.test.ts` — new registry/schema tests.
- `tests/mcp/tools.test.ts` — actual tool-list parity.
- `tests/mcp/resources.test.ts` — actual resource and resource-template parity.
- `tests/mcp/prompts.test.ts` — actual prompt-list parity.
- `tests/mcp/operation-routes.test.ts` — new API response and safety tests, or `tests/mcp/activity-routes.test.ts` if the route test fits cleanly there.
- `tests/web/activity-panel.test.tsx` — selector and controller tests.
- A focused WebUI client test may be added if needed to validate malformed responses and error handling.

Do not broaden scope to other documentation or implementation areas. Update the relevant metadata roadmap/implementation status only after the implementation is independently accepted, not pre-emptively.

## 6. Protected areas and non-goals

### Protected — must remain unchanged

- Activity persistence: `packages/database/src/repositories/mcp-activity.ts`, its schema and migrations.
- Existing shared Activity filters and response shape in `packages/contracts/src/mcp-activity.ts` and `/api/mcp/activity`.
- Existing `toolName` storage and API query contract.
- MCP transport and lifecycle behavior: Streamable HTTP, STDIO, handler creation, notification bridge, subscriptions/listen, Host/Origin checks and shutdown logic.
- M6-C history semantics and M6-D/E event delivery/integration behavior.
- Market-data services, provider adapters, broker credentials/configuration, subscriptions and capture/sync settings.
- Phase 3 instrument-picker implementation and its tests, except where an existing broad test command naturally exercises them.
- Database files, production data, migrations, manifests, lockfiles and dependencies.

### Explicit non-goals

- No `operationType` column, persisted type, API activity filter or migration.
- No operation type filter in the Activity UI; type is only a visual grouping.
- No new tool/resource/prompt or changes to existing operation behavior or MCP-visible metadata.
- No generic metadata registry, metadata database, microservice or universal schema-driven form renderer.
- No exposure of input JSON Schema, arguments, annotations, internal SDK objects, handler references, provider metadata or configuration.
- No `McpServer` private fields or `@internal` SDK methods.
- No categories, permissions, availability-state model or capability expansion in this increment.
- No change to the current M6 unavailable operations; they remain listed with honest descriptions.
- No new dependency, polling loop, background refresh worker or cache framework.
- No M6 scope change, provider-extensibility work, derivative expiry discovery or security-hardening scope from other phases.
- No commit, push, merge, rebase or amend without separate authorization.

## 7. Option and Metadata Impact Assessment — mandatory 18 questions

| # | Assessment | Phase 2 answer |
|---:|---|---|
| 1 | New selectable options, capabilities, entities or configuration fields? | The Activity panel gets one selectable option per registered MCP operation. No new MCP capability, domain entity or operational configuration is introduced. |
| 2 | Exact source of truth? | `packages/mcp-core/src/operation-descriptors.ts`; `registerTools()`, `registerResources()` and `registerPrompts()` consume the same named descriptor constants. No second backend list. |
| 3 | What kind of values are these? | Runtime registration metadata owned by the MCP application layer, not shared enum choices, provider capabilities, market-domain data or user-managed settings. The response shape itself is a shared contract. |
| 4 | How does each consumer obtain it? | MCP clients continue using standard MCP list methods. The API reads the mcp-core descriptor accessor and serves a read-only endpoint. WebUI fetches that endpoint and validates it against `@markethub/contracts`. REST/SSE market-data services and provider adapters do not consume this metadata. |
| 5 | Does an existing API, schema, registry or repository provide it? | No WebUI operation-metadata API or descriptor registry exists. The MCP registrations exist, but their current inline metadata is not exported as a safe WebUI contract. Activity history only stores operation names and is not a complete catalogue. |
| 6 | Is a new discovery API necessary, or is direct shared import sufficient? | A small read-only API is selected. The WebUI must not import `@markethub/mcp-core` because it is a server-side package that depends on the MCP server SDK. `apps/api` already depends on mcp-core, so it can bridge the shared source to the browser safely. |
| 7 | How do options appear without a frontend list edit? | The registration functions and endpoint use the same descriptor entries. WebUI renders the response array; adding a new descriptor and its actual registration makes it discoverable without editing ActivityPanel options. |
| 8 | Cache invalidation or refresh? | Fetch once on Activity panel mount and on explicit Retry. No polling. API response uses `Cache-Control: no-store`; a page reload picks up the deployed registry. |
| 9 | Sensitive metadata risks? | Only stable name, type, title and public description are allowed. No input schema, argument values, annotations, handler details, credentials, tokens, provider identifiers, secret or configuration fields. Strict schema rejects unapproved fields. |
| 10 | Tests proving source consistency and no duplicate definitions? | Compare descriptor names/type/description against real MCP `tools/list`, `resources/list` + `resources/templates/list`, and `prompts/list` results; compare `title` for resources/prompts and assert tools have none. Test endpoint response and selector options. Assert the browser does not maintain a second static list. |
| 11 | Shared contract impact? | Add a small `mcp-operations.ts` response schema and export it. Do not alter existing Activity or provider contracts. |
| 12 | Provider/runtime registration impact? | No provider identities/capabilities change. Preserve fixed `UPSTOX`/`FYERS` contracts and runtime registration. |
| 13 | MCP tool/resource/prompt impact? | All current registrations consume descriptors for their registration name and display metadata. No SDK internals. Preserve callbacks, schemas, URI templates, annotations and order. Descriptor types are derived from the tool/resource/prompt registry group. |
| 14 | REST/SSE/WebUI impact? | Add one read-only REST GET endpoint and use it only in ActivityPanel. Do not change SSE, activity filters, records, status or transport values. Existing UI hardcodes only the free-text operation field; replace that with server-provided descriptors. |
| 15 | Large/changing domain-data discovery? | Not applicable. This list is a small code-defined registration catalogue, bounded at 100; no pagination or catalog repository is needed. |
| 16 | Configuration persistence? | Not applicable. No user settings or operational configuration are introduced or modified. |
| 17 | Forward compatibility? | A new operation is added to the descriptor registry and consumed by its registration function. API and UI render the returned array, so no frontend options edit is needed. Tests enforce parity across all protocol list surfaces. |
| 18 | Dependency direction/circular imports? | `@markethub/contracts` remains a leaf contract package; `mcp-core` imports its schema/types; `apps/api` imports both; WebUI imports contracts and calls the API. WebUI must not import mcp-core. No cycle is introduced. |

## 8. Acceptance criteria

The phase is complete only when all of the following are demonstrated against the actual diff and test evidence.

### 8.1 Single source of truth and protocol parity

- [ ] The descriptor registry contains all 19 currently registered operations (9 tools, 7 resources, 3 prompts).
- [ ] Descriptor names exactly match actual MCP protocol registrations; resource parity includes both `resources/list` and `resources/templates/list`.
- [ ] Descriptor type matches the source registration group.
- [ ] Registration functions use the descriptor's stable name and display metadata; activity records use the same name.
- [ ] No second list of operation names, titles or descriptions is introduced in the API or WebUI.
- [ ] Order is deterministic across process runs.
- [ ] A newly added operation becomes available to the WebUI through the descriptor/API path without a frontend options-list change.

### 8.2 API contract and exposure

- [ ] `GET /api/mcp/operations` returns HTTP 200 and the strict `{ operations }` response.
- [ ] All records pass `mcpOperationDescriptorSchema`; response passes `mcpOperationListSchema`.
- [ ] The response is bounded (maximum 100), read-only and carries `Cache-Control: no-store`.
- [ ] Only `name`, `type`, `title`, `description` are returned. No SDK schema, raw handler, annotation, arguments, token, credential or operational configuration appears.
- [ ] Endpoint does not alter `/api/mcp/activity` response or filters.

### 8.3 WebUI behavior

- [ ] Activity panel shows `Any operation` by default and groups registered choices into Tools, Resources and Prompts.
- [ ] It displays stable operation names, plus existing titles for resources/prompts and the stable name as fallback for tools.
- [ ] Choosing one operation immediately applies the filter through the existing `toolName` query parameter (reset to page 1 and load).
- [ ] Transport, status and date filters continue working and combine correctly with operation selection.
- [ ] Selecting/changing an operation resets pagination to the first page as existing filter changes do.
- [ ] Loading, error and empty descriptor states are honest; Retry reloads descriptors.
- [ ] If descriptor loading fails, Activity history, refresh, pagination, detail views and result navigation remain usable with `Any operation`.
- [ ] No periodic polling, new dependency or custom form framework is added.

### 8.4 Regression and scope integrity

- [ ] Existing MCP tool/resource/prompt behavior, registrations and MCP-visible metadata remain unchanged apart from sourcing the same name/title/description from the descriptor module.
- [ ] Existing Activity persistence, filters, detail routes and history semantics are unchanged.
- [ ] No M6-D/E, transport, provider, database, migration, credential/configuration or Phase 3 picker scope is modified.
- [ ] Full tests, typecheck, build and diff checks pass; results are recorded as local or CI evidence accurately.
- [ ] Independent review confirms the actual diff matches this assignment.

## 9. Required tests

### 9.1 Descriptor module

Add `tests/mcp/operation-descriptors.test.ts` to verify:

- exactly 19 current descriptors and unique stable names;
- expected current type counts: 9 tools, 7 resources, 3 prompts;
- every descriptor passes the shared strict schema;
- no extra fields survive strict validation;
- list ordering is deterministic;
- descriptor list contains only safe display metadata.

### 9.2 Actual MCP registration parity

Extend the existing client-based tests, without accessing SDK internals:

- `tests/mcp/tools.test.ts`: compare `client.listTools()` entries with the tool descriptors; compare name and description, and assert every listed tool has no `title` (preserving current metadata).
- `tests/mcp/resources.test.ts`: compare the union of `client.listResources()` and `client.listResourceTemplates()` with resource descriptors. Do not compare only the static list.
- `tests/mcp/prompts.test.ts`: compare `client.listPrompts()` entries with prompt descriptors.
- Retain existing invocation tests to prove handlers, validation and service behavior remain intact.

### 9.3 API route

Test `GET /api/mcp/operations` for:

- HTTP 200, exact envelope and strict schema validation;
- all 19 records and expected type counts;
- no unapproved fields — assert raw JSON keys explicitly: every key is in `["description","name","title","type"]`, the four required keys `description`/`name`/`type` are always present, and `("title" in entry) === (entry.type !== "tool")` (the strict schema also fails loud on producer drift);
- `Cache-Control: no-store`;
- no mutation of activity rows and no change to existing activity route behavior.

### 9.4 WebUI/client

Extend `tests/web/activity-panel.test.tsx` and focused client tests as needed:

- `Any operation` is the default and option groups use descriptor type;
- all choices are sourced from the supplied descriptor state, not a component constant — **AC4 proof:** render the selector with a synthetic 20th descriptor passed in state and assert it appears, without editing selector code or mutating the exported registry;
- selected stable name maps to the existing `toolName` filter;
- operation selection combines with transport/status/date filters;
- pagination resets when the operation changes;
- loading, error, retry and empty states render correctly;
- descriptor fetch failure does not prevent activity refresh or use of other controls — **drive a real rejected fetch through the controller**, not just a preset view-state flag: extend the existing `makeController()` helper (`tests/web/activity-panel.test.tsx:123–156`) with an injectable `fetchMcpOperations` mock, make it reject, run the mount load, and assert (a) `operationsError` is set, (b) the activity list request still succeeds and records render, (c) activity `loading`/`error` are untouched, and (d) `onRetryOperations` re-invokes `fetchMcpOperations`. A separate view-level test may still assert the error/retry rendering; the controller test is what proves isolation;
- invalid descriptor response is rejected by the shared schema;
- removed operation selection is reset to `Any operation` after a successful descriptor fetch/retry, pagination returns to the first page, and the next activity query omits `toolName`;
- changing the Operation select immediately applies the filter (page 1 + load with the new `toolName`), matching Apply-filters behavior;
- `fetchMcpOperations(signal)` forwards the same signal object to `fetch` — mock `fetch` and assert `init.signal === signal`; assert `AbortError` propagates unchanged (a structural fake signal like `tests/web/retry-sleep.test.ts:5–26` may be reused if helpful).

### 9.5 Commands

Run from the repository root after inspecting the actual scripts and current Git state:

```bash
bun test tests/mcp/operation-descriptors.test.ts tests/mcp/tools.test.ts tests/mcp/resources.test.ts tests/mcp/prompts.test.ts tests/mcp/operation-routes.test.ts tests/mcp/activity-routes.test.ts tests/web/activity-panel.test.tsx
bun run typecheck
bun run build
bun test
git diff --check
```

If the API test is added to `activity-routes.test.ts` rather than a new file, adjust the focused command and report the exact commands actually run. Do not infer success from test creation. No live provider connection or market data is required for this phase.

## 10. Implementation control, verification and report format

This plan is not implementation authorization. Once separately authorized, OpenCode must:

1. Record `git status --short --branch`, branch name, HEAD, upstream sync and relevant worktree state before changes. Preserve all unrelated modifications and untracked files.
2. Re-read this plan and inspect the current local files; do not assume GitHub matches the active worktree.
3. Verify installed SDK types/source at implementation start. Do not rely on old SDK internals or inferred API shapes.
4. Implement in the order **2A → 2B → 2C**, keeping each increment within the files and invariants above.
5. Run targeted tests after each work package, then the full validation set in §9.5.
6. Inspect the complete final diff, including tests and docs, for scope drift, duplicate metadata, secret exposure, registration order changes and behavior regressions.
7. Record `git status --short --branch` after the task and list all preserved unrelated modifications.

The completion report must use these headings:

1. **Result:** complete / partial / blocked.
2. **Baseline:** branch, before/after HEAD, upstream status and before/after working-tree state.
3. **Files changed:** exact path and purpose.
4. **Descriptor parity:** counts and exact tool/resource/template/prompt comparisons.
5. **API evidence:** endpoint, response schema, cache header and safety checks.
6. **WebUI evidence:** selector states, filter wiring, retry and fallback behavior.
7. **Tests:** exact commands and actual pass/fail/assertion totals.
8. **Typecheck/build/diff:** exact outcomes.
9. **Option and Metadata Impact Assessment:** confirm all 18 answers still hold or list approved deviations.
10. **Protected-scope audit:** confirm database, M6 transports, provider/configuration, and unrelated features are untouched.
11. **Unverified items:** browser/CI/provider/network checks not run; distinguish local tests from CI.
12. **Git status and authorization:** report final state; do not commit or push without separate approval.

No commit, push, merge, rebase, amend or destructive cleanup is part of this assignment.

## 11. Risks, deferred decisions and references

### 11.1 Risks and mitigations

- **Descriptor drift:** mitigated by making registration functions consume named descriptor constants and testing parity against actual protocol list responses.
- **Incorrect resource counting:** resources may appear as static resources or templates. Test the union of both MCP list methods.
- **Overexposure:** keep the response to four display fields, strict and bounded; do not export schemas, annotations, credentials or handler state.
- **Activity availability during metadata failure:** load the descriptor list independently and retain `Any operation` so logs still work.
- **Stale selection after code change:** validate the selected name against a successful refreshed list and reset only when it no longer exists.
- **SDK drift:** verify the installed SDK types at implementation time; no internal SDK APIs are permitted regardless.

### 11.2 Explicitly deferred

- Persisted `operationType` and type-based filtering.
- Schema-derived operation forms and argument metadata.
- Operation categories, availability flags, annotations and permissions.
- General-purpose metadata endpoint/framework for every backend domain.
- Provider/capability discovery, derivative expiry discovery and configuration correctness phases.
- Separate security hardening of the existing catalog response.

These are separate architectural concerns and must not be pulled into this increment merely because the descriptor registry makes them conceivable.

### 11.3 Official technical references

Re-verify the latest stable protocol and installed SDK at implementation start. The current repository baseline is pinned to `@modelcontextprotocol/server@2.4.0` and documents MCP revision `2026-07-28`.

- MCP server discovery: <https://modelcontextprotocol.io/specification/2026-07-28/server/discover> — protocol versions/capabilities and server identity; not a list of operation descriptors.
- MCP tools: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools> — registered tool names, descriptions and input schemas.
- MCP resources: <https://modelcontextprotocol.io/specification/2026-07-28/server/resources> — resource listing/read model, including resource templates.
- MCP prompts: <https://modelcontextprotocol.io/specification/2026-07-28/server/prompts> — prompt listing and prompt metadata.
- Official TypeScript SDK tools guide: <https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html> — `registerTool()` and display title metadata.
- Official TypeScript SDK resources guide: <https://ts.sdk.modelcontextprotocol.io/v2/servers/resources.html> — static resources and resource templates.
- Official TypeScript SDK prompts guide: <https://ts.sdk.modelcontextprotocol.io/v2/servers/prompts.html> — prompt registration and title/description metadata.

---

**Completion definition:** Phase 2 is accepted only after actual registration parity, safe API delivery, a working Activity selector, regression validation and independent diff review are evidenced. Publishing the plan itself does not mark Phase 2 implemented.
