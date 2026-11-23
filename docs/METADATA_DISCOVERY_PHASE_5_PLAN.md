# Phase 5 — Provider and Capability Extensibility

> **Status:** IMPLEMENTED AND PUBLISHED on `develop`. All four work packages (WP 5A, WP 5B, WP 5C.1, WP 5C.2) are complete with independent audit KEEP verdicts and full verification evidence recorded in §4. Implementation followed `docs/PROJECT_MANAGER_PROTOCOL.md`.
>
> **Repository:** `Rajendertyagi/MarketHubTS`
> **Original inspected baseline:** `develop` at `729723f09114e6a52c0e97cc4dafb7d675865ed5` (2026-11-23)
> **Current baseline:** `develop` at `2df616df5628e2b6405349c998947a95737548d4` (WP 5A complete)
> **Governing requirement:** AD-025, `docs/METADATA_AND_CAPABILITY_DISCOVERY.md`
> **Related roadmap:** `docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md` §7 and `docs/IMPLEMENTATION_ROADMAP.md` §4.1

## Review Focus

These are the inputs and failure modes the governing docs imply but no single happy-path test fully exercises. Each is pinned to a test in §9.

1. **A documentation-only capability presented as available** — `source: DOCUMENTATION` / `state: UNKNOWN` must render as unverified, never as working; pinned by §9.2 source-honesty test.
2. **An unverified entitlement** — `entitlementUnverified: true` must be visible, not flattened; pinned by §9.3 entitlement test.
3. **A capability report that is absent** — omission must read as "no report", not as full support or failure; pinned by §9.2/§9.3 empty-state tests.
4. **A provider added to the shared contract** — the WebUI must render it without a hardcoded `providers.UPSTOX`/`providers.FYERS` edit; pinned by §9.2 enumeration test.
5. **A malformed provider-status response** — must be rejected by a shared schema, not cast; pinned by §9.1/§9.2 client tests.

---

## 0. Decision: this is the next implementation increment

The canonical order was: Phase 1 + Phase 3 WP 3a → Phase 3 WP 3b–3c → Phase 2 WP 2a–2c → **Phase 5** — all four are now implemented and published on `develop`. Phase 4 remains blocked on catalog population; Phase 6 WP6A (retention consistency) and WP6B (snapshot provider selection) are implemented, audited KEEP and published on `develop`, while WP6C (Overview accuracy) remains pending, so Phase 6 is not complete; Phase 7 remains separately gated. Phase 5's prerequisites (Phase 1 identity, Phase 2 descriptor pattern) were met.

**Extensibility boundary:** this improves how the existing provider set is represented and consumed. It does **not** make providers dynamically plug-in-extensible. `UPSTOX` and `FYERS` remain the only provider identities until the shared identity contract, registry and adapter composition are deliberately extended.

**Capability-source decision (the key design choice):** surface the rich streaming capability detail from the **existing** `SubscriptionStateView.runtimes[].capabilities` / `runtime.capabilities` data path — not by synthesizing a "representative" set from `upstoxCapabilities()` into provider status. The subscription view already carries generation-scoped `CapabilityResult` data from the real stream with a proper lifecycle; rendering it avoids fabricating a provider-wide matrix from a mode/instrument-specific pure function. The two capability vocabularies stay strictly separate.

**Ruling on subscription polling:** keep bounded 10-second refresh in Phase 5 — without it, capability changes stay invisible until a reload or subscription write. WP 5C is split into two separately authorized tasks: **5C.1** render per-provider runtime status and capabilities; **5C.2** add safe, bounded automatic refresh. Polling must prevent overlapping requests, prevent an older GET from overwriting a newer PUT result, cancel on unmount, and preserve last-known-good data on failure. Prefer existing TanStack Query functionality over a custom polling framework. Cost if wrong: extra surface area around write-race handling; mitigated by the explicit coordination rules in §3.5 and the dedicated tests in §9.3.

Do not fold in Phase 6c's stale overview statements, Phase 4 expiry work, provider activation, Stage G live verification, or any credential-form generalization.

---

## 1. Objective and product outcome

Make provider status and capability information useful and extensible in the WebUI without maintaining a second provider list or capability list in React.

Three bounded outcomes:

1. The Providers panel renders the validated provider collection by iteration, rather than naming `UPSTOX` and `FYERS` individually.
2. The Providers panel presents the broad provider API capabilities and limits already supplied by each adapter, including their state, source, date and explanatory note.
3. The Streaming selections panel presents per-provider runtime state and structured component-capability results already available from the subscription-status contract, rather than discarding them.

The intended result is a truthful status UI: authentication, connection state, broad API capability metadata, and runtime streaming capability are shown as separate dimensions. Unknown or unverified information remains visibly unknown.

---

## 2. Verified current state

The following was checked against `develop` at the baseline commit above.

### 2.1 Provider identity and registry

