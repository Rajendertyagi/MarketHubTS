# MarketHubTS — Metadata Discovery Phase 6 Implementation Plan

> **Document type:** Technical implementation plan and bounded execution specification  
> **Status:** WP6A and WP6B implemented, independently reviewed and published. WP6C remains pending separate authorization.
>
> **Repository:** `Rajendertyagi/MarketHubTS`  
> **GitHub branch reviewed:** `develop`  
> **Reviewed HEAD:** `a1df3d1964dac209af20bd9f797bc25d99efb278`  
> **Review date:** 2026-11-23  
> **Governing protocol:** `docs/PROJECT_MANAGER_PROTOCOL.md`  
> **Initiative:** `docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md`, Phase 6

This document is the technical lead's plan. OpenCode must execute the decisions and boundaries defined here; it must not replace this document with a new architecture plan or ask the product owner to re-decide the settled technical details. The agent must still inspect its actual local checkout and Git status immediately before implementation, because its local state may differ from the GitHub baseline reviewed here.

**Permission boundary:** This plan authorizes planning only. Each work package requires separate explicit implementation approval. Implementation approval does not authorize a commit, push, merge, rebase, amend, or any other Git history/ref change. No repository files were changed while preparing this plan.

---

## 1. Executive decision

Phase 6 closes three bounded correctness and presentation gaps:

| Work package | Scope | Decision |
|---|---|---|
| **WP6A — Retention consistency** | Shared response contracts, safe retention form editing, honest saved-settings state, complete fail-closed regression coverage | Retain the existing retention policy and storage. Add shared response schemas, preserve raw input while editing, validate on save, and distinguish valid-empty from missing/invalid settings. |
| **WP6B — Snapshot provider selection** | Explicit provider selection and correct UI semantics | Keep saved configs explicit. Remove the silent FYERS default, derive provider choices from the shared provider schema, require a deliberate provider selection, and clearly explain that explicit selection has no fallback. Do not call the current ordered fallback “automatic routing.” |
| **WP6C — Overview accuracy** | Correct implemented / locked / incomplete / unimplemented labels | Correct the Overview to match the source and project status. Use the existing `mcp.httpHandlerMounted` field for the MCP HTTP handler row. Do not add a backend endpoint or alter readiness. |

**Execution order:** WP6A → independent review → WP6B → independent review → WP6C → independent review. Do not combine the three implementations into one batch.

### Why WP6B does not add an “Automatic” UI option

The repository's general provider direction says automatic source selection should consider actual capability, availability, freshness, reliability, and account limits. The current snapshot service does not implement that policy. Omitting `provider` currently means only “try the injected provider array in its existing order”; it does not rank providers by capability, entitlement, freshness, reliability, or limits. In the production API composition the snapshot service is constructed with `providers: []`, so no provider-backed capture is currently active.

The official Upstox and FYERS option-chain APIs also have different request models. Upstox requires an `instrument_key` and `expiry_date`; FYERS requires a `symbol`, and uses different options such as `strikecount`, `timestamp`, and `greeks`. Neither vendor API defines MarketHub's cross-provider priority policy. An “Auto” label over today's simple array-order fallback would overstate what the application does.

Therefore Phase 6 keeps the UI explicitly manual and truthful. Capability-aware automatic selection remains a separate future design/implementation item that must only be claimed after the real provider path and selection policy exist.

### 1.1 Review focus — failure modes this phase must close

These are the failure modes most likely to survive a happy-path implementation. Each is pinned to a concrete test or independent source assertion:

1. **Retention settings look valid when they are missing or malformed.** Pin with `AppSettings.getRetention()` and API fail-closed tests in `tests/market/historical-routes.test.ts`.
2. **A valid empty retention configuration is mistaken for an invalid configuration, or vice versa.** Pin both cases with shared-schema, persistence and cleanup tests in `tests/market/historical-routes.test.ts` and `tests/web/historical.test.ts`.
3. **An invalid number typed into the retention form disappears or is silently treated as a blank/no-limit value.** Pin the pure `parseRetentionDraft()` helper with table-driven tests in `tests/web/historical.test.ts`; verify raw form text is retained on validation failure.
4. **An explicit snapshot provider fails but another provider is silently called.** Pin explicit-provider exclusivity and no-fallback behavior in `tests/market/snapshots.test.ts`.
5. **Array-order fallback is presented as capability-aware automatic routing, or the WebUI reintroduces a duplicated provider list.** Pin omitted-provider order in `tests/market/snapshots.test.ts`, the selection helper in `tests/web/snapshots.test.ts`, and a CWD-independent source assertion that the WebUI has no duplicated provider union/tuple.
6. **The Overview presents an endpoint being mounted as proof that its full milestone is accepted, or claims live provider data is operational.** Pin mounted/unmounted copy and implemented/locked/not-accepted distinctions in `tests/web/overview-status.test.tsx`.

---

## 2. Repository review and verified baseline

### 2.1 GitHub state reviewed

- Repository: `Rajendertyagi/MarketHubTS`
- Branch: `develop`
- HEAD at review: `a1df3d1964dac209af20bd9f797bc25d99efb278`
- HEAD commit message: `docs: fix four remaining stale Phase 5 status references`
- The commit inspected is the current `develop` branch head returned by GitHub on 2026-11-23.
- The GitHub recursive tree and the source/docs/test files listed below were inspected at that ref.

This is a GitHub remote review, not a claim about the OpenCode machine's working tree. Before execution, OpenCode must report its own `git status --short --branch`, `git rev-parse HEAD`, and whether it is on the expected branch. If local code or branch state differs, preserve the work and stop to report the discrepancy before making edits.

### 2.2 Governing repository documents

The design and limits below were checked against:

- `docs/PROJECT_MANAGER_PROTOCOL.md` — role ownership, implementation workflow, 12 mandatory assignment sections, 18-question impact assessment, Git and permission boundaries.
- `docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md` — Phase 6 definition and Phase 7 dependency.
- `docs/METADATA_AND_CAPABILITY_DISCOVERY.md` — AD-025 and source-of-truth inventory, especially areas H, I and J.
- `docs/ARCHITECTURE_DECISIONS.md` — AD-025 ownership and fixed `UPSTOX` / `FYERS` identity boundary.
- `docs/IMPLEMENTATION_ROADMAP.md` §4.1 — implementation order, intended scope and acceptance.
- `docs/ENGINEERING_STANDARDS.md` — modularity, dependency direction, testing, reliability and no unnecessary layers.
- `docs/TESTING_AND_ACCEPTANCE.md` — evidence-based test expectations and separation of local verification from CI.
- `docs/PROJECT_STATUS.md` — M6 and Stage G implementation/acceptance state.
- `docs/PROVIDER_INTEGRATION.md` — provider independence and the longer-term capability-aware source-selection requirement.
- `docs/METADATA_DISCOVERY_PHASE_5_PLAN.md` — Phase 5 close-out and the current provider metadata model.

