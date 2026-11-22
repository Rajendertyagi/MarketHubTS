# MarketHubTS — Phase 3 WP 3b–3c: Reusable Instrument Search Picker

**Plan status:** Source study and implementation plan only. No repository files changed by this plan.
**Repository baseline inspected:** `Rajendertyagi/MarketHubTS`, branch `develop`, commit `671575590f31a91f0dfde9aeb5101aa50e04155d` (Phase 1 implementation and close-out corrections pushed). Source baseline at this commit; this plan document is finalized in the working tree. Source facts were re-verified against this checkout; line numbers may move during implementation, so verify names/usages before editing.

**Governing documents:**
- [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) — AD-025, especially §§5–8 and §10.E.
- [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) — §4.1, Phase 3.
- [METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md](METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md) — §1 canonical implementation order and Phase 3.
- [METADATA_DISCOVERY_FIRST_SLICE_PLAN.md](METADATA_DISCOVERY_FIRST_SLICE_PLAN.md) — Increment 2.
- [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md) — §§3–4.1.

---

## 0. Decision: this is the next implementation increment

The repository's canonical implementation order is:

1. Phase 1 shared-contract consistency + Phase 3 WP 3a historical interval selector — completed and pushed.
2. **Phase 3 WP 3b–3c — reusable instrument picker using the existing `GET /api/catalog/search`** — next.
3. Phase 2 MCP Activity Operation selector — later, after the descriptor-delivery decision.
4. Later phases only when their prerequisites are satisfied.

Do not start Phase 2 as the next implementation task. Do not combine this task with provider extensibility, derivative expiry discovery, catalog ingestion or other roadmap work.

---

## 1. Verified source baseline

### 1.1 Existing catalog search API — reuse it

`apps/api/src/catalog-routes.ts` already registers `GET /api/catalog/search`.

Current behavior:
- `text` is required and trimmed; empty/whitespace-only text returns HTTP 400 with the shared `apiErrorSchema` shape.
- `limit` defaults to 25 and must be an integer from 1 through 100.
- `cursor`, when present, must be a non-empty token.
- The route calls the existing `CatalogRepository.searchInstruments()` method.
- The response is `{ instruments, nextCursor }`.
- Each returned instrument is validated with `canonicalInstrumentSchema` before serialization.
- It requests a `limit + 1` lookahead row, returns at most `limit` instruments, and sets `nextCursor` to the last returned instrument's `canonicalId` only when another page exists.
- The route is read-only and deliberately has no local-peer/auth guard, consistent with the existing read-only catalog API.