- `packages/contracts/src/provider-identity.ts` owns `providerIdSchema`; its current values are `UPSTOX` and `FYERS`.
- `packages/contracts/src/provider.ts` defines `ProviderStatus`, the fixed-key `ProviderStatusMap`, `providerStatusSchema`, and `providerStatusMapSchema`.
- `packages/market-core/src/provider.ts` owns `ProviderRegistry`. It stores adapters in a `Map`, but `getStatuses()` and `validateAll()` still return a fixed two-provider map and synthesize a disabled status for a provider with no registered adapter.
- `ProviderRegistry` is therefore **not** dynamically extensible today. Do not describe it as a runtime plug-in registry.

### 2.2 Existing provider status API

- `apps/api/src/provider-routes.ts` composes the provider status map through `composeProviderStatuses()` and validates the map with `providerStatusMapSchema`.
- `GET /api/providers/status` already returns `{ providers, localManagement, note }`. It is a read-only diagnostic route intended to be readable by LAN clients. `providers` can be `null` when no registry/auth map is available (`provider-routes.ts:38–55`); the WebUI already handles that state.
- Credential and provider-management routes are separate and guarded by the existing local-peer check. Their behavior is not part of this phase.
- There is no reason to create another provider metadata endpoint for the information already returned by this route.

### 2.3 Current Providers WebUI

- `apps/web/src/lib/status.ts` has a hand-written `ProviderStatusView` that omits `capabilities` and `limits`.
- `fetchProvidersStatus()` casts parsed JSON to that interface without validating the response against a shared contract.
- `apps/web/src/App.tsx` renders `providers.UPSTOX` and `providers.FYERS` explicitly.
- The `ProviderControls` component contains separate Upstox and FYERS credential/authentication workflows. Those are intentionally provider-specific and must remain so.
- The provider status query already refreshes every 10 seconds and supports manual refresh.

### 2.4 Two distinct capability contracts — do not merge them

The repository has two different capability models with different meanings and owners.

**A. Provider-wide API capability metadata — `packages/contracts/src/provider.ts`**

- `ProviderStatus.capabilities` is an array of `ProviderCapability`.
- Its state vocabulary is `AVAILABLE`, `UNAVAILABLE`, `UNKNOWN`.
- Its source vocabulary is `API`, `DOCUMENTATION`, `USER`, `UNKNOWN`.
- Optional metadata includes `asOf` and `note`.
- `ProviderStatus.limits` is an array of `ProviderLimit`, with `value`, the same state/source vocabularies, and optional `publishedAt`/`note`.
- Upstox and FYERS adapters populate these arrays after successful validation. For example, the current adapter source marks several documentation-derived capabilities and rate figures as `UNKNOWN`, with notes that account limits are not verified.
- The Providers panel does not currently render these arrays.

**B. Component-level streaming capability — `packages/contracts/src/live-components.ts`**

- `CapabilityResult` is per provider and per component (`quote`, `depth`, `derivatives`).
- Its state vocabulary is `SUPPORTED`, `UNSUPPORTED`, `LIMITED`, `UNAVAILABLE`.
- Optional fields include `fields`, `levels`, `reason` and `entitlementUnverified`.
- This model describes streaming component capability, not broad REST/API capability metadata.
- `packages/broker-upstox/src/components.ts` builds Upstox component capability results for a feed mode/instrument type. `packages/broker-fyers/src/stream.ts` reports component capabilities and supplies them on a typed terminal limit failure.
- `apps/api/src/stream-supervisor.ts` retains the capability results associated with the current terminal generation (`stream-supervisor.ts:235–240`). `packages/contracts/src/live.ts` already includes optional `runtime.capabilities` (`:262`) and the per-provider `runtimes` map (`:287`) in `SubscriptionStateView`.
- `apps/api/src/subscription-coordinator.ts` already returns a runtime entry keyed by provider for each configured runtime (`:124–141`). `GET /api/market/subscriptions` already validates the response through `subscriptionStateViewSchema` (`market-routes.ts:108–109`).
- `apps/web/src/lib/subscriptions.ts` already validates subscription responses using that shared schema (`:43–47`).
- `apps/web/src/components/SubscriptionPanel.tsx` currently shows desired/applied generation (`:107`), per-selection resolution state from `view.runtime.resolutions` (`:111,118–120`), and aggregate runtime connection/error from `view.runtime` (`:134–135`). It does not render `view.runtimes` or `runtime.capabilities`.

These two models must stay separate. In particular, do not translate `UNKNOWN` to `UNAVAILABLE`, `UNAVAILABLE` to `UNSUPPORTED`, or infer streaming support from a successful authentication check.

### 2.5 Existing update behavior