### 2.3 Current project milestone boundaries

At the reviewed baseline:

- Metadata discovery Phases 1, 2, 3 and 5 are recorded as implemented and published on `develop`.
- Phase 4 derivative expiry discovery remains blocked on a real catalog population path and a bounded query. It is not part of Phase 6.
- Phase 6 WP6A (retention consistency) and WP6B (snapshot provider selection) are implemented, independently audited to KEEP and published on `develop`; WP6C (Overview accuracy) remains pending separate authorization. Phase 6 is therefore not yet complete.
- Phase 7 is the final cross-system acceptance phase and depends on previous phases.
- M6-D/E source and tests are present on `develop`, but neither phase is accepted or complete. M6-B4 remains separately owned and not accepted.
- Production market-data drivers remain locked. There is no verified live provider socket/feed, and no provider-backed historical or option-chain retrieval is active.

Do not use Phase 6 to unblock Phase 4, claim Phase 7 acceptance, change M6-D/E or M6-B4 scope, or activate Stage G.

---

## 3. Official documentation and API research

Research was checked against official vendor/framework documentation on 2026-11-23. These sources inform the decisions below; they do not establish that MarketHub has activated or verified live provider access.

### 3.1 Zod — shared schema ownership and validation

**Official documentation:** https://zod.dev/api?id=enums

The repository pins Zod `4.6.7` in `packages/contracts` and `apps/api`. The contract package already owns Zod schemas and inferred types. This phase should extend that existing contract layer for the two retention response payloads; it must not introduce a second set of frontend/backend response interfaces.

The project already derives UI options from shared Zod schemas, for example `candleIntervalSchema.options` in `HistoricalPanel.tsx`. Use the same established project pattern with `providerIdSchema.options`; do not create another provider array in the WebUI.

No Zod upgrade, package change, or new validation dependency is required.

### 3.2 React — controlled form input behavior

**Official documentation:** https://react.dev/reference/react-dom/components/input

The repository uses React `19.3.1`. React's controlled-input guidance requires a controlled input's `value` to be updated synchronously by its `onChange` handler. This supports the WP6A decision to keep the exact raw text being typed in component state and validate it on save. A number such as `0`, `1.5`, or a temporarily incomplete value must not be silently converted to an empty field while the user is typing.

No form library or new dependency is required.

### 3.3 Hono — request/response validation

**Official documentation:** https://hono.dev/docs/guides/validation

The API uses Hono `4.13.18` and currently performs route validation with existing Zod `safeParse` calls. Hono documents a thin validation layer and the option to integrate a validator. For this phase, keep the current local `safeParse`/schema-parse style and the existing route structure. Do not add `@hono/zod-validator` or change middleware architecture merely to validate two response envelopes.

### 3.4 Upstox — official option-chain interfaces

**Official option-chain API:** https://upstox.com/developer/api-documentation/get-pc-option-chain/  
**Official option-contract API:** https://upstox.com/developer/api-documentation/get-option-contracts/

The current Upstox option-chain endpoint is `GET /v2/option/chain`. Its documented required query parameters include `instrument_key` and `expiry_date`. The related option-contract endpoint is `GET /v2/option/contract`, where `instrument_key` is required and `expiry_date` is optional.

These APIs define Upstox's provider-specific requests. They do not define an application-level rule for preferring Upstox over FYERS or for retrying another provider after an explicitly selected Upstox request fails.

### 3.5 FYERS — official option-chain interface

**Official option-chain API:** https://fyers.in/api-docs/v3/api/market-data/option-chain/

The documented FYERS option-chain interface uses a required `symbol` and options including `strikecount` (maximum 50), `timestamp`, and `greeks`. The API documentation describes expiry data in its response. This is a provider-specific request/response shape and is materially different from the Upstox interface.

The official documentation does not define a cross-provider priority, fallback, or capability-aware automatic-routing rule for MarketHub.

### 3.6 Research conclusion

- Keep provider IDs and selectable values owned by the shared contracts package.
- Preserve provider-specific API adapters and their own verified request/response behavior.
- Do not infer a common automatic provider policy from vendor API availability.
- Keep the current Phase 6 scope away from provider activation, adapter changes, and live-account testing.

---

## 4. WP6A — Retention controls consistency

### 4.1 Objective

Make the retention settings API, UI, and cleanup result use one shared response contract, and make the UI faithfully represent what will and will not be deleted. Preserve existing data-retention policy and authorization.

### 4.2 Verified current implementation

| File | Current responsibility / behavior |
|---|---|
| `packages/contracts/src/snapshots.ts` | Owns `retentionDataClassSchema` (`CANDLE`, `SNAPSHOT`, `ACTIVITY`) and `retentionSettingsSchema`. Each optional `maxAgeDays` must be a positive integer. |
| `packages/database/src/app-settings.ts` | Stores JSON in `app_meta` under `retention_settings`; `getRetention()` reports missing, malformed or schema-invalid data as invalid; `setRetention()` validates before persisting. |
| `apps/api/src/historical-routes.ts` | Owns `applyRetentionCleanup()`, `GET /api/retention`, local-owner-only `PUT /api/retention`, and local-owner-only `POST /api/retention/cleanup`. Invalid/missing settings fail closed; configured classes are deleted independently; no default duration is used. |
| `apps/web/src/lib/historical.ts` | Defines local `RetentionView` and `RetentionCleanupResult` interfaces; validates nested settings but manually coerces other response fields; cleanup response currently defaults missing counters to zero. |
| `apps/web/src/components/HistoricalPanel.tsx` | Has three manual fields. Current `onChange` deletes the class from draft state for blank **and for invalid non-empty intermediate values**. Thus a controlled field can clear itself while the user is typing an invalid/intermediate number. The status message also does not clearly distinguish a valid empty configuration from missing/invalid settings. |
| `tests/market/historical-routes.test.ts` | Covers local-owner PUT, invalid PUT, missing settings failing closed, and saving a valid CANDLE setting. It does not fully cover each class independently or the valid-empty case. |
| `tests/web/historical.test.ts` | Covers basic retention fetch/save/fail-safe behavior and ACTIVITY result/round-trip. Does not cover malformed response envelopes or invalid intermediate form input. |

### 4.3 Architectural decision

**Keep the existing storage and retention policy.** Do not change database schema, migration history, cleanup thresholds, or automatic cleanup behavior.

Add two shared response schemas and inferred types to `packages/contracts/src/snapshots.ts` (the exact names below are the selected names for this plan):