`packages/database/src/repositories/catalog.ts` implements bounded keyset search:
- Case-insensitive substring matching against `canonicalSymbol`, `displayName` and `identityKey`.
- SQL `LIKE` metacharacters `%`, `_` and `\` are escaped.
- Results are ordered by `canonicalId` ascending.
- `afterCanonicalId` is the keyset cursor.
- Repository lookahead is `limit + 1`.

`packages/market-core/src/types.ts` documents the repository result as bounded and deterministic. The current API contract already supplies everything needed for this picker; no new endpoint, filter parameter, migration or repository method is justified.

### 1.2 Search limitations — preserve them honestly

The current endpoint does **not** search aliases or identifier-history values such as ISIN/exchange security IDs. It searches only symbol, display name and identity key.

The current endpoint/repository does **not** provide server-side filters for exchange, segment, instrument category, market type, underlying, product scope or lifecycle state. The response contains those properties through `canonicalInstrumentSchema`, but they are not search predicates.

Do not add client-side or pretend server-side faceted filters in this increment. Do not claim that an ISIN/alias search or a filter is supported when it is not.

The architecture inventory also records that the current local catalog can be empty because a production/offline population path is not yet established. The picker must handle an empty catalog honestly; it must not add sample instruments, synthesize options or expand into catalog ingestion.

### 1.3 Existing WebUI patterns and gaps

- `apps/web/src/lib/activity.ts` is the closest client pattern: `URLSearchParams`, `Accept: application/json`, response parsing and typed HTTP errors.
- The WebUI package already depends on `@markethub/contracts`; no dependency addition is needed.
- `apps/web/src/components/SubscriptionPanel.tsx` stores a `draftId`, accepts a manually typed canonical ID, and passes it to the existing `replaceSubscriptions()` flow.
- `apps/web/src/components/HistoricalPanel.tsx` stores `canonicalId`; its `focus` prop can prefill that value from an MCP activity reference. Read-cached and sync-config requests use that existing ID and must keep their shapes.
- `apps/web/src/components/SnapshotPanel.tsx` stores `underlying`; the underlying ID is used by existing capture-config and capture requests. Expiry and explicit provider selection are separate form fields and must remain unchanged.
- The current tests use Bun, injected `fetch` mocks and `renderToStaticMarkup`; there is no installed DOM/testing-library dependency in `apps/web/package.json`.
- `tests/mcp/catalog-search.test.ts` covers repository search behavior; `tests/market/catalog.test.ts` covers catalog foundation/identity/sync (not search). There is no dedicated catalog-route test in the current test tree.

### 1.4 Fields available for results

`packages/contracts/src/market.ts` defines `canonicalInstrumentSchema`. Useful picker fields include:
- `canonicalId` — the exact value to pass to existing panel actions/APIs.
- `displayName` and `canonicalSymbol` — user-facing names.
- `exchange` and `segment` — useful disambiguation.
- `marketType` and `instrumentCategory` — optional secondary classification.
- Optional `derivative` data — available in the schema, but do not use it to invent expiry selection or contract discovery.

The UI should render a concise human-readable label such as display name + symbol + exchange/segment. Keep `canonicalId` as the selected value. Do not render `identityKey`, arbitrary `sourceMeta` or other internal metadata as the visible option label.

---

## 2. Objective and user-visible result

Replace manual canonical-ID entry in all three panels with one reusable searchable picker backed by the existing bounded catalog API:

1. Subscription panel — selected result supplies the `canonicalId` used by the existing Add/`replaceSubscriptions()` flow.
2. Historical panel — selected result supplies the `canonicalId` used by cached reads and sync-config operations. Activity focus can still prefill the canonical ID.
3. Snapshot panel — selected result supplies the `underlyingCanonicalId` used by the existing capture-config and capture flows.

The picker is an input aid only. It does not create or change subscriptions/configurations itself. The existing panel action buttons continue to own those operations.

---

## 3. Proposed design

### 3.1 Typed catalog client

Add `apps/web/src/lib/catalog.ts`.

Suggested public surface:

```ts
export interface CatalogSearchQuery {
  text: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface CatalogSearchPage {
  instruments: CanonicalInstrument[];
  nextCursor: string | null;
}

export async function searchInstruments(
  query: CatalogSearchQuery
): Promise<CatalogSearchPage>;
```

Implementation constraints:
- Use `URLSearchParams` for `text`, `limit` and `cursor`.
- Trim the search text and avoid issuing a request for an empty query; the server correctly returns 400 for empty text.
- Use a bounded page size of 25 by default; never exceed the API maximum of 100. The picker always passes 25; the client clamps 1–100 defensively.
- Forward an optional `AbortSignal` to `fetch`.
- Parse each result with the shared `canonicalInstrumentSchema` and validate the response envelope (`instruments` array and `nextCursor: string | null`). Do not trust an unvalidated JSON cast. Define the envelope schema locally in `catalog.ts` — **no contract change** (the API has no shared envelope schema today; add one only if source review establishes a real cross-package reuse need).
- Follow the typed-error and safe error-message approach used by `activity.ts`; abort/cancellation is not a user-facing error. Deliberate simplification: catalog search has no 404 or 422 semantics, so use three error kinds — `CatalogErrorKind = "forbidden" | "validation" | "internal"`, with `classify(status)` mapping 403→forbidden, 400→validation, else internal. `forbidden` is defensive-only — the current route has no auth/local-peer guard (`catalog-routes.ts:20–23`) and cannot emit 403 today; keep the kind for forward safety without claiming it is currently reachable. `AbortError` must propagate unchanged (not be converted to a typed error) so the picker can distinguish cancellation from failure.
- Do not add a new HTTP endpoint or a new package/dependency.

### 3.2 Reusable `InstrumentPicker`

Add `apps/web/src/components/InstrumentPicker.tsx`.

Use one controlled component API across all three panels. A suitable shape is:

```ts
interface InstrumentPickerProps {
  value: string;
  onChange: (canonicalId: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}
```

The exact prop names may follow local conventions, but the contract is:
- Parent owns the selected canonical ID.
- The component owns only transient search text, result list, loading/error/pagination state and a cached selected descriptor `{ canonicalId, label }`. Render the cached label **only** when `canonicalId === value`; otherwise render the safe ID fallback. When the parent changes `value` (e.g. a new activity focus), the old label must not be shown against the new ID.
- Selecting a result calls `onChange(instrument.canonicalId)` — never the display label.
- Typing a query does not select the first result automatically.
- A selected canonical ID supplied by a parent (especially `HistoricalPanel` activity focus) must remain representable even when it is not in the current result page. Show a safe fallback using that ID until a display record is available; do not silently clear or replace it. The search box remains a separate query field; clearing it does not clear `value`.
- Provide clear loading, results, no-match, empty-catalog, error/retry and load-more states. "Stale" means a superseded in-flight response ignored by generation check, not a separate visible state.
- Keep search and selection accessible: a labelled search input, keyboard-usable result controls, visible focus, and appropriate list/option semantics. Do not rely on color alone. Required keyboard behavior: **ArrowDown/ArrowUp** move an active option, **Enter** selects the active option (not auto-select on typing), **Escape** clears the search text without clearing `value`, and focus returns to the search input after selection. Concretely: `role="listbox"` on the results container, `role="option"` + `aria-selected` on each option, and `aria-activedescendant` on the search input pointing at the active option; assert these attributes in the static-markup test. The selected value is always `canonicalId`; the display label is presentation only.
- Keep the existing Tailwind visual language and do not introduce a UI framework or generic form renderer.

### 3.3 Search, debounce, cancellation and pagination

Recommended behavior:
1. User types a non-empty query.
2. Wait approximately 250–300 ms after the last keystroke.
3. Start a first-page request using `limit=25` and no cursor.
4. Abort the previous request when the query changes or the component unmounts. Also guard against stale completions so a late response from an older query cannot replace newer results.
5. A query change resets the previous result list and cursor.
6. Selecting an item stores its `canonicalId` in the parent; search text and selected value remain distinct.
7. When `nextCursor` is non-null, show a bounded "Load more" action. Request the next page with the **same trimmed query**, limit and cursor; append results and defensively avoid duplicate `canonicalId` entries.
8. **Load More is single-flight (required):** disable or lock the action while a pagination request is pending so a second click cannot issue another request for the same cursor. The old request's settle must not re-enable the lock; re-enable only when it settles (success, error or abort) **and** the generation still matches. A fresh query with a non-null `nextCursor` makes Load More available anew (subject to the 100-result cap); on unmount it stays disabled. The pending state must be reflected in the view (disabled button / busy indicator) and asserted in tests. This is independent of, and in addition to, the generation guard — the lock prevents duplicate requests, the generation guard prevents stale responses from being applied.
9. A new query invalidates the old cursor and any in-flight load-more request.
10. Empty query returns to idle with no request and no stale result list.

**Controller topology (required):** use **one `AbortController` per query generation**. On new text, increment a generation counter, abort the previous controller, then run the debounce via `createRetrySleep` (`apps/web/src/lib/retry-sleep.ts:6–24`) with the **new generation's** controller's signal — **never** the aborted controller's (an already-aborted signal makes `createRetrySleep` resolve immediately at `retry-sleep.ts:8–10`, skipping the debounce). Because `createRetrySleep` **resolves** (not rejects) on abort (`retry-sleep.ts:13–17`), guard **both** the post-sleep and post-fetch paths with a generation check — if the generation changed, return without touching state. `AbortError` from `fetch` is caught and ignored for superseded generations. This prevents an aborted debounce from being treated as a completed query.

**Unmount (required):** on unmount, increment the generation counter (or set a `disposed` flag checked in **both** guards) **and** abort the current controller. Incrementing is essential: abort alone lets `createRetrySleep` resolve via its abort listener while the generation is unchanged, so the post-sleep guard would pass and issue a fetch after unmount. With the generation incremented, no fetch is issued after unmount.

**Bounded pagination (required):** the picker fixes `limit` to 25 and stops issuing "Load more" requests once **100 results** are held (4 pages). This cap is a local constant independent of the client's defensive 1–100 clamp, and guarantees no full-catalogue download.

Use the current API pagination rather than loading the full catalog. The first page can be 25 items; the "Load more" action makes remaining matches reachable up to the cap.

### 3.4 Result presentation

Use fields already returned by `canonicalInstrumentSchema`:
- Primary: `displayName`.
- Secondary: `canonicalSymbol` and `exchange/segment` for disambiguation.
- Optional small category text: `instrumentCategory` or `marketType`.
- Selected value: `canonicalId`.

Do not add exchange/category/segment filters. Do not search alias or ISIN fields unless the backend search contract is extended in a separately reviewed task.

### 3.5 Panel integration — preserve each existing flow

**SubscriptionPanel.tsx**
- Replace `draftId` text entry with the picker.
- The Add action still adds `{ canonicalId, enabled: true }` through the current `commit()` / `replaceSubscriptions()` flow.
- Preserve duplicate detection, busy-state behavior, subscription error handling, state loading, toggle/remove actions and the existing request contract.
- Do not make selecting a result automatically commit a subscription.
- Keep existing selections and runtime resolutions intact.

**HistoricalPanel.tsx**
- Replace only the canonical ID text input with the picker.
- Keep interval (already sourced from `candleIntervalSchema`), from/to date inputs, Read cached, Add sync config, retention settings, cleanup and all request shapes unchanged.
- Keep `focus` handling: `historicalFocusToForm()` still validates the interval/date range and pre-fills `canonicalId`; the picker must display the externally supplied value even if no search result is loaded.
- Do not replace or modify the existing activity-focus navigation behavior.

**SnapshotPanel.tsx**
- Replace only the underlying canonical-ID text input with the picker.
- Keep the expiry text input manual. Expiry discovery is Phase 4 and is currently blocked by missing authoritative populated derivative data and an unbounded derivative query.
- Keep the current explicit provider selector/default and the exact capture-config/capture request shapes. Do not change provider preference/fallback semantics (architecture area I is separately unresolved).
- Keep focused snapshot, saved configs, stored snapshots, capture error handling and provider-unavailable messaging unchanged.

---

## 4. Expected file scope

### New files
- `apps/web/src/lib/catalog.ts`
- `apps/web/src/components/InstrumentPicker.tsx`
- `tests/web/catalog.test.ts` (typed client tests)
- `tests/web/instrument-picker.test.ts`
- `tests/market/catalog-routes.test.ts` (recommended: the current API route has no dedicated route-level test)

### Expected modified files
- `apps/web/src/components/SubscriptionPanel.tsx`
- `apps/web/src/components/HistoricalPanel.tsx`
- `apps/web/src/components/SnapshotPanel.tsx`
- `tests/web/subscriptions.test.ts`
- `tests/web/historical.test.ts`
- `tests/web/snapshots.test.ts`

### Existing files to reuse, not redesign
- `apps/api/src/catalog-routes.ts`
- `packages/database/src/repositories/catalog.ts`
- `packages/market-core/src/types.ts`
- `packages/contracts/src/market.ts`
- `apps/web/src/lib/activity.ts` as a client/error-handling style reference
- Existing tests `tests/mcp/catalog-search.test.ts` (repository search) and `tests/market/catalog.test.ts` (catalog foundation/identity/sync)

Expected production changes are WebUI-only. The catalog-route test is test-only. Do not edit API route, repository, database schema, migrations or contracts unless preflight reveals a concrete defect in the existing search contract; any such finding must be reported separately before broadening scope.

---

## 5. Explicit non-goals / protected areas

Do not:
- Add a second catalog endpoint or metadata service.
- Add new server filters for exchange, segment, category, market type, lifecycle, underlying, product scope, alias or ISIN.
- Fetch the full catalog or cache it all in the browser.
- Add a new database schema, migration, catalog ingestion/sync runner or sample data.
- Invent derivative expiries, options strikes or contract availability.
- Replace the Snapshot expiry field or alter provider selection/default/fallback behavior.
- Change Subscription/Historical/Snapshot API payloads, request ordering or persistence behavior.
- Add a universal select/form framework or dependency.
- Start the MCP Operation selector, provider extensibility, Phase 4, Phase 5 or Phase 6 work.
- Change M6-C, M6-D, M6-E, B4, Stage G or physical LAN scope.
- Commit or push without separate authorization.

Preserve unrelated working-tree changes and untracked files, especially `docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md`.

---

## 6. Option and Metadata Impact Assessment (PROJECT_MANAGER_PROTOCOL §4.1)

1. **New options/entities/config:** no new domain entities or persisted configuration. The UI exposes existing canonical instruments as selectable search results.
2. **Source-of-truth owner:** the canonical catalog stored through `CatalogRepository` / `SqliteCatalogRepository`; `canonicalInstrumentSchema` owns the instrument shape.
3. **Category:** large/changing domain data, not a static enum or user-managed setting.
4. **Consumer delivery:** all three WebUI panels call the shared `InstrumentPicker`; the picker calls `apps/web/src/lib/catalog.ts`, which reads the existing `GET /api/catalog/search` endpoint.
5. **Existing source:** yes. `catalog-routes.ts` and `searchInstruments()` already exist. `canonicalInstrumentSchema` provides the result shape.
6. **New API necessary:** no. Reuse the existing bounded endpoint. Do not add a new read route.
7. **Forward updates:** new catalog records matching the existing search fields become available without WebUI list edits, once those records are actually present in the catalog. Do not imply that a provider feed or catalog ingestion is activated by this UI change.
8. **Cache/refresh:** query-based local component state; debounce user input; reset results/cursor when the query changes; abort stale requests; allow explicit "Load more" up to the 100-result cap. No full-catalog cache or polling.
9. **Sensitive data:** render only approved display fields and canonical ID. Do not display `identityKey`, arbitrary `sourceMeta` or provider credentials/tokens. Preflight should confirm the existing endpoint's full `CanonicalInstrument` response remains acceptable under the existing metadata security rules; do not widen the response.
10. **Consistency tests:** validate API response envelope and each instrument with the shared schema; verify query encoding, limit/cursor, pagination, cancellation/stale-response behavior, all picker states and each panel's unchanged request body.
11. **Shared contract impact:** no new enum. Reuse `canonicalInstrumentSchema`; avoid creating a duplicate instrument type.
12. **Provider/runtime registration:** none. No provider identity, status, capability or registration change.
13. **MCP impact:** none. No new tool/resource/prompt or Activity operation.
14. **REST/WebUI impact:** existing read-only catalog REST route consumed by three WebUI panels; Subscription/Historical/Snapshot mutation/read APIs remain unchanged.
15. **Domain-data discovery:** use the existing bounded, cursor-paginated catalog API. Search fields remain symbol, display name and identity key only.
16. **Configuration persistence:** no new configuration. Existing panels retain ownership of their existing save/commit actions.
17. **Forward compatibility:** newly synced instruments matching existing search fields are discoverable without a separate frontend options list. Aliases/ISIN and contextual filters are not covered by current API semantics.
18. **Dependency direction:** WebUI → `@markethub/contracts` and existing API; API → `CatalogRepository`; no new dependency, package boundary or circular import.

---

## 7. Acceptance criteria

The increment is complete only when:

1. One reusable `InstrumentPicker` is used by Subscription, Historical and Snapshot panels.
2. It selects a result by `canonicalId`, not by display name or symbol.
3. Search uses the existing `GET /api/catalog/search` route and does not add a new endpoint.
4. Requests are debounced, bounded, cancellable and protected against stale responses (per-generation controller + dual guards).
5. Cursor pagination is supported up to the 100-result cap without unbounded result loading; changing the query resets pagination. **Load More is single-flight** — the action is disabled/locked while a pagination request is pending, so no two requests share a cursor.
6. Loading, empty-query, empty-catalog/no-match, error/retry and load-more states are clear and usable. Keyboard navigation (Arrow keys, Enter, Escape) and selected-value handling (`canonicalId`) work as specified in §3.2.
7. All three panels preserve their existing request shapes and action behavior.
8. Historical activity focus continues to prefill the selected canonical ID, even if the ID is not in the currently rendered search results.
9. Snapshot expiry remains manual, provider selector/default remains unchanged, and no expiry is invented.
10. No manual canonical-ID entry field remains in the three target input controls (the picker's search box is permitted); existing stored canonical IDs and existing configuration displays remain intact.
11. No new dependency, database migration, catalog-ingestion path or server filter is introduced.
12. Existing catalog repository tests and all relevant WebUI/API regression suites pass.
13. No M6 or unrelated scope changes are present.

---

## 8. Required tests and verification

### Catalog client tests

Add tests for:
- Search query encoding, trimming and the default bounded limit.
- Correct `cursor` forwarding for later pages.
- `AbortSignal` propagation to `fetch`. For abort, replicate the structural-fake pattern from `tests/web/retry-sleep.test.ts:5–26` inside the new `tests/web/catalog.test.ts` (those helpers are module-local and not exported; no source file is modified) and use an enhanced `fakeFetch` that throws a `DOMException` named `"AbortError"` when `init.signal` aborts (the existing `fakeFetch` in `tests/web/activity.test.ts:10–15` ignores the signal and cannot test this); assert `AbortError` propagates unchanged and is not surfaced as an ordinary user error.
- Valid response parsing with `canonicalInstrumentSchema`.
- Rejection of malformed envelopes, malformed instrument rows and invalid `nextCursor` values.
- Structured 400 and server-error responses becoming typed errors.

### Picker tests

Use the existing Bun + `renderToStaticMarkup` conventions; do not add a UI testing dependency just for this increment. Separate pure presentation/state helpers from the async hook/controller (with injectable `sleep` and `search`) so behavior is deterministic without DOM.

Test:
- Empty/idle state does not issue a request.
- Loading state.
- Matching results with readable labels and exact canonical ID values.
- Selection calls `onChange` with `canonicalId` only; no auto-selection of the first result.
- No-results and empty-catalog messages.
- Error and retry state.
- Load-more availability only when `nextCursor` exists; stops at the 100-result cap; appends without duplicate canonical IDs. **Single-flight:** while a pagination request is pending, a second Load More click issues no request and the action is disabled/busy; it re-enables only when the request settles with a matching generation.
- Keyboard behavior: ArrowDown/ArrowUp move the active option, Enter selects the active option (no auto-select on typing), Escape clears search text without clearing `value`, and focus returns to the search input after selection.
- A new query clears the previous result page/cursor and aborts the in-flight request; stale completions are ignored by generation check.
- A parent-supplied selected ID (including a historical activity-focus ID) remains visible when absent from current search results; clearing search text does not clear the selection. Label coherence: select result A (caching its label), then externally change `value` to B; assert B (or its ID fallback) is shown and A's label is not.

Also perform a real browser smoke test for typing/debounce, aborting a slow request, selecting with keyboard/mouse and loading another page. Do not claim browser behavior was automated unless a browser test actually runs.

### API route test

Add a focused route-level test for the existing `GET /api/catalog/search` path:
- Successful response envelope and `canonicalInstrumentSchema`-valid results.
- Empty query rejection.
- Invalid limits below 1, above 100 and non-integer values.
- Cursor behavior and `nextCursor` handling.
- No accidental unbounded list path.

Do not modify the route unless a real bug is uncovered and separately scoped.

### Panel integration / regression tests

- Subscription: picker selection populates the existing draft canonical ID; Add still sends exactly `{ canonicalId, enabled: true }`; duplicate/busy/error/toggle/remove behavior unchanged.
- Historical: picker selection populates the existing `canonicalId`; cached-read and sync-config request shapes unchanged; `focus` prefill remains intact; interval selection remains all 16 values with default `1D`.
- Snapshot: picker selection populates `underlyingCanonicalId`; capture and config payloads unchanged; expiry remains manual; provider remains explicit FYERS default with current semantics; focused/stored snapshot views unchanged.

### Commands

Run focused tests first, using only paths that exist or are explicitly created by this plan:

```bash
bun test tests/web/catalog.test.ts
bun test tests/web/instrument-picker.test.ts
bun test tests/market/catalog-routes.test.ts
bun test tests/web/subscriptions.test.ts tests/web/historical.test.ts tests/web/snapshots.test.ts
bun test tests/market/catalog.test.ts tests/mcp/catalog-search.test.ts
```

Then:

```bash
bun run typecheck
bun run build
bun test
git diff --check
```

Report exact commands, test totals and any tests not run. Verify the repository's actual test naming and package scripts first; do not claim a grouped command that was not executed.

---

## 9. Implementation sequence — file-by-file with dependencies

Each step lists the files it touches, what it depends on, and its exit condition. Complete and validate a step before starting the next. All steps are one bounded assignment; no commit/push until after independent review and separate authorization.

| Step | Files | Depends on | Change | Exit condition (acceptance) |
|---|---|---|---|---|
| 1. Preflight | none (read-only) | — | `git status`/branch/HEAD/full diff; preserve local + untracked changes; re-read governing plans; confirm Phase 1 baseline. | Baseline recorded; no existing work overwritten; any catalog-contract defect reported separately, not fixed here. |
| 2. API/client check | none (read-only) | 1 | Verify `catalog-routes.ts`/`searchInstruments` behavior, response safety and empty-catalog handling. | Confirmed no new endpoint/filter/repository method is justified; any defect reported separately. |
| 3. Typed client | new `apps/web/src/lib/catalog.ts`; new `tests/web/catalog.test.ts` | 2 | `searchInstruments`, local Zod envelope, 3-kind typed errors, `AbortError` propagation, `buildCatalogQuery`/`formatInstrumentLabel` pure helpers. | Client tests pass: query encoding, limit clamp, cursor, envelope/instrument validation, typed errors, abort propagation. |
| 4. Picker core | new `apps/web/src/components/InstrumentPicker.tsx`; new `tests/web/instrument-picker.test.ts` | 3 | Controlled picker, pure view/controller split, debounce, per-generation `AbortController` + dual guards, unmount increment, single-flight Load More, 100-result cap, keyboard behavior, all UI states. | Picker tests pass: states, selection by `canonicalId`, debounce/cancellation/stale guards, single-flight, cap, keyboard, externally-set `value`. |
| 5. Subscription integration | `apps/web/src/components/SubscriptionPanel.tsx`; `tests/web/subscriptions.test.ts` | 4 | Replace `draftId` input with picker; keep `commit()`/`replaceSubscriptions()` and duplicate/busy/error/toggle/remove behavior. | Add still sends `{ canonicalId, enabled: true }`; no auto-commit; existing subscription tests green. |
| 6. Historical integration | `apps/web/src/components/HistoricalPanel.tsx`; `tests/web/historical.test.ts` | 4 | Replace canonical-ID input only; keep interval/date controls, read-cached/sync-config shapes and activity-focus prefill. | Focus prefill displays the ID even when absent from results; all 16 intervals + `1D` default intact; request shapes unchanged. |
| 7. Snapshot integration | `apps/web/src/components/SnapshotPanel.tsx`; `tests/web/snapshots.test.ts` | 4 | Replace underlying input only; keep manual expiry and explicit provider. | Capture/config payloads unchanged; expiry manual; provider default FYERS unchanged; focused/stored snapshot views intact. |
| 8. API route test | new `tests/market/catalog-routes.test.ts` | 2 | Route-level test for the existing `GET /api/catalog/search` (envelope, validation, cursor, no unbounded path). | Route test passes; route source unchanged. |
| 9. Full validation | none (commands) | 3–8 | Run §8 focused tests, then typecheck, build, full suite, `git diff --check`; perform the manual browser smoke test. | All commands pass with reported totals; browser behavior recorded honestly (not claimed automated). |
| 10. Independent diff audit + report | none (read-only) | 9 | Verify no hidden API/request/persistence changes, no unbounded fetch, no stale-response race, no fabricated data, no unrelated scope; produce §11 report. | Audit findings resolved or recorded; report complete; no commit/push. |

**Critical path:** 1 → 2 → 3 → 4 → {5, 6, 7} → 9 → 10. Step 8 (API route test) depends only on step 2 and may start in parallel with steps 3–4. Steps 5–7 depend on step 4 and are independent of each other; step 9 requires steps 3–8.

---

## 10. Risks and decisions

| Risk | Required mitigation |
|---|---|
| Catalog is empty or not populated | Honest empty state; no fake defaults. Confirm data availability separately; do not create a population mechanism in this task. |
| Old results arrive after a new query | Per-generation `AbortController`; abort previous fetch and guard stale completions on both post-sleep and post-fetch paths. |
| Cursor reused for a different query | Reset cursor and results on every new trimmed query. |
| Large match sets | Default page 25, API max 100, explicit Load more only, hard 100-result cap. |
| Duplicate Load More requests for the same cursor | Single-flight lock: disable/busy the action while a pagination request is pending; re-enable only on settle with matching generation. Generation guard remains for stale responses. |
| User cannot identify similar instruments | Show display name, symbol, exchange and segment; keep canonical ID as the selected value. |
| Context-specific validity differs across panels | Do not invent filters; backend validation remains authoritative. |
| Historical activity focus provides an ID not in search results | Preserve/display the externally supplied value as a fallback. |
| Snapshot expiry/provider semantics are mistaken for catalog metadata | Keep expiry manual and provider behavior exactly as it is. |
| Test environment lacks DOM tooling | Use pure view helpers/static markup and deterministic client tests; add no dependency; document manual browser checks. |

---

## 11. Required implementation report and authorization boundary

Report:
1. Starting/ending HEAD, branch and working-tree state.
2. Exact files changed and why.
3. Catalog client URL, schema parsing, error and cancellation behavior.
4. Picker state model, debounce, stale-response guard and pagination behavior.
5. Three panel integrations and proof of unchanged request/config payloads.
6. Catalog empty-state behavior and confirmation that no data was fabricated.
7. Test commands/results, typecheck/build results and browser smoke-test evidence.
8. Full diff summary, `git diff --check`, and confirmation unrelated changes/untracked files were preserved.
9. Incomplete or unverified acceptance criteria.

This plan is **not** authorization to implement, commit or push. Implementation and testing require separate authorization. Commit/push requires a further explicit authorization after independent review.