- Provider status is refreshed on a 10-second interval in `App.tsx`.
- `SubscriptionPanel` fetches the subscription view on mount and after a successful write. The Zustand store does not itself refresh `subscriptions` from an SSE event. Runtime capability information can therefore change after the initial fetch without immediately appearing in the panel.
- `fetchSubscriptions()` currently takes no `AbortSignal` (`subscriptions.ts:43`).
- Use the existing `GET /api/market/subscriptions` route; do not create a parallel status route.

---

## 3. Selected architectural decisions

### 3.1 Keep the current provider identities and API wire shape

- Keep `providerIdSchema` fixed to `UPSTOX` and `FYERS` in this phase.
- Keep the existing `{ providers, localManagement, note }` JSON response shape to avoid an unnecessary API migration.
- The WebUI should iterate `Object.values(validatedProviders)` and render each entry using `status.id`. It must not name `providers.UPSTOX` or `providers.FYERS` in the list rendering.
- A future provider addition still requires an explicit backend contract/registry/adapter extension. Once the provider status map contract is extended, the list rendering must not need a corresponding React list edit.

### 3.2 Add one shared contract for the provider-status envelope

Add an envelope schema in `packages/contracts/src/provider.ts` (working name `providerStatusesResponseSchema`) describing the existing response:

```ts
export const providerStatusesResponseSchema = z.object({
  // The route returns providers: null when no registry/auth map is available.
  providers: providerStatusMapSchema.nullable(),
  localManagement: z.boolean(),
  note: z.string()
});
export type ProviderStatusesResponse = z.infer<typeof providerStatusesResponseSchema>;
```

Export its inferred type from `provider.ts`; the existing `index.ts` barrel already re-exports `./provider`, so no extra export list edit is needed.

The API route should validate the complete envelope before returning it. The WebUI client should parse the response with the same shared schema and reject malformed payloads with a stable, user-safe error. Remove the narrower duplicated `ProviderStatusView`/`ProvidersStatusResponse` interfaces once all consumers use the shared type. A `providers: null` response remains valid and is rendered as an explicit "Provider status is currently unavailable." state (distinct from the `undefined` loading state) — implemented in WP 5A.

Do not change the endpoint path, HTTP method, status-map keys or response field names.

### 3.3 Render provider-wide metadata from `ProviderStatus`

- Iterate each provider's `capabilities` and `limits` arrays. Their values and names come from the adapter status; the frontend owns only presentation labels, layout and visual treatment.
- Display capability state and source independently. Display `asOf` and `note` when present.
- Display limits with their source, state, `publishedAt` and note. A numeric value with state `UNKNOWN` must not look like a verified account entitlement or guaranteed account limit.
- Empty arrays mean "no capability metadata reported", not "provider has no capability".
- Keep authentication state and streaming connection state separate from capability status.

### 3.4 Render component-level runtime capabilities from the existing subscription view

- Prefer `view.runtimes` when it is present and has at least one entry, iterating its entries and showing each provider key with its own runtime state/error/capability results.
- For legacy/single-runtime payloads with no populated `runtimes` map — including `runtimes: {}` (present but empty) — continue to render `view.runtime` as the fallback. Do not render the `runtime` compatibility alias in addition to a populated `runtimes` map, because the coordinator's `runtime` field represents the first runtime (`subscription-coordinator.ts:130–140`) — rendering both would duplicate it.
- Render `runtime.capabilities` only when the backend actually supplies results. Show the exact state (`SUPPORTED`, `UNSUPPORTED`, `LIMITED`, `UNAVAILABLE`), fields/levels where supplied, reason where supplied, and an explicit "entitlement not verified" indicator when `entitlementUnverified === true`.
- Omission **or an empty array** of `runtime.capabilities` means no runtime capability report was supplied. It must not be presented as full support or as a failure.
- Keep the existing `SubscriptionStateView` schema and API route as the source; no new data contract is needed for this part.

### 3.5 Refresh runtime diagnostics without adding another API

Refresh the existing subscription view at a bounded 10-second interval, matching the existing provider-status cadence. **Prefer existing TanStack Query functionality over building a custom polling framework**; only fall back to an equally bounded single-flight pattern if TanStack Query cannot integrate cleanly with the existing serialized write behavior. Preserve the Zustand store as the view consumed by the current panel if that is the least disruptive implementation. **If TanStack Query is used, its query cache/update path must still treat the PUT-returned view as authoritative and must not bypass the existing serialized write behavior/generation guard in `lib/subscriptions.ts`.** Extend `fetchSubscriptions()` to accept an optional `AbortSignal` so an in-flight read can be cancelled on unmount or before a write:

```ts
export async function fetchSubscriptions(signal?: AbortSignal): Promise<SubscriptionStateView> {
  const response = await fetch("/api/market/subscriptions", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {})
  });
  // ...existing error handling and subscriptionStateViewSchema.parse...
}
```