1. `retentionSettingsViewSchema` / `RetentionSettingsView`
2. `retentionCleanupResultSchema` / `RetentionCleanupResult`

The settings view must encode the two real states without ambiguity:

- Valid persisted state: `{ settings: RetentionSettings, valid: true, error: null }`
- Missing, malformed, or invalid persisted state: `{ settings: null, valid: false, error: string }`

A valid configuration with `classes: {}` is valid and is **not** the same as an invalid/missing configuration.

The cleanup result schema must cover the existing wire shape:

- `ran: boolean`
- `reason: string | null`
- `candlesDeleted: non-negative integer`
- `snapshotsDeleted: non-negative integer`
- `activitiesDeleted: non-negative integer`

The API and browser client must parse the complete response with these shared schemas. Do not cast the result and silently replace missing/malformed counters with zero. Zero is a real cleanup result, not a recovery strategy for a malformed server response.

Implementation guidance (not permission to expand scope):

- Define the response schemas next to `retentionSettingsSchema` in `packages/contracts/src/snapshots.ts`; `packages/contracts/src/index.ts` already re-exports `./snapshots`.
- Use `z.discriminatedUnion("valid", ...)` with these exact branches: valid = `{ settings: retentionSettingsSchema, valid: z.literal(true), error: z.null() }`; invalid = `{ settings: z.null(), valid: z.literal(false), error: z.string().min(1) }`. This pins a non-empty error on the invalid branch and a null error on the valid branch at schema level.
- Keep the existing JSON fields and routes unchanged.
- Make `AppSettings.getRetention()` return the shared inferred view type. Preserve the existing exported `RetentionReadResult` name as a type alias to the shared contract type, avoiding an unnecessary public type break.
- Make `applyRetentionCleanup()` use the shared `RetentionCleanupResult` type. Preserve the existing exported API `RetentionCleanupResult` name as a type alias to the shared contract type rather than retaining a second interface definition.
- Validate API GET/PUT retention views and cleanup responses with the shared schemas before returning them.
- Make `fetchRetention()` and `runRetentionCleanup()` parse the entire response with the shared schemas. Remove duplicate local response interfaces after confirming no references remain.
- No API middleware rewrite, new dependency, or route rename.

### 4.4 Retention form behavior

Use three raw text states for the three numeric controls (CANDLE, SNAPSHOT, ACTIVITY). Keep the raw string as typed by the user; do not store partially valid values in `RetentionSettings`.

**Required test seam:** add a pure helper in a focused module, `apps/web/src/lib/retention-form.ts`, and export:

```ts
import {
  retentionSettingsSchema,
  type RetentionDataClass,
  type RetentionSettings
} from "@markethub/contracts";

export type RetentionDraft = Record<RetentionDataClass, string>;
export type RetentionDraftErrors = Partial<Record<RetentionDataClass, string>>;

export function parseRetentionDraft(draft: RetentionDraft): {
  settings: RetentionSettings | null;
  errors: RetentionDraftErrors;
};
```

The helper must not mutate the supplied draft. Trim each raw string; an empty string omits that class. **Canonical accepted form after trim: ASCII digits only, matching `/^[0-9]+$/`** — reject `+`, `-`, exponent (`1e2`), decimal point (`1.0`), separators (`1,000`), and any other non-digit characters. Then parse with `Number(raw)` and require `Number.isSafeInteger(n) && n > 0`. Leading zeros (`01`) are accepted as the integer 1 (they are ASCII digits and parse to a safe positive integer); this is the only non-canonical digit form accepted, and it is pinned by a test. Return field-specific errors for invalid values and `settings: null` if any field is invalid. When all fields are valid, return the constructed `{ version: 1, classes }` and an empty `errors` object. Validate the completed settings with `retentionSettingsSchema` before returning them. Keep this helper independent of React and DOM APIs so Bun tests can import it directly.

The component must use this helper in its save handler rather than duplicating parsing logic in inline `onChange` handlers. Keep raw text in controlled input state and do not write partial values into `RetentionSettings`. Use `type="text"` with `inputMode="numeric"` for these fields so invalid/intermediate text is not silently normalized by a number input before the helper can report it. Keep field-level accessible error text and `aria-invalid` state. Do not clear or rewrite raw values when validation fails.

On save:

1. Trim the raw value.
2. Empty string means that class is omitted from `classes`, so no max-age cleanup is configured for that class.
3. A non-empty value must parse as a positive integer. Zero, negative, fractional, non-numeric, and invalid values must be rejected with a visible field-level message; do not clear the field.
4. Call `parseRetentionDraft()` from the save handler. If it returns `settings: null`, render its field-level errors and do not call `saveRetention()`.
5. Only after all three values validate, pass the returned `RetentionSettings` object through the existing shared contract and API.
6. After a successful save, reload persisted state and clear validation messages.

Use the existing simple controlled text inputs with `inputMode="numeric"`; do not rely on browser `min`/`step` validation as a replacement for the pure helper.

Display three distinct persisted states:

- **Missing/invalid:** “No valid saved retention settings. Cleanup is disabled and deletes nothing.”
- **Valid, no limits:** “Saved settings are valid, but no retention limits are configured. Cleanup will delete nothing.”
- **Valid, one or more limits:** “Saved retention limits apply only to the configured data classes.”

Also explain that edits are not persisted until Save and that **Run cleanup uses saved settings**, not an unsaved draft. Keep cleanup a deliberate, user-triggered action.

**Draft initialization/reload rule:** when a valid settings view loads (initial fetch or after a successful save), populate each raw draft field from `settings.classes.<CLASS>?.maxAgeDays?.toString() ?? ""` — a configured class becomes its digit string, an unconfigured class becomes `""`. When the persisted view is invalid/missing, initialize all three draft fields to `""` and show the invalid/missing status; do not fabricate default periods. Unsaved user edits are only overwritten by an explicit successful save/reload, not by a background refresh. Pin this with a unit test of the draft-from-view mapping (a pure `draftFromView(view): RetentionDraft` helper is the recommended seam) and a static-render assertion of the three field values.

Do not invent default retention periods or silently clear/replace saved settings when the page loads.

### 4.5 Allowed files

- `packages/contracts/src/snapshots.ts`
- `packages/database/src/app-settings.ts`
- `apps/api/src/historical-routes.ts`
- `apps/web/src/lib/historical.ts`
- `apps/web/src/lib/retention-form.ts` (new pure form-parsing helper)
- `apps/web/src/components/HistoricalPanel.tsx`
- `tests/market/historical-routes.test.ts`
- `tests/web/historical.test.ts`
- A new `tests/market/retention.test.ts` only if a focused service/database-level test cannot be added cleanly to the existing test layout.

