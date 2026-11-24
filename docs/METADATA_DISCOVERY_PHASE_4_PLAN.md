# Phase 4 — Provider-backed derivative expiry discovery

> **Status:** Complete and published. All three work packages (WP4A/WP4B/WP4C) were implemented, independently audited to KEEP with no findings, and published on `develop`. See the close-out record at the end of this document. This document grants no further authorization.
>
> **Repository baseline reviewed:** `develop` at Phase 6 documentation close-out commit `cbb4e445901396177a7f02becea16f8a545d0b65` (2026-11-24 review). The close-out commit changes documentation only; the source-level Phase 4 findings described below remain applicable.
>
> **Scope owner:** Product owner. **Technical direction/review:** Technical lead. **Implementation:** OpenCode, only after separate authorization for each work package.

## 0. Purpose and recommended direction

Phase 4 supplies real, provider-specific option expiries to the existing Snapshot Panel. It closes the current gap between the canonical instrument catalogue and the expiry choice needed by option-chain capture.

The implementation should reuse the catalogue, contracts, synchronization service, SQLite database, API app, and WebUI patterns already present in MarketHubTS. It must be a small vertical feature, not a new market-data platform inside the platform.

### Recommended decisions (not product-owner-approved until explicitly accepted)

1. **Initial catalogue sources:** official Upstox BOD instrument JSON and official FYERS Symbol Master JSON files.
2. **No direct NSE/BSE feeds.** The broker masters provide the initial instrument universe supported by each provider. Add exchange sources only later if a specific coverage or independent-validation gap is demonstrated.
3. **Refresh model:** automatically download the public master files over HTTPS, without broker login or user tokens. Check freshness at API startup and run any needed refresh in the background; do not block API startup. Refresh no more than once per provider per India-market date while the API remains running.
4. **Last-known-good behavior:** keep serving the last successful catalogue while a refresh runs or after it fails. Never clear existing data because a network request or parse failed.
5. Canonical instrument and contract identity stays provider-neutral. Provider-native identifiers and availability stay provider-specific in the existing `provider_instrument_mappings` table.
6. The expiry API must be provider-aware. A catalogue expiry is suggested only when the selected provider has an active mapping for a matching option contract.
7. Expiries are discovered from locally persisted imported master data. Do not call the live option-chain endpoint just to populate a dropdown.
8. **Manual expiry remains available as an explicit fallback.** The catalogue list is the primary suggestion source, but the user may enter a date when the catalogue is empty, stale, or missing a contract. Manual dates must be clearly marked as unverified against the selected provider's current master. They must not be presented as catalogue-confirmed availability or trigger provider fallback.
9. WP4C updates the existing Snapshot Panel only. It does not activate live option-chain retrieval.
10. Existing `UPSTOX` and `FYERS` provider identities remain fixed. No dynamic provider/plugin registry is introduced.
11. Keep the first implementation to NSE/BSE stock and index option contracts and the cash/index underlying records needed to resolve them. Futures, currency derivatives, commodities, and other products are not required for this option-chain expiry selector.
12. Keep the existing SQLite catalogue and sync-run history. Do not introduce another database, a generic ingestion framework, a message queue, a distributed scheduler, or a metadata microservice.

## 1. User-visible result

For a supported underlying and an explicitly selected provider:

- The Snapshot Panel requests the available expiry dates from MarketHub's own API.
- The API returns unique, future expiry dates backed by active mappings for that exact provider and underlying.
- The user can choose a returned expiry suggestion or explicitly enter a manual date. Manual dates are marked unverified against the selected provider's current master; no hardcoded list, silent default, or provider fallback is used.
- Changing the underlying or provider clears the previous expiry and loads the correct list again.
- The UI shows loading, error/retry, empty, and stale-catalogue states honestly.
- The user is not told that live option-chain capture works merely because the expiry list is available. Production snapshot providers remain unconfigured until the separate Stage G gate is authorized and passed.

## 2. Verified repository baseline

The following findings were checked against `cbb4e44` and its source tree:

| Area | Current state | Phase 4 implication |
|---|---|---|
| Canonical contracts | `CanonicalInstrument`, derivative categories, `DerivativeSpec`, provider IDs, mapping status, provenance, and sync-batch schemas already exist in `packages/contracts`. | Extend existing contracts only where a new expiry-list response is needed. Do not create duplicate provider or derivative enums. |
| Canonical identity | `computeIdentityKey` and `CatalogSyncService` already normalize instruments, resolve cash underlyings before derivatives, remap underlying IDs, and check derivative/underlying compatibility. | Reuse this path. Do not write directly to SQLite from provider parsers. |
| Persistence | `derivative_contracts`, `provider_instrument_mappings`, `catalog_sync_runs`, and relevant indexes already exist. | No new table is expected for the initial implementation. |
| Sync behavior | `CatalogSyncService.applyBatch` validates a batch and writes its upserts transactionally. `COMPLETE` currently does **not** mean that mappings missing from a provider snapshot are automatically deactivated. | Add narrowly scoped provider-snapshot reconciliation; do not assume the existing completeness field already performs it. |
| Provider mappings | Mappings already hold provider, native identifier, canonical ID, status, source metadata, provenance, and validity fields. Status values include `ACTIVE`, `INACTIVE`, `REMOVED`, and `UNKNOWN`. | Store provider-specific availability and native IDs here. Do not put one provider's inactive state on the shared canonical contract. |
| Derivative read | `CatalogRepository.findDerivativeContracts` currently accepts optional filters and executes an unbounded `.all()` query. It does not join provider mappings. | Add a required-filter, bounded expiry read model. Do not call this unbounded method from the new route. |
| Existing REST | `GET /api/catalog/search` is bounded and read-only. No derivative-expiry endpoint exists. | Add one small read-only catalogue endpoint with shared request/response validation. |
| Option-chain capture | The existing `OptionChainRequest` carries canonical underlying ID, expiry, optional provider, and `nativeIdentifier`. Existing provider adapters use that native identifier as the provider's **underlying** request symbol/key. | Import underlying mappings as well as option-contract mappings. Resolve it server-side only when a future capture path is authorized. Do not render, accept from UI controls, or log provider-native identifiers in the WebUI; the existing unused `nativeIdentifier` field in the client type must not become UI-visible. |
| Production composition | `apps/api/src/app.ts` constructs the historical and snapshot services with empty provider arrays. The production provider drivers remain deliberately locked. | Phase 4 is catalogue discovery only. Do not add provider instances, credentials, live calls, or activation. |
| WebUI provider choice | WP6B already requires an explicit provider; the options derive from the shared `providerIdSchema`. | Reuse the selected provider. Do not add “Automatic”, a FYERS default, or a second provider list. |

### Key source files reviewed

- `packages/contracts/src/market.ts`
- `packages/market-core/src/identity.ts`
- `packages/market-core/src/types.ts`
- `packages/market-core/src/sync/apply.ts`
- `packages/market-core/src/sync/normalize.ts`
- `packages/database/src/schema.ts`
- `packages/database/src/repositories/catalog.ts`
- `packages/database/src/repositories/catalog-mappers.ts`
- `apps/api/src/catalog-routes.ts`
- `apps/api/src/app.ts`
- `packages/market-core/src/snapshots/service.ts`
- `packages/broker-upstox/src/option-chain.ts`
- `packages/broker-fyers/src/option-chain.ts`

## 3. Source data and provider-specific identifier rules

### 3.1 Upstox

Use the official BOD JSON file, not the deprecated CSV format. The published file contains equity, index, futures, and options records. Relevant option fields include `segment`, `exchange`, `expiry`, `instrument_type` (`CE`/`PE`), `instrument_key`, `underlying_key`, `underlying_type`, `strike_price`, `lot_size`, `tick_size`, and `freeze_quantity`.

- Use `instrument_key` as the provider-native identifier. Upstox specifically recommends it as the stable instrument identifier; do not use `exchange_token` as canonical identity.
- For the underlying mapping used by the option-chain API, use the underlying instrument's `instrument_key` (`underlying_key` on derivative rows points to it).
- Parse the expiry value using a tested India-market-date conversion. Do not assume that taking the UTC date from the timestamp produces the exchange expiry date.
- The BOD file is a daily snapshot of instruments available at the beginning of the day. A successful complete import may reconcile absent mappings only inside the Upstox scopes covered by that complete file.