The implementation must prevent overlapping requests and preserve the existing serialized write behavior. When a subscription write starts, cancel or suspend any in-flight/pending poll; after the write completes, apply its returned view as authoritative and resume polling. Do not allow an older GET response to overwrite a newer PUT result. **Coordination mechanism (required):** polling must coordinate with the serialized write queue in `lib/subscriptions.ts` (`writeQueue`, `writeGeneration`, superseded-write `view: null` semantics at `:51–78`). Discard any poll result that started before the latest completed write was applied, or use a monotonic client-side write/version guard shared by poll and write paths. `AbortSignal` cancellation is necessary but **not sufficient by itself** — a response can parse before the abort is observed — so the apply step must re-check the guard before calling `setSubscriptions`/store update. A polling failure must not erase the last known-good view; show a separate stale/error indication and allow retry/refresh. **Polling stale/error indication must be distinct from post-commit write/runtime errors; local component state is preferred unless a shared store field is clearly justified.**

### 3.6 Keep provider-specific authentication workflows

Keep the explicit Upstox token and FYERS OAuth/config flows. Do not introduce a generic provider form renderer or infer credential fields from capability metadata.

---

## 4. Exact implementation scope and work packages

Implementation order: **5A → 5B → 5C**. Each work package must remain bounded and pass its own tests before the next begins.

### WP 5A — Validated, enumerable provider status — COMPLETE (published at `2df616d`)

1. Add the provider-status response envelope schema/type to `packages/contracts/src/provider.ts`.
2. Validate the complete response envelope in `apps/api/src/provider-routes.ts` while preserving the existing response shape and LAN/read-only behavior.
3. Update `apps/web/src/lib/status.ts` to parse the response against the shared schema. Remove duplicated narrow provider response interfaces.
4. Update Providers list rendering in `apps/web/src/App.tsx` (or a focused provider-status component) to iterate the validated map and display entries by `status.id`.
5. Preserve the current provider status polling interval, manual refresh, loading/error behavior, and provider management controls.

**WP 5A exit:** no frontend access to `providers.UPSTOX` or `providers.FYERS` for list rendering; API and WebUI validate the same response contract; endpoint JSON shape remains unchanged.

**WP 5A completion evidence:** commits `f7b3dcf` (implementation), `dfd8029` (nit fixes + focused component extraction), `2df616d` (null-vs-undefined state fix). Files: `packages/contracts/src/provider.ts`, `apps/api/src/provider-routes.ts`, `apps/web/src/lib/status.ts`, `apps/web/src/App.tsx`, new `apps/web/src/components/ProviderStatus.tsx`, `tests/providers/status-composition.test.ts`, new `tests/web/provider-status.test.ts`. Focused tests 10 pass / 0 fail; full suite 872 pass / 0 fail; typecheck/build/diff-check clean. Independent audits on `opencode/iceman-free`: KEEP (implementation), NEEDS FIX (encoding regression from a tooling edit), KEEP (after encoding fix), KEEP (after null-state fix). All acceptance criteria met; no remaining limitations.

### WP 5B — Provider-wide capabilities and limits — COMPLETE (published at `bfc1e36`)

1. Extend the provider status presentation to render `ProviderStatus.capabilities` and `ProviderStatus.limits`.
2. Use the existing `capabilityStateSchema` and `capabilitySourceSchema` values. Do not add new capability states or hardcode provider capability names.
3. Clearly distinguish `API` evidence from `DOCUMENTATION` evidence, and show `USER`/`UNKNOWN` accurately when present.
4. Preserve unknown values and dates. In particular, do not promote documentation-derived limit values to verified account entitlements.
5. Keep current auth/streaming statuses, error/restriction display, and control behavior intact.

**WP 5B exit:** the provider panel displays all supplied capability/limit records without a frontend capability inventory; an empty or unknown report is explicit and honest.

**WP 5B completion evidence:** commits `e2b20f8` (implementation), `bfc1e36` (audit fixes). Files: `apps/web/src/components/ProviderStatus.tsx`, `tests/web/provider-status.test.ts`. Focused tests 33 pass / 0 fail; full suite 885 pass / 0 fail; typecheck/build/diff-check clean. Independent audits on `opencode/iceman-free`: KEEP with 5 minor/nit findings → all fixed → KEEP with no outstanding findings. All acceptance criteria met; no remaining limitations.

### WP 5C.1 — Render per-provider runtime status and capabilities — COMPLETE (published at `16f2b88`)

1. Update the subscription runtime presentation to prefer and iterate `SubscriptionStateView.runtimes` where supplied, with a fallback to the legacy `runtime` field (including `runtimes: {}`).
2. Display `runtime.capabilities` from the existing `CapabilityResult` contract, including all four status values and `entitlementUnverified`.
3. Preserve desired selections, generation semantics, runtime error handling, and the current write queue. Do not alter provider runtime or supervisor behavior.
4. Do not wire `upstoxCapabilities()` into a new runtime path in this work package. It is mode/instrument-specific and must not be presented as a live runtime report unless an independently approved design establishes the correct source and lifecycle.