No other source files should change without stopping and reporting the reason.

### 4.6 Required WP6A tests

**Shared contract and persistence**

- Valid `RetentionSettingsView` with all classes configured parses.
- Valid empty settings `{version: 1, classes: {}}` parses as valid.
- Invalid view has `settings: null`, `valid: false`, and a useful non-empty error; a `valid: false` view with an empty-string error is **rejected** by the schema (`z.string().min(1)`).
- A `valid: true` view with a non-null error is rejected (`error: z.null()` on the valid branch).
- Invalid combinations (for example `valid: true` with `settings: null`) are rejected.
- Cleanup result requires all fields and rejects missing, fractional, negative, or non-numeric deletion counts.
- `AppSettings.getRetention()` distinguishes missing, malformed JSON, schema-invalid JSON, valid empty settings, and valid configured settings.

**Cleanup behavior**

- Missing settings: `ran: false`, all deleted counts zero, no repository cleanup method called.
- Malformed and schema-invalid persisted settings: same fail-closed behavior.
- Valid empty settings: `ran: true`, all deleted counts zero, no repository cleanup method called.
- CANDLE-only configuration cleans only candles.
- SNAPSHOT-only configuration cleans only snapshots.
- ACTIVITY-only configuration cleans only activities when an activity repository is supplied.
- A mixed configuration applies each configured class independently.
- An omitted class setting does not trigger cleanup for that class.
- Preserve the existing local-owner-only PUT and cleanup restrictions; explicitly test remote cleanup rejection as well as remote PUT rejection.
- Do not delete data from an unconfigured class as a side effect of another class's limit.

Use an injected fixed clock or deterministic timestamps where needed. Do not use wall-clock timing or live data.

**Web client and form**

- `fetchRetention()` rejects malformed full response envelopes.
- `runRetentionCleanup()` rejects malformed or incomplete cleanup payloads instead of filling missing counts with zero.
- All three classes round-trip through the client.
- `parseRetentionDraft()` is imported directly by the tests and covered with table-driven cases for each class: blank, positive integer (`"30"`), leading-zero digits (`"01"` → accepted as 1), zero (`"0"`), negative (`"-1"`), fractional (`"1.5"`), exponent (`"1e2"`), decimal (`"1.0"`), separator (`"1,000"`), plus-prefixed (`"+1"`), non-numeric (`"abc"`), whitespace-only (`"   "` → treated as blank/omit), and an integer beyond the safe range (`"9007199254740992"` → rejected).
- The helper returns `settings: null` and field-specific errors if any value is invalid; it returns a schema-valid settings object only when every non-empty value is valid.
- The helper does not mutate the supplied raw draft. The component retains invalid raw text, displays the corresponding field error and does not call the save API after a failed parse.
- `draftFromView()` (or the chosen draft-mapping seam) maps a valid view to digit strings / `""` per class and an invalid/missing view to three `""` fields; pinned by a unit test.
- Static rendering shows the three inputs with `type="text"` and `inputMode="numeric"` (and **no** `type="number"`), explains saved-vs-unsaved settings and valid-empty behavior, and reflects the draft field values from the mapping.

### 4.7 WP6A acceptance

WP6A is complete only when:

- one shared contract owns settings-view and cleanup-result response shapes;
- storage and route behavior are unchanged except for validation through those schemas;
- all three classes behave independently;
- invalid/missing settings fail closed;
- valid empty settings are visibly and semantically distinct from invalid settings;
- invalid input remains visible and blocks save;
- saved-vs-unsaved cleanup behavior is explicit;
- all focused tests pass, and the full regression/typecheck/build checks pass;
- independent review of the complete diff returns **KEEP / no findings**.

---

## 5. WP6B — Snapshot provider selection semantics

### 5.1 Objective

Make snapshot provider selection explicit and consistent with current MarketHub behavior. Remove the hidden FYERS preference and avoid claiming that simple provider-array order is automatic provider selection.

### 5.2 Verified current implementation

| File | Current responsibility / behavior |
|---|---|
| `packages/contracts/src/provider-identity.ts` | Owns `providerIdSchema`, currently `UPSTOX` and `FYERS`, and inferred `ProviderId`. |
| `packages/contracts/src/snapshots.ts` | `OptionChainCaptureConfig.provider` is required. `optionChainCaptureRequestSchema.provider` is optional for on-demand calls. |
| `packages/market-core/src/snapshots/service.ts` | Explicit `request.provider` filters the provider array to that ID and tries only that provider. Omitted provider tries the injected providers sequentially in their current array order until one succeeds. |
| `apps/api/src/snapshot-routes.ts` | Validates the on-demand request and preserves omission of `provider`; saved configs require provider through the config schema. |
| `apps/api/src/app.ts` | Composes `OptionChainSnapshotService` with `providers: []`; live provider-backed snapshot retrieval is not activated in the normal application composition. |
| `apps/web/src/components/SnapshotPanel.tsx` | Initializes provider to `FYERS`; manually hardcodes FYERS/UPSTOX option elements; uses the same explicit selection for save-config and Capture now. |
| `apps/web/src/lib/snapshots.ts` | `CaptureRequest.provider` repeats the `UPSTOX` / `FYERS` union rather than using the shared `ProviderId` type. |
| `tests/market/snapshots.test.ts` | Covers snapshot value semantics, on-demand/config independence, scheduled capture, and disabled config. It does not directly test explicit-provider exclusivity or omitted-provider fallback. |
| `tests/web/snapshots.test.ts` | Uses server-rendered UI assertions and client tests. It currently asserts the provider is a manual field but does not assert the default is empty or that options come from the contract. |

### 5.3 Architectural decision

**Keep saved capture configurations explicitly provider-bound.** `OptionChainCaptureConfig.provider` is required by the existing persisted contract. Do not make it optional, add an `AUTO` provider identity, or migrate the database.

**Remove the silent FYERS default from the WebUI.** An empty initial selection means the user must deliberately choose a provider before adding a saved config or requesting a manual capture. This avoids hiding a fixed provider preference in the UI. It does not change the shared provider identity set.

**Derive provider options from `providerIdSchema`.** Use the existing contract export and the same schema-derived option pattern used by the interval selector. The WebUI must not define a second `"UPSTOX" | "FYERS"` option list or a parallel array. Use `ProviderId` for the web capture request type.

**Keep the service semantics unchanged:**

- Explicit provider: only that provider is attempted; failure does not fall back.
- Omitted provider: current configured provider array is tried sequentially in its existing order. This behavior stays available to callers that intentionally omit provider.
- Saved config: provider remains required and is passed explicitly by `captureScheduled()`.
- On-demand request: remains independent of saved capture config and does not mutate it.

