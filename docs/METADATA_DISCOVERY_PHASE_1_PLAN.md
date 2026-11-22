# MarketHubTS — Metadata Discovery Phase 1 Implementation Plan

**Plan basis:** Independently inspected repository source at `develop` commit `1b1925a20ae50bf187666a6c3406d89aa121736f`.
**Phase:** [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §4.1, Phase 1 — Shared contract consistency.
**First implementation milestone:** Phase 1 contract centralization plus the Phase 3 historical interval-selector increment. This UI increment is included because the roadmap explicitly groups it into the bounded first milestone. The catalog picker and MCP Operation selector remain later increments.
**Status:** Implementation plan only. No application source, tests, contracts, API, migration, manifest, dependency or runtime configuration has been changed by this plan; this document is added to the repository as documentation only. Every implementation step requires separate authorization.

**Governing documents:**
- [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) — authoritative architecture requirement (AD-025) and source-verified centralization inventory §10
- [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §4.1 — phase table and canonical implementation order
- [METADATA_DISCOVERY_FIRST_SLICE_PLAN.md](METADATA_DISCOVERY_FIRST_SLICE_PLAN.md) — bounded first slice
- [METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md](METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md) — program-level Phases 0–7 plan
- [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md) §4.1 — mandatory Option and Metadata Impact Assessment

---

## 0. Phase 1 in context

**Phase numbers are architectural groupings, not implementation order.** The canonical increment order (roadmap §4.1, program plan §1) is:

1. **This assignment** — Phase 1 shared-contract consistency + Phase 3 WP 3a (historical interval selector).
2. Phase 3 WP 3b–3c — reusable instrument picker using the existing bounded `GET /api/catalog/search`.
3. Phase 2 — MCP Activity Operation selector, after the descriptor-delivery decision.
4. Phases 4–6 as prerequisites clear; Phase 7 last.

Phase 2 is therefore **not** the second implementation task. This assignment deliberately stops at Phase 1 + the interval selector; do not pull the instrument picker or Operation selector into it merely because they appear in the larger initiative.

**Architecture areas covered by this assignment** (from architecture doc §10):

| Area | Covered here | Deferred to |
|---|---|---|
| A — Provider identity | Canonical leaf schema, all `@markethub/contracts` module consumers, and the `ProviderStatusView.id` type in WebUI `lib/status.ts:34` (duplicate TypeScript union removed) | Phase 5 (full provider-status response validation, fixed-key rendering in `App.tsx:133–134`, provider enumeration and extensibility — see architecture doc §10.A) |
| B — SSE event definitions | One contracts-owned event-name tuple and all producers/consumers | — |
| C — Duplicated contract values | CE/PE, HTTP/STDIO transport, ActivityPanel transport/status filter options, historical intervals | Retention classes (lower priority, Phase 6) |
| D — MCP operation discovery | Not in this phase | Phase 2 |
| E — Catalog/instrument discovery | Interval selector only | Phase 3 picker |
| F–J | Not in this phase | Phases 4–6 |

**Option and Metadata Impact Assessment (protocol §4.1 — all 18 questions answered):**

1. New options/capabilities/entities/config fields: **none** — this consolidates existing definitions.
2. Source-of-truth owner: `@markethub/contracts` (leaf provider identity, market option type, mcp-activity transport, live event names, historical intervals).
3. Category: shared contract enums/schemas (all five values).
4. Consumer discovery: direct import from `@markethub/contracts`; no HTTP discovery.
5. Existing API/schema: yes — all canonical schemas already exist; duplicates are the problem.
6. New discovery/read API necessary: **no** — not justified.
7. UI update on new registration: a new enum value reaches all consumers **that derive their values from the shared contract** at build time, with no frontend list edit. Consumers that still hold a duplicate literal are not covered until they are migrated; provider extensibility remains deferred to Phase 5 (see Q17).
8. Cache invalidation/refresh: **N/A** — no HTTP metadata; static imports need no cache policy.
9. Sensitive metadata: **none** — no credentials, tokens, secrets, internal provider identifiers or sensitive configuration are exposed; no new response surface.
10. Consistency tests: contract schema tests, SSE wire-compatibility tests, rendered interval-option test, existing regression suites.
11. Shared contract impact: high — provider identity, option type, transport, event names, intervals.
12. Provider/runtime registration impact: none — fixed `UPSTOX`/`FYERS` preserved; no registry change.
13. MCP tool/resource/prompt impact: none — no operation descriptors or registrations change.
14. REST/SSE/WebUI consumer impact: contract imports replace duplicated literals; wire behavior unchanged.
15. Domain-data discovery impact: none — no catalog or domain API change.
16. Configuration persistence impact: none — no config CRUD or storage change.
17. Forward compatibility: a new **interval** value reaches all consumers through the shared contract without a frontend edit. For **providers**, centralizing the identity schema removes the duplicate type but does **not** make adding another provider automatic — the status map, registry, adapters and application integration remain fixed to `UPSTOX`/`FYERS`; full provider addition still requires the Phase 5 contract, registry, status-map, adapter and API work.
18. Dependency direction: leaf module with no value imports from `provider.ts`/`live.ts`/`market.ts`; no cycle introduced.

---

## 1. Objective

Remove confirmed duplicate definitions of backend-owned identities and wire-contract values, and make the SSE event-name contract shared by the contract package, realtime backend, API route, WebUI and tests. Then remove the historical interval list duplicated in the WebUI and consume the existing shared contract directly.

The outcome must be a consistency refactor, not a behavior or product-scope change.

### Definition of done

1. `UPSTOX` and `FYERS` have one runtime Zod identity schema in a dependency-light contracts module. Existing public exports and the current fixed two-provider behavior remain compatible.
2. `CE` and `PE` are reused from `optionTypeSchema` in snapshot validation and the market-core identity input type.
3. MCP activity transport uses `McpActivityTransport` from `@markethub/contracts`, while the existing `ActivityTransport` export from `@markethub/mcp-core` remains available.
4. The six existing named SSE events have one exported contract tuple, and backend/API/WebUI consumers use it or derived constants. Existing event names, order, payloads, IDs and recovery behavior do not change.
5. `HistoricalPanel` renders every value from `candleIntervalSchema.options`; there is no local interval-value array.
6. Existing typecheck, build and regression suites pass. No API, database, migration, manifest, dependency or runtime configuration change is introduced.

---

## 2. Verified baseline and current source

The following observations are from the source at the plan-basis commit. Line numbers may move during implementation; verify names and usages against the checked-out working tree before editing.

| Concern | Current source | Verified issue |
|---|---|---|
| Provider identity | `packages/contracts/src/provider.ts` defines `providerIdSchema`; `market.ts`, `live.ts`, `live-components.ts`, `historical.ts` and `snapshots.ts` repeat the same two values in schemas. | Multiple runtime definitions can drift. `provider.ts` imports `providerConnectionStateSchema` from `live.ts`, so moving the canonical value into `live.ts` would create an avoidable cycle. |
| Provider public aliases | `market.ts` exports `providerSchema` / `Provider`; `provider.ts` exports `providerIdSchema` / `ProviderId`; `contracts/src/index.ts` star-exports both modules. | Preserve all currently exported names. Do not create duplicate root-barrel exports. |
| Provider fixed-key records | `live.ts:150–153` hardcodes `UPSTOX`/`FYERS` as object keys in `liveItemSchema.observations`; `provider.ts:113–116` does the same in `ProviderStatusMap`. | Deliberate fixed-key boundary representations, like `ProviderStatusMap` — not runtime enum duplication. Classify as retained boundary copies in the implementation report (§8 item 4); include them in the §5 preflight search so the classification is verified, not assumed. |
| Option type | `packages/contracts/src/market.ts` owns `optionTypeSchema` / `OptionType`; `snapshots.ts` repeats `z.enum(["CE", "PE"])`; `packages/market-core/src/identity.ts` repeats the `"CE" | "PE"` union in `IdentityInput`. | Runtime and compile-time representations are duplicated. |
| MCP activity transport | `packages/contracts/src/mcp-activity.ts` owns `mcpActivityTransportSchema` / `McpActivityTransport`; `packages/mcp-core/src/activity.ts` declares `ActivityTransport = "HTTP" | "STDIO"`. | A type-only duplication. `ActivityTransport` is re-exported by `packages/mcp-core/src/index.ts`; preserve that export. |
| SSE event names | `packages/contracts/src/live.ts` has payload schemas for five event types. `snapshot` is a transport event carrying `liveSnapshotSchema`, not a discriminated payload with `type: "snapshot"`. `apps/web/src/lib/live-stream.ts` declares `SSE_EVENT_NAMES`; `packages/realtime/src/types.ts` documents a literal list but types `OutboundEvent.event` as `string`; `hub.ts` and `apps/api/src/market-routes.ts` repeat event strings. | Six named transport events are not owned by one shared contract. |
| Historical interval selector | `packages/contracts/src/historical.ts` defines 16 `candleIntervalSchema` values. `apps/web/src/components/HistoricalPanel.tsx` imports that schema for validation but separately declares a 7-value `INTERVALS` array. | Nine valid intervals are absent from the selector; a supported focus value such as `30m` can validate but cannot be selected in the UI. |
| Package boundaries | `packages/contracts` exports `./src/index.ts`; `apps/web` depends on `@markethub/contracts`; realtime and MCP already import contract types/schemas. | No new package or runtime dependency is needed. |

### Existing six SSE event names — preserve exactly

1. `snapshot` — initial snapshot transport event; payload is the `LiveSnapshot` object validated by `liveSnapshotSchema`.
2. `item-updated` — revisioned data event.
3. `item-removed` — revisioned data event.
4. `provider-connection-changed` — revisioned data event requiring snapshot refresh.
5. `snapshot-required` — control event; does not advance the data revision.
6. `refresh` — control event; does not advance the data revision.

Do not add a synthetic `snapshot` payload schema merely to make event names look uniform. Do not change wire payloads, event IDs or whether control events advance revisions.

---

## 3. Scope boundaries

### In scope

- A small dependency-free provider identity module inside `packages/contracts`.
- Reuse the canonical provider and option-type schemas in existing contracts, and use the shared `ProviderId` type for the WebUI `ProviderStatusView.id` field (type only — no response validation or fixed-key rendering change).
- Reuse the shared activity transport type.
- Derive the Activity panel's transport and status filter options from the shared contracts (`mcpActivityTransportSchema`, `mcpActivityStatusSchema`) instead of hardcoded literals.
- One shared, typed SSE event-name contract used by all current producers and consumers.
- Historical interval selector derives its options from `candleIntervalSchema.options`.
- Focused regression tests and whole-repository typecheck/build/test validation.

### Explicitly out of scope

- Dynamic provider registration or changing `ProviderId` from the fixed `UPSTOX` / `FYERS` union.
- Changing `ProviderStatusMap`, the provider-status HTTP response, provider adapters, auth workflows or provider selection policy.
- New metadata/discovery HTTP endpoint, operation descriptors, MCP Activity Operation selector or operation-type filtering.
- Catalog instrument picker, faceted catalog search, derivative expiry discovery or catalog population.
- New database columns, migrations, SQL CHECK changes or persisted-data transformations.
- Changing SSE event names, order, payloads, IDs, replay rules, queue policy, refresh/recovery semantics or public REST/SSE behavior.
- New dependencies, package boundaries, generic registries, universal form renderers or unrelated cleanup.
- Any M6-C, M6-D, M6-E, B4, Stage G or physical LAN scope change.

---

## 4. Implementation design

### 4.1 Provider identity: introduce a dependency-light leaf module

**New file:** `packages/contracts/src/provider-identity.ts`

Move the canonical `providerIdSchema` and `ProviderId` type into this module. It must import neither `live.ts` nor `provider.ts` (or any other module that creates a cycle). Its dependency should be limited to Zod.

**Dependency-direction note:** the existing `provider.ts` ↔ `live.ts` cycle pressure is already avoided today because `live.ts:2` imports `ProviderId` as a type (erased at runtime) and inlines its own value schema (`live.ts:9–12`). The leaf module does not "remove" that existing pressure — it ensures the new canonical identity schema adds **no** runtime import from `provider.ts`, `live.ts` or `market.ts`, so consumers can import it as a value without creating a cycle.

Then update consumers:

| File | Required change |
|---|---|
| `packages/contracts/src/provider.ts` | Import and re-export `providerIdSchema` / `ProviderId` from the leaf module. Keep provider configuration, status and adapter contracts unchanged. Keep the runtime import of `providerConnectionStateSchema` from `live.ts`. |
| `packages/contracts/src/market.ts` | Replace the local provider enum with `providerSchema = providerIdSchema`; preserve `Provider` as a type alias to `ProviderId`. Keep `provenanceSchema.provider` using `providerSchema` so its public shape is unchanged. |
| `packages/contracts/src/live.ts` | Replace private `liveProviderIdSchema` with the leaf `providerIdSchema` (a local alias is acceptable for readability). This updates all four usages: `providerConnectionStatusSchema`, `providerObservationSchema`, `selectedObservationSchema` and `liveProviderConnectionChangedEventSchema.provider` (`:192`). Import `ProviderId` as a type from the leaf module rather than through `provider.ts`. |
| `packages/contracts/src/live-components.ts` | Use the leaf provider schema in `capabilityResultSchema`; import the `ProviderId` type from the leaf module. |
| `packages/contracts/src/historical.ts` | Replace every repeated provider enum in candle, request, note and policy schemas with the leaf provider schema. Import the type from the leaf module. |
| `packages/contracts/src/snapshots.ts` | Replace repeated provider enums in snapshot and capture schemas with the leaf provider schema. Import the type from the leaf module. |
| `packages/contracts/src/index.ts` | Prefer preserving the existing barrel: it already exports `provider.ts`, which should re-export the leaf symbols. Avoid duplicate `export *` names unless the TypeScript barrel is deliberately reconciled and verified. |
| `apps/web/src/lib/status.ts` | Replace the duplicate `id: "UPSTOX" \| "FYERS"` union in `ProviderStatusView` (`:34`) with the shared `ProviderId` type imported from `@markethub/contracts`. **Phase 1 scope is this type only** — do not validate the full provider-status response, change the `providers: Record<"UPSTOX" \| "FYERS", ...>` shape (`:46`), alter fixed-key rendering in `App.tsx:133–134`, or add provider enumeration. Those remain Phase 5. Preserve current API behavior. |

**Compatibility requirements:**

- `@markethub/contracts` continues to export `providerIdSchema`, `ProviderId`, `providerSchema` and `Provider` under their existing names.
- `providerSchema` should be an alias of the same schema instance, not a separately constructed `z.enum`.
- `ProviderStatusMap` and `providerStatusMapSchema` remain fixed to `UPSTOX` and `FYERS`. This phase does not make providers dynamically extensible.
- Do not silently widen any provider type or change validation behavior.

### 4.2 Option type: reuse the existing market contract

`packages/contracts/src/market.ts` remains the owner of `optionTypeSchema` / `OptionType`.

- In `packages/contracts/src/snapshots.ts`, import `optionTypeSchema` and `OptionType`; use the schema in the nested strike schema and the type in `OptionChainStrike.optionType`.
- In `packages/market-core/src/identity.ts`, import `OptionType` as a type and use it for `IdentityInput.derivative.optionType` instead of repeating the string union.
- Leave SQL CHECK values and provider-native adapter mappings unchanged. SQL cannot import TypeScript contracts; adapters may translate provider-native values at their boundary.
- Do not rename the public `OptionType` or `optionTypeSchema` exports.

### 4.3 MCP activity transport: reuse the shared type

In `packages/mcp-core/src/activity.ts`:

- Import `McpActivityTransport` as a type from `@markethub/contracts`.
- Define the current public alias as `export type ActivityTransport = McpActivityTransport` (or an equivalent direct alias).
- Keep `WithActivityArgs.transport` and all call sites unchanged.
- Keep `packages/mcp-core/src/index.ts` exporting `ActivityTransport` under its current name.

There is no need for a new runtime transport schema: `mcpActivityTransportSchema` already owns runtime validation in the contracts package.

### 4.4 SSE event names: one contracts-owned tuple

In `packages/contracts/src/live.ts`, define and export one canonical tuple in the existing wire order:

```ts
export const LIVE_EVENT_NAMES = [
  "snapshot",
  "item-updated",
  "item-removed",
  "provider-connection-changed",
  "snapshot-required",
  "refresh"
] as const;
export type LiveEventName = (typeof LIVE_EVENT_NAMES)[number];
```

For readable call sites, export named constants derived from the tuple rather than repeating string literals in producers. The tuple remains the single source of literal values. Use exactly these six names so implementers and tests share one vocabulary:

`LIVE_EVENT.snapshot`, `LIVE_EVENT.itemUpdated`, `LIVE_EVENT.itemRemoved`, `LIVE_EVENT.providerConnectionChanged`, `LIVE_EVENT.snapshotRequired`, `LIVE_EVENT.refresh`.

Use the contract as follows:

| Consumer | Required change |
|---|---|
| `packages/contracts/src/live.ts` | Use named constants derived from `LIVE_EVENT_NAMES` in the five existing `z.literal` event payload schemas. Do not create a `type: "snapshot"` payload schema; `snapshot` remains transport-only and carries the existing `LiveSnapshot`. |
| `packages/realtime/src/types.ts` | Change `OutboundEvent.event` from `string` to `LiveEventName`. Remove the manually maintained event-name comment/list or refer to the contract type. |
| `packages/realtime/src/hub.ts` | Use shared event constants for the initial `snapshot`, `snapshot-required` control events and `refresh`. Data events continue to use `event.type` from `LiveChangeEvent`. Queue coalescing comparisons must use the same shared constants. |
| `apps/api/src/market-routes.ts` | Use the shared `snapshot-required` event constant when writing the invalid-cursor SSE response. |
| `apps/web/src/lib/live-stream.ts` | Import the tuple from `@markethub/contracts`. Keep `SSE_EVENT_NAMES` as an alias to `LIVE_EVENT_NAMES` for compatibility with current imports/tests, rather than maintaining a second array. |
| `apps/web/src/lib/live.ts` | Derive the control-event type from the shared constants: `type LiveControlEventName = typeof LIVE_EVENT.snapshotRequired \| typeof LIVE_EVENT.refresh;` and use it for the `control` field at `:55`. Replace the two literal return values in `parseSseMessage()` (`:73`, `:76`) with the shared constants. Preserve all existing parsing, classification and recovery behavior. |
| Tests | Import the contract tuple/constants when enumerating events. Keep a deliberate wire-compatibility assertion for the exact six names and order. Ensure listeners, hub output and route output still match. |

Do not change `parseSseMessage` semantics. It currently distinguishes full snapshot payloads, revisioned data events and control events by payload shape; preserve that design. The `live.ts` change is type/constant substitution only — no parsing or recovery behavior changes.

### 4.5 Historical interval selector: derive options directly

In `apps/web/src/components/HistoricalPanel.tsx`:

- Remove the local `INTERVALS: CandleInterval[]` array.
- Continue using `CandleInterval` for state and public form types.
- Render options from `candleIntervalSchema.options` directly.
- Keep the current default interval (`1D`), control label, form submission shape and backend validation unchanged.
- Do not create an API call for intervals. The WebUI already depends on `@markethub/contracts` and imports `candleIntervalSchema` for validation.

This closes the concrete mismatch: a focus interval such as `30m` already passes `historicalFocusToForm()` but was absent from the seven-item selector.

### 4.6 Activity filter options: derive from shared contracts

In `apps/web/src/components/ActivityPanel.tsx`:

- Replace the hardcoded transport `<option>` literals (`HTTP`/`STDIO` at `:134`) with options derived from `mcpActivityTransportSchema.options` (`packages/contracts/src/mcp-activity.ts:10`).
- Replace the hardcoded status `<option>` literals (`started`/`succeeded`/`failed`/`interrupted` at `:138–139`) with options derived from `mcpActivityStatusSchema.options` (`mcp-activity.ts:6`).
- Keep the existing "Any transport"/"Any status" empty-value default, the `buildActivityQuery` filter shape (`:78–88`), and the per-status tone mapping (`:26–31`) unchanged — tone mapping is presentation-only and stays local.
- Do **not** add an operation-type filter or change the `toolName` free-text filter; those are later-phase work (Phase 2 / deferred type filtering).

This fulfils program-plan WP 1d and architecture doc §10.C. No API or contract change is needed — the WebUI already imports from `@markethub/contracts`.

---

## 5. Recommended execution order

Keep this as one bounded implementation assignment, but complete and validate each stage before proceeding to the next.

1. **Preflight and complete inventory.** Verify actual branch/HEAD, working-tree state and all existing modifications. Preserve them — including untracked documentation files such as `docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` and any uncommitted plan/doc-map changes. Run repository-wide searches for provider literals, `CE`/`PE` unions, activity transport unions, SSE event-name literals and interval arrays. Reconcile any additional actual consumer before editing; do not blindly trust the list in this plan if the checkout differs.
2. **Provider identity leaf and compatibility exports.** Introduce `provider-identity.ts`, update provider/market/live/live-components/historical/snapshots modules and the WebUI `ProviderStatusView.id` type, then typecheck the contracts package and workspace.
3. **Option type and activity transport.** Reuse `optionTypeSchema` / `OptionType` and `McpActivityTransport`; check all public imports and type-only dependency direction.
4. **Activity filter options.** Derive `ActivityPanel` transport/status options from the shared schemas; keep the empty-value defaults and local tone mapping.
5. **SSE event-name contract.** Add the tuple and derived constants, narrow `OutboundEvent.event`, then update hub, API route, WebUI alias and tests. Verify wire names and order are unchanged.
6. **Historical interval selector.** Remove the local array and render the shared schema options. Add a regression assertion that all 16 schema values appear and `30m` is available.
7. **Cross-package validation and independent diff review.** Run focused suites first, then typecheck, build and the full test suite. Inspect the complete diff for API/wire/behavior changes and ensure Phase 1 did not expand into later metadata work.

Do not combine the instrument-picker or MCP Operation-selector work into this assignment merely because they appear in the larger metadata initiative.

---

## 6. Test plan and acceptance evidence

### 6.1 Provider identity and public compatibility

- Create `tests/market/contract-identity.test.ts` (new file; there is no `tests/contracts/` directory today) to assert the canonical provider schema accepts exactly `UPSTOX` and `FYERS` and rejects an unknown provider.
- In the same file, assert `providerSchema` remains the same schema alias as `providerIdSchema`.
- Exercise representative provider fields in market provenance, live observations, historical records/requests and snapshot payloads to ensure parsing behavior has not changed.
- Keep `ProviderStatusMap` and provider registry tests intact; verify two fixed keys and current status behavior.
- Verify WebUI `ProviderStatusView.id` uses the shared `ProviderId` type (typecheck-level assertion) and that no duplicate `"UPSTOX" | "FYERS"` union remains in `lib/status.ts:34`; confirm the `providers` response shape and `App.tsx` fixed-key rendering are unchanged.
- Review the dependency graph and confirm `provider-identity.ts` imports no provider/live/market module and no runtime cycle was introduced.

### 6.2 Option type and transport

- Verify `optionTypeSchema` continues to accept `CE` and `PE` and rejects other values.
- Exercise snapshot-envelope parsing for both option types.
- Run market identity/catalog tests to verify identity-key behavior for CE and PE is byte-for-byte unchanged.
- Run MCP activity tests and typecheck to verify `ActivityTransport` remains publicly importable and exactly matches `McpActivityTransport`.
- Extend `tests/web/activity-panel.test.tsx` to assert the transport and status `<option>` values are derived from the shared schemas (all four statuses, both transports, plus the empty "Any" defaults) and that the existing filter query shape is unchanged.

### 6.3 SSE event contract and wire compatibility

- Pin the exact event tuple and order to the six existing names listed in §2, in `tests/market/contract-identity.test.ts` (new file named in §6.1).
- Verify `OutboundEvent.event` is restricted to `LiveEventName` at compile time.
- Run realtime hub tests for initial snapshot, item updates/removals, provider connection changes, overflow `snapshot-required`, and `refresh`.
- Run API stream-route tests to verify event names, IDs, payload JSON and termination behavior remain unchanged.
- Run WebUI live-stream tests to verify all six listeners are registered, invoked and removed, and recovery/refresh behavior remains unchanged. In `tests/web/live-stream.test.ts`, derive the `emitControl()` helper's accepted type from the shared `LIVE_EVENT` constants (for example `typeof LIVE_EVENT.snapshotRequired | typeof LIVE_EVENT.refresh`) rather than maintaining another `"refresh" | "snapshot-required"` literal union.
- Explicitly verify that `snapshot` still carries a `LiveSnapshot` payload without a `type` discriminator and that control events still carry no revision ID.

### 6.4 Historical selector

- Add a **new** render-based assertion to `tests/web/historical.test.ts` (that file currently tests pure functions only and does not render the component). `HistoricalPanel` uses React hooks, so render it with `renderToStaticMarkup(createElement(HistoricalPanel, {}))` from `react-dom/server` — do **not** invoke `HistoricalPanel()` directly. Verify every `candleIntervalSchema.options` value is present as an option.
- Verify `30m` appears; retain the existing `historicalFocusToForm` valid/invalid interval tests.
- Verify the default remains `1D` and existing historical request/config shapes are unchanged.

### 6.5 Commands

Run from repository root (adjust only if the repo protocol specifies a more focused command):

```bash
bun test tests/market/contract-identity.test.ts
bun test tests/web/activity-panel.test.tsx
bun test tests/web/historical.test.ts
bun test tests/web/live-stream.test.ts
bun test tests/market/realtime-hub.test.ts tests/market/stream-routes.test.ts
bun test tests/market/components.test.ts tests/market/catalog.test.ts
bun test tests/providers/registry.test.ts tests/providers/components.test.ts
bun run --filter @markethub/contracts typecheck
bun run typecheck
bun run build
bun test
git diff --check
```

Report actual command output and pass/fail totals. Do not claim tests were run if they were not. If the package-filter syntax differs in the checked-out Bun version, run the package script directly and report the exact command.

### 6.6 Acceptance gate

Phase 1 is accepted only when:

- No production duplicate provider identity enum remains in the reviewed contract modules, and WebUI `ProviderStatusView.id` uses the shared `ProviderId` type with no duplicate union.
- No duplicate CE/PE schema or market-core type union remains in the reviewed target modules.
- `ActivityTransport` is an alias to the shared contract type.
- ActivityPanel transport/status filter options are derived from `mcpActivityTransportSchema`/`mcpActivityStatusSchema`; no hardcoded **backend-value** option literals (HTTP/STDIO or status values) remain in the component. The empty-value "Any transport"/"Any status" defaults are presentation-only and are retained per §4.6.
- The named SSE event contract is consumed by hub, API and WebUI; the event tuple is not re-declared in production consumers.
- Exact SSE wire names/order/payload/revision semantics remain unchanged under tests.
- All 16 historical intervals are selectable from the shared schema.
- Compatibility exports and all existing regression tests pass.
- No later-phase scope has leaked into the diff.

Source search should be part of the review, not a brittle runtime test that merely checks filenames. Use actual repository-wide search results to confirm any duplicates that remain are deliberate boundary representations (for example SQL CHECK literals or provider-native adapter mappings).

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Runtime import cycle between `provider.ts` and `live.ts` | Put provider identity in a dependency-free leaf module; keep provider connection-state ownership in `live.ts`. |
| Breaking public imports during relocation | Re-export `providerIdSchema` and `ProviderId` through `provider.ts`; preserve `providerSchema`, `Provider` and `ActivityTransport` aliases. Run workspace typecheck. |
| Accidentally changing supported providers | Keep the canonical schema exactly `UPSTOX` / `FYERS`; leave status map, registry and adapters unchanged. |
| Event-name drift or wire behavior change | Define exact existing six names once, derive schema literals and producers from constants, and retain wire-compatibility tests. Treat `snapshot` as transport-only. |
| Incorrectly widening outbound events | Use `LiveEventName` in `OutboundEvent`; ensure every event producer is one of the six contract names. |
| Option-type duplication survives in identity code | Use `OptionType` in the market-core input type; leave SQL/native mapping representations at their boundaries. |
| UI options still omit valid intervals | Render from `candleIntervalSchema.options` and test all 16 values in rendered markup. |
| Unrelated local changes get staged | Preflight and stage only reviewed Phase 1 source/test paths; preserve all existing user modifications and untracked documentation files. |

---

## 8. Required implementation report

The implementation agent must report:

1. Starting and ending HEAD, branch and working-tree state.
2. Exact changed source and test files.
3. Provider-identity dependency graph and public-export compatibility results.
4. Confirmed remaining provider/option/transport duplicates and why each boundary copy is retained.
5. SSE tuple consumers updated and exact confirmation of unchanged wire behavior.
6. Historical selector verification showing all 16 options, including `30m`.
7. Exact validation commands, results, failures and unverified areas.
8. Confirmation that no API, database, migration, dependency, runtime config, provider-extensibility or later metadata-selector work was included.
9. Complete diff summary and explicit list of preserved unrelated user changes.

No commit or push is authorized by this plan. Obtain separate authorization after implementation and independent diff review.