**WP 5C.1 exit:** when a provider runtime reports structured capabilities, the WebUI renders them under that provider; no report is not misrepresented as support; legacy single-runtime views remain usable.

**WP 5C.1 completion evidence:** commits `e19b4b8` (implementation), `16f2b88` (audit fixes). Files: `apps/web/src/components/SubscriptionPanel.tsx`, new `apps/web/src/components/SubscriptionRuntimeView.tsx`, `tests/web/subscriptions.test.ts`. Focused tests 17 pass / 0 fail; full suite 892 pass / 0 fail; typecheck/build/diff-check clean. Independent audits on `opencode/iceman-free`: KEEP with 4 minor/nit findings → all fixed → KEEP with no outstanding findings. All acceptance criteria met; no remaining limitations.

### WP 5C.2 — Add safe, bounded automatic refresh — COMPLETE (published at `0712cb8`)

1. Add bounded 10-second refresh of the existing subscription-status GET route so terminal runtime capability changes can appear without a page reload or new subscription write (§3.5).
2. Prefer existing TanStack Query functionality over a custom polling framework. If TanStack Query is used, its cache/update path must treat the PUT-returned view as authoritative and must not bypass the serialized write/generation guard in `lib/subscriptions.ts`.
3. Prevent overlapping requests; cancel on unmount and before writes; prevent an older GET response from overwriting a newer PUT result via the monotonic guard (§3.5); preserve last-known-good data on refresh failure with a distinct stale/error indication.
4. Extend `fetchSubscriptions()` with an optional `AbortSignal` (§3.5).

**WP 5C.2 exit:** runtime capability changes appear without reload; polling never races with writes, never overwrites newer data, cancels on unmount, and degrades honestly on failure. This task is separately authorized and independently audited from 5C.1.

**WP 5C.2 completion evidence:** commits `1dde388` (implementation), `0712cb8` (audit fixes). Files: `apps/web/src/components/SubscriptionPanel.tsx`, new `apps/web/src/lib/subscription-poller.ts`, `apps/web/src/lib/subscriptions.ts`, `tests/web/subscriptions.test.ts`. Focused tests 33 pass / 0 fail; full suite 908 pass / 0 fail; typecheck/build/diff-check clean. Independent audits on `opencode/iceman-free`: NEEDS FIX (2 majors: unguarded mount GET, missing resume-after-write tests; 2 minors; 1 nit) → all fixed → NEEDS FIX (1 minor liveness edge case) → fixed → KEEP with no outstanding findings. Mandatory race test (older GET resolving after successful PUT) and liveness test (never-settling aborted fetch) both present and passing. All acceptance criteria met; no remaining limitations.

---

## 5. Files and components allowed to change

Keep the implementation to these files unless a concrete dependency requires an additional file and the reason is reported before editing it.

**Contracts and API**

- `packages/contracts/src/provider.ts`
- `apps/api/src/provider-routes.ts`

**WebUI**

- `apps/web/src/lib/status.ts`
- `apps/web/src/lib/subscriptions.ts` (optional `AbortSignal` for cancellable status reads)
- `apps/web/src/App.tsx`
- `apps/web/src/components/SubscriptionPanel.tsx`
- `apps/web/src/store/live-store.ts` — optional only if a separate polling-stale/polling-error state cannot be cleanly kept as local component state; report before editing. The store already owns `subscriptionError`/`setSubscriptionError` for write/runtime errors; polling staleness must remain distinct from those.
- Optional focused presentation components under `apps/web/src/components/` if they keep responsibilities cohesive and reduce unnecessary growth of `App.tsx`/`SubscriptionPanel.tsx`.

**Tests**

- `tests/providers/status-composition.test.ts`
- `tests/web/subscriptions.test.ts`
- `tests/web/provider-status.test.ts` (new — provider enumeration and capability rendering; does not exist today)
- Existing adapter/registry tests may be extended only for regression assertions directly required by this scope.

No package dependency is expected. `apps/web` already depends on `@markethub/contracts` and TanStack Query.

---

## 6. Protected areas and explicit non-goals

### Protected — must remain unchanged

- `packages/contracts/src/provider-identity.ts` and the current `UPSTOX`/`FYERS` identity values.
- `packages/market-core/src/provider.ts` registry behavior, unless a specific correctness defect is demonstrated and separately approved.
- Upstox/FYERS adapter credential validation, OAuth, token replacement, expiry handling, retry policy and provider API calls.
- Provider credential routes, local-owner checks, callback validation, credential storage and persisted provider settings.
- `packages/contracts/src/live.ts`, `packages/contracts/src/live-components.ts`, `apps/api/src/stream-supervisor.ts` and `apps/api/src/subscription-coordinator.ts` data-production/reconciliation behavior.
- Subscription persistence, database schema/migrations, canonical market data, MCP tools/resources/prompts and catalog discovery.
- Existing AD-024 design and any locked/production streaming boundary.
- Provider controls in the WebUI: preserve their current Upstox/FYERS-specific forms and behavior.