The WebUI in this phase always sends an explicit provider. The copy beside the dropdown must say, in plain language, that only the selected provider is attempted and there is no fallback for an explicit selection. The Capture now / Add config actions must not run while provider selection is empty; keep validation in the handlers as well as disabled button presentation.

The UI is deliberately **manual-only** in this phase. Do not call the current omitted-provider array-order behavior “automatic selection”. Capability-aware automatic routing is a future feature and must account for actual provider option-chain capability, provider connection/availability, account entitlement, request limits, freshness/reliability and an explicit no-fixed-priority policy. That feature is not supplied by Phase 6.

### 5.4 UI and client implementation

**Required test seam:** add a pure helper in `apps/web/src/lib/snapshot-form.ts` and export:

```ts
import { providerIdSchema, type ProviderId } from "@markethub/contracts";

export function selectedProviderOrError(value: string): ProviderId | null;
```

It must validate non-empty values with the shared `providerIdSchema.safeParse()` and return the validated `ProviderId`; return `null` for the empty placeholder or any invalid value. It must be a pure function with no React/DOM dependency. Both `addConfig()` and `capture()` must call this helper before constructing a config/request. On `null`, each handler must set a clear “Choose a provider” validation error and return without calling its API client. Tests must cover the empty sentinel, both current provider IDs and an invalid ID.

- Initialize the selected provider state to an empty sentinel (for example `""`) rather than `"FYERS"`.
- Render a “Choose provider” placeholder option.
- Render provider options from `providerIdSchema.options`. **Option order follows the schema's definition order (`UPSTOX`, then `FYERS`)** — this intentionally changes the current UI order (FYERS first) and is pinned by a test so it is deliberate, not accidental.
- Narrow/validate the state to `ProviderId` before creating a config or calling `captureSnapshot()`.
- Disable the two actions until a provider is selected, and retain handler-level validation to protect against invocation outside the rendered button state.
- Change `CaptureRequest.provider` in `apps/web/src/lib/snapshots.ts` to the shared `ProviderId` type. The field may remain optional in the client type because the API contract supports omitted provider for non-WebUI/internal callers; the WebUI itself must send it explicitly.
- The repository sets `exactOptionalPropertyTypes: true` in `tsconfig.base.json`. When an optional `provider` property is conditionally omitted, use conditional object spread (`...(provider ? { provider } : {})`) rather than assigning `provider: undefined`. The UI handlers should normally pass the already validated, required `ProviderId` returned by `selectedProviderOrError()`.
- Keep the existing FYERS/UPSTOX provider IDs and labels. Do not generalize authentication forms or provider registration.
- Explain that the explicit selected provider is exclusive for the request; do not claim the fallback provider will be tried.
- Preserve the existing honest unavailable state because production composition currently supplies no option-chain providers.

### 5.5 Allowed files

- `apps/web/src/components/SnapshotPanel.tsx`
- `apps/web/src/lib/snapshots.ts`
- `apps/web/src/lib/snapshot-form.ts` (new pure provider-selection helper)
- `tests/market/snapshots.test.ts`
- `tests/web/snapshots.test.ts`
- `tests/market/snapshot-routes.test.ts` (new) only if a small API passthrough assertion is required to prove omitted provider remains omitted. The route under test is `apps/api/src/snapshot-routes.ts`, not the historical-routes file; no dedicated snapshot-route test file exists today.

Do not change the snapshot service or route implementation unless the new tests demonstrate that current behavior differs from the verified behavior described above. If source behavior differs on the agent's local checkout, stop and report rather than silently changing it.

### 5.6 Required WP6B tests

**Service behavior (`tests/market/snapshots.test.ts`)**

Extend the fake provider or add a small failing fake so tests can prove:

1. Explicit UPSTOX success calls UPSTOX and not FYERS.
2. Explicit FYERS success calls FYERS and not UPSTOX.
3. Explicit provider failure returns an error and does not call the other provider.
4. An omitted provider tries injected providers in their existing order.
5. If the first provider fails and the next succeeds, the resulting snapshot identifies the successful provider.
6. If all omitted-provider attempts fail, capture returns an unavailable/error result without inventing data.
7. An explicit provider not present in the configured provider list does not invoke a different provider.
8. Scheduled capture uses the provider stored in its config and remains explicit.
9. On-demand capture still does not read or modify saved capture configs.

The tests use deterministic fake providers only. Do not call vendor APIs, read real credentials, or activate provider adapters.

**WebUI/client (`tests/web/snapshots.test.ts`)**

1. Initial render has no provider preselected.
2. The UI contains the placeholder and all values currently exported by `providerIdSchema`, rendered in schema definition order (`UPSTOX` before `FYERS`).
3. `selectedProviderOrError()` is directly unit-tested for empty, UPSTOX, FYERS and invalid inputs; both UI handlers use it before API calls.
4. No duplicated provider literal list is introduced in the client or component source. Import `readFileSync` from `node:fs`; use `readFileSync(new URL("../../apps/web/src/components/SnapshotPanel.tsx", import.meta.url), "utf8")` and the equivalent URL for `apps/web/src/lib/snapshots.ts` in `tests/web/snapshots.test.ts`; this resolves from the test module rather than the process working directory. Assert that neither source contains a literal union (`"UPSTOX" | "FYERS"` or reverse) or an array/tuple literal containing both provider IDs in either order. Explicitly **allow**: `providerIdSchema.options`, JSX labels/text containing a provider name, and equality comparisons against a `ProviderId` value. Use the positive signals — presence of `providerIdSchema.options` in the component and the imported `ProviderId` type in the client — as the primary assertion, with the negative source check as defense in depth.
5. The selection is documented as manual and exclusive/no-fallback.
6. Capture and config creation require a provider selection.
7. Existing API unavailable/422 behavior remains visible and unchanged.
8. Client request typing accepts the shared `ProviderId` without changing the optional-provider wire contract.

**API behavior (only if necessary)**

Confirm an omitted provider remains omitted in the body passed to `captureOnDemand()` and an explicit value is passed through unchanged. Existing route validation and 422 no-provider behavior must remain intact.

### 5.7 WP6B acceptance

WP6B is complete only when the UI no longer silently defaults to FYERS, provider choices derive from the shared contract, manual selection is clear, explicit provider exclusivity and the internal omitted-provider order are pinned by service tests, no provider service/fallback behavior was changed, all focused and global checks pass, and independent review returns **KEEP / no findings**.

---

## 6. WP6C — WebUI Overview status accuracy

### 6.1 Objective

Replace the stale Overview summary/status rows with a small, accurate view of what exists today. Clearly distinguish implemented foundations from locked/inactive functionality, incomplete work, and genuinely unimplemented features.

### 6.2 Verified current implementation