Official documentation: [Upstox Instruments](https://upstox.com/developer/api-documentation/instruments/), [Upstox Put/Call Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/).

### 3.2 FYERS

Use the official JSON symbol-master files for the relevant segments. The documented file set includes `NSE_FO`, `BSE_FO`, `NSE_CM`, and `BSE_CM`. The FO files supply option rows; the cash-market files supply underlying rows where present.

Relevant documented fields include `fyToken`, `symTicker`, `exchangeName`, `optType`, `underSym`, `underFyTok`, `minLotSize`, `tickSize`, `lastUpdate`, `expiryDate`, `strikePrice`, `qtyFreeze`, and `tradeStatus`.

- `symTicker` is the symbol string to verify against the Option Chain API's required `symbol` parameter (the API documents examples such as `NSE:SBIN-EQ`). The existing FYERS adapter passes `OptionChainRequest.nativeIdentifier` as `symbol`.
- `fyToken` is the unique token for a symbol; `underFyTok` references the underlying's token. Use these to join derivative rows to the correct underlying record. **Do not pass `fyToken` as the option-chain `symbol` unless official documentation and a real fixture prove that is accepted.**
- `tradeStatus = 1` means active; `tradeStatus = 0` means inactive. Map this to the provider mapping's status, not to a global canonical lifecycle state.
- `expiryDate` is documented as a timestamp, but the Symbol Master page does not define its unit/time-zone conversion in the field description. The importer must verify the current official sample values and their agreement with the documented option-chain expiry representation before converting them to `YYYY-MM-DD`. Do not guess seconds versus milliseconds or UTC versus IST.
- `lastUpdate` is a date string and should be retained as source-version/freshness evidence where relevant.

Before implementation is considered ready, OpenCode must inspect representative current official JSON rows for one stock option, one index option, and their underlying rows. If `underFyTok` cannot be resolved to an imported underlying row for a relevant segment, report that exact gap and do not guess from `underSym` alone.

Official documentation: [FYERS Symbol Master JSON](https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-json/), [FYERS Option Chain API](https://fyers.in/api-docs/v3/api/market-data/option-chain/).

## 4. Target architecture

```text
Upstox BOD JSON ─┐
                 ├─ provider-specific parsers/normalizers
FYERS master JSON┘
                         │
                         ▼
              existing CatalogSyncService
                         │
             existing SQLite catalogue tables
       canonical instruments + derivative contracts
          + provider mappings + catalog sync runs
                         │
                         ▼
           bounded provider-aware expiry query
                         │
                         ▼
        GET /api/catalog/derivative-expiries
                         │
                         ▼
        existing Snapshot Panel expiry selector
```

There is one canonical catalogue, not one catalogue per broker. The same exchange contract reported by both brokers must converge on the same canonical identity while retaining two distinct provider mappings.

### 4.1 Identity and mapping ownership

- Canonical identity is derived with the existing `computeIdentityKey` and normalization rules. Provider-native IDs must never enter the canonical identity key.
- Provider mappings are unique per provider/native identifier and point to a canonical instrument.
- Upstox option-contract mappings retain the option contract `instrument_key`; the underlying instrument mapping retains the underlying `instrument_key` required for option-chain retrieval.
- FYERS option-contract mappings retain the verified symbol ticker; the underlying mapping retains the verified API `symbol` string. `fyToken` is retained as source metadata/lookup evidence so `underFyTok` can resolve the underlying. Do not conflate `symTicker`, `fyToken`, and `exToken`.
- Import cash/index underlyings before or alongside derivative rows through the existing order-independent sync path. Resolve each provider's underlying reference to the canonical equity/index record. Never match an unresolved derivative to an underlying by display name alone.
- A record from one provider must not overwrite or deactivate the other provider's mapping.

### 4.2 Shared derivative fields versus provider-specific data

`derivative_contracts` has one row per canonical contract, including single shared `lotSize`, `tickSize`, `quantityFreeze`, `contractSource`, and `contractObservedAt` fields. The two providers can report the same contract, so a blind sequential import would make these shared fields last-provider-wins.

Use this narrow merge rule before/around `mergeInstrument`:

**Mechanism (wired into the existing apply path):** during instrument processing in `apply.ts`, after canonical identity resolution and before/around `mergeInstrument`, compute the shared-field diffs against the existing canonical derivative row. For each differing shared field, (a) append a `DERIVATIVE_SHARED_FIELD_CONFLICT` `WARNING` to the batch conflict list and (b) accumulate a patch keyed by `(provider, nativeIdentifier)` into that mapping's `sourceMeta`. Provider identity comes from `batch.provider` and the mapping rows being upserted; only mappings belonging to the importing provider/snapshot are annotated — never another provider's mapping. The accumulated `sourceMeta` patch is applied during the later mapping upsert/merge (the `provider_instrument_mappings` merge block around `apply.ts:337-360`, which preserves existing fields and merges `sourceMeta`), inside the same `repo.transaction(...)` as the instrument writes and conflict recording. No separate post-import annotation pass is used.

- Contract identity fields (`exchange`, canonical segment, derivative class, canonical underlying, expiry, normalized strike, and option type) must resolve to the same canonical identity across providers. A mismatch remains an identity/ambiguity `ERROR`; it is not downgraded to a shared-field warning.
- Compare populated, provider-neutral derivative attributes, including `lotSize`, `tickSize`, `quantityFreeze`, `contractSource`, and `contractObservedAt`, plus any other populated non-identity derivative field explicitly treated as shared by the existing contract. If the canonical value is absent, populate it. If both canonical and incoming values are populated and differ, preserve the existing canonical value; do not use last-provider-wins merging.
- For each differing field, emit a deterministic `WARNING` conflict with type `DERIVATIVE_SHARED_FIELD_CONFLICT`. Include the canonical ID, field name, existing canonical value, incoming provider value, provider ID, and source identifier. Do not put timestamps, random IDs, or ordering-dependent text in the conflict identity/message.
- Store the provider-reported derivative values in that provider/native mapping's existing `sourceMeta` (under one stable derivative-attributes key), alongside the source/version/observation metadata, via the per-`(provider, nativeIdentifier)` patch applied during the mapping upsert in the same transaction. Do not discard the value simply because it differs from the shared canonical value.
- Warning idempotency is based on the last value already recorded for that same provider/native mapping and field: if an unchanged value is re-imported, do not emit the same conflict again. If that provider's reported value changes while still differing from the canonical value, emit one new warning for the changed value. The mapping's `sourceMeta` must be updated in the same transaction as the import.
- `contractLifecycleStatus` is explicitly EXCLUDED from shared-field diffing: it is managed only by the defined canonical lifecycle rules and must never be set, cleared, or inferred from one provider's status value or from a provider's omission of a row. Provider-specific activity/lifecycle status and raw/supplemental provider fields remain in that provider mapping's `sourceMeta`; one provider's `INACTIVE`/`REMOVED` state must never overwrite the shared `contractLifecycleStatus` or another provider's mapping.
- A warning alone does not fail an otherwise valid complete snapshot: a committed `COMPLETE` snapshot with warning-only conflicts is recorded as sync-run `status = COMPLETED`. `ERROR` conflicts still roll back the transaction. Do not classify a successful warning-only complete snapshot as `PARTIAL` merely because its `conflicts` array is non-empty. **Both status computation sites must change:** `apply.ts:404` (persisted sync-run status) and `apply.ts:414` (returned `CatalogSyncResult.status`) currently both compute `conflicts.length ? "PARTIAL" : "COMPLETED"`; each must instead use an ERROR-severity-only rule — no ERROR conflicts → `COMPLETED` even when WARNING/INFO conflicts are present, any ERROR → rollback as today. Before implementation, inspect existing tests and consumers for `PARTIAL` assumptions tied to a non-empty `conflicts` array and record any that must be updated.

No new provenance table or generalized conflict-resolution framework is required.

### 4.3 Complete snapshot reconciliation and transaction boundary

The existing sync service upserts rows; it does not automatically deactivate mappings missing from a `COMPLETE` provider snapshot. Add one narrow sync-service/repository-transaction operation; do not create a separate reconciliation service or table.

**Public entry point (concrete):** add to `CatalogSyncService` the method

```ts
applyCompleteProviderSnapshot(
  batch: CatalogSyncBatch,
  reconciliation: ProviderReconciliationDescriptor
): Promise<CatalogSyncResult>
```

where `ProviderReconciliationDescriptor` is the reconciliation input defined below. This is the only public path that performs complete-snapshot reconciliation; the reconcile operation is never exposed as a standalone post-import cleanup action.

The operation accepts:

```ts
{
  provider: ProviderId,
  coverage: Array<{
    exchange: Exchange,
    segment: Segment,
    instrumentCategories: InstrumentCategory[]
  }>,
  activeNativeIdentifiers: ReadonlySet<string>,
  sourceVersion?: string,
  sourceObservedAt?: string,
  now: string
}
```

**Refactor for one transaction:** extract the body of `applyBatch` into an internal transaction-aware apply helper (for example `applyBatchInTx(tx, batch)`) that performs instrument/mapping upserts, conflict collection, and sync-run create/update against a supplied `CatalogRepositoryTx`. `applyBatch` keeps its current public signature and calls this helper inside its own `repo.transaction(...)`. `applyCompleteProviderSnapshot` opens one `repo.transaction(...)`, calls the same helper for the batch, then calls `CatalogRepositoryTx.reconcileProviderMappings(...)` and updates the same sync-run record inside that same transaction before commit. `applyBatch` is **not** called unchanged from inside another transaction; the shared helper is the single apply implementation so both paths use identical validation, conflict, and status logic.

`coverage` is an explicit list of exact scope tuples, not independent exchange/segment/category lists that could form an unintended Cartesian product. For this initial phase, only the source slices actually imported are covered: the relevant NSE/BSE FO option categories (`STOCK_OPTION`, `INDEX_OPTION`) and the specific NSE/BSE CM/equity/index records retained to resolve their underlyings (`EQUITY`, `INDEX`). A tuple must identify the exact exchange, provider segment value, and canonical instrument categories from that source file. Do not include currency, commodity, unrelated CM categories, or a broader universe merely because a source file contains them.

- The importer builds `activeNativeIdentifiers` from all active provider mappings in the fully validated provider snapshot across the declared `coverage`. Explicit inactive source rows are applied as `INACTIVE` before reconciliation and are not put in the active-ID set.
- The repository-transaction operation considers only existing `ACTIVE` mappings for the same provider whose explicit mapping exchange/segment and joined canonical instrument category match one of the exact coverage tuples. Mappings with missing/ambiguous scope metadata are left untouched; they are not safe to infer into a covered scope.
- An existing active mapping in that exact scope whose native identifier is absent from `activeNativeIdentifiers` becomes `REMOVED` for that provider only, with `validTo`/`updatedAt` set to `now`. Update reconciliation provenance with merge semantics that preserve unrelated metadata: set `provenanceJson.sourceVersion` from `sourceVersion`, `provenanceJson.sourceObservedAt` from `sourceObservedAt`, and `provenanceJson.syncedAt = now` (and/or record the same facts under `sourceMetaJson.reconciliation.*`). Do not overwrite other keys in `provenanceJson` or `sourceMetaJson`. Do not change already `INACTIVE`, `REMOVED`, or `UNKNOWN` mappings merely because they are absent.
- Invoke reconciliation only through the complete-provider-snapshot sync path, after all snapshot rows/mappings have been applied and validated, only when `batch.provider` matches, `batch.completeness === "COMPLETE"`, and no `ERROR` conflict exists. A warning-only shared-field conflict does not prevent reconciliation.
- **Deterministic `scopeJson` serializer:** define one canonical serializer/helper in a shared location (for example the contracts or market-core sync module) with a stable key order and an explicit shape/version, and use it on BOTH the write path (when `applyCompleteProviderSnapshot` stores `batch.scope` into `catalog_sync_runs.scope_json`) and the read path (WP4B's latest-sync lookup key). The serialized scope contains only the exact coverage tuples (exchange, provider segment, instrument categories) — it does not include source version, provider identity, fetch time, or other source/provider metadata, which live in their own columns/fields. Both paths must produce byte-for-byte equal strings for the same scope; the lookup requires exact equality and must not parse JSON inside SQL.
- **Atomicity:** the preferred and required implementation is one existing `CatalogRepository.transaction` opened by `applyCompleteProviderSnapshot`: call the shared internal tx-aware apply helper for the batch, perform the transaction-scoped `CatalogRepositoryTx.reconcileProviderMappings(...)` call, update the same sync-run record, then commit. `applyBatch` is not called unchanged inside another transaction; both public methods share the internal helper instead. If reconciliation fails, the transaction must roll back both the import and the mapping status changes. Do not commit the import and then run deactivation as an unrelated second transaction. If the current sync-service structure makes one transaction impossible, stop and report before implementation; do not silently weaken this boundary.
- If any required file is missing, malformed, unexpectedly empty, incomplete, or fails validation, do not call the complete-snapshot path and do not reconcile. Keep the last successful catalogue and report stale/unknown freshness.
- Treat the required FYERS segment files as one FYERS refresh snapshot for the initial implementation. If one required FYERS file fails, retain the previous FYERS snapshot. The independent Upstox refresh may still succeed.

## 5. Refresh and failure policy

Use the existing `catalog_sync_runs` history for last-attempt, last-success, counts, source version, and error status. Do not add a separate import-history table.

### 5.1 Why automatic download is the recommended choice

These are **public instrument-master file downloads**, not authenticated market-data requests. FYERS' official Symbol Master page lists direct `https://public.fyers.in/sym_details/...` JSON download URLs and does not specify an authorization header for those downloads. FYERS' own published symbol utility fetches those URLs with a normal HTTPS request and no broker access token. Upstox likewise publishes direct JSON file URLs under its assets host. The authenticated FYERS API rules apply to authenticated API calls such as user/account or market-data requests; they should not be applied to these static master-file downloads by assumption.

Sources: [FYERS Symbol Master JSON](https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-json/), [FYERS' published symbol-master utility](https://github.com/FyersDev/fyers-skills/blob/master/skills/fyers-trading/scripts/fyers_symbols.py), [Upstox Instruments](https://upstox.com/developer/api-documentation/instruments/).

### 5.2 Operational policy

- On API startup, inspect each provider's last successful import. If that provider has no successful snapshot for the current India-market date, start its refresh **asynchronously**. API startup and unrelated endpoints must not wait for the download or import to finish.
- If the API remains running, use one small app-owned daily trigger to request at most one refresh per provider per India-market date. Do not add a generic scheduler, job framework, worker service, or external cron dependency.
- Download only the documented public HTTPS master-file URLs. Do not send, request, or store broker login credentials, app secrets, OAuth tokens, or user access tokens for master downloads.
- Keep Upstox and FYERS refreshes independent. A failure of one provider must not prevent the other provider's valid refresh.
- Prevent overlapping refreshes of the same provider/scope with a simple in-process single-flight guard.
- Validate the complete provider snapshot before writing. Apply it transactionally through the existing catalog sync path and provider-scoped reconciliation rules in §4.3.
- Keep the last successfully imported catalogue readable while a refresh runs and after a later download, parse, validation, or transaction failure. Mark its freshness `STALE` or `UNKNOWN`; do not clear it or silently replace it with an empty list.
- Reject HTTP errors, invalid JSON, unexpectedly empty files, missing required segments, unresolved required underlyings, duplicate identity/mapping conflicts, or failed transactions without deactivating existing mappings.
- Store concise source metadata (provider, segment/scope, fetched time, source data date/version, optional content hash, and record counts). Do not store access tokens or full raw master files in SQLite. Temporary download bytes may be processed in memory or in a bounded temporary file and discarded after import.
- The expiry API may return the last successful expiry list with `STALE` freshness information after a refresh failure. It must not invent a replacement list.

This is a small refresh-once-per-day policy, not a general ingestion platform. Upstox documents a daily BOD refresh around 6 AM and that the file can change later only when needed; FYERS labels its symbol masters as the latest per-segment downloads and supplies a `lastUpdate` date in the records. Retain both source data date and MarketHub's last successful fetch time because they are different facts. If public file access is temporarily unavailable, the existing catalogue remains usable and the UI's manual expiry fallback remains available.

## 6. Work-package sequence

The work packages are deliberately sequential: **WP4A → WP4B → WP4C**. Each requires its own product-owner authorization, implementation report, independent diff review, and KEEP decision before the next work package begins.

---

# WP4A — Import Upstox and FYERS instrument masters

## 1. Objective

Populate the existing canonical catalogue with the supported stock/index option contracts and the provider-specific underlying/contract mappings needed for provider-aware expiry discovery. Both providers' records for the same contract must converge on one canonical identity.

## 2. Verified current state

There is a tested transactional `CatalogSyncService` and persistent catalogue schema, but no production importer that fetches and converts the official Upstox/FYERS master files. The sync service does not reconcile missing provider mappings from complete snapshots.

## 3. Exact scope

- Add one focused parser/normalizer per provider using the documented JSON format.
- Import all in-scope NSE/BSE stock/index option contracts (`CE`/`PE`) and only the cash-equity/index underlying records required to resolve those contracts within the declared provider, exchange, segment, and instrument-category scope.
- For underlying resolution, read the relevant provider CM/equity/index master files but retain only the referenced NSE/BSE `EQUITY`/`INDEX` underlyings required by the in-scope options. Reading a full in-scope CM file is acceptable only when needed to resolve those references and justified in the importer report; importing/storing its unrelated CM universe is not. Do not import unrelated CM segments, products, or universes.
- Map provider fields to existing `CanonicalInstrument`, `DerivativeSpec`, `ProviderInstrumentMapping`, provenance, and sync-batch contracts.
- Resolve provider underlying references to canonical underlyings before derivative rows are applied.
- Add provider-scoped complete-snapshot reconciliation after a successful full provider import.
- Add a small app-owned refresh trigger following §5, using existing sync-run persistence.
- Support a dry-run/validation mode in the importer or test harness so row counts, skipped out-of-scope records, unresolved underlyings, duplicate identities, and mapping conflicts can be reviewed without database writes.

## 4. Architectural direction

- Keep provider-specific parsing separate from canonical identity and persistence.
- Reuse `CatalogSyncService.applyBatch`; do not write SQL directly from parsers.
- Use the existing shared Zod schemas and provider IDs.
- For Upstox, parse the BOD JSON and keep `instrument_key` as the native identifier.
- For FYERS, parse the relevant JSON segment files. Verify `symTicker` as the option-chain `symbol`; use `fyToken`/`underFyTok` for underlying resolution.
- Parse and validate all required files for one provider before writing. Combine the supported rows into one complete provider snapshot; a valid unchanged snapshot must be idempotent when imported again.
- Before/around `mergeInstrument`, apply §4.2: compute shared-field diffs against the existing canonical derivative, fill an absent canonical shared value, preserve an already-populated canonical value on disagreement, record `DERIVATIVE_SHARED_FIELD_CONFLICT` as a deterministic `WARNING`, and accumulate a per-`(provider, nativeIdentifier)` `sourceMeta` patch applied during the later mapping upsert in the same transaction. `contractLifecycleStatus` is excluded from diffing. Suppress repeat warnings when the same provider/native mapping reports the same value again. Both status sites (`apply.ts:404` persisted and `:414` returned) use the ERROR-only rule, so warning-only conflicts do not demote a successfully committed complete snapshot from `COMPLETED` to `PARTIAL`.
- Add a narrow public `CatalogSyncService.applyCompleteProviderSnapshot(batch: CatalogSyncBatch, reconciliation: ProviderReconciliationDescriptor): Promise<CatalogSyncResult>` entry point (§4.3). Refactor `applyBatch` by extracting an internal tx-aware apply helper shared by both methods; the new method opens one `repo.transaction(...)`, calls the helper for the batch, calls `CatalogRepositoryTx.reconcileProviderMappings(...)`, and updates the same sync-run record before commit — only after all import writes have succeeded, completeness is `COMPLETE`, the provider/scope match, and no `ERROR` conflict remains. `applyBatch` is not called unchanged inside another transaction. The reconciliation input includes `provider`, exact `coverage` tuples, `activeNativeIdentifiers`, `sourceVersion`, `sourceObservedAt`, and one transaction timestamp `now`; provenance updates use merge semantics on `provenanceJson`/`sourceMetaJson`. The reconcile operation must never be exposed as an independent post-import cleanup action.
- Do not assume an undocumented timestamp unit or timezone. Prove the expiry conversion with actual official sample rows and tests.

## 5. Files/components allowed to change

OpenCode must inspect the current tree and propose the smallest exact list before editing. Expected areas are:

- `packages/market-core/src/sync/` — focused provider master parsers/normalizers and the complete-snapshot sync-service entry point that invokes reconciliation inside the existing transaction.
- `packages/market-core/src/sync/apply.ts` — only the minimal shared-field comparison/warning behavior, the per-`(provider, nativeIdentifier)` `sourceMeta` patch applied during the mapping upsert, and complete-provider-snapshot transaction orchestration: extract an internal tx-aware apply helper used by both `applyBatch` and `applyCompleteProviderSnapshot` (which is not called unchanged inside another transaction). Preserve the existing rollback behavior for `ERROR` conflicts and the ERROR-only status rule at both sites (`apply.ts:404` and `:414`).
- `packages/market-core/src/types.ts` — only the minimum `ProviderReconciliationDescriptor` input type, the `CatalogRepositoryTx.reconcileProviderMappings` input/result type and method signature, and reuse of existing `CatalogSyncBatch`/`CatalogSyncResult` types.
- `packages/database/src/repositories/catalog.ts` — implement that method on the existing transaction repository (`TxRepo`); scope selection and `REMOVED` updates must be part of the caller's transaction. Do not add an independent non-transactional repository reconciliation call.
- `apps/api/src/app.ts` or the existing runtime composition entry — wire the single refresh owner without changing unrelated routes.
- Existing tests mirroring the changed source modules, with fixed sanitized official-format fixtures.

No table/data migration is expected; an index migration is allowed only with explicit evidence from the query plan/fixture size and must be reported before adding it. If implementation concludes a schema change is unavoidable, stop and report the reason and exact alternative before changing it.

## 6. Protected areas

- `main` and all stable-branch content.
- Existing canonical identity algorithm and identity-version semantics unless a proven source-format defect requires a separately approved change.
- Existing `CatalogSyncService` transaction and conflict guarantees; do not weaken rollback behavior.
- Snapshot provider ordering/fallback, option-chain adapters, provider credentials/auth, live provider composition, streaming drivers, and Stage G boundary.
- MCP tools/resources/prompts, SSE, subscription/streaming services, retention logic, unrelated catalog search, and unrelated WebUI components.
- Package dependencies, lockfiles, runtime configuration, and database files/data outside approved migrations (none expected).
- Untracked or unrelated user work; inspect and preserve the working tree.

## 7. Non-goals

- Direct NSE/BSE source downloads or exchange API integrations.
- All-exchange/global catalogue completeness claims.
- Futures, currency, commodity, mutual-fund, or global index ingestion in this initial option-chain slice.
- Live option-chain or quote requests; broker login/token use for master-file downloads (the documented master-file URLs are public file downloads and require no broker token).
- A generic provider plugin system, ingestion framework, distributed queue, job scheduler, metadata database, or new database.
- Historical contract reconstruction beyond retaining existing canonical records and provider mapping history.

## 8. Acceptance criteria

- Both official source formats parse into valid shared canonical/sync contracts.
- A stock option and an index option from each provider are represented correctly, with their underlying mappings resolved.
- The same exchange contract from Upstox and FYERS resolves to the same canonical ID and has two different provider mappings.
- Provider-native IDs are preserved exactly and are correct for each provider's later option-chain API. In particular, FYERS `symTicker` is not confused with `fyToken`.
- Expiry dates are normalized correctly to `YYYY-MM-DD` using a tested India-market-date conversion.
- Re-importing an unchanged complete snapshot is idempotent; updating a mapping does not change canonical identity.
- A disagreement in a populated shared derivative attribute preserves the existing canonical value, records a deterministic `WARNING` conflict of type `DERIVATIVE_SHARED_FIELD_CONFLICT` with both values, provider, and source, and stores the provider-reported value in that provider mapping's `sourceMeta` via a per-`(provider, nativeIdentifier)` patch applied during the mapping upsert in the same transaction; only the importing provider's mappings are annotated. `contractLifecycleStatus` is never diffed or changed by a provider import. It does not fail the import; a complete warning-only run remains `status = COMPLETED`.
- Re-importing the same provider/native mapping with the same differing attribute value does not create another warning. A changed provider-reported value may create one new warning for that changed value.
- Both status computation sites use the ERROR-severity-only rule: the persisted sync-run status (`apply.ts:404`) and the returned `CatalogSyncResult.status` (`apply.ts:414`) are each `COMPLETED` for a warning-only complete snapshot, and any `ERROR` conflict still rolls back. Existing tests/consumers with `PARTIAL` assumptions tied to a non-empty `conflicts` array are inspected and updated.
- Explicit FYERS inactive status affects only FYERS mapping status. Complete-snapshot omission affects only currently `ACTIVE` mappings within exact provider/exchange/segment/instrument-category coverage tuples.
- Reconciliation runs only through `applyCompleteProviderSnapshot` for a validated `COMPLETE` provider snapshot, after all rows have applied without `ERROR` conflicts, inside the same single `repo.transaction(...)` as the catalogue upserts and sync-run update, using the shared internal tx-aware apply helper (not `applyBatch` called unchanged inside another transaction). Reconciliation provenance is merged into `provenanceJson.sourceVersion`, `provenanceJson.sourceObservedAt`, and `provenanceJson.syncedAt = now` (and/or `sourceMetaJson.reconciliation.*`) without overwriting unrelated metadata. Any reconciliation failure rolls back both the import and all mapping status changes.
- A failed/partial import never deactivates previously valid mappings and never deletes canonical contracts.
- A bad underlying reference, ambiguous mapping, duplicate canonical identity, invalid date, malformed payload, or transaction failure is reported and does not leave partial writes.
- Refresh failure retains the last good catalogue and updates sync-run/freshness state.
- No production provider is activated and no live market-data request is made.

## 9. Required tests

- Fixture tests using representative official-format Upstox and FYERS rows: stock option, index option, equity/index underlying, inactive FYERS row, and at least one row from each supported NSE/BSE scope.
- Timestamp tests: seconds vs milliseconds, UTC/IST boundary, date rollover, invalid/zero/negative/out-of-range timestamps, invalid calendar date.
- Classification tests: exchange, segment, option class, CE/PE, strike normalization, underlying type, lot/tick/freeze fields.
- Identifier tests: Upstox underlying `instrument_key`; FYERS `symTicker` request identifier; FYERS `fyToken`/`underFyTok` relationship; ensure no token is accidentally used as the `symbol` parameter.
- Cross-provider convergence test: same contract → same canonical identity/ID, separate mappings.
- Shared-field conflict tests: differing populated `lotSize`, `tickSize`, `quantityFreeze`, `contractSource`, and `contractObservedAt` preserve the existing canonical value; produce one deterministic `WARNING` `DERIVATIVE_SHARED_FIELD_CONFLICT` containing both values, provider, and source; and retain the incoming provider values in that provider mapping's `sourceMeta` via the per-`(provider, nativeIdentifier)` patch applied during the mapping upsert, with only the importing provider's mappings annotated. Include a test proving an unchanged re-import of the same provider/native mapping and field value creates no new warning, plus a changed-value case. Include a test that `contractLifecycleStatus` is never diffed or changed by a provider import.
- Warning-status test: a complete snapshot with warning-only shared-field conflicts commits and records BOTH the persisted sync-run status (`apply.ts:404`) AND the returned `CatalogSyncResult.status` (`apply.ts:414`) as `COMPLETED`; an `ERROR` conflict still rolls back. Include a regression check that no test or consumer assumes `PARTIAL` merely because `conflicts` is non-empty.
- Idempotency test: importing the same complete provider snapshot twice produces no duplicate canonical instruments/contracts/mappings or duplicate shared-field warnings.
- Reconciliation tests: only a successful complete provider snapshot calls reconciliation; only absent `ACTIVE` mappings inside the exact provider/exchange/segment/instrument-category coverage tuples become `REMOVED`; explicit inactive rows remain `INACTIVE`; other providers, other exchanges, other segments/categories, and mappings with ambiguous scope remain unchanged.
- Reconciliation transaction/rollback test: force the transaction-scoped reconciliation operation to fail after catalogue upserts and prove the whole transaction rolls back, including newly inserted/updated instruments, contracts, provider mappings, and mapping statuses. Prove `applyCompleteProviderSnapshot` uses the shared internal tx-aware apply helper (not `applyBatch` called unchanged inside another transaction) and that the sync-run update and reconciliation provenance merge (`provenanceJson.sourceVersion`, `provenanceJson.sourceObservedAt`, `provenanceJson.syncedAt = now` / `sourceMetaJson.reconciliation.*`, preserving unrelated keys) occur in that same transaction. Prove no reconciliation is invoked for malformed, failed, `PARTIAL`, or `INCREMENTAL` snapshots.
- Scope-isolation test: an NSE FO snapshot cannot remove BSE FO or NSE/BSE CM underlying mappings outside its declared tuple set; a provider snapshot cannot affect the other provider; a FYERS required-file failure cannot reconcile any FYERS scope; Upstox refresh remains independent; canonical rows are retained.
- Rollback tests: malformed/ambiguous input causes no partial database writes.
- Refresh tests: no overlapping same-provider refresh, last-known-good data retained after failure, daily freshness decision is deterministic with injected clock.

## 10. Verification instructions

- Start with `git status --short --branch` and `git rev-parse HEAD`; confirm the expected `develop` branch and report untracked/modified files before edits.
- Inspect actual current master rows and verify the FYERS index-underlying relationship and expiry timestamp representation before finalizing the parser.
- Run the focused importer/sync/database tests, then the full test suite, typecheck, build, and `git diff --check`.
- Inspect the resulting SQLite catalogue in a test database: canonical duplicates, provider mappings, status isolation, last sync-run records, and rollback behavior.
- Report local test results separately from CI. Do not claim live provider verification.

## 11. Expected implementation report

Provide the complete 12-section Project Manager Protocol report: objective; verified current state; exact scope; architectural direction; changed files; protected areas; non-goals; acceptance results; tests and actual commands/results; verification evidence; complete/incomplete/unverified items and before/after Git status; completed Option and Metadata Impact Assessment.

Include sample normalized rows with credentials/tokens redacted, importer counts per provider/scope, sync-run IDs/statuses, exact identifier mapping decisions, timestamp conversion evidence, reconciliation evidence, and any source discrepancies. Request authorization before commit/push; implementation authorization does not include publication permission.

## 12. WP4A Option and Metadata Impact Assessment

1. **New selectable options, capabilities, entities, or configuration:** WP4A imports provider-supported stock/index option contracts, the cash/index underlyings required to resolve them, and provider-specific mappings. Their expiries become catalogue domain data consumed in WP4B/WP4C. No new provider identity, fixed option enum, capability, or user configuration is introduced.
2. **Source of truth:** Upstox BOD and FYERS Symbol Master files are the external source records. Provider parsers own source-field conversion only; `@markethub/contracts` owns validated canonical shapes; `@markethub/market-core` owns canonical identity and sync rules; existing SQLite `canonical_instruments`, `derivative_contracts`, `provider_instrument_mappings`, and `catalog_sync_runs` own persisted catalogue state.
3. **Value classification:** contracts, expiries, provider availability, lot/tick/freeze attributes, and provider-native identifiers are dynamic domain/source data. They are not shared enums, runtime capability registrations, or user-managed configuration. Shared canonical derivative fields remain provider-neutral; per-provider values/status remain in the provider mapping.
4. **Consumers:** WP4B's backend expiry query consumes the canonical contracts and provider mappings. WP4C's existing Snapshot Panel consumes the bounded WP4B response. A future, separately authorized capture path may resolve the provider's underlying native identifier server-side. **N/A — no UI/MCP/SSE change in WP4A.**
5. **Existing capability reuse:** reuse `computeIdentityKey`, canonical/derivative/provider mapping schemas, `CatalogSyncService`, its transaction boundary, `CatalogRepositoryTx`, `catalog_sync_runs`, and the existing SQLite catalogue. There is no current provider-master importer or complete-snapshot mapping reconciliation operation; WP4A adds only those narrow missing paths.
6. **Discovery/read API necessity:** no new read API is needed for the importer. WP4B adds the single bounded provider-aware expiry endpoint because WebUI must not read SQLite or broker files directly. WP4A itself adds no new REST endpoint.
7. **UI update behavior:** provider/underlying expiry choices will be fetched from WP4B by WP4C; no expiry or instrument list is copied into WebUI constants. **N/A — no WebUI control changes in WP4A.**
8. **Refresh/cache invalidation:** public provider master files refresh in the background under §5.1/§5.2, at most once per provider per India-market date. Persist imported data and last-attempt/last-success metadata through the existing catalogue and sync-run history. Preserve last-known-good records after failures. No second cache, scheduler framework, or user refresh setting is added.
9. **Sensitive metadata:** source files contain public instrument-master data, not broker account credentials. Keep provider-native identifiers server-side in `provider_instrument_mappings`/`sourceMeta`; do not store credentials/tokens or raw files in SQLite. Do not render, accept from UI controls, or log provider-native identifiers in the WebUI. The existing unused `nativeIdentifier` field in the client type must not become UI-visible.
10. **Source-to-consumer tests:** fixture tests prove official-format provider rows normalize to canonical records, provider mappings retain distinct native IDs, cross-provider contracts converge, shared-field warnings are deterministic/idempotent, reconciliation is transactionally scoped, and WP4B can later return only the selected provider's data. No UI/MCP/SSE tests are needed in WP4A.
11. **Shared contract impact:** reuse existing `CanonicalInstrument`, `DerivativeSpec`, `ProviderInstrumentMapping`, sync batch, conflict, and provider schemas. Extend only the narrow shared response contract required by WP4B if/when that work package is authorized; WP4A adds no duplicate enum and no new provider ID. Any minimum importer/scope type must live in its existing owning package and preserve dependency direction.
12. **Provider/runtime registration impact:** preserve the fixed `UPSTOX`/`FYERS` provider identity. WP4A imports static master files only; it does not register, authenticate, connect, activate, or dynamically discover providers. Adding another provider later remains a deliberate contract/parser/adapter task.
13. **MCP tool/resource/prompt impact:** **N/A — no MCP operation, tool, resource, or prompt is added or changed in WP4A.**
14. **REST/SSE/WebUI consumer impact:** **N/A — no REST, SSE, or WebUI change in WP4A.** The importer is backend-only. The REST expiry response belongs to WP4B; its Snapshot Panel consumer belongs to WP4C.
15. **Domain-data discovery impact:** WP4A populates the existing canonical catalogue only for the explicitly declared NSE/BSE stock/index options and the underlying cash/index records needed to resolve them. WP4B serves the changing expiry domain through a provider-aware, database-bounded query. No market-data values are copied into frontend constants.
16. **Configuration persistence impact:** no new user-managed setting or capture configuration is introduced. Automatic refresh uses public HTTPS files without broker credentials; successful/failed import state and source metadata use existing sync-run/catalogue persistence. No saved Snapshot Panel configuration is silently changed.
17. **Forward compatibility:** new rows from the two supported providers flow through the existing provider parsers and provider IDs without a WebUI list edit. A third provider is not auto-enabled; it requires an explicit shared provider identity, source parser, mapping rules, and adapter/contract work.
18. **Dependency direction:** provider source parsing and sync orchestration remain in existing market-core sync modules; database-specific reconciliation is implemented by the existing database repository transaction adapter; API composition wires the service; contracts remain dependency-light. No market-core-to-database import, circular dependency, new package, or duplicate service layer is introduced.

---

# WP4B — Bounded provider-aware expiry API

## 1. Objective

Expose a small read-only API that returns the valid expiry dates for one required canonical underlying and one required provider, based on active provider mappings in the imported catalogue.

## 2. Verified current state

`findDerivativeContracts` currently allows optional filters and returns all matching rows with `.all()`. There is no provider-aware derivative read model or expiry endpoint. Existing `/api/catalog/search` demonstrates the project's bounded read-only API pattern.

## 3. Exact scope

- Add a repository query dedicated to expiry discovery. Require `underlyingCanonicalId`, `provider`, and a market-local `today` value.
- Join canonical option contracts to `provider_instrument_mappings` by canonical ID and selected provider.
- Filter to `STOCK_OPTION`/`INDEX_OPTION`, `mapping.status = ACTIVE`, the requested underlying, and future/current valid expiry dates.
- Return distinct expiry dates ordered ascending, with a hard maximum result count (100 is the proposed ceiling; normal results should be far smaller).
- Add one endpoint: `GET /api/catalog/derivative-expiries?underlyingCanonicalId=...&provider=...`.
- Validate query parameters and response with shared Zod contracts.
- Return catalogue freshness metadata sourced from existing sync-run history: last successful import time and `FRESH`/`STALE`/`UNKNOWN` state. Do not expose raw provider errors, credentials, or native IDs.

## 4. Architectural direction

Proposed repository seam:

```ts
listDerivativeExpiries({
  underlyingCanonicalId: string,
  provider: ProviderId,
  today: string,
  limit: number
}): Promise<string[]>;
```

The exact public type can follow repository conventions, but provider and underlying must remain required. Add this narrow lookup over the existing `catalog_sync_runs` table:

```ts
getLatestProviderSync(
  provider: ProviderId,
  source: string,
  scopeJson: string,
  statuses: SyncRunStatus[],
  completeness?: SyncCompleteness | SyncCompleteness[]
): Promise<CatalogSyncRunRecord | null>;
```

`source` and `scopeJson` identify the one stable, complete initial master snapshot for that provider (use stable source IDs such as `UPSTOX_BOD_MASTER` and `FYERS_SYMBOL_MASTER`; FYERS' required segment files form one combined snapshot). `scopeJson` is produced by the single canonical serializer/helper defined in §4.3 (shared location, stable key order, explicit shape/version) and contains only the exact coverage tuples — not source version, provider identity, fetch time, or other source/provider metadata. The same helper is used on the WP4A write path and this WP4B read path so the strings are byte-for-byte equal for the same scope; the lookup requires exact equality and must not parse JSON in SQL. The repository query filters by provider, source, exact `scopeJson`, the supplied `statuses`, and (when provided) `completeness`, then orders by `finishedAt DESC`, `startedAt DESC`, and `runId DESC`, with `LIMIT 1`. For freshness, call it with `statuses: ["COMPLETED"]` and `completeness: "COMPLETE"`. A sync run is successful for freshness only when `status = COMPLETED`, `completeness = COMPLETE`, and `finishedAt` is present; `status = PARTIAL`/`FAILED`/`RUNNING`/`CANCELLED` and `completeness = PARTIAL`/`INCREMENTAL` do not count. `lastSuccessfulSyncAt` is exactly that selected run's `finishedAt`. A later failed, running, partial, or cancelled attempt must not replace the last successful run or its `lastSuccessfulSyncAt`.

Freshness classification is deterministic:

- `UNKNOWN` when no successful complete provider snapshot exists for that exact provider/source/scope.
- `FRESH` when the latest successful complete snapshot's **source data date**, converted/interpreted as an `Asia/Kolkata` market date, equals today's `YYYY-MM-DD` market date.
- `STALE` otherwise, including a prior source data date, missing/unparseable source data date, or a required file whose freshness date is older than today's market date. Do not substitute `finishedAt` or download time for the source data date.
- For FYERS, `lastUpdate` (`YYYY-MM-DD`) is a per-record field. For each required segment file, use the newest valid `lastUpdate` date among its in-scope rows as that file's source data date (equivalent to checking whether the file contains a record updated today); the combined FYERS snapshot's source data date is the oldest of those per-file dates. A missing/invalid date for a required file makes the snapshot date unverified and therefore `STALE`. Do not take the oldest date across every record, because unchanged instruments can legitimately have older per-record `lastUpdate` values.
- For Upstox, verify the actual official file response metadata (for example a valid `Last-Modified` date) at implementation time. The official BOD file schema does not document a per-row `lastUpdate` field; if no reliable source date is available from the official response, leave `sourceObservedAt` unknown and report `STALE` rather than inventing a date from the local fetch time. The source date is distinct from MarketHub's fetch and successful-import time.

The SQLite expiry query must perform the provider mapping join, required filters, distinct, ordering, and limit in the database; do not load every derivative contract into memory and filter in JavaScript.

Proposed response shape (final names should follow local contract conventions):

```ts
{
  underlyingCanonicalId: string,
  provider: "UPSTOX" | "FYERS",
  expiries: string[], // unique YYYY-MM-DD, ascending
  freshness: {
    state: "FRESH" | "STALE" | "UNKNOWN",
    lastSuccessfulSyncAt: string | null
  }
}
```

- Use `todayIst` (`YYYY-MM-DD` in `Asia/Kolkata`) for the expiry comparison and include `expiryDate >= todayIst` (today's expiry is included; yesterday's is excluded). Inject the clock in tests. Do not use the browser's local timezone.
- If no active mapping exists for the selected provider, return an empty expiry array. Do not borrow another provider's expiry list.
- Do not return provider-native identifiers in the expiry API. In the WebUI, do not render, accept from UI controls, or log provider-native identifiers; the existing unused `nativeIdentifier` field in the client type must not become UI-visible. The backend resolves native identifiers from provider mappings only when a future authorized capture path needs them.
- Reuse the existing catalogue route conventions and app composition. A focused `derivative-routes.ts` is acceptable if it keeps derivative logic out of an overloaded route file; no new server or service layer is needed.
- Do not use the current unbounded `findDerivativeContracts` path in the route.

## 5. Files/components allowed to change

Expected areas, subject to OpenCode's pre-edit inspection:

- `packages/contracts/src/market.ts` or the existing catalogue-contract module — expiry response/freshness schema and inferred type.
- `packages/market-core/src/types.ts` — required bounded expiry query type and `getLatestProviderSync(provider, source, scopeJson, statuses, completeness?): Promise<CatalogSyncRunRecord | null>` repository contract.
- `packages/database/src/repositories/catalog.ts` — bounded distinct expiry query and latest provider sync-run lookup from the existing `catalog_sync_runs` table, filtered by provider/source/exact `scopeJson`/statuses/`completeness` and ordered `finishedAt DESC`, `startedAt DESC`, `runId DESC` with `LIMIT 1`. Require `status = COMPLETED` and `completeness = COMPLETE` for freshness.
- `apps/api/src/derivative-routes.ts` (new focused route) or the existing catalog route module, plus `apps/api/src/app.ts` registration.
- Focused contracts, repository, and route tests.

No table/data migration is expected; an index migration is allowed only with explicit evidence from the query plan/fixture size and must be reported before adding it. Do not pre-emptively create multiple indexes.

## 6. Protected areas

All WP4A protected areas remain protected. In addition, do not change catalog search behavior, instrument-picker response shape, existing option-chain capture semantics, provider fallback behavior, or shared API error conventions outside the new endpoint.

## 7. Non-goals

- Live broker calls to discover expiries.
- A generic search/filter endpoint for all derivative contracts.
- Strike lists, option-chain payloads, quote/Greeks data, futures expiry UI, or historical contract APIs.
- Returning provider-native IDs or raw master rows in the API response, or rendering/accepting/logging provider-native identifiers in the WebUI. The existing unused client `nativeIdentifier` field must remain unused and not UI-visible.
- Pagination for a result naturally capped to a small expiry list; use a hard limit and explicit overflow handling instead.
- New cache, registry, database, or service framework.

## 8. Acceptance criteria

- The endpoint requires a valid provider and non-empty canonical underlying ID; invalid or missing values receive the project's standard 400 response.
- Results contain only unique, ascending `YYYY-MM-DD` expiry dates for active option mappings belonging to that provider and underlying.
- Expired dates, inactive/removed/unknown mappings, futures, other underlyings, and other providers are excluded.
- An expiry available from Upstox but not FYERS appears only for Upstox, and vice versa.
- Empty catalogue/provider coverage returns an empty list with honest freshness information; no dates are fabricated.
- Query is performed in SQLite with required filters and a hard limit. It does not invoke an unbounded `.all()` across the derivative table.
- Last successful import time and freshness reflect the latest successful complete provider snapshot in `catalog_sync_runs`: `UNKNOWN` when no such snapshot exists; `FRESH` only when its source data date equals today's `Asia/Kolkata` market date; `STALE` otherwise. `COMPLETED` with `COMPLETE` completeness is successful; `PARTIAL` status and `PARTIAL`/`INCREMENTAL` completeness do not count. A later `FAILED`/`RUNNING`/`PARTIAL`/`CANCELLED` attempt does not replace `lastSuccessfulSyncAt`.
- The latest-provider-sync repository lookup filters provider, stable source, exact `scopeJson` (from the shared canonical serializer), the supplied statuses, and the supplied `completeness`; orders by `finishedAt DESC`, `startedAt DESC`, `runId DESC`; and returns one row via `LIMIT 1`. Only `COMPLETED` snapshots with `completeness = COMPLETE` qualify for freshness.
- Response is validated with the shared contract; no provider-native identifier, token, credential, or raw provider error is exposed.

## 9. Required tests

- Repository tests for required filters, provider join, distinct expiry, ascending order, inclusive expiry boundary (`todayIst` included; yesterday excluded), and hard limit.
- Provider isolation tests where the same underlying/expiry set differs between Upstox and FYERS.
- Mapping status tests for `ACTIVE`, `INACTIVE`, `REMOVED`, and `UNKNOWN`.
- Classification tests exclude stock/index futures from the option-chain expiry list.
- Date tests around IST midnight and expiry-day boundaries with a fixed clock.
- API tests for missing/invalid provider, missing underlying, unknown underlying, no matches, shared response schema, and sanitized errors.
- Freshness tests for every state: no successful snapshot gives `UNKNOWN`; a `COMPLETED`/`COMPLETE` snapshot whose source date is today in `Asia/Kolkata` gives `FRESH`; an older, missing, invalid, or inconsistent source date gives `STALE`.
- Latest-provider-sync lookup tests prove provider/source/exact-`scopeJson` isolation (using the shared serializer on both write and read paths), status filtering to `COMPLETED` and `completeness = "COMPLETE"` for successful snapshots, deterministic ordering by `finishedAt DESC`, then `startedAt DESC`, then `runId DESC`, with `LIMIT 1`, and that a later `FAILED`, `RUNNING`, `PARTIAL`, or `CANCELLED` attempt does not replace `lastSuccessfulSyncAt`. Also prove completeness `PARTIAL`/`INCREMENTAL` is not accepted as a successful provider snapshot.
- Regression test that proves a provider's missing expiry is not filled from the other provider.
- Query-shape/performance assertion or SQL inspection proving the DB applies filters and limit rather than returning all contracts.

## 10. Verification instructions

Run focused contracts, repository, and API tests; typecheck and build the affected workspaces; run the full test suite and `git diff --check`. Inspect the final SQL/query construction and verify that provider, status, underlying, derivative class, expiry, ordering, and limit are applied in the database.

Test with a populated temporary SQLite database containing duplicate expiries, multiple providers, expired contracts, inactive mappings, and unrelated underlyings. Report local results separately from CI.

## 11. Expected implementation report

Use all 12 Project Manager Protocol sections. Include the exact endpoint/request/response schema, repository method signature, SQL/query shape, freshness rule, changed files, focused/full test commands and outputs, and evidence that the result is bounded and provider-isolated. List any remaining unknowns. Request separate authorization before commit/push.

## 12. WP4B Option and Metadata Impact Assessment

1. **New values:** expiry dates are changing domain data; provider remains the existing fixed contract enum.
2. **Owner:** canonical contracts and repository/API own the expiry response; database catalogue owns records and provider mappings.
3. **Classification:** expiry list is domain data, not a shared enum or user configuration.
4. **Consumers:** Snapshot Panel via REST; no MCP or SSE consumer is added.
5. **Existing source:** current derivative contracts and provider mappings already contain the required relationships.
6. **API need:** yes; a bounded REST endpoint is required because the WebUI must not access SQLite or ingest broker files.
7. **UI update:** query the endpoint whenever provider/underlying changes; do not add frontend expiry constants.
8. **Refresh:** rely on WP4A import state; no separate endpoint cache. Freshness uses the latest successful `COMPLETED`/`COMPLETE` sync run for the exact provider/source/scope and its source data date compared with today's `Asia/Kolkata` date; later failed/running/partial attempts do not replace the last successful sync time. UI query invalidation/refetch is tied to provider/underlying changes and retry.
9. **Sensitive fields:** return no provider native identifiers, access tokens, credentials, or raw source metadata.
10. **Consistency tests:** contract, repository, and API tests prove source-to-query behavior and provider isolation.
11. **Shared contract:** add only the response/freshness schema; reuse `providerIdSchema` and existing instrument/derivative schemas.
12. **Provider registration:** no new provider or capability identity.
13. **MCP:** no MCP operation/tool/resource/prompt change.
14. **REST/SSE/WebUI:** add one read-only REST endpoint; no SSE changes; UI consumes the response.
15. **Domain discovery:** required filters and DB-enforced hard limit; no unbounded domain list.
16. **Persistence:** no user configuration; source data remains in the existing catalogue.
17. **Forward compatibility:** a new provider must be added deliberately to the shared provider identity and adapter contracts; the endpoint naturally filters mappings by a valid provider.
18. **Dependency direction:** contracts remain dependency-light; market-core defines the repository seam; database implements it; API registers it; WebUI uses HTTP. No circular dependency.

---

# WP4C — Snapshot Panel expiry discovery with manual fallback

## 1. Objective

Prefer real expiry dates returned by WP4B for the selected underlying and explicit provider, while preserving the existing ability to enter an expiry date manually when catalogue data is missing or unavailable. Clearly distinguish catalogue-confirmed suggestions from a manual, unverified date.

## 2. Verified current state

WP6B already establishes explicit provider selection and uses the existing shared provider contract. The instrument picker already exists from Phase 3. The Snapshot Panel does not yet have a provider-aware expiry discovery path. Production snapshot providers remain an empty list.

## 3. Exact scope

- Add catalogue-backed expiry suggestions to the existing Snapshot Panel using the selected canonical underlying and explicit provider.
- Preserve a clearly labelled manual date-entry path. Use catalogue suggestions by default when present, but do not remove manual entry when the list is empty, stale, or the request fails.
- Keep the existing unused `nativeIdentifier?: string` field in `apps/web/src/lib/snapshots.ts` unused in WP4C; do not bind it into request construction or UI state. Do not render, accept from UI controls, or log provider-native identifiers in the WebUI; that client field must not become UI-visible.
- Clear the current expiry value and its source marker when either provider or underlying changes, then fetch the new catalogue list.
- Never silently select the first expiry, reuse an expiry from the previous underlying/provider, or substitute another provider's list.
- Show loading, empty, error with retry, and stale-catalogue status using the API freshness metadata. Keep the manual entry path available in each of those states.
- Mark the selected value's origin: `Catalogue` when it exactly matches a current response option, or `Manual — not verified against the current provider master` when typed by the user or absent from the current list.
- Validate manual values as real calendar dates in `YYYY-MM-DD` format. Do not claim that syntactic validity proves the selected provider offers the contract.
- Keep the existing save-configuration path usable with a valid manual date. Live capture remains separately unavailable until the existing Stage G gate is authorized and passed; this WP must not enable it.
- Preserve the selected provider behavior from WP6B. Do not add an Automatic provider option or a provider default.

## 4. Architectural direction

- Reuse the existing Snapshot Panel, instrument picker, provider control, REST client/query conventions, and shared types. The existing optional `nativeIdentifier` property in the client type remains unused; do not pass it from the WebUI.
- Catalogue expiry suggestions come only from WP4B; never hardcode expiry values.
- Keep the existing manual date-entry capability. A minimal dropdown/suggestion list plus the existing editable date field is sufficient; do not introduce a generic autocomplete or form framework.
- Keep the UI controlled. Track whether the current value came from the catalogue or manual entry. If a manually entered date later appears in the latest provider-specific response, it may be relabelled as catalogue-confirmed; if it is absent, keep the manual warning.
- On provider/underlying change, clear the current expiry and its source marker before starting the new request so an old date cannot be accidentally carried across instruments or providers.
- Ignore late responses for an older provider/underlying selection (use the repository's existing query/cancellation pattern).
- Keep UI state local to the Snapshot Panel/query cache. Do not add global state or a generic dropdown framework.
- A stale catalogue list may be displayed with a warning because it represents the last successful import; the UI must not label it fresh. Manual entry remains possible, but must not be represented as verified provider availability.
- When live capture is eventually enabled under its separate gate, the backend must validate the selected provider and underlying mapping and pass that provider's native underlying identifier. A manual date must never cause automatic provider fallback or bypass provider-specific request validation.
- Do not connect or invoke live provider adapters in WP4C. A selectable or manually entered expiry proves neither live data access nor capture availability.

## 5. Files/components allowed to change

Expected areas, subject to OpenCode's pre-edit inspection:

- The existing Snapshot Panel component and its focused tests.
- Existing API client/query module for the new endpoint.
- Shared frontend types only through imports from `@markethub/contracts`.
- Small presentation-only loading/empty/error text or component logic if needed; no new general UI framework.

The implementer must identify the actual existing component/file from the current tree before editing; do not create a second Snapshot Panel or duplicate provider/instrument picker.

## 6. Protected areas

All prior work-package protected areas remain protected. Do not alter provider auth, option-chain adapter behavior, snapshot persistence/configuration, retention, capture scheduling, MCP/SSE, live-data composition, or Stage G. Do not redesign unrelated Snapshot Panel layout or global UI styling.

## 7. Non-goals

- Live option-chain calls or provider activation.
- Changing the capture service semantics or saved capture-configuration schema; retaining the existing manual date input is not a schema change.
- Claiming a manually typed date is confirmed by either provider.
- Futures selector, strike picker, option-chain display, charts, alerts, or watchlists.
- New global state manager, generic dynamic-form system, or duplicate metadata registry.
- Automatic provider selection or a fallback to the other provider.
- Rendering, accepting from UI controls, or logging provider-native identifiers in the WebUI. The existing unused client `nativeIdentifier` field must remain unused and must not become UI-visible.

## 8. Acceptance criteria

- Catalogue suggestions appear only in the existing Snapshot Panel and are queried for the selected underlying/provider.
- Suggested expiry options come only from WP4B; none are hardcoded.
- The existing manual entry path remains available when the catalogue is empty, stale, errors, or does not contain the user's required date.
- Catalogue-confirmed and manual-unverified values are visibly distinguishable.
- Manual entry accepts only a real `YYYY-MM-DD` calendar date; it does not claim provider availability.
- Changing the underlying or provider clears the prior date/source marker and fetches the correct new list.
- Late responses from the previous selection cannot repopulate the current list.
- Loading, empty, error/retry, and stale states are visible without fabricated values, and none hides the manual fallback.
- A valid manual date remains saveable in the existing capture-configuration flow. This does not turn on provider capture; the existing production provider list remains empty and Stage G remains locked.
- Provider selection remains explicit and has no FYERS default or Automatic choice.
- No live provider connection, option-chain request, catalogue write from the WebUI, or Stage G activation is introduced.

## 9. Required tests

- Component tests for loading, successful expiry suggestions, empty list, error/retry, and stale-list messaging.
- Manual-entry tests for empty, stale, and error states; invalid calendar dates; a valid date absent from the catalogue; and origin labelling.
- Save-config regression test proves a valid manual date remains accepted by the existing capture-configuration path without changing its schema.
- Provider/underlying change tests verify the prior date and origin marker are cleared immediately and the new API query uses the new pair.
- Deferred-response race test proves an old request cannot overwrite a newer selection or its origin marker.
- When a manual date matches a newly loaded provider-specific list, test that it is marked catalogue-confirmed; when absent, it remains explicitly unverified.
- No-hardcoded-options test or contract-backed assertion confirms suggestions come from the API response.
- Regression tests for WP6B explicit provider selection and existing Snapshot Panel behavior.

## 10. Verification instructions

Run focused Snapshot Panel and API-client tests, WebUI typecheck/build, full suite, and `git diff --check`. Manually inspect the empty/stale/error UI states at the supported desktop layout. Confirm the final diff contains no provider activation or capture-service changes.

## 11. Expected implementation report

Use all 12 Project Manager Protocol sections. Include component/API data flow, exact changed files, loading/error/empty/stale behavior, race-condition test evidence, accessibility/keyboard behavior of the selector, and confirmation that provider activation remains locked. Report before/after Git status and ask separately before commit/push.

## 12. WP4C Option and Metadata Impact Assessment

1. **New selectable value:** current provider-supported expiries are domain data returned by WP4B; no new fixed option set.
2. **Owner:** backend derivative-expiry API and canonical catalogue; WebUI owns only presentation labels and local selection state.
3. **Classification:** dynamic domain data, not a shared enum or persisted user setting.
4. **Consumers:** existing Snapshot Panel only.
5. **Existing source:** selected provider from WP6B; canonical underlying from Phase 3 instrument picker; expiry list from WP4B.
6. **API need:** consume the dedicated bounded expiry endpoint; do not import server/database modules into WebUI.
7. **UI update:** refetch from API on provider/underlying changes; no duplicated frontend list.
8. **Refresh:** clear selection on key change; refetch/retry with existing query mechanism; stale state comes from API metadata.
9. **Sensitive fields:** no native identifier/token is rendered or retained in UI state.
10. **Consistency tests:** controlled component tests cover response changes, races, invalidation, and no hardcoded choices.
11. **Shared contract:** consume WP4B's inferred response type; do not recreate it in the WebUI.
12. **Provider registration:** no provider or capability change.
13. **MCP:** no change.
14. **REST/SSE/WebUI:** consume one REST response; no SSE changes.
15. **Domain discovery:** all expiry data comes through the bounded provider-aware API.
16. **Configuration persistence:** no change to saved capture configuration or user settings.
17. **Forward compatibility:** any provider added later must satisfy the shared provider contract and backend adapter/mapping requirements; no frontend list edit is required for expiry values.
18. **Dependency direction:** WebUI depends on shared contracts and API client only; no backend or database import.

---

## 7. Cross-work-package acceptance and release gate

Phase 4 is complete only when all three work packages have separately passed their own acceptance and independent review gates.

- WP4A: both master imports are repeatable, provider mapping isolation and complete-snapshot reconciliation are proven, and canonical duplicates do not appear.
- WP4B: the expiry API is shared-schema validated, provider-aware, database-bounded, and returns only valid future/current options.
- WP4C: the existing Snapshot Panel uses the API and has correct selection invalidation and all required UI states.
- Focused tests, full test suite, workspace typechecks, workspace builds, and `git diff --check` pass.
- Independent review returns **KEEP** for the final diff of each work package; findings are fixed and retested before the next work package is authorized.
- No unrelated refactoring, protected-area edits, Stage G activation, or unapproved database/user-data operations are present.
- Local test results and CI evidence are reported separately. No live provider verification is claimed.
- Commit/push/merge permission is obtained separately for each publication action.

## 8. Explicit exclusions for the whole Phase 4

- Direct NSE/BSE exchange feeds or exchange API ingestion.
- A new database, master-data service, metadata service, universal registry, dynamic provider plugin system, queue, or generalized scheduler.
- An operator-managed local-file import workflow in the first version; add one only if a real offline-installation requirement is later confirmed.
- Live provider authentication, live option-chain/quote retrieval, provider activation, trading, order placement, or Stage G verification. Public static symbol-master file downloads in WP4A do not constitute broker login or live market-data activation.
- Changing provider identity, WP6B explicit-provider behavior, snapshot fallback semantics, existing streaming/runtime boundaries, MCP, SSE, or unrelated product milestones.
- Claiming the catalogue is the complete exchange universe. It represents the instrument coverage available through the imported Upstox and FYERS masters for the supported product scope.
- Table/data migrations: none expected. An index migration is allowed only with explicit evidence from the query plan/fixture size and must be reported before adding it; no schema change is authorized by this plan.

## 9. Project Manager Protocol and authorization

This plan follows `docs/PROJECT_MANAGER_PROTOCOL.md`:

- Each WP is a separate bounded implementation assignment with the 12 required sections and its own 18-question Option and Metadata Impact Assessment.
- OpenCode must inspect local branch, HEAD, and working tree before each WP and preserve untracked/modified work.
- OpenCode may not silently expand scope, change protected code, or make product-level architecture decisions.
- A plan or implementation approval is not commit/push/merge approval.
- No code implementation begins until the product owner explicitly authorizes WP4A. WP4B and WP4C remain gated on the preceding work package's KEEP review.

## 10. Reference index

### Repository sources at `cbb4e44`

- [Project Manager Protocol](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/docs/PROJECT_MANAGER_PROTOCOL.md)
- [Metadata Discovery Implementation Plan](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md)
- [Metadata and Capability Discovery](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/docs/METADATA_AND_CAPABILITY_DISCOVERY.md)
- [Architecture Decisions](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/docs/ARCHITECTURE_DECISIONS.md)
- [Engineering Standards](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/docs/ENGINEERING_STANDARDS.md)
- [Testing and Acceptance](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/docs/TESTING_AND_ACCEPTANCE.md)
- [Market contracts](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/contracts/src/market.ts)
- [Market-core catalog types](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/market-core/src/types.ts)
- [Catalog sync application](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/market-core/src/sync/apply.ts)
- [Catalog normalization](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/market-core/src/sync/normalize.ts)
- [SQLite catalog schema](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/database/src/schema.ts)
- [SQLite catalog repository](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/database/src/repositories/catalog.ts)
- [Catalog API routes](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/apps/api/src/catalog-routes.ts)
- [API composition](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/apps/api/src/app.ts)
- [Option-chain request/service](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/market-core/src/snapshots/service.ts)
- [Upstox option-chain adapter](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/broker-upstox/src/option-chain.ts)
- [FYERS option-chain adapter](https://github.com/Rajendertyagi/MarketHubTS/blob/cbb4e44/packages/broker-fyers/src/option-chain.ts)

### Official documentation reviewed 2026-11-24

- [Upstox Instruments — official BOD JSON master and field descriptions](https://upstox.com/developer/api-documentation/instruments/)
- [Upstox Put/Call Option Chain — underlying instrument key and expiry date request](https://upstox.com/developer/api-documentation/get-pc-option-chain/)
- [FYERS Symbol Master JSON — segment files and field descriptions](https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-json/)
- [FYERS Option Chain — `symbol`, `timestamp`, and `expiryData` request/response](https://fyers.in/api-docs/v3/api/market-data/option-chain/)

---

## 13. Close-out record (2026-11-24)

Phase 4 is **complete and published on `develop`**. All three work packages were implemented by `opencode/hy4-flash-free` and independently audited by `opencode/iceman-free` to KEEP with no outstanding findings, including fix-forward cycles for audit and technical-lead findings.

| WP | Scope | Implementation / fix commits | Audit |
|---|---|---|---|
| WP4A | Upstox BOD + FYERS Symbol Master import, single-transaction complete-snapshot reconciliation, shared-field conflicts, daily refresh, source-date honesty, import-report validation, referenced-underlying filtering | `03adab1`, `bcec6ab`, `8785670`, `13826fb` | KEEP (multiple fix cycles) |
| WP4B | Bounded provider-aware expiry API `GET /api/catalog/derivative-expiries` with honest FRESH/STALE/UNKNOWN freshness | `e99c5f3` | KEEP |
| WP4C | Snapshot Panel expiry selector with manual fallback, origin labelling, race guard | `9862464`, `13061da` | KEEP |
| Plan | Canonical specification | `ed967e3`, close-out `85bb8a6` | KEEP |

**Technical-lead fix-forward (closed before acceptance):** complete import reports are validated before reconciliation (invalid/incomplete/empty required segments fail closed with last-known-good retained); existing populated shared derivative fields are preserved when a provider omits them; Upstox underlyings are restricted to those referenced by in-scope options; index-option cross-provider convergence is reported honestly as not achievable (the masters have no shared index identifier) with per-provider resolution tested instead of a fabricated identity.

**Delivered:** a local catalogue from public Upstox/FYERS masters (no credentials, no live calls), a bounded provider-aware expiry API with honest freshness, and a Snapshot Panel selector that keeps manual entry as a clearly-labelled unverified fallback. Provider identity stays fixed `UPSTOX`/`FYERS`; no Automatic option, no FYERS default. No live provider connection, no activation, no Stage G change, no full exchange catalogue claim.

**Verification (local/agent-reported, not CI):** focused suites pass; full suite 1073 pass / 1 fail — the single failure is a pre-existing Windows `EBUSY` temp-dir cleanup flake in an untouched supervisor test (passes in isolation); `bun run typecheck`, `bun run build` and `git diff --check` clean. GitHub showed no status checks for these commits.

**Not delivered / separate gates:** live provider verification (Stage G), provider activation, M5 Phase 4B, M6-D/E, M6-B4, Phase 7 cross-system acceptance, and full exchange catalogue coverage.

---

**End of Phase 4 plan.** This document is now an implementation record as well as the original specification. It grants no implementation or publication permission.