### Explicit non-goals

- Adding a third provider or making provider registration dynamically plug-in-extensible.
- A generic adapter factory, provider plugin framework, universal auth flow, universal credential-form schema, or dynamic OAuth form renderer.
- Replacing the fixed provider identity contract with arbitrary strings.
- Creating a new provider metadata endpoint or a metadata microservice.
- Adding a database table, migration, new package or dependency.
- Combining `ProviderCapability` (`AVAILABLE`/`UNAVAILABLE`/`UNKNOWN`) with `CapabilityResult` (`SUPPORTED`/`UNSUPPORTED`/`LIMITED`/`UNAVAILABLE`).
- Inventing capability states such as `SUPPORTED` or `LIMITED` in `provider.ts`, or inferring entitlement from authentication success.
- Changing broker capability facts, rate limits, plan entitlements, source dates or notes. Any factual update requires separate official provider documentation evidence and explicit scope.
- Turning `upstoxCapabilities()` into a runtime report without proving the feed-mode/instrument context and lifecycle.
- Changing streaming enablement, retry/reconciliation, subscriptions, data-selection policy or provider ordering.
- Phase 6c stale overview statements, Phase 4 expiry work, provider activation, or Stage G live verification.

---

## 7. Option and Metadata Impact Assessment — mandatory 18 questions

1. **What new selectable options, capabilities, entities or configuration fields are introduced?** None. The phase only displays the existing provider identities, provider-wide capability/limit records, and runtime component-capability records.
2. **Who owns their source of truth?** Provider identity: `providerIdSchema` in `provider-identity.ts`; provider status/capabilities/limits: `ProviderStatus` and adapter status through `ProviderRegistry`; runtime component capability: `capabilityResultSchema`, streaming drivers and `StreamSupervisor`.
3. **Are they shared contract enums, backend capabilities, domain data or user-managed values?** The provider IDs and status vocabularies are shared contracts; capability records are backend/adapter-owned metadata; runtime capability results are per-provider runtime data. No user-managed setting is added.
4. **How will each consumer obtain them?** Provider panel: existing `GET /api/providers/status`, validated by the shared provider response schema. Subscription panel: existing `GET /api/market/subscriptions`, validated by `subscriptionStateViewSchema` and iterated from its `runtimes` map.
5. **Does an existing API, schema, registry or repository already provide the information?** Yes. Both APIs and the relevant Zod schemas already exist. The gap is WebUI validation/rendering and refresh behavior.
6. **Is a new discovery/read API necessary?** No. Reuse the two existing read endpoints.
7. **How will the UI update when new values/capabilities are registered, without a separate frontend-list edit?** Provider cards iterate the validated status map; runtime cards iterate the `runtimes` record; capability lists iterate backend-supplied arrays. Presentation labels remain local.
8. **What cache invalidation or refresh behavior is needed?** Keep the provider status 10-second polling/manual refresh. Add bounded 10-second refresh for subscription runtime status; successful writes update the view immediately. Preserve last known-good view on refresh errors.
9. **Are any metadata fields sensitive or unsafe to expose?** Credentials, access tokens, app secrets, authorization URLs/state, app IDs, redirect URIs and provider settings must not be included. The public provider status contract contains status/diagnostic metadata only. Continue sanitizing error text; do not expose config/credential-store objects.
10. **What tests prove consistency and no duplicate definition?** Contract validation tests, API envelope tests, UI enumeration tests built from the validated map, capability rendering tests for both models, arbitrary runtime-key iteration tests, legacy fallback tests, and malformed-payload rejection tests.
11. **Shared contract impact?** Add only the provider-status envelope schema/type. Reuse current provider and runtime schemas; do not add duplicate enums or modify their states.
12. **Provider/runtime registration impact?** No provider identity is added. The current fixed `UPSTOX`/`FYERS` contract remains. Existing runtime keys are consumed dynamically; backend provider registration remains explicit.
13. **MCP tool/resource/prompt impact?** None.
14. **REST/SSE/WebUI consumer impact?** Preserve `GET /api/providers/status` and `GET /api/market/subscriptions` response shapes. Update only provider-status client validation/rendering and subscription runtime rendering/refresh. No SSE change.
15. **Domain-data discovery impact?** None. These are bounded status responses, not catalog/domain collections.
16. **Configuration persistence impact?** None. Credential and provider settings flows remain unchanged.
17. **Forward compatibility?** A provider added through a future approved contract/registry extension appears in the provider list and per-provider runtime map without an additional React key/list edit. Its auth controls still require an explicitly designed provider-specific implementation.
18. **Dependency direction?** The response envelope belongs in `@markethub/contracts`; API and WebUI depend on the contract. No imports from the WebUI/API into contracts or provider adapters; no circular dependency is introduced.