- `apps/web/src/App.tsx` currently says: “Market data, providers, catalog, alerts, and MCP HTTP are not implemented in this foundation milestone.”
- The Overview status rows currently label “Market data/providers” and “MCP HTTP transport” as “Not implemented”.
- Provider management/status UI and API exist. This is an implemented foundation; it does **not** prove that a broker is connected or that live market data has been verified.
- Catalog search and the reusable InstrumentPicker exist. Full exchange catalog population/seeding is not complete; do not describe the entire catalog as populated or production-ready.
- Historical candle and snapshot persistence/API/UI exist as an offline foundation. `apps/api/src/app.ts` composes both corresponding services with empty provider arrays. Provider-backed historical/option-chain retrieval is therefore not active through the normal application composition.
- M6-A's MCP HTTP handler and `/mcp` route foundation exist. The system status contract exposes `mcp.httpHandlerMounted`, and `apps/api/src/app.ts` sets it from whether the application has an MCP handler. This flag describes handler mounting only.
- M6-D/E source and tests are present on `develop`, but project status explicitly says the phases are neither accepted nor complete. M6-B4 remains separately owned and not accepted.
- Alerts and scanners are not implemented.
- Production streaming drivers remain locked; Stage G real provider verification remains separately gated.

### 6.3 Selected status language

Use the following distinctions. Exact UI wording can be short, but it must preserve the meaning in this table.

| Overview item | Required label / meaning | Must not imply |
|---|---|---|
| Application runtime, config, database, API and WebUI shell | Implemented | That all product features are complete |
| Provider management/authentication/status | Implemented foundation | That credentials are configured, a broker is connected, or a live feed is verified |
| Live market-data feed | Locked / not activated | That production drivers or real provider sockets are active |
| Catalog search and instrument picker | Implemented; catalog population incomplete | That the full NSE/BSE instrument/derivative catalog is populated |
| Historical and snapshot persistence | Implemented offline; provider-backed retrieval inactive | That live historical candles or option-chain data have been fetched from brokers |
| MCP HTTP handler | Mounted / not mounted, based on `data.mcp.httpHandlerMounted` | That M6-D/E notifications or all HTTP integration acceptance have passed |
| M6-D/E notification/client conformance | Not accepted; source/tests present, completion unverified | That the milestone has been accepted or is complete |
| Alerts and scanners | Not implemented | That those features exist behind the current panels |

Use neutral labels for “locked”, “incomplete” or “not accepted”; reserve “Implemented” for an implemented foundation. No frontend wording can turn an unverified capability into a verified live service.

### 6.4 UI structure decision

Keep this as a **presentation-only** change:

- Replace the inaccurate Overview paragraph.
- Replace the two broad inaccurate list rows with the more precise rows from §6.3.
- Use the already-present `data.mcp.httpHandlerMounted` boolean for the MCP HTTP handler's mounted/not-mounted label. The explanatory text must say that mount status is not M6-D/E acceptance.
- Do not add a backend endpoint, status contract field, registry, feature-flag service, metadata API, polling loop or health check.
- Preserve `fetchSystemStatus()`, current query cadence, readiness calculations, loading/error handling, provider status panel and all runtime behavior.

To make the display testable without mounting the whole `App` with React Query and router providers, extract the small Overview capability/status list into one focused presentational component, for example `apps/web/src/components/OverviewStatus.tsx`, receiving only `mcpHttpHandlerMounted: boolean`. If the agent finds an equally simple existing component/pattern that avoids a new component, it may use that instead, but it must keep testability and presentation-only scope. Do not create a generic registry or universal status framework.

### 6.5 Allowed files

- `apps/web/src/App.tsx`
- `apps/web/src/components/OverviewStatus.tsx` (new, only if the small component extraction is needed)
- `tests/web/overview-status.test.tsx` (new focused static-render test)
- `docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md` (WP6C close-out only: remove the stale `App.tsx:211,219,281,282` references in the Phase 6c summary)
- `docs/METADATA_AND_CAPABILITY_DISCOVERY.md` (WP6C close-out only: remove the stale `App.tsx:211,219,281,282` references in area J)

No backend changes, contract changes, API changes, or `docs/PROJECT_STATUS.md` corrections are required. The two listed documentation edits are narrowly scoped source-reference corrections, not general documentation polishing. Prefer file/function/section references over fragile line numbers where practical.

### 6.6 Required WP6C tests

- Static-render the status component and assert accurate implemented-foundation, locked/inactive, incomplete, not-accepted and not-implemented labels.
- Test both `mcpHttpHandlerMounted: true` and `false` and verify the label changes accurately.
- Confirm the copy distinguishes the MCP HTTP handler being mounted from M6-D/E acceptance.
- Confirm no stale “providers are not implemented” or “MCP HTTP is not implemented” sentence remains in the Overview.
- Confirm catalog text does not claim full catalog population.
- Confirm provider-backed historical/option-chain retrieval is described as inactive/locked rather than operational.
- At WP6C close-out, correct the stale `App.tsx:211,219,281,282` citation in each of the two docs named in §6.5 (`METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md` and `METADATA_AND_CAPABILITY_DISCOVERY.md`) — two citations total — and make no unrelated documentation changes.
- Preserve all existing runtime readiness, loading, error, refresh and provider panel behavior.

Do not add UI tests that require real network access. Use the existing Bun test and `react-dom/server` static rendering pattern.

### 6.7 WP6C acceptance

WP6C is complete only when the Overview accurately describes the current implementation/acceptance boundary, the MCP mount label comes from the existing status response, no new backend surface or runtime behavior has been added, tests pass, all global checks pass, and independent review returns **KEEP / no findings**.

---

## 7. Cross-work-package architecture and protected boundaries

### 7.1 Source-of-truth decisions

| Value/data | Owner | Consumer rule |
|---|---|---|
| Retention class IDs | `retentionDataClassSchema` in `@markethub/contracts` | Do not add a second backend/frontend enum. Presentation labels remain local. |
| Retention settings shape | `retentionSettingsSchema` in `@markethub/contracts` | Persist through existing `AppSettings` / API. |
| Retention response shapes | New shared response schemas in `packages/contracts/src/snapshots.ts` | Database/API/WebUI derive their types from the shared schemas. |
| Provider IDs | `providerIdSchema` in `@markethub/contracts` | WebUI options and `CaptureRequest` type derive from the shared provider identity. |
| Saved snapshot capture provider | Existing `OptionChainCaptureConfig.provider` field | Required explicit provider; no schema migration. |
| Runtime MCP handler mount state | Existing `SystemStatus.mcp.httpHandlerMounted` | WebUI reads the existing status field; no new registry/API. |
| Overview labels/tones | WebUI presentation | Local wording is permitted; do not duplicate backend-owned provider/capability inventories. |