---

## 8. Acceptance criteria

### 8.1 Provider status contract and enumeration

- The existing status endpoint returns the same fields and same JSON structure as before.
- The complete response envelope is validated by the shared contract in the API and WebUI, including the `providers: null` case.
- Invalid JSON or a malformed response produces a stable UI error; it is not blindly cast.
- Provider list rendering iterates values and uses each status object's `id`; there is no hardcoded `providers.UPSTOX`/`providers.FYERS` list rendering.
- Provider IDs remain fixed to the currently approved values. This phase makes no claim of dynamic provider plug-ins.

### 8.2 Provider-wide capability metadata

- All backend-supplied capability/limit entries render without a duplicated frontend names list.
- `AVAILABLE`, `UNAVAILABLE` and `UNKNOWN` are visibly distinct.
- `API`, `DOCUMENTATION`, `USER` and `UNKNOWN` sources are preserved and displayed accurately.
- Optional dates and notes appear only when supplied.
- Documentation-derived values with `UNKNOWN` state are not described as verified account entitlements or effective account limits.
- Empty arrays produce a neutral "no metadata reported" state, not an unsupported/unavailable claim.

### 8.3 Streaming runtime capabilities

- Each entry in `view.runtimes` is rendered under its own provider key when that map is present and non-empty; an empty `runtimes` object falls back to `view.runtime`.
- Legacy/single-runtime payloads still render using `view.runtime`.
- `SUPPORTED`, `UNSUPPORTED`, `LIMITED` and `UNAVAILABLE` remain distinct.
- `fields`, `levels`, `reason` and `entitlementUnverified` are displayed only when present and are not fabricated.
- No capability report is not shown as a successful support matrix.
- Runtime status refresh does not overwrite a newer user write or hide the desired selection state; polling is cancelled/suspended during writes and resumes from the returned write view.

### 8.4 Behavior and security

- Provider authentication and credential-management flows are unchanged.
- Existing local-owner checks and read-only LAN status behavior remain unchanged.
- No credentials/secrets/configuration values are present in provider status payloads.
- One provider's status/capability error does not hide another provider's status.
- No new endpoint, migration, package dependency or provider runtime behavior is introduced.

---

## 9. Required tests and commands

### 9.1 Contracts and API

- Provider response envelope accepts the current valid response (including `providers: null`) and rejects malformed/missing/wrong-typed fields. Add these envelope cases in `tests/providers/status-composition.test.ts` or a focused contracts test; name the file in the implementation report.
- `GET /api/providers/status` keeps its response envelope and passes the shared schema.
- Status payload contains only the intended non-secret response fields.
- Existing composition behavior still reports both fixed providers, including disabled defaults when an adapter is absent.

### 9.2 Provider WebUI (`tests/web/provider-status.test.ts`)

- Provider list renders all entries derived from the validated map; a regression test must fail if rendering goes back to named `UPSTOX`/`FYERS` property access.
- `providers: null` renders the explicit "Provider status is currently unavailable." state (not loading); `undefined` still renders loading.
- Capability rendering covers each existing state and source, optional notes/dates, empty arrays and a documentation-derived numeric limit with `UNKNOWN` state (source-honesty).
- Authentication and streaming status continue to display independently.

### 9.3 Subscription runtime WebUI (`tests/web/subscriptions.test.ts`)

- A coordinated response with multiple keys in `runtimes` renders each provider without a frontend provider list.
- Legacy payload without `runtimes` renders `runtime` once; `runtimes: {}` (present but empty) also falls back to legacy `view.runtime` rendering.
- When `runtimes` is populated, the legacy `runtime` alias is not rendered a second time.
- Capability rendering covers all four statuses, fields, levels, reason and `entitlementUnverified: true`.
- Missing/empty capability arrays do not imply support or unavailability.
- Polling stops on unmount, does not overlap requests, preserves last known-good data on errors, and does not race with serialized subscription writes. **Specifically: a poll response that resolves after a successful PUT does not overwrite the PUT's returned view** (the monotonic guard from §3.5), and polling stale/error indication is distinct from post-commit write/runtime errors.
- `fetchSubscriptions(signal)` forwards the same signal object to `fetch` and `AbortError` propagates unchanged.

### 9.4 Regression commands

Run the focused provider and WebUI tests first, then the full repository checks:

```bash
bun test tests/providers/status-composition.test.ts tests/providers/registry.test.ts
bun test tests/web/provider-status.test.ts tests/web/subscriptions.test.ts
bun run typecheck
bun run build
bun test
git diff --check
```

Do not claim CI verification unless an actual GitHub Actions run/status is available. Record exact local test counts and failures. Verify actual test paths/naming before writing; do not claim a grouped command that was not executed.

---

## 10. Implementation control and verification

Before editing:

1. Re-read `docs/PROJECT_MANAGER_PROTOCOL.md` and inspect the latest `develop` branch. The baseline in this plan may be stale if the parallel documentation task has already published updates.
2. Record `git status --short --branch`; preserve all pre-existing and untracked work.
3. Confirm the latest documentation close-out did not alter the Phase 5 assumptions or scope.
4. Report the exact files proposed for each WP. Any extra file or contract behavior change needs a reason before editing it.

During implementation:

- Complete WP 5A, verify it, then WP 5B, verify it, then WP 5C.1, verify it, then WP 5C.2, verify it. Each is separately authorized and independently audited.
- Do not start a new provider, auth, adapter, data or streaming architecture task.
- Keep the existing endpoint shapes and subscription write semantics.
- Do not use a generic fallback capability label that turns unknown information into a positive claim.

After implementation:

- Review the complete diff independently, not only the agent's summary.
- Verify no frontend provider/capability list was added.
- Verify both capability contracts remain separate and all status/source values are preserved.
- Run the focused and full tests, `bun run typecheck`, `bun run build` and `git diff --check`.
- Record `git status --short --branch` after implementation and identify all modified/untracked files.
- Report implemented, tested, incomplete and unverified items separately.
- No commit, push, merge, rebase or amend without separate explicit authorization.

---

## 11. Risks, deferred decisions and repository references

### 11.1 Key risks

- **Capability-model confusion:** `ProviderCapability` and runtime `CapabilityResult` have different states and meanings. Mitigation: render them in separate UI contexts and keep both existing schemas.
- **Unverified entitlements:** adapter notes include documentation-derived values not verified against a user's broker account. Mitigation: show state/source/note and never infer entitlement from auth success.
- **Runtime capability freshness:** terminal capability reports are generation-scoped. Mitigation: use the existing view and refresh cadence; do not retain an old generation's result as current.
- **Compatibility:** external consumers may rely on the existing provider status map. Mitigation: preserve the API envelope and map shape.
- **False extensibility claim:** status iteration does not make provider registration dynamic. Mitigation: explicitly keep the provider ID contract and adapter registration process unchanged.
- **Upstox runtime context:** `upstoxCapabilities()` requires instrument type/feed mode and is not automatically a provider-wide status matrix. Mitigation: do not wire it into the runtime status panel in this phase.
- **Polling/write races:** the WP 5C refresh must not overwrite a newer write. Mitigation: single-flight, cancel on unmount/write, last-known-good preservation, and dedicated tests (§9.3).

### 11.2 Deferred

- Actual addition of another provider and its full adapter/auth/data lifecycle.
- Dynamic provider plugin registration or a generic provider configuration form.
- A unified cross-provider capability matrix for all REST, historical, option-chain and streaming operations.
- Surfacing mode-specific Upstox capability results outside their proven mode/instrument context.
- Any changes to capability facts based on revised official provider documentation.
- Any AD-024 redesign, live data runtime change or Stage G activation.

### 11.3 Source files inspected

- `packages/contracts/src/provider-identity.ts`, `provider.ts`, `live-components.ts`, `live.ts`
- `packages/market-core/src/provider.ts`
- `packages/broker-upstox/src/index.ts`, `components.ts`
- `packages/broker-fyers/src/index.ts`, `stream.ts`
- `apps/api/src/provider-routes.ts`, `stream-supervisor.ts`, `subscription-coordinator.ts`, `market-routes.ts`
- `apps/web/src/lib/status.ts`, `subscriptions.ts`, `App.tsx`, `components/SubscriptionPanel.tsx`, `store/live-store.ts`
- `tests/providers/status-composition.test.ts`, `registry.test.ts`, `tests/web/subscriptions.test.ts`
- `docs/PROJECT_MANAGER_PROTOCOL.md`, `METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md` §7, `METADATA_AND_CAPABILITY_DISCOVERY.md` (AD-025), `ARCHITECTURE_DECISIONS.md` AD-002/003/023/024/025

No official provider API behavior or account entitlement is changed or newly asserted by this plan. If implementation changes any capability fact, that fact must be independently checked against the relevant official provider documentation and recorded with its source/date.

---

## 12. Handoff boundary and authorization

This document is now an implementation record as well as the original plan. Phase 5 is **complete and published on `develop`**; it is not an open implementation assignment and grants no further authorization.

All four work packages were separately authorized, implemented, independently audited to KEEP with no outstanding findings, and published: WP 5A (`2df616d`), WP 5B (`bfc1e36`), WP 5C.1 (`16f2b88`), WP 5C.2 (`0712cb8`), with the final documentation close-out at `abf5c64`. Per-package evidence is recorded in §4. No further Phase 5 implementation work is pending.

**Remaining work (separately gated):** Phase 7 cross-system acceptance runs when its other prerequisites are complete. Live provider verification (Stage G) remains locked and requires separate authorization. No Phase 6, Phase 7 or Stage G work is authorized by this document.