### 7.2 Protected areas

No WP6A/B/C changes to:

- SQLite table definitions, Drizzle schema, migrations or persisted data layout.
- Provider adapters, OAuth flows, credential storage, provider authentication or SDK versions.
- Provider identity set or registry design.
- Streaming supervisor/coordinator, subscription poller, SSE hub/client, or locked production driver boundary.
- Catalog ingestion/population, catalog repository, derivative discovery or expiry logic.
- Snapshot provider ordering, filtering, retry behavior or service implementation, unless a test proves the verified behavior is already broken (stop and report before any such correction).
- MCP registration, tools/resources/prompts, MCP transport, M6-B4, M6-D/E ownership or acceptance.
- Stage G activation or live provider testing.
- Package dependencies, package manager, lockfiles, or build configuration.
- Project-wide styling redesign, generic form/metadata frameworks, a universal registry or service layer.

### 7.3 Explicit non-goals

Phase 6 does not deliver:

- Capability-aware automatic provider selection.
- New provider or provider plugin extensibility.
- Live Upstox/FYERS data retrieval or broker account verification.
- Catalog population or NSE/BSE master-file synchronization.
- Derivative expiry selectors or computed expiries.
- Alerts, scanners, charts, or other unimplemented market modules.
- M6-D/E, M6-B4, Phase 4 or Phase 7 completion.
- Backup/restore changes or production database operations.

---

## 8. Execution controls and dependency order

### 8.1 Mandatory order

1. Product owner explicitly authorizes WP6A implementation.
2. OpenCode checks local branch/HEAD/status and executes WP6A only.
3. OpenCode reports complete diff, focused tests, global checks and status.
4. OpenCode requests a fresh-context independent audit from the configured `opencode/iceman-free` reviewer (or the project's currently designated independent-review agent), supplying the complete diff and test evidence. WP6B is held until that audit returns KEEP with no findings.
5. ChatGPT, as Technical Lead / Architect under `docs/PROJECT_MANAGER_PROTOCOL.md`, independently checks the complete diff, the reviewer report and the test evidence, and records the final technical disposition. The configured subagent is an additional independent audit, not a replacement for the technical lead's review.
6. Product owner separately authorizes WP6B implementation. OpenCode executes WP6B only; the same independent-audit then technical-lead-review sequence applies.
7. Product owner separately authorizes WP6C implementation. OpenCode executes WP6C only; the same independent-audit then technical-lead-review sequence applies.
8. The phase is closed only after all three work packages have a KEEP disposition from the independent audit and the technical lead, and full verification is clean.

Do not begin the next package while the previous package has unresolved findings. Fix-forward only within the package's allowed scope.

### 8.2 Mandatory pre-edit procedure

Before each package, OpenCode must:

1. Run `git status --short --branch`.
2. Run `git rev-parse HEAD` and `git branch --show-current`.
3. Confirm the worktree is clean or explicitly inventory every pre-existing staged, unstaged and untracked change. Preserve unrelated work.
4. Confirm the files and behaviors against the current local source; the GitHub baseline in this document may have advanced.
5. If the branch is not `develop`, HEAD has diverged, a relevant file materially differs, or existing work overlaps the allowed files, stop and report before editing.
6. Do not reset, clean, checkout over, stash without authorization, or delete user work.

### 8.3 Verification commands

Use the repository's documented Bun workspace scripts. At minimum, run the relevant focused tests, then:

```bash
bun test
bun run typecheck
bun run build
git diff --check
```

Focused tests:

**WP6A**

```bash
bun test tests/market/historical-routes.test.ts tests/web/historical.test.ts
```

If a dedicated `tests/market/retention.test.ts` is added under the scope in §4.5:

```bash
bun test tests/market/retention.test.ts
```

**WP6B**

```bash
bun test tests/market/snapshots.test.ts tests/web/snapshots.test.ts
```

If the optional `tests/market/snapshot-routes.test.ts` is added under §5.5:

```bash
bun test tests/market/snapshot-routes.test.ts
```

**WP6C**

```bash
bun test tests/web/overview-status.test.tsx
bun test tests/web/
```

The agent must use the actual resulting test paths and report exact commands and outcomes. Do not claim that a test ran because it was added. Do not report local tests as GitHub CI. Check GitHub Actions/commit statuses separately if relevant and available; state “no CI evidence” when no run/status exists.

### 8.4 No Git publication in this assignment

The plan does not authorize commit, push, merge, rebase, amend, force-push, or branch deletion. After tests and independent review, leave the implementation as a local worktree diff unless the product owner separately authorizes Git publication.

---

## 9. Required implementation-assignment format and report

Each WP6A/WP6B/WP6C handoff must include these 12 required elements from `docs/PROJECT_MANAGER_PROTOCOL.md`:

1. **Objective:** use the package objective in this plan.
2. **Verified current state:** use the relevant tables and file/function observations in §§4–6; verify against the agent's local source before editing.
3. **Exact scope:** only the exact WP being authorized.
4. **Architectural direction:** follow the selected decisions in this plan; do not redesign them.
5. **Files/components allowed to change:** use the package-specific allowlist.
6. **Protected areas:** use §7.2.
7. **Non-goals:** use §7.3 and the package-specific exclusions.
8. **Acceptance criteria:** use that WP's acceptance list.
9. **Required tests:** use that WP's test list.
10. **Verification instructions:** use §8.2–§8.3.
11. **Expected report format:** exact files changed, behavior, evidence, command results, failures, unverified work, full diff, and before/after status.
12. **Option and Metadata Impact Assessment:** complete the 18 questions below in the implementation report, even where the answer is “no change”.

### 9.1 Expected completion report

For each package, report:

- Package identifier and completion state.
- Initial branch, HEAD and `git status --short --branch`.
- Exact file list and purpose of each change.
- Concise before/after behavior description.
- Complete diff or a directly accessible diff for the configured fresh-context independent reviewer and technical-lead review.
- Independent reviewer identity, verdict, findings and evidence; separate technical-lead disposition.
- Focused test command and output summary.
- Full `bun test` command and actual totals.
- `bun run typecheck`, `bun run build` and `git diff --check` results.
- What was not tested, unavailable or unverified.
- Explicit confirmation that protected areas, user changes and untracked files were preserved.
- Final `git status --short --branch`.
- Explicit confirmation: no commit/push/merge/rebase/amend was performed.

Any test failure or unexpected scope change must be reported, not hidden. Do not mark a package complete while a required check is failing or skipped without an agreed reason.

---

## 10. Option and Metadata Impact Assessment — mandatory 18 questions

The assessment below is the technical lead's decision. OpenCode must carry these answers into each WP completion report and update them only if it discovers a real conflict in the local source. Do not introduce an unapproved option or metadata source.

| # | Required question | Phase 6 decision |
|---:|---|---|
| 1 | What new selectable options, capabilities, entities or configuration fields are introduced? | No new provider IDs, retention classes, capture fields or market entities. WP6A adds shared response-envelope schemas only. WP6B exposes the existing provider IDs from the canonical contract. WP6C changes only presentation labels. |
| 2 | Who owns each source of truth? | Retention class/settings schemas and provider identity remain in `@markethub/contracts`; persistence remains in `AppSettings`; cleanup remains in the existing API/domain path; snapshot capture remains in `OptionChainSnapshotService`; MCP mount state remains in `SystemStatus`. |
| 3 | Are these shared enums, backend capabilities, domain data or user-managed values? | Retention values are user-managed configuration validated by shared schemas. Provider IDs are fixed shared-contract values. Overview status phrases are presentation-only. No new backend capability or domain-data set is introduced. |
| 4 | How do WebUI, MCP, REST/SSE and adapters obtain the values? | WebUI imports shared Zod schemas/types and reads existing API routes/status. MCP, SSE and provider adapters are unchanged. No new HTTP discovery endpoint is required. |
| 5 | Does an existing API, schema, registry or repository already provide the information? | Yes: `retentionSettingsSchema`, `retentionDataClassSchema`, `providerIdSchema`, snapshot config/request schemas, `/api/retention`, snapshot routes/service, and `SystemStatus.mcp.httpHandlerMounted`. |
| 6 | Is a new discovery/read API necessary? | No. Existing APIs and direct shared-package imports are sufficient. |
| 7 | How does the UI update when values/capabilities are registered? | Provider options derive from `providerIdSchema.options`. Retention classes remain owned by shared schema; only labels are presentation-owned. There is no new runtime registry. |
| 8 | What cache invalidation or refresh is required? | No new cache. Retention form reloads after save using the existing GET. Snapshot provider options are static shared-contract values. Overview uses the already fetched `/api/status` query result. |
| 9 | Are metadata fields sensitive? | No new credentials, tokens, account data or provider-native identifiers are surfaced. Keep current local-owner restrictions on retention mutation/cleanup. |
| 10 | What tests prove source-to-consumer consistency? | Full settings-view/cleanup payload schema tests; retention route/client tests; provider options derived from contract and capture service explicit/omitted semantics tests; Overview mount-state rendering tests. |
| 11 | Shared contract impact? | Add `retentionSettingsViewSchema` and `retentionCleanupResultSchema` in the existing snapshots contract module; no migration to existing retention settings/config/snapshot wire shape. Export inferred types through the existing `snapshots` barrel export. |
| 12 | Provider/runtime registration impact? | None. `providerIdSchema` remains fixed to UPSTOX/FYERS. No provider registry/adapter changes and no activation. |
| 13 | MCP tool/resource/prompt impact? | None. MCP registrations, descriptors and transport remain untouched. |
| 14 | REST/SSE/WebUI consumer impact? | Existing retention REST responses gain complete shared-schema validation but keep the same JSON shape. Snapshot API contract remains unchanged. WebUI provider field uses `ProviderId`. Overview reads the current `mcp.httpHandlerMounted` field. No SSE changes. |
| 15 | Domain-data discovery impact? | None. No instruments, contracts, expiries, strikes or other domain lists are discovered or copied into UI constants. |
| 16 | Configuration persistence impact? | Retention persists via the existing `AppSettings`/`app_meta` owner. Saved snapshot capture configs remain explicitly provider-bound. On-demand capture continues not to mutate saved configuration. |
| 17 | Forward compatibility? | Provider option rendering follows additions to the shared provider contract without a second UI options list; adding an actual new provider still requires explicit backend contract/registry/adapter integration. No dynamic-provider claim is made. |
| 18 | Dependency direction? | No new package. Contract schemas remain in the dependency-light contracts package; database/API/WebUI depend on contracts. No contracts-to-application or circular import is introduced. |

---

## 11. Final Phase 6 exit gate

Phase 6 is complete only when all of the following are true:

- WP6A has KEEP / no findings from independent review.
- WP6B has KEEP / no findings from independent review.
- WP6C has KEEP / no findings from independent review.
- Focused tests for all packages pass.
- Full Bun test suite passes.
- All workspace typechecks pass.
- All workspace builds pass.
- `git diff --check` passes.
- Final diff contains no unrelated refactoring or protected-area changes.
- Local test evidence is distinguished from CI evidence.
- Current status and any remaining unverified behavior are reported honestly.

**Current status (2026-11-23):** WP6A and WP6B have KEEP / no findings from independent review and are published on `develop` (WP6A: `f25d514` implementation, `128e44a` audit fix, `2866bae` technical-lead loading-state race fix; WP6B: `d132894`). WP6C has not been authorized or started, so its gate criterion above is not met and Phase 6 is not yet complete.

Phase 6 completion does not complete Phase 4, Phase 7, M6-D/E, M6-B4 or Stage G. Those retain their existing separate gates.

---

## 12. Reference index

### Repository sources reviewed at `develop` HEAD `a1df3d1964dac209af20bd9f797bc25d99efb278`

- [Project Manager Protocol](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/PROJECT_MANAGER_PROTOCOL.md)
- [Metadata Discovery Implementation Plan](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md)
- [Metadata and Capability Discovery / AD-025](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/METADATA_AND_CAPABILITY_DISCOVERY.md)
- [Architecture Decisions](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/ARCHITECTURE_DECISIONS.md)
- [Implementation Roadmap](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/IMPLEMENTATION_ROADMAP.md)
- [Engineering Standards](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/ENGINEERING_STANDARDS.md)
- [Testing and Acceptance](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/TESTING_AND_ACCEPTANCE.md)
- [Project Status](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/PROJECT_STATUS.md)
- [Provider Integration](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/PROVIDER_INTEGRATION.md)
- [Phase 5 Plan](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/METADATA_DISCOVERY_PHASE_5_PLAN.md)

### Official API and framework documentation reviewed 2026-11-23

- [Zod API — schema definition and enums](https://zod.dev/api?id=enums)
- [React `<input>` — controlled input behavior](https://react.dev/reference/react-dom/components/input)
- [Hono — validation guide](https://hono.dev/docs/guides/validation)
- [Upstox — Put/Call Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/)
- [Upstox — Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/)
- [FYERS — Option Chain API v3](https://fyers.in/api-docs/v3/api/market-data/option-chain/)

---

**End of plan.** This file is a standalone specification for the three Phase 6 work packages. It does not itself grant implementation or Git publication permission.
