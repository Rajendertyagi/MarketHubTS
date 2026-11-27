# MarketHubTS â€” M4 Stage G + M5 Phase 4B Data Integration Completion Plan

> **Status:** Technical implementation plan only. No application code changed, no provider connection attempted, no credentials accessed, and no Git commit or push performed.
>
> **Prepared:** 25 November 2026
> **Repository:** `Rajendertyagi/MarketHubTS`
> **Remote baseline inspected:** `develop` at `28a2f3416f9ddcfdf5fab72abc4f3e26671d04b6`
> **Protected branch:** `main` at `865d86f393a29bc1ec8d455a51d9efa82d722c48`
> **Next milestone decision:** Complete real Upstox + FYERS data integration before starting M7.

---

> ## Reconciliation note (2026-11-27) â€” post-baseline drift; no product-scope or gate change
>
> This plan was prepared against remote `develop` at `28a2f34` (25 November 2026). It is re-affirmed on **2026-11-27** against `develop` HEAD **`3c34fba0dc1ac7e3337f561ea9d3673103b6ea34`** (16 post-baseline commits, `c26531a..3c34fba`). `main` is unchanged at `865d86f`. All 19 sections, the final recommendation, historical figures and official-source facts are preserved; **no product scope, locked gate (Stage G / M5 Phase 4B / M7 / Phase 3) or official-source fact is changed**. The 16 commits are the completed, accepted **G0 catalog-refresh child-process / write-coordinator programme** (`docs/G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md`, accepted at `08cf605`). Six reconciliations apply:
>
> 1. **503 `CATALOG_WRITE_BUSY` contract (new).** During a catalog refresh, interactive write paths fail fast with HTTP 503 `CATALOG_WRITE_BUSY` (`app.ts:150-157`; `historical-routes.ts:106`; `snapshot-routes.ts:85`; `mcp-services.ts:96,130`; credential/subscription writes likewise). Background sync/capture skip with `{ skipped: true, reason: "CATALOG_WRITE_BUSY", retryable: true }`. WP5Aâ€“WP5D acceptance and Â§10/Â§13 now include a contention/retry scenario so a transient lock is not misreported as a provider failure. Product scope is unchanged.
> 2. **`writeGuard` threaded through services/repositories.** The Â§7.2 snippet was stale: `HistoricalCandleService`/`OptionChainSnapshotService` now receive `writeGuard: writeCoordinator ?? undefined` (`index.ts:416,419`); `runSync`/`captureScheduled` skip with `{ skipped: true, reason: "CATALOG_WRITE_BUSY", retryable: true }` (`historical/service.ts:173`, `snapshots/service.ts:139`); `CandleRepository.upsertCandles`/`SnapshotRepository.putSnapshot` call `assertWritable("I")` (`candles.ts:52`, `snapshots.ts:90`). WP5E must thread the guard (updated snippet in Â§7.2).
> 3. **"G0" naming collision.** This plan's internal "G0 â€” Pre-activation audit" (Â§6.2) is relabelled **"Stage-G pre-activation audit (plan-internal G0)"**. In repository docs, "G0" now refers to the completed, accepted catalog-refresh programme; an instruction to "do G0 first" no longer means this preflight package.
> 4. **Composition root changed.** `index.ts` now wires `CatalogWriteOwnership` (`:244`), `CatalogWriteCoordinator` (`:252`), `CatalogRefreshChildManager` (`:269`), startup recovery (`:502-551`) and shutdown drain (`:560-618`). Â§6.3 G3 and Â§7.7 WP5E must preserve this ordering; the older root is not current.
> 5. **Baseline drift.** Bun `1.4.4` â†’ `1.4.5` (`package.json:5`, commit `3d40441`); test baseline `1115` â†’ `1253` pass / 0 fail with 14 new G0 test files. Â§17 Q1 and Â§10.4 now state 1.4.5 / 1253; historical figures remain marked historical.
> 6. **Status-doc pointer clarified.** `PROJECT_STATUS.md:7` says this plan records the catalog-refresh startup defect as a blocker; it does not. The defect was tracked separately in `CATALOG_REFRESH_STARTUP_DEFECT.md` and is now **RESOLVED/accepted via G0** (`08cf605`). `PROJECT_STATUS.md` is out of scope for this reconciliation and was not edited.
>
> **Verification basis:** read-only audit `data-plan-verification.md` (2026-11-27, audited KEEP). This reconciliation is documentation-only; no source, test, schema, migration, dependency, manifest or config was changed, and no commit/stage/push was performed.

---

> ## Reconciliation note (2026-11-27, revision 2) — focused technical revision; no product-scope or gate change
>
> This plan is re-affirmed on **2026-11-27** against `develop` HEAD **`049fe84117cc9d383e56316b26bc4cdc800f6df3`** (the drift note above records the earlier `3c34fba` baseline; both are historical). Before editing, the actual source and official provider docs were studied across files: `packages/contracts/src/live.ts`, `live-components.ts`, `snapshots.ts`, `apps/api/src/subscription-coordinator.ts`, `stream-supervisor.ts`, both broker adapters (`stream.ts`, `components.ts`, `historical.ts`, `option-chain.ts`, `index.ts`, `runtime.ts`), `packages/market-core/src/types.ts`, `docs/PRODUCT_REQUIREMENTS.md` and `docs/MARKET_DATA_AND_CATALOG.md`. All 19 sections, the final recommendation, historical figures, official-source facts, locked gates (Stage G / M5 Phase 4B / M7 / Phase 3), G0 safeguards and plan-only status are preserved. Five technical corrections are applied:
>
> 1. **Missing product-promised data added (Â§3, Â§4.7â€“Â§4.9, WP5Fâ€“WP5H).** One-time (on-demand) quote and market-depth retrieval for instruments not currently subscribed, futures-chain data, and BSE SENSEX plus its supported derivatives are now explicit. These are already product promises (`PRODUCT_REQUIREMENTS.md` Â§4.2, Â§8; `MARKET_DATA_AND_CATALOG.md` Â§1.2, Â§5), not new scope. Upstox has no dedicated futures-chain REST endpoint in the documented API families; its futures coverage is derived from the instrument master (FUTIDX/FUTSTK) plus Full Market Quotes V3 / streaming. FYERS has a dedicated `/data/futures-chain` endpoint whose documented examples include `BSE:SENSEX-INDEX`.
> 2. **Default streaming data bundle defined (Â§6.2).** `SubscriptionSelection` is `{canonicalId, enabled}` and `DriverSubscription` is `{canonicalId, nativeIdentifier}`; neither carries component requirements, and no per-component UI selector exists. One fixed, provider-neutral default bundle (quote always; depth where the instrument type/provider supports it; derivatives only for derivative instruments where the feed supplies OI/IV/Greeks) is the single source of the component requirements that G1/G2 translate into provider modes. No new UI selector is introduced.
> 3. **Provider-field disposition made explicit (Â§4.3, Â§4.10).** Required / shared-canonical / provider-specific decisions are recorded for previous OI, OI change, close price, bid/ask quantities, POP, LTP change, futures price and Rho. **Rho correction:** the earlier claim that Rho is not established for Upstox is outdated. The official V3 proto (`MarketDataFeed.proto`, `message OptionGreeks { ... double rho = 5; }`, accessed 2026-11-27) establishes it, and the existing mapper already promotes it (`broker-upstox/src/stream.ts:172`, `components.ts:159`, `contracts/src/live-components.ts:120` `GreeksValue.rho`). Live entitlement still needs verification.
> 4. **Request-time credential retrieval required (Â§7.2.1, WP5Aâ€“WP5D, Â§10.1).** The REST adapters currently take a fixed `token: string` at construction. They must obtain the current credential through the existing `CredentialStore` at request time, mirroring the stream adapters. FYERS SDK singleton / single-slot-listener / token-rotation constraints are preserved.
> 5. **Implementation order changed (Â§8, Â§10, Â§14, final recommendation).** Build both streaming integrations first; connect all quote/depth/history/option-chain/futures-chain paths; test every path offline; then perform ONE coordinated real-provider verification covering both providers and all supported data types; then finish the coverage report and confirm WebUI/API/MCP parity. No streaming-only live test followed by a later REST exercise.
>
> **Newly verified official sources (accessed 2026-11-27):** Upstox [Full Market Quotes V3](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/), [Put/Call Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/), [Market Data Feed V3](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/) and [V3 proto](https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto); FYERS [Quotes](https://fyers.in/api-docs/v3/api/market-data/quotes/), [Market Depth](https://fyers.in/api-docs/v3/api/market-data/market-depth/), [Futures Chain](https://fyers.in/api-docs/v3/api/market-data/futures-chain/), [Option Chain](https://fyers.in/api-docs/v3/api/market-data/option-chain/) and [auth best practices](https://fyers.in/api-docs/v3/api/authentication/individual-app/best-practices/). Documented limits/coverage differ by provider and plan; none is an account-entitlement guarantee.
>
> **Verification basis:** this revision is documentation-only. Pre-existing user changes elsewhere in `docs/` were left untouched; no source, test, schema, migration, dependency, manifest or config was changed, and no commit/stage/push was performed.

---

> ## Reconciliation note (2026-11-28, revision 3) - focused data-completion corrections; no product-scope or gate change
>
> This plan is re-affirmed on **2026-11-28** against `develop` HEAD **`049fe84117cc9d383e56316b26bc4cdc800f6df3`**. The basis is the audited deep study `FNO_DEEP_STUDY_REPORT.md` (40 official URLs, all accessed 2026-11-27), independently audited and confirmed. All 19 sections, the final recommendation, historical figures, official-source facts, locked gates (Stage G / M5 Phase 4B / M7 / Phase 3), G0 safeguards, plan-only status and every pre-existing reconciliation note are preserved. This pass is documentation-only. Seven corrections are applied:
>
> 1. **Blocking futures-catalogue dependency (new WP5I, §7.9).** Both current master importers skip futures rows: `upstox-master.ts:146-160` keeps only CE/PE options (FUTIDX/FUTSTK are skipped at `:150`), and `fyers-master.ts:144-156` keeps only CE/PE (`optType === "XX"` futures are skipped at `:155`). **FUTIDX means index futures and FUTSTK means stock futures.** WP5G (Upstox chain derivation from FUTIDX/FUTSTK rows) and WP5H (SENSEX FUTIDX verification) cannot succeed until those rows are imported. A new WP5I "Futures catalogue import" is inserted before them, with canonical identity/mapping, exact expiry/strike/lot/tick and fail-closed validation; §8, §10, §13 and §14 are updated.
> 2. **Rho is streaming-only (§4.3, §4.5, §5.1, §5.3).** `OptionGreeks.rho = 5` exists in the V3 proto and the existing mapper is correct, but neither `/v2/option/chain` nor `/v3/market-quote/option-greek` carries Rho (they list delta/gamma/theta/vega/IV; the chain also has `pop`). REST snapshots must have null/absent Rho; never imply REST Rho availability.
> 3. **No previous OI in the proto (§4.3, §4.10, §5.1).** The earlier "feed may expose previous OI" claim is removed. Previous OI is REST-only where available: Upstox `previous_oi` (Full Quotes V3) / `prev_oi` (chain), FYERS `prev_oi` (chain), `pdoi` (depth) and `previousOi` (Symbol Master JSON).
> 4. **FYERS LTT is epoch seconds (§4.1, §5.2, §6.2 G2, §11, §12, §17 Q2).** Official samples show 10-digit epoch seconds (`last_traded_time: 1690953622`, depth `ltt: 1622184920`, quotes `tt: "1691020800"`). The permanent `UNKNOWN` default is refined to "seconds evidenced by official examples; confirm on a live sample before promoting to canonical timestamp", with receipt-time fallback only for genuinely ambiguous frames.
> 5. **FYERS token rotation vs SDK singleton (§7.2.1, §11, §17 Q8).** Daily 06:30 IST expiry, single-slot listeners and `close()` not detaching them require an explicit retire-and-recreate generation rule: on rotation, bump generation, retire/close the old driver, create a fresh singleton, re-register listeners, and let the supervisor own retries. Never reuse a stale token or leave orphaned listeners.
> 6. **SENSEX futures are monthly-only (§3.1, §4.9, §5, §7.11, §10).** BSE notice 20250617-11: 3 serial monthly SENSEX futures, last Thursday; no fresh weekly index futures from 1 Jul 2025. SENSEX options: 7 weekly + 3 monthly + 3 quarterly + 8 semi-annual. SEBI circular 2025/76, NSE circulars 68589/68747 and BSE contract specs are cited as expiry authority.
> 7. **Minor source facts (§4.4, §5.1, §5.2, §7.3, §7.4, §9, §11, §17).** Upstox expired-history intervals are restricted to 1/3/5/15/30 minute and day (Plus-gated); FYERS expired F&O rows are `columns`-driven with `no_data` and null Greeks, and BSE history starts 2023-08-07; Upstox Instrument Search (Beta) is noted as unverified/optional and is not adopted; SEBI retail-algo changes effective 1 Apr 2026 are flagged for re-verification before live activation.
>
> **Verification basis:** documentation-only; no source, test, schema, migration, dependency, manifest or config was changed; no commit/stage/push was performed. Pre-existing user work elsewhere in `docs/` was left untouched. Exact `git diff --check` and changed-file results are recorded in the accompanying report.

---

> ## Reconciliation note (2026-11-28, revision 4) - supplementary F&O data-boundary corrections; no product-scope or gate change
>
> This plan is re-affirmed on **2026-11-28** against `develop` HEAD **`049fe84117cc9d383e56316b26bc4cdc800f6df3`**. The basis is the audited supplementary study `FNO_SUPPLEMENT_REPORT.md` (official URLs with 2026-11-28 access dates), independently audited KEEP. This revision 4 adds **no new work package**: the six edits below are boundary/fact corrections only. The work packages WP5F–WP5H and WP5I were introduced by the earlier revision 2 and revision 3 reconciliation notes in this same working-tree change set; they are not new in revision 4. All 19 sections, the final recommendation, historical figures, official-source facts, locked gates (Stage G / M5 Phase 4B / M7 / Phase 3), G0 safeguards, plan-only status and every pre-existing reconciliation note are preserved. This pass is documentation-only; **no new work package is added**. Six corrections are applied:
>
> 1. **SENSEX lot qualified per expiry (Â§4.9, Â§7.9).** The unqualified "lot 20" is replaced: 20 for Nov-Dec 2026 expiries only; BSE notice `20260930-58` revises it to 25 effective Jan 2027 and subsequent expiries; tick Rs 0.05 unchanged. WP5I now records source/effective date per lot/tick and preserves expiry-series distinctions.
> 2. **Corporate-action raw-data boundary (Â§3.2, Â§4.4, Â§4.6, Â§5.4, Â§11, Â§12, Â§17 Q9).** NSE/BSE adjust strike, futures base price, lot and positions on the last cum-day after close (TECHM 1:1 bonus, factor 2, ex-date 30 Nov 2026). The catalogue stores raw provider values as-is; no adjustment factors, no retroactive rewrite, no cross-ex-date splicing; adjustment events recorded as provenance only if the source supplies them. No adjustment work package.
> 3. **Stock F&O eligibility sources pinned (Â§3.2, Â§4.6, Â§5.4, Â§9, Â§17 Q5).** NSE F&O Stock Introduction and Exclusion Tracker (entries through 27 Jan 2027), NSE Selection Criteria (16th of month), BSE folist/eligibility (15th PSF), SEBI 2024/116. Eligibility is dynamic and re-verified at preflight, not permanent; a provider master row is not exchange eligibility.
> 4. **Per-expiry lot/tick authority (Â§4.6, Â§5.4, Â§7.9, Â§17 Q10).** Lot/tick are per-expiry contract fields (`MinLot`, `NewBrdLotQty`, `BidIntrvl`), not constants. Corrected history: NIFTY 75â†’50 in 2021 (`FAOP/47854`), 50â†’25 then 25â†’75 in 2024 (`61415`/`64625`), 75â†’65 in 2025 (`70616`).
> 5. **Settlement-mode market-data-only rule (Â§3.2, Â§4.6, Â§5.4, Â§11, Â§12, Â§17 Q11).** SEBI 2024/116: index derivatives cash-settled, single-stock physically settled; contract master `SttlmMtd='C'`/`'P'` (the 18 `C` FUTSTK rows are `NSETEST` test symbols). Record as canonical metadata where supplied; no settlement/exercise/delivery logic.
> 6. **India VIX derivatives out of scope (Â§3.2, Â§4.9, Â§5.4, Â§17 Q12, Â§19).** `FUTIVX` existed historically (2014 launch, weekly Tuesday, cash-settled); no `OPTIVX` evidenced; zero VIX rows in the 27 Nov 2026 contract master (83,326 rows, only FUTIDX/FUTSTK/OPTIDX/OPTSTK). India VIX is consumed only as an index/chain metric.
>
> **Verification basis:** documentation-only; no source, test, schema, migration, dependency, manifest or config was changed; no commit/stage/push was performed. Pre-existing user work elsewhere in `docs/` was left untouched. Exact `git diff --check` and changed-file results are recorded in the accompanying report.
>
> ---

---

## 1. Executive decision

**Do not start M7 implementation yet.** MarketHubTS has substantial provider-independent infrastructure and offline adapter code, but it is not yet receiving live Upstox/FYERS data in its production application.

The next implementation programme is:

1. **Build both providers' streaming integrations** (M4 Stage G driver bridges) through the existing provider runtimes and canonical market-data pipeline, with the production boundary still locked.
2. **Connect both providers' data paths** (M5 Phase 4B): one-time quote and market depth, historical candles, option-chain snapshots and futures-chain data, plus the supported BSE SENSEX derivatives.
3. **Test every path offline** with deterministic fixtures before any real provider connection is attempted.
4. **Run ONE coordinated real-provider verification** covering both providers and all supported data types only after the complete integration is reviewed and explicitly authorized; then finish the coverage report and confirm WebUI/API/MCP receive the same data.
5. Only then authorize **M7 â€” Watchlists, Alerts and Scanners** against verified data.

The work must reuse the existing architecture. It must not introduce a parallel market-data service, duplicate provider-specific logic in the WebUI/MCP layers, or silently downgrade unsupported data.

### Why this comes before M7

The current source composition deliberately constructs both streaming supervisors with `LockedProviderDriver`. It also constructs `HistoricalCandleService` and `OptionChainSnapshotService` with empty provider collections (`providers: []`). Therefore, the presence of adapter classes and mocked tests does not mean that a running MarketHub instance can receive real ticks or retrieve live historical/option-chain data.

M7 features need trustworthy data and freshness states. Building them first would create workflows whose principal input is still unavailable or synthetic. M7 remains planned, not the next coding task.

---

## 2. Verified repository baseline

### 2.1 Repository and scope inspected

The remote `develop` branch was inspected at `28a2f3416f9ddcfdf5fab72abc4f3e26671d04b6` (tree contained 374 entries). Relevant documentation and source inspected included:

- `docs/PROJECT_MANAGER_PROTOCOL.md`
- `docs/ENGINEERING_STANDARDS.md`
- `docs/IMPLEMENTATION_ROADMAP.md`
- `docs/PROJECT_STATUS.md`
- `docs/PROVIDER_INTEGRATION.md`
- `docs/MULTI_PROVIDER_STREAMING_ARCHITECTURE.md`
- `docs/STAGE_5_PLAN.md`
- `packages/contracts/src/live.ts`
- `packages/contracts/src/live-components.ts`
- `packages/contracts/src/historical.ts`
- `packages/broker-upstox/src/stream.ts`, `components.ts`, `historical.ts`, `option-chain.ts`
- `packages/broker-fyers/src/stream.ts`, `historical.ts`, `option-chain.ts`
- `packages/market-core/src/live/*` and historical/snapshot services
- `apps/api/src/index.ts`, `stream-supervisor.ts`, `subscription-coordinator.ts`
- Existing provider, market and WebUI tests and fixtures.

**Local checkout limitation:** this review reads the remote GitHub branch. It does not establish the state of the user's local working tree. Before implementation, OpenCode must run `git status --short --branch`, `git rev-parse HEAD`, and `git branch --show-current` in the actual checkout, and preserve every pre-existing change. Do not assume a clean tree from this plan.

### 2.2 Current implementation status

| Area | Verified repository status | What this does *not* prove |
|---|---|---|
| M3 Upstox authentication | Analytics-token credential/auth adapter exists; provider is registered in the application composition. | No real account token was used or validated in this review. |
| M3 FYERS authentication | V3 individual-app OAuth adapter exists; provider is registered. | No real FYERS session was used or validated in this review. |
| Canonical live contracts | Implemented: provider observations, quote/depth/derivatives components, timestamps, freshness, provenance, capabilities and source selection. | It does not itself deliver provider data. |
| Upstox stream adapter | `UpstoxMarketDataStream` exists and uses the pinned official `upstox-js-sdk@2.31.0`; decoder and mapping code exist. | It is not the production driver currently wired into the application. No live socket verification has been completed. |
| FYERS stream adapter | FYERS Data Socket adapter exists and uses pinned `fyers-api-v3@2.4.1`; canonical component updates exist. | It is adapter-only. Production driver wiring, Bun/runtime compatibility and live feed verification remain outstanding. |
| Shared runtime lifecycle | `StreamSupervisor` and `SubscriptionCoordinator` exist; one runtime is composed per provider. | Both production runtimes currently receive locked drivers. |
| Production streaming | `apps/api/src/index.ts` creates `LockedProviderDriver("UPSTOX")` and `LockedProviderDriver("FYERS")`. | No provider SDK instance or live socket is created by the normal app composition. |
| Live delivery | Shared `MarketDataService`, bounded `LiveEventHub`, REST snapshot/SSE routes and WebUI live-data UI exist. | These components cannot show real provider ticks until the production drivers are activated and subscriptions are genuinely applied. |
| Historical contracts/storage | Canonical candle contracts, five-table M5 persistence, repositories, coverage/gap logic and retention handling are implemented. | Storage primitives do not mean candles are being retrieved from a broker. |
| Upstox historical adapter | Offline adapter exists, mapping canonical intervals to provider requests and parsing candle rows. Tests use injected/mock fetch. | No live REST retrieval or account entitlement has been verified. |
| FYERS historical adapter | Offline adapter exists, including resolution conversion, OI flags and expired-data handling. Tests use injected/mock fetch. | No live REST retrieval or account entitlement has been verified. |
| Upstox option-chain adapter | Offline adapter exists for option-chain REST data and maps market data/Greeks. | No real option-chain request has been run through the app. |
| FYERS option-chain adapter | Offline adapter exists; it discovers available expiries and requests the exact selected expiry, with OI/Greeks parsing. | No real option-chain request has been run through the app. |
| M5 application composition | M5 routes, services, repositories and WebUI surfaces exist. | `apps/api/src/index.ts` currently constructs both services with `providers: []`; the providers are not wired into the running services. |
| Instrument masters | WP4Aâ€“4C imported public Upstox BOD and FYERS Symbol Master files, added expiry discovery and a WebUI expiry selector. | This is broker-available master-file coverage, not proof of exhaustive NSE/BSE coverage or correct mappings for every product/contract. |
| M6 | Accepted and closed at the inspected baseline. | M6 completion does not activate M4 Stage G or M5 Phase 4B. |

### 2.3 Exact architecture facts to preserve

- `MarketDataService` is the canonical live-data service shared by consumers.
- `SubscriptionCoordinator` is the single owner of desired streaming subscriptions and fans changes out to independent provider runtimes.
- One `StreamSupervisor` exists per provider. They must not compete over the shared desired-subscription repository or tracking state.
- The canonical live component model is `quote`, `depth`, and `derivatives`.
- Provider-specific SDK modes and field names stay inside their broker adapters.
- The existing Stage F supervisor lifecycle/recovery guarantees remain authoritative. Do not introduce a second reconnect owner or uncontrolled retry loop inside a provider SDK wrapper.
- `LiveEventHub` is bounded in-memory delivery/replay, not historical storage. Do not persist every tick merely to make M4 appear complete.
- M5 candle and snapshot persistence remain separate data lifecycles.
- M5 provider choice is explicit. Do not add an implicit FYERS default or an unapproved automatic-provider policy.
- WebUI owns operational subscription/capture configuration. MCP on-demand operations must not silently mutate those settings.
- No orders, trading, portfolio mutation, automated trading or investment recommendations are part of this work.

---

## 3. Completion target and product boundary

### 3.1 What â€œdata integration completeâ€ means here

For the current MarketHubTS market-data scope, completion means:

1. Both providers can authenticate using the already approved **read-only/data-only** app arrangements. FYERS auth docs note SEBI retail-algo regulation changes effective **1 Apr 2026**; re-verify that the existing data-only arrangement remains valid under the post-April-2026 rules before any live activation (§5.2, §11.1).
2. Both streaming adapters are connected to the production runtime through the existing supervisor/coordinator design.
3. User-selected canonical instruments can be mapped to each provider's native symbol/key and actually subscribed.
4. Real provider messages are decoded, normalized and delivered through canonical quote/depth/derivatives components with provider attribution, timestamps and freshness.
5. One provider can fail, expire or hit a limit without disabling the other provider or corrupting shared desired state.
6. Historical candles can be fetched from each supported provider, validated, cached and read after restart.
7. Option-chain data can be fetched from each supported provider for an explicitly selected underlying/expiry and stored as snapshots.
8. One-time (on-demand) quote and market-depth retrieval works for instruments that are **not** in the configured streaming selections, without silently changing those selections.
9. Futures-chain data is available for supported underlyings, and BSE SENSEX plus its supported SENSEX futures/options are covered where the provider master and API actually supply them (BANKEX, SENSEX50 and other BSE derivatives stay out of scope). The asymmetry is explicit: **SENSEX futures are monthly-only** (3 serial monthly contracts, last Thursday; no fresh weekly index futures from 1 Jul 2025 per BSE notice 20250617-11), while SENSEX options have 7 weekly + 3 monthly + 3 quarterly + 8 semi-annual contracts. Futures rows must first be imported by WP5I (§7.9).
10. Actual limitations, unsupported fields, entitlements, stale data, request failures and no-data results are visible and truthful.
11. Tests prove the flow with both deterministic offline fixtures and explicitly authorized real-provider evidence.

### 3.2 What this plan does not claim to implement

This is not a plan to mirror every endpoint in the Upstox or FYERS platform. It covers the read-only market-data foundation required by the current F&O-focused product: catalogue identity/mappings, live quotes, market depth, provider-supported derivative metrics, one-time on-demand quote/depth, historical candles, active option-chain contracts/data, futures-chain data, the supported expired-F&O history paths, and BSE SENSEX plus its supported derivatives. The existence of an endpoint in a broker API is not permission to add it to this product scope.

The following remain separate workstreams unless current product requirements explicitly include them: account/portfolio data, funds, positions, order APIs, trading, news, fundamentals, screeners, webhooks for broker events, and market-wide analytics beyond the market-data inputs defined here.

Corporate-action adjustment of F&O contract specifications is **out of scope** for this programme. NSE and BSE adjust open futures/options positions on the last cum-trading day after close, modifying strike price, futures base price, market lot/multiplier and position count (NSE "Adjustments in case of Corporate Actions"; BSE corporate-action notices under SEBI guidelines; e.g. TECHM 1:1 bonus, adjustment factor 2, ex-date 30 Nov 2026 per NSE circular `NCL/CMPT/77593`, accessed 2026-11-28). This programme stores provider-returned values as-is with provider, source date and receipt provenance. It does **not** compute adjustment factors, retroactively rewrite stored candles or snapshots, or splice pre- and post-ex-date series into one canonical series. Record an adjustment event as provenance/diagnostic only if the source supplies it. Cross-adjustment comparisons remain unverified unless a separately authorized phase adds an explicit, source-attributed adjustment model; no adjustment work package is part of this plan.

India VIX derivatives are **out of scope**. NSE historically listed India VIX futures (`FUTIVX`, underlying symbol `INDIAVIX`, weekly Tuesday expiry, cash-settled, launched 26 Feb 2014); no `OPTIVX` instrument is evidenced in the official sources reviewed. The current NSE contract master (27 Nov 2026, 83,326 rows) contains **zero** VIX rows and only `FUTIDX`/`OPTIDX`/`FUTSTK`/`OPTSTK`; NSE's current product page lists six index derivatives and no VIX derivatives (all accessed 2026-11-28). India VIX may be consumed only as a provider-supplied index/chain metric under Â§4.5/Â§4.10; the legacy NSE `INDIAVIX` quote page must not be treated as evidence of active contracts, and no VIX futures/options instrument may be added to the catalogue by this programme.

Settlement mode is exchange-defined contract metadata and is **not** inferred from market data. Index derivatives are cash-settled; single-stock derivatives are physically settled (SEBI circular `SEBI/HO/MRD/MRD-PoD-2/P/CIR/2024/116`, 30 Aug 2024; physical settlement mandated in phases by `SEBI/HO/MRD/DOPI/CIR/P/2018/161` and accelerated by `SEBI/HO/MRD/DOP1/CIR/P/2019/28`). The NSE contract master expresses this per contract as `SttlmMtd` (`C` for index derivatives, `P` for real stock derivatives; the 18 `C` FUTSTK rows are `NSETEST` test symbols, not real stocks). This product consumes market data only: expiry is the last trading day taken from contract data, final settlement price is not derived from candles or snapshots, and no delivery, exercise, assignment, obligation or position outcome is modelled.

Stock F&O eligibility is **dynamic and exchange-published**, not a static list in this plan. The pinned authoritative sources are the NSE F&O Stock Introduction and Exclusion Tracker (linked from NSE Contract Information; current file dated 23-11-2026 with entries effective through 27 Jan 2027), the NSE Selection Criteria page (16th-of-month, rolling six-month review), the BSE F&O Underlying Asset List / eligibility page (15th-of-month PSF), all under SEBI circular `SEBI/HO/MRD/MRD-PoD-2/P/CIR/2024/116` (all accessed 2026-11-28). Stock eligibility changes on published effective dates (e.g. ACUTAAS/APARINDS 25 Nov 2026; IEX/IREDA 25/27 Nov 2026; INOXWIND 30 Dec 2026; GODFRYPHLP 27 Jan 2027). Index-derivative eligibility is reviewed semi-annually (first week of April and October, with a 21-month seasoning rule); stock criteria are reviewed monthly. Both must be re-verified at preflight and at each catalogue refresh, not treated as permanent. A provider master row is evidence of provider availability, **not** exchange eligibility.

### 3.3 No fabricated or misleading data

- A missing field remains absent/null according to the existing contract; never fill it with `0`, another provider's value, or a stale value without explicit provenance and freshness.
- A provider's omitted field is not automatically a clear. Preserve the component merge rules already implemented.
- `native` provider payloads may be retained for diagnostics/provenance where existing contracts permit, but they are not canonical fields and must not be used as alert conditions or silently displayed as normalized market values.
- Display states must distinguish: not configured, authentication required/expired, disconnected, connecting, streaming but no subscription, subscribed but no tick yet, fresh, stale/last-known, partial, unsupported, limited and error.
- An empty response or documented `no_data` is not a fabricated candle or snapshot.

---

## 4. Provider data coverage: field-by-field target

The table below defines what must be investigated and verified. â€œDocumentedâ€ is not the same as â€œverified for the user's accountâ€ or â€œcurrently mapped correctly by this repositoryâ€. The live-verification columns are deliberately not marked passed.

### 4.1 Streaming quote fields

| Canonical field | Upstox documented surface | FYERS documented surface | Repository baseline / required treatment |
|---|---|---|---|
| LTP | V3 LTPC and full feeds | Data Socket `sf`; index feed `if`; Lite mode has LTP only | Existing adapters map LTP. Verify real values and index/equity/derivative symbol classes. |
| Previous session close | LTPC `cp`; full-feed quote fields | `prev_close_price` on symbol/index updates | Existing mappings exist. Keep the unambiguous canonical `previousClose`; do not confuse it with the current candle close. |
| Last traded quantity | LTPC `ltq` | Symbol update includes last-traded quantity where documented | Verify field presence and integer safety. Index messages have a reduced field set. |
| Last traded time | LTPC `ltt` | `last_traded_time` (symbol update), `ltt` (depth) and `tt` (quotes) are **evidenced as 10-digit epoch seconds** by official samples (`1690953622`, `1622184920`, `"1691020800"`), accessed 2026-11-27 | Upstox mapping exists. For FYERS, treat seconds as the evidenced default, but confirm on a live sample before promoting to a canonical timestamp; use receipt-time fallback only for genuinely ambiguous frames. Do not permanently label the unit `UNKNOWN`. |
| Day open/high/low | Full-feed OHLC/session fields | `open_price`, `high_price`, `low_price` in `sf`/reduced index data | Existing canonical mapping exists. Verify each message type and instrument type. |
| Traded volume | Full feed / market OHLC / feed details | `vol_traded_today` for symbol updates; index messages may omit volume | Preserve absent index volume as absent. Never synthesize index volume. |
| Average traded price | Upstox full-feed detail where supplied | FYERS symbol update includes average traded price where supplied | Map only if the current canonical contract owns the field; otherwise add only through an approved shared-contract change. |
| Change / change percent | Feed fields where supplied; verify current SDK decoding | `ch` / `chp` on symbol/index data | Existing FYERS adapter has change fields. Check canonical display and API contract consistency. |
| One-minute / thirty-minute session candles | Upstox full feed has market OHLC interval entries | Not a Data Socket OHLC candle stream; use history REST for candle series | These are current-feed auxiliary bars, not the durable M5 candle archive. Avoid duplicate or ambiguous `close` semantics. |
| Index quote | Upstox `indexFF` full-feed shape | FYERS `if` message shape | Verify the reduced field set. Do not require volume/depth when the index feed does not supply it. |
| Year high/low, circuit bands, total buy/sell quantity, CAS indicative data | Some Upstox REST/feed payloads expose additional fields depending on endpoint/version/session | FYERS has its own available market-information fields; availability varies by API | Not all are part of the current canonical `QuoteValue`. Do not push them into `native` and call them supported. Classify as optional provider extras; add a shared canonical field only if the product requires it and both consumers are updated. |

### 4.2 Market depth

| Requirement | Upstox | FYERS | Required verification |
|---|---|---|---|
| Best bid/ask (L1) | Available through applicable full/first-depth feed shapes | Best bid/ask may be included in symbol update; `dp` is the distinct depth event | Ensure bid/ask is owned by canonical `depth`, not duplicated inside `quote`. |
| Five-level depth | Full market-depth feed shape; confirm actual mode, instrument type and account entitlement | Dedicated `dp` update provides five bid/ask levels | Verify all ten side/level price and size fields; preserve order counts if supported by canonical contract. |
| Thirty-level depth | Upstox `full_d30` is a documented feed mode with stricter limits/entitlement requirements | Not provided by the ordinary FYERS Data Socket depth update; 50-level TBT is a separate surface | Do not silently substitute FYERS five-level depth for a 30-level request. Mark unsupported/limited. |
| Index depth | Generally not part of index quote payload | `if` index update is reduced; no ordinary five-level order-book payload is promised for an index | Mark unsupported rather than manufacturing bid/ask. |
| Depth update semantics | Full/snapshot vs partial updates depend on feed mode/message semantics | `dp` update and symbol `sf` may arrive separately | Verify whether each frame is complete or partial before merge/clear. Missing fields mean â€œno changeâ€ unless the provider explicitly indicates a clear. |

**Important architectural rule:** the accepted AD-024 contract says quote owns trade/session statistics; depth owns all bid/ask prices, quantities and levels; derivatives owns OI/IV/Greeks. FYERS best bid/ask from `sf` must be split into a depth component and must not become a second quote source. Preserve the current component-level update/merge design.

### 4.3 Derivative metrics

| Field | Upstox | FYERS | Required treatment |
|---|---|---|---|
| Open interest (OI) | Available in applicable full/option-Greeks feed details and REST responses | Not part of the FYERS Data Socket `sf`/`if`/`dp` quote stream; available through option-chain and applicable historical/expired REST responses | Treat FYERS OI as REST/snapshot or historical data, not as a live tick. Upstox feed-mode availability must be verified with live fixtures. |
| Implied volatility (IV) | Available in option-Greeks/option-chain surfaces subject to feed mode/entitlement | Option-chain REST supports `greeks=1` and nested `iv`; not Data Socket | Keep REST-derived values separately attributed and timestamped. Do not claim they are stream-tick updates for FYERS. |
| Delta, gamma, theta, vega | Upstox option chain / option-greeks surfaces | FYERS option-chain REST `greeks=1` | Preserve missing/null Greek values as null/absent; do not zero-fill. |
| Rho | **Streaming-only.** Official V3 proto `OptionGreeks { ... double rho = 5; }` (accessed 2026-11-27); the existing mapper already promotes it (`broker-upstox/src/stream.ts:172`, `components.ts:159`) into canonical `GreeksValue.rho` (`contracts/src/live-components.ts:120`). **Absent from both Upstox REST surfaces:** `/v2/option/chain` and `/v3/market-quote/option-greek` list only delta/gamma/theta/vega/IV (the chain also has `pop`). | Not listed in the FYERS documented option-chain Greek set inspected (`greeks=1` returns delta/gamma/theta/vega/IV only) | Keep Rho as an optional canonical Greek **from the V3 stream only**. A REST option-chain snapshot can never carry Rho: leave it null/absent, never imply REST Rho availability, and do not require it from FYERS. Verify live stream delivery/entitlement. |
| Previous OI / OI change / OI percentage change | **REST-only:** Full Quotes V3 `previous_oi` and option-chain `prev_oi`. The V3 proto has **no previous OI** field (`MarketFullFeed` does not carry it); the earlier "feed may expose previous OI" claim is withdrawn. | **REST-only:** option-chain `prev_oi`, `oich`, `oichp`; depth `pdoi`, `oipercent`; Symbol Master JSON `previousOi` | Existing canonical derivatives contract may not include all of these. Audit schemas before mapping; add only deliberate, typed fields. Never expect previous OI from a streaming frame. |
| PCR / total call OI / total put OI | Upstox option-chain includes `pcr` per strike/chain response context | FYERS option-chain includes `callOi` and `putOi` | These are chain-level aggregate metrics, not per-contract derivative values. They need an explicit snapshot/aggregate contract if required. |

### 4.4 Historical candle data

| Capability | Upstox | FYERS | Repository requirement |
|---|---|---|---|
| Active-contract OHLCV candles | V3 historical candle API | `/data/history` | Both offline adapters already exist. Activate service providers and verify real response parsing, interval mapping and window handling. |
| Open interest in candles | V3 candle row includes OI where supplied | `oi_flag=1` requests OI | Keep OI nullable; missing OI is not zero. |
| Intraday intervals | Official V3 API supports minute intervals 1â€“300 and hours 1â€“5 with endpoint-specific maximum windows | Official API supports the documented minute resolutions; up to 100 days per request for the documented intraday intervals | Confirm supported canonical intervals against both adapters; chunk requests to provider windows without gaps/overlap errors. |
| Daily/weekly/monthly | Official V3 supports day/week/month; published historical availability extends back further for daily/weekly/monthly than intraday | `1D`, `1W`, `1M`; max 366 days per request for these resolutions | Verify date-boundary conversion, timezone/calendar semantics and duplicate candle handling. |
| Active F&O | Uses native active contract identifiers | Uses native F&O symbols and `cont_flag` as applicable | Resolve canonical IDs to the exact provider-native contract. Do not construct symbols by string guessing. |
| Expired F&O | Separate expired-instruments APIs; expired historical candle access is documented as Upstox Plus-only. **Expired-candle intervals are a restricted set:** `1minute`, `3minute`, `5minute`, `15minute`, `30minute`, `day` (not the V3 active set of 1-300 minutes / 1-5 hours / day/week/month). | Separate expiry-date â†’ expired-contract â†’ expired-data API flow. Rows are **`columns`-driven**: map by column name, first six fixed (timestamp, open, high, low, close, volume), optional OI/Greeks appended after index 5; Greek values may be `null`; `s=no_data` with empty candles is a valid empty result. **BSE history starts 2023-08-07** (NSE 2018-10-10, MCX 2018-10-18). | Treat entitlement and date coverage as provider-specific. A denied Plus endpoint is not an adapter bug if the account lacks entitlement. Do not assume active-interval support for expired contracts; do not positional-map FYERS rows without reading `columns`. |
| History window / account plan | Endpoint limits vary by interval and endpoint; expired history has separate rules | Current docs publish plan- and resolution-specific windows and request sizes; Standard expired intraday is capped at **10 API requests/day** | Expose the actual account/provider limitation. Never hardcode entitlement as guaranteed. |

> **Corporate-action boundary (accessed 2026-11-28):** historical candles and expired-F&O rows are provider-returned series. Neither the Upstox V3 candle contract nor the FYERS historical-data contract documents corporate-action adjustment semantics; a FYERS community reply says history is adjusted except for demergers, but that is not a formal API contract. Do not assume "adjusted" or "unadjusted". Record provider and retrieval date; do not join pre- and post-ex-date rows into a single canonical series without explicit adjustment metadata; do not derive an adjustment factor from price jumps. NSE/BSE adjust strikes, futures base prices, lots and positions on the last cum-day after close (e.g. TECHM 1:1 bonus, factor 2, ex-date 30 Nov 2026), so a stored series can be non-continuous across an ex-date by design.

### 4.5 Option-chain data

| Capability | Upstox | FYERS | Repository requirement |
|---|---|---|---|
| Active option contracts | `GET /v2/option/contract` | Current symbols from Symbol Master; option-chain/expiry API metadata | Resolve underlying and selected expiry against provider metadata. |
| Active option chain | `GET /v2/option/chain` | `options-chain-v3` | Both offline adapters exist; connect them to M5 service and verify live. |
| Expiry selection | Upstox accepts explicit expiry date and documents relative expiry keywords | FYERS returns `expiryData`; exact expiry epoch is passed to select the requested expiry | Continue using exact requested expiry; do not rely on list order or ambiguous expiry flags. |
| Strike coverage | Provider returns supported strikes/contract rows | `strikecount` supports up to 50 strikes on each side of ATM | Show actual returned strike range/count; do not claim a full chain if limited by API request or account. |
| Per-strike market data | LTP, close, volume, OI, bid/ask and quantities, previous OI | LTP, bid/ask, OI, OI change/percentage, previous OI, volume | Map fields to the existing snapshot contract; identify omissions before expanding the contract. |
| Greeks | Delta, gamma, theta, vega, IV; current docs also list POP. **Rho is not in either REST surface** (V3 proto stream only). | Delta, gamma, theta, vega, IV | Audit whether POP is represented. Do not silently discard a required metric or cram it into untyped payload. Never expect Rho in a REST snapshot. |
| Underlying/VIX/aggregates | Underlying spot price and PCR in response | Underlying chain entry/forward data, India VIX, aggregate call/put OI | Store only if the canonical snapshot envelope models the metric; otherwise propose a specific contract change. |
| Exchange/product availability | Upstox Put/Call Option Chain currently documents an MCX exclusion | FYERS option-chain availability varies by instrument/segment and must be verified | Report per-provider/segment coverage; do not claim universal NSE/BSE/MCX support. |

### 4.6 Instrument catalogue and provider-native mapping

Existing WP4Aâ€“4C imports public Upstox BOD and FYERS Symbol Master files and exposes provider-aware derivative expiry discovery. This is a useful foundation, but current documentation explicitly limits claims to broker-available coverage rather than a complete exchange catalogue.

**Current import gap (blocking for WP5G/WP5H):** both importers keep only CE/PE options. `packages/market-core/src/sync/upstox-master.ts:146-160` skips non-CE/PE rows at `:150` (so FUTIDX index futures and FUTSTK stock futures never enter the catalogue), and `packages/market-core/src/sync/fyers-master.ts:144-156` skips `optType === "XX"` futures at `:155`. WP5I (§7.9) closes this gap before any futures-chain or SENSEX-futures verification is attempted.

**Stock-eligibility authority (pinned, accessed 2026-11-28):** stock F&O eligibility is dynamic and exchange-published, not a static list in this plan. The authoritative sources are the NSE Selection Criteria page (`https://www.nseindia.com/products-services/equity-derivatives-selection-criteria`) and the NSE **F&O Stock Introduction and Exclusion Tracker** linked from NSE Contract Information (current file dated 23-11-2026, with entries effective through 27 Jan 2027), the BSE F&O Underlying Asset List (`https://www.bseindia.com/markets/Derivatives/DeriReports/folist`) and BSE eligibility page, all under SEBI circular `SEBI/HO/MRD/MRD-PoD-2/P/CIR/2024/116` (30 Aug 2024). NSE computes the top-500/quarter-sigma/delivery criteria on the **16th** of each month on a rolling six-month basis; BSE's PSF review is calculated on the **15th**. Additions and removals take effect on published effective dates (e.g. ACUTAAS/APARINDS 25 Nov 2026; IEX/IREDA 25/27 Nov 2026; INOXWIND 30 Dec 2026; GODFRYPHLP 27 Jan 2027). The catalogue must source eligibility from these published lists/circulars with effective dates; the presence of a provider master row is evidence of provider availability, **not** exchange eligibility. Index-derivative eligibility is reviewed semi-annually (April/October) and must be re-verified at preflight, not treated as permanent.

**Upstox Instrument Search (Beta):** `GET /v2/instruments/search` is a real authenticated endpoint (query <=50 chars, max 30 records/page, documented ambiguity caveats). It is **not adopted** by this plan: master files plus `/v2/option/contract` remain the chosen discovery path because they are public, deterministic and already imported. Treat the endpoint as an unverified/optional bounded fallback only if a future assignment proves a concrete gap; do not rely on it for catalogue completeness.

The completion audit must prove, per supported exchange/segment:

- The instrument/contract exists in the latest provider master source.
- Its canonical instrument identity is stable and unambiguous.
- Its Upstox `instrument_key` and FYERS symbol/FY token mapping are exact and separately attributed.
- The derivative underlying, expiry, strike, CE/PE, lot size, tick size, segment and instrument type are correct where supplied.
- Expired instruments remain addressable for historical data without corrupting current active contract identity.
- Master source date/freshness reflects the source's own published date/version, not merely download time.
- Partial/failed refresh never destroys the last valid catalogue.

Do not claim full NSE/BSE coverage based only on successful imports. The work package must compare the intended product universe with the actual rows/segments available in each provider master and report missing/unmapped/ambiguous cases.

- **Raw provider data only across corporate actions.** The catalogue stores the contract specification as published by the selected source for the selected date. NSE/BSE adjust strike, futures base price, market lot/multiplier and position count on the last cum-trading day after close; the NSE contract master carries `CorpAdjstmnt`, `OffclCorpActnEvtId`, `IntrstOrDvdd`, `RghtsOrBns` and special-ex-date fields. These are source metadata/provenance, not instructions to reconstruct adjusted historical contracts. Do not splice or retroactively rewrite stored candles/snapshots across an ex-date; record an adjustment event only if the source supplies it.
- **Lot and tick are per-contract, per-expiry values, not global constants.** NSE publishes lot changes by circular (`NSE/FAOP/47854` 75→50 in 2021; `61415` 50→25 and `64625` 25→75 in 2024; `70616` 75→65 in 2025) and reflects them in `fo_mktlots.csv` expiry-series columns and in contract-master `MinLot` / `NewBrdLotQty` / `BidIntrvl`. Tick size is reviewed monthly by circular (`NSE/FAOP/67134`, `67135`, `70382`). Two lots can coexist for different expiries (SENSEX 20 for Nov–Dec 2026, 25 from Jan 2027). The catalogue must store each value with its source, effective date and applicable expiry series; it must never apply a current lot/tick to a historical contract.
- **Settlement mode is source-attributed metadata, not a market-data input.** Where the provider/exchange master supplies a settlement-mode field (for example NSE contract-master `SttlmMtd`, `C` for index and `P` for real stock derivatives), retain it as source-attributed contract metadata; do not compute it from instrument type alone, do not use it to alter candle or snapshot interpretation, and do not model delivery, exercise, assignment or settlement outcomes.

### 4.7 One-time (on-demand) quote and market depth

This is an existing product promise, not new scope: `PRODUCT_REQUIREMENTS.md` Â§8 allows on-demand retrieval for instruments **not** in configured streaming/sync selections without silently modifying operational settings, and `MARKET_DATA_AND_CATALOG.md` Â§5 lists quotes and depth as required domains.

| Capability | Upstox (official, accessed 2026-11-27) | FYERS (official, accessed 2026-11-27) | Required treatment |
|---|---|---|---|
| One-time quote | `GET /v3/market-quote/quotes`, up to **500** instrument keys per request; `last_price`, `ohlc` (open/high/low/close/volume/ts), `average_price`, `net_change`, `prev_close_price`, `oi`, `previous_oi`, `year_high`/`year_low`, circuit limits, CAS fields, `last_trade_time` (ms string), ISO `timestamp`. Bearer token. | `GET /data/quotes` up to **50** symbols (Standard); `POST /data/quotes` up to **50** Standard / **1,000** Prime. `lp`, `ch`, `chp`, `bid`, `ask`, `open_price`/`high_price`/`low_price`/`prev_close_price`, `atp`, `volume`, `tt`, `fyToken`; per-symbol `s` must be checked. No OI in quotes. | Map to canonical `quote` with `provider-rest` provenance and receipt time. Batch within documented limits; report per-symbol errors honestly; never fabricate absent fields. |
| One-time market depth | Same V3 quotes response carries `depth.buy` / `depth.sell`, **top 5** levels with `quantity`, `price`, `orders`. | `GET /data/depth`, **max 1 symbol** per request, `ohlcv_flag=1`; `bids`/`ask` arrays (price, volume, ord), `totalbuyqty`/`totalsellqty`, `oi`, `pdoi`, `oipercent`, `ltp`/`ltq`/`ltt`, OHLC, circuit limits. | Map to canonical `depth` (levels + levelCount) with explicit level count; keep OI/prev-OI/OI-% as derivatives/provider-specific per Â§4.10. Do not persist per-tick; do not change streaming selections. |

These REST snapshots are **not** a replacement for the streaming feed and are not durable tick storage. They are read-only on-demand reads through the same canonical service/contracts, shared by REST, WebUI and MCP.

### 4.8 Futures-chain data

| Capability | Upstox | FYERS (official, accessed 2026-11-27) | Required treatment |
|---|---|---|---|
| Currently available futures contracts | **No dedicated futures-chain REST endpoint** is present in the documented Upstox API families (Market Quote, Historical, Option Chain, Expired Instruments, Market Information, Fundamentals, News). Derive the chain from the provider instrument master (`FUTIDX` = index futures, `FUTSTK` = stock futures rows) and obtain live fields via Full Market Quotes V3 (â‰¤500 keys) or the streaming feed. | `GET /data/futures-chain?symbol=...` returns the underlying entry (empty `expiry`) plus currently available futures contracts with `symbol`, `fyToken`, `lp`, `ch`, `chp`, `expiry` (epoch), `volume`. Documented examples include `NSE:NIFTY50-INDEX`, `NSE:SBIN-EQ` and `BSE:SENSEX-INDEX`. Only current contracts; expired contracts use the expiry-date flow. | Produce a canonical futures-contract list with provider attribution and honest derivation. Do not claim a native Upstox chain endpoint, do not compute OI/Greeks, and respect plan/rate limits. **Prerequisite:** WP5I (§7.9) must first import the futures rows; without them neither derivation nor SENSEX FUTIDX verification has data. |

### 4.9 BSE SENSEX and its supported derivatives

Product scope is **SENSEX plus SENSEX futures and options** (`PRODUCT_REQUIREMENTS.md` Â§4.2; `MARKET_DATA_AND_CATALOG.md` Â§1.2). BANKEX derivatives, SENSEX50 derivatives, other BSE stock derivatives and other unsupported BSE derivatives are explicitly **out of scope**; do not broaden the universe merely because a broker supplies additional instruments. This boundary also excludes India VIX derivatives (`FUTIVX`; no `OPTIVX` evidenced), which are not among the six current NSE index derivatives and have zero rows in the 27 Nov 2026 official contract master (accessed 2026-11-28).

**Futures/options asymmetry (official, accessed 2026-11-27):** SENSEX **futures** are **monthly-only** - 3 serial monthly contracts expiring on the last Thursday, cash settled, tick Rs 0.05. The market lot is **20 for November and December 2026 expiries and 25 for January 2027 and subsequent expiries** (BSE notice `20260930-58`, 30 Sep 2026, effective 30 Oct 2026, accessed 2026-11-28; the earlier lot of 20 was set by BSE notice `20241021-13`, 21 Oct 2024). Do not hardcode a single SENSEX lot across expiries. BSE notice `20250617-11` states that no fresh weekly contracts on index futures are introduced from 1 Jul 2025. SENSEX **options** have **7 weekly + 3 monthly + 3 quarterly + 8 semi-annual** contracts (last Thursday of the month / Thursday of the week for weeklies, European, min 101 strikes, 100-point interval). Do not assume weekly SENSEX futures exist or that option-cycle counts apply to futures. The governing framework is SEBI circular `SEBI/HO/MRD/TPD-1/P/CIR/2025/76` (26 May 2025, effective 1 Sep 2025): each exchange uses one expiry weekday (NSE Tuesday per circulars `NSE/FAOP/68589` and `68747`; BSE Thursday per notice `20250617-11`), with one weekly benchmark index option per exchange and all other equity derivatives monthly in the last week. Expiry dates remain source-driven from contract data, never computed from these weekday rules.

The completion audit must prove, per provider: the SENSEX index and SENSEX FUTIDX/OPTIDX contracts exist in the current master; the canonical identity is stable; the Upstox `instrument_key` and FYERS symbol/FY token mappings are exact and separately attributed; expiry, strike, lot/tick and CE/PE are source-driven; and expired SENSEX contracts remain addressable for history. FYERS documents `BSE:SENSEX-INDEX` as a valid futures-chain symbol; Upstox BSE keys and FYERS BSE option-chain availability must be verified from the current master/API rather than assumed. Report per-provider/segment coverage and gaps; do not claim full BSE coverage.

### 4.10 Provider-field disposition (required / canonical / provider-specific)

No documented provider field may be silently discarded. Every field below is classified; fields not promoted to a canonical contract are retained in `providerExtensions` with provenance, never zero-filled or blended.

| Field | Upstox source | FYERS source | Decision |
|---|---|---|---|
| Previous OI | **REST-only:** option chain `market_data.prev_oi`; Full Quotes V3 `previous_oi`. Not present in the V3 proto/feed. | **REST-only:** option chain `prev_oi`; depth `pdoi`; Symbol Master JSON `previousOi` (catalogue-level source) | Product-relevant. Add a typed optional canonical field only through a reviewed shared-contract change; until then retain attributed in `providerExtensions`. Never expect it from a streaming frame. |
| OI change / % | Not documented in the option-chain response | Option chain `oich`/`oichp`; depth `oipercent` | Provider-specific until a canonical field is approved. **Never compute** from previous OI (product forbids calculating missing provider-supplied fields). |
| Close price (per strike) | Option chain `market_data.close_price`; Full Quotes `ohlc.close` | Depth `c` | Distinct from canonical `previousClose` (session close) and from LTP. Keep provider-specific or propose a typed field; do not conflate. |
| Bid/ask quantity | Option chain `bid_qty`/`ask_qty`; Full Quotes `depth[].quantity` | Depth `bids`/`ask` `volume`; option chain supplies bid/ask **price only** | Canonical `depth` owns bid/ask size; map where supplied, leave absent where not supplied. |
| POP (probability of profit) | Option chain `option_greeks.pop` | Not documented | Provider-specific extension; retain attributed. Do not promote to a canonical Greek without a product decision. |
| LTP change / % | Full Quotes `net_change` | Option chain `ltpch`/`ltpchp`; quotes `ch`/`chp` | Canonical `quote.change` / `changePercent` already exist; map where supplied, never compute if absent. |
| Futures price / change | Not a dedicated endpoint; from master + quotes/feed | Option-chain underlying entry `fp`/`fpch`/`fpchp`; futures-chain `lp`/`ch`/`chp` | Provider-specific futures metrics until a canonical futures contract exists; retain attributed. |
| Rho | V3 proto `OptionGreeks.rho`; already mapped (see Â§4.3). **Not in `/v2/option/chain` or `/v3/market-quote/option-greek`.** | Not in documented `greeks=1` set | Optional canonical Greek **from the V3 stream only**; Upstox mapped, FYERS absent/null, REST snapshots null/absent. Verify live stream entitlement. |

---

## 5. Official API research and verified constraints

Official documentation was first checked on **25 November 2026** and re-checked for the quote/depth/futures-chain/field-disposition facts on **27 November 2026** (access date for every URL added in revision 2). The links below are the sources for the provider facts in this plan. Recheck them at the start of implementation because broker docs, subscription tiers and limits can change. Documented limits and coverage are not account-entitlement guarantees.

### 5.1 Upstox

| Topic | Official source | Relevant finding |
|---|---|---|
| API overview and API families | [Upstox API Documentation](https://upstox.com/developer/api-documentation/) | Market-data, historical, option-chain, expired-instrument and realtime feed surfaces are separate APIs. |
| Analytics Token | [Analytics Token](https://upstox.com/developer/api-documentation/analytics-token/) | Long-lived (one-year) read-only token; supports GET APIs in Market Quote, Historical Data, Option Chain, Market Information, Fundamentals, News, IPO and WebSocket categories; no static IP for those categories. One token per account. |
| Live feed | [Market Data Feed V3](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/) | WebSocket with Protobuf payloads, mode-specific fields, connection/subscription caps and redirect handling. Current published normal limits include two connections/user and different limits for LTPC, full and option-Greeks modes. |
| REST quote snapshot | [Full Market Quotes V3](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/) | Snapshot endpoint supports up to 500 instruments in one request and includes additional quote/session fields. It is not a replacement for ongoing WebSocket updates. |
| Active historical candles | [Historical Candle Data V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/) | Canonical active-history source; minute/hour/day/week/month intervals have different availability windows and retrieval limits. Candle rows include OHLC, volume and OI where returned. |
| Active option contracts | [Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/) | Provider-native option-contract discovery for an underlying and optional expiry. |
| Active option chain | [Put/Call Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/) | Per-strike call/put market data and Greeks, including LTP, volume, OI, bid/ask, previous OI and Greek fields. Current endpoint docs exclude MCX. |
| Expired contracts | [Expired Instruments](https://upstox.com/developer/api-documentation/expired-instruments/) and [Expired API launch/entitlement](https://upstox.com/developer/api-documentation/announcements/expired-instruments-api/) | Expiry/expired-contract/history family is distinct; expired-instrument APIs are Upstox Plus gated. Verify account entitlement before promising expired-history coverage. |
| Instrument data | [Instruments](https://upstox.com/developer/api-documentation/instruments/) | Current provider instrument files contain provider-native IDs, instrument type, expiry, strike, lot/tick and segment metadata. |
| V3 feed schema (accessed 2026-11-27) | [MarketDataFeed.proto](https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto) | Authoritative field list: `OptionGreeks` includes `rho = 5`; `MarketFullFeed` carries `oi`, `iv`, `atp`, `vtt`, `tbq`, `tsq`, `marketLevel.bidAskQuote` and `marketOHLC`; `IndexFullFeed` carries only `ltpc` + `marketOHLC` (no depth/Greeks). Confirms the existing Upstox Rho mapping is well founded. **The proto has no previous OI field** - the plan's earlier "feed may expose previous OI" claim is withdrawn. |
| REST Greek surfaces (accessed 2026-11-27) | [Option Greek](https://upstox.com/developer/api-documentation/option-greek/) and [Put/Call Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/) | `/v3/market-quote/option-greek` and `/v2/option/chain` list delta/gamma/theta/vega/IV (chain also has `pop`) - **no Rho on any REST surface**. REST snapshots must leave Rho null/absent. |
| Expired-history intervals (accessed 2026-11-27) | [Expired Historical Candle Data](https://upstox.com/developer/api-documentation/get-expired-historical-candle-data/) | Expired candles accept only `1minute`, `3minute`, `5minute`, `15minute`, `30minute`, `day`; the V3 active 1-300 minute / 1-5 hour / day/week/month set does not apply. Upstox Plus gated. |
| Instrument Search (Beta) (accessed 2026-11-27) | [Instrument Search](https://upstox.com/developer/api-documentation/instrument-search/) | Authenticated `GET /v2/instruments/search`, query <=50 chars, max 30 records/page, documented ambiguity caveats. **Not adopted** by this plan (unverified/optional fallback only); master files + `/v2/option/contract` remain the discovery path. |
| Rate limits (accessed 2026-11-27) | [Rate Limiting](https://upstox.com/developer/api-documentation/rate-limiting/) | Standard APIs 50/s, 500/min, 2000/30min; exceeding returns HTTP 429 code `UDAPI10005`; repeated breaches can temporarily suspend access. Tie retries to the existing shared cooldown owner. |
| Futures chain (accessed 2026-11-27) | [API overview](https://upstox.com/developer/api-documentation/api-overview/) and [Market Quote](https://upstox.com/developer/api-documentation/market-quote) | No dedicated futures-chain REST endpoint is documented. Futures coverage must be derived from the instrument master (`FUTIDX` = index futures, `FUTSTK` = stock futures) plus Full Market Quotes V3 or the streaming feed; report this derivation honestly. **WP5I must import those rows first.** |

**Implementation-specific note:** `packages/broker-upstox/src/stream.ts` contains `UPSTOX_V3_LIMITS` and mode grouping. Reconcile these checked-in values with the current official page before activation. The existing code documents normal limits of two connections per user; LTPC 5,000 individual / 2,000 combined; option-Greeks 3,000 / 2,000; full 2,000 / 1,500; full_d30 50 individual / 1,500 combined. These are published limits, not an account-entitlement guarantee.

### 5.2 FYERS

| Topic | Official source | Relevant finding |
|---|---|---|
| API overview | [FYERS API v3 Docs](https://fyers.in/api-docs/v3/getting-started/) | Distinguishes data WebSockets and market-data REST surfaces from general/order/account APIs. |
| Individual-app authentication | [Authentication Flow](https://fyers.in/api-docs/v3/api/authentication/individual-app/authentication-flow/) | Uses authorization code, random `state`, backend `appIdHash`; access token expires daily at 6:30 AM. The existing project uses a non-trading/data-only app. |
| Token validation and security | [FYERS auth best practices](https://fyers.in/api-docs/v3/api/authentication/individual-app/best-practices/) | Keep app secret and access token private; do not expose app secret in frontend; verify state; renew expired token through the approved flow. |
| Data Socket overview | [Data Socket Overview](https://fyers.in/api-docs/v3/api/websockets/data-socket/overview/) | Single market-data socket family with `sf` symbol, `if` index and `dp` depth messages; subscribe after connection; limits count across connections. |
| Symbol update | [Data Socket Symbol Update](https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-symbol-update/) | Current day quote fields for equity/option symbols; index feed is reduced. |
| Market depth | [Data Socket Market Depth Update](https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-depth-update) | Five-level depth (`dp`); 50-level depth is a separate Tick-by-Tick API and is not part of the normal Data Socket scope. |
| Historical data | [Historical Data API](https://fyers.in/api-docs/v3/api/market-data/historical-data/) | `/data/history`; interval and range parameters; previous completed-minute rule; request windows differ for intraday and daily/weekly/monthly. `oi_flag` includes OI for supported history. |
| Option chain | [Option Chain](https://fyers.in/api-docs/v3/api/market-data/option-chain/) | CE/PE strikes, available expiries, India VIX and per-strike OI/changes/volume/bid/ask; `greeks=1` returns delta/gamma/theta/vega/IV; max 50 strikes per side. |
| Expired F&O | [Expired F&O Data](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/) | Expiry dates â†’ expired contracts â†’ expired candle data. This is separate from active-contract history. |
| Expiry discovery | [Get Expiry Dates](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expiry-dates/) | Expiry dates are provider-discovered within a bounded date range; exchange history start dates differ. |
| Expired candle retrieval | [Get Expired F&O Data](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expired-fo-data) | Supports expired-contract candles and optional OI/Greek fields with segment limitations; monthly timeframe is not yet available per the page inspected. Rows are **`columns`-driven** (map by column name; first six fixed, optional OI/Greeks appended after index 5; Greek values may be `null`; `s=no_data` with empty candles is valid). History start: **NSE 2018-10-10, BSE 2023-08-07, MCX 2018-10-18**. Standard expired intraday is capped at 10 API requests/day. |
| Symbol Master | [Symbol Master File](https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-file/) | Segment-specific CSVs; provider symbols must be used exactly as supplied. Symbol Master JSON contains additional metadata not in the CSV. |
| Market-data REST catalogue | [Market Data APIs](https://fyers.in/api-docs/v3/api/market-data/) | Lists history, quotes, depth, option chain, futures chain and expired F&O endpoints. |
| One-time quotes (accessed 2026-11-27) | [Quotes](https://fyers.in/api-docs/v3/api/market-data/quotes/) | `GET /data/quotes` up to 50 symbols; `POST /data/quotes` up to 50 Standard / 1,000 Prime. Fields include `lp`, `ch`/`chp`, `bid`/`ask`, OHLC, `prev_close_price`, `atp`, `volume`, `tt`, `fyToken`; per-symbol `s` must be checked. No OI in quotes. |
| One-time market depth (accessed 2026-11-27) | [Market Depth](https://fyers.in/api-docs/v3/api/market-data/market-depth/) | `GET /data/depth`, max 1 symbol, `ohlcv_flag=1`; five `bids`/`ask` levels (price, volume, ord), totals, `oi`, `pdoi`, `oipercent`, `ltp`/`ltq`/`ltt`, OHLC and circuit limits. |
| Futures chain (accessed 2026-11-27) | [Futures Chain](https://fyers.in/api-docs/v3/api/market-data/futures-chain/) | `GET /data/futures-chain?symbol=...`; underlying entry plus currently available futures contracts (`symbol`, `fyToken`, `lp`, `ch`, `chp`, `expiry` epoch, `volume`). Documented examples include `BSE:SENSEX-INDEX`. Expired contracts use the expiry-date flow. |
| Option-chain field detail (accessed 2026-11-27) | [Option Chain](https://fyers.in/api-docs/v3/api/market-data/option-chain/) | `strikecount` max 50 per side; `greeks=1` gives delta/gamma/theta/vega/IV only (no Rho); underlying entry carries `fp`/`fpch`/`fpchp`; per strike `ltpch`/`ltpchp`, `oich`/`oichp`, `prev_oi`, `callOi`/`putOi`, `indiavixData`. |
| LTT unit (accessed 2026-11-27) | [Symbol Update](https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-symbol-update/), [Indices Update](https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-indices-update/), [Depth Update](https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-depth-update/) and [Quotes](https://fyers.in/api-docs/v3/api/market-data/quotes/) | Official samples show 10-digit epoch **seconds**: `last_traded_time: 1690953622`, `exch_feed_time: 1690953622`, depth `ltt: 1622184920`, quotes `tt: "1691020800"`. Treat seconds as evidenced; confirm on a live sample before promoting to canonical timestamp. |
| Plans and limits (accessed 2026-11-27) | [Plans & Rate Limits](https://fyers.in/api-docs/v3/getting-started/plans-and-limits/) | Data APIs Standard 5/s, 50/min, 5000/day; error `-429`; user blocked for the rest of the day if a per-minute limit is exceeded more than three times/day. Tie retries to the shared cooldown owner. |
| SEBI retail-algo timing (accessed 2026-11-27) | [Authentication Flow](https://fyers.in/api-docs/v3/api/authentication/individual-app/authentication-flow/) | FYERS auth docs note SEBI retail algo trading regulation changes effective **1 Apr 2026**. Re-verify the existing data-only arrangement before live activation; this is a data-only app, but the note must not be silently assumed away. |

**Published FYERS plan constraints to verify against the actual account:** current Data Socket docs show Standard up to 100 symbols and Prime up to 5,000 symbols per user across connections. The project must not assume Prime. Current history documentation distinguishes Standard and Prime date windows. Rate limits and plan entitlement must be obtained from the current official Plans & Rate Limits page and then verified against actual account responses; the local adapters' cooldown logic must not be treated as proof of account limits.

### 5.3 Provider documentation versus actual account truth

For every provider feature, record four separate statuses:

1. **Documented:** official documentation describes the endpoint or field.
2. **Implemented offline:** an adapter/parser/contract exists and deterministic mocked tests pass.
3. **Account entitlement verified:** the user's configured account can access it under its current plan/token.
4. **Live application verified:** a real request/feed reached MarketHub and the correct canonical/API/UI/persistence output was observed.

**Surface-specific constraints (do not blur across surfaces):** Rho is documented only on the Upstox V3 stream (`OptionGreeks.rho = 5`) and is absent from both Upstox REST Greek surfaces and from FYERS; a REST snapshot must carry null/absent Rho. Previous OI is REST-only (Upstox `previous_oi`/`prev_oi`, FYERS `prev_oi`/`pdoi`/`previousOi`) and is not in the V3 proto. FYERS LTT is evidenced as epoch seconds by official samples but is confirmed-only-on-live-sample before canonical promotion. SENSEX futures are monthly-only while SENSEX options include weeklies. These are documentation facts, not account-entitlement claims.

Never collapse these four statuses into a single â€œsupportedâ€ badge.

### 5.4 Exchange and regulator constraints (accessed 2026-11-28)

The following official sources govern contract facts that this plan consumes as source-attributed metadata. They are documentation facts, not account-entitlement claims, and must be re-checked at preflight.

| Topic | Official source (accessed 2026-11-28) | Relevant finding / plan boundary |
|---|---|---|
| Corporate-action adjustment | [NSE "Adjustments in case of Corporate Actions"](https://www.nseindia.com/static/products-services/equity-derivatives-corporate-actions-adjustments); [NSE circular NCL/CMPT/77593 (TECHM 1:1 bonus, factor 2, ex-date 30 Nov 2026)](https://nsearchives.nseindia.com/content/circulars/CMPT77593.pdf); [BSE notice 20250801-29 (HDFC Bank bonus)](https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20250801-29) | Strike, futures base price, market lot/multiplier and positions are adjusted on the last cum-day after close. Store raw provider values as-is; no adjustment factor computation, no retroactive rewrite, no cross-ex-date splicing. Provider history adjustment is undocumented/inconsistent (Upstox/FYERS candle contracts silent; FYERS forum reply is not an API contract). |
| Stock F&O eligibility | [NSE F&O Stock Introduction and Exclusion Tracker (23-11-2026)](https://nsearchives.nseindia.in//web/mediaattachment/2026-11/FO_Stock_Introduction_and_Exclusion_Tracker_23-11-2026_20261123172526.xlsx); [NSE Selection Criteria](https://www.nseindia.com/products-services/equity-derivatives-selection-criteria); [BSE F&O Underlying Asset List](https://www.bseindia.com/markets/Derivatives/DeriReports/folist); [SEBI 2024/116](https://www.sebi.gov.in/sebi_data/attachdocs/aug-2024/1725027626764.pdf) | NSE 16th-of-month / BSE 15th-of-month PSF on a rolling six-month basis; tracker entries effective through 27 Jan 2027. Eligibility is dynamic and must be re-verified at preflight; a provider master row is not exchange eligibility. |
| Lot/tick change authority | [NSE/FAOP/47854 (2021 75→50)](https://nsearchives.nseindia.com/content/circulars/FAOP47854.pdf); [61415 (2024 50→25)](https://nsearchives.nseindia.com/content/circulars/FAOP61415.pdf); [64625 (2024 25→75)](https://nsearchives.nseindia.com/content/circulars/FAOP64625.pdf); [70616 (2025 75→65)](https://nsearchives.nseindia.com/content/circulars/FAOP70616.pdf); [fo_mktlots.csv](https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv); [BSE notice 20260930-58 (SENSEX 20→25 from Jan 2027)](https://www.bseindia.com/downloads/UploadDocs/Notices/20260930-58/20260930-58.pdf) | Lot/tick are per-expiry contract fields (`MinLot`, `NewBrdLotQty`, `BidIntrvl`), not constants; two lots can coexist. Store with source, effective date and expiry series. |
| Settlement mode | [SEBI 2024/116](https://www.sebi.gov.in/sebi_data/attachdocs/aug-2024/1725027626764.pdf); [SEBI 2018/161](https://www.sebi.gov.in/sebi_data/attachdocs/dec-2018/1546255335099.pdf); [SEBI 2019/28](https://www.sebi.gov.in/sebi_data/attachdocs/feb-2019/1549625911612.pdf); NSE contract master `NSE_FO_contract_27112026.csv.gz` | Index derivatives cash-settled (`SttlmMtd='C'`), single-stock derivatives physically settled (`SttlmMtd='P'`; the 18 `C` FUTSTK rows are `NSETEST` test symbols). Record as metadata only; no settlement/exercise/delivery logic. |
| India VIX derivatives | [NSE press release 26 Feb 2014](https://nsearchives.nseindia.com/content/press/26022014.htm); [NSE F&O Consolidated Circular NSE/FAOP/34596](https://nsearchives.nseindia.com/content/circulars/FAOP34596.pdf); [NSE Products](https://www.nseindia.com/static/products-services/equity-derivatives-products); NSE contract master 27 Nov 2026 | `FUTIVX` existed historically (weekly Tuesday, cash-settled); no `OPTIVX` evidenced; zero VIX rows in the current 83,326-row master. Out of scope; India VIX only as an index/chain metric. |

---

## 6. M4 Stage G â€” production live-stream activation

### 6.1 Objective

Replace the locked production streaming boundary with real provider drivers **only through the approved Stage G gate**, using the already implemented provider stream adapters, one shared subscription coordinator and independent per-provider supervisors.

### 6.2 Stage G work packages

#### Default streaming data bundle (single source of component requirements)

The current subscription contract selects an **instrument**, not individual data components: `SubscriptionSelection` is `{ canonicalId, enabled }` (`packages/contracts/src/live.ts:231-235`) and the driver handoff `DriverSubscription` is `{ canonicalId, nativeIdentifier }` (`apps/api/src/stream-supervisor.ts:17-20`). The supervisor resolves mappings and passes those instrument-level subscriptions to each driver (`stream-supervisor.ts:361-382`). There is no per-component selector in the API, WebUI or MCP, and this programme does **not** introduce one.

Therefore the component requirements that G1/G2 translate into provider feed modes come from **one fixed, provider-neutral default bundle** applied to every selected instrument:

- **quote** — always requested (LTP, previous session close, session OHLC/volume/change where the feed supplies them).
- **depth** — requested where the instrument type and provider support it (L1 or five levels); index instruments carry a reduced quote and no depth.
- **derivatives** — requested only for derivative instruments (options/futures) where the streaming feed actually supplies OI/IV/Greeks. FYERS Data Socket reports derivatives `UNSUPPORTED` (REST-only), so its driver must not request or claim them from the socket.

This default bundle is the **single source** of the "quote/depth/derivatives requirements" referenced in G1 and G2 below. The driver derives the concrete provider request from it (Upstox mode selection; FYERS `sf`/`if`/`dp` subscriptions and the adapter-local `depth?: boolean` flag at `packages/broker-fyers/src/stream.ts:55-60`). Capability results remain honest per provider and instrument type: requesting the default bundle never converts an unsupported component into a supported one. If a future product need genuinely requires per-component selection, it must be a separate shared-contract and WebUI-discovery change (AD-025), not part of this programme.

#### Stage-G pre-activation audit and gate preparation (plan-internal "G0")

> **Naming note (2026-11-27):** this preflight package was originally labelled "G0" inside this plan. In repository documentation "G0" now refers to the **completed and accepted catalog-refresh child-process / write-coordinator programme** (`docs/G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md`, accepted at `08cf605`), which is unrelated to this preflight. Where this plan says "G0" it means this plan-internal Stage-G pre-activation audit only. Do not confuse the two when reading assignments or status docs.

**Purpose:** prove that the existing foundations are ready and identify precise differences between provider stream adapters and the `StreamingDriver` contract.

Work:

- Re-check local branch/HEAD/status and compare the local checkout with the approved `develop` baseline.
- Inspect `StreamingDriver`, `DriverSubscription`, `DriverCallbacks`, `StreamSupervisor`, `SubscriptionCoordinator`, `UpstoxMarketDataStream`, FYERS Data Socket adapter and their SDK seams in the local source.
- Verify the actual installed lockfile versions and package runtime compatibility. Do not upgrade either SDK just because a newer release exists; a version change requires separate evidence and approval.
- Re-fetch current official docs for both feeds, modes, redirects, caps, SDK usage, field shapes and error/close behavior.
- Compare each provider adapter's emitted canonical components with `quoteFieldSchema`, `DepthValue`, `DerivativesValue`, component merge behavior and UI selectors.
- Define a small, owner-selected smoke-test basket: at least one liquid equity, one index, one active option and one active future where both provider mappings exist. Use the same canonical instruments for each-provider comparisons when possible.
- Prepare sanitized test evidence handling; never write raw access tokens, app secrets, full auth headers, redirect query parameters or personal/account data into logs or fixtures.

**Exit criteria:** a reviewed file-level gap list exists; package versions and supported runtime are known; instrument fixtures/mappings exist for the smoke basket; test scenarios are executable; no production driver is unlocked yet.

#### G1 â€” Upstox production driver bridge

**Purpose:** make the existing Upstox stream adapter satisfy the application's `StreamingDriver` lifecycle without moving provider logic into `apps/api`.

Expected work:

- Add a focused driver/factory adapter in `packages/broker-upstox` (exact path to follow current package conventions; do not add a parallel stream service).
- Adapt `start(subscriptions, callbacks, signal)`, `updateSubscriptions(...)`, `stop()` and `getConnectionState()` to the existing `StreamingDriver` contract.
- Resolve each canonical subscription to its current Upstox native `instrument_key` through the existing catalogue/mapping seam; missing mappings must be reported per instrument, not silently dropped.
- Translate the **default data bundle** (Â§6.2) for each selected instrument into valid Upstox feed mode(s) â€” quote always, depth/derivatives only where the instrument type and feed support them; group by mode only where the SDK/API requires it. The bundle, not a UI selector, is the source of these requirements.
- Enforce current mode-specific subscription limits before sending changes; never silently shrink the owner's desired list.
- Ensure the SDK `autoReconnect` behavior does not compete with the Stage F `StreamSupervisor` retry owner. Prefer the existing supervisor as the single reconnect/lifecycle authority; if the SDK requires its own setting, configure it deliberately and test the resulting lifecycle.
- Use the existing protobuf-readiness gate and defensive decoder. Keep SDK internals behind the package seam.
- Deliver decoded `ComponentUpdate`/normalization events to the supervisor callbacks with correct provider/canonical identity, receipt timestamps, source timestamps and provenance.
- Honor `AbortSignal` during connect/start/update and close any partially created SDK/socket resource on cancellation or startup failure.
- Do not place tokens in error messages, URLs, debug payloads or logs.

**Required tests:** driver contract tests with fake SDK streamer; start/update/unsubscribe/stop; abort during connect; connection-state transitions; mode grouping; limit enforcement; partial payload handling; protobuf not ready; malformed frame; close/error/reconnect behavior; stale callback rejection by supervisor epoch/instance guards.

#### G2 â€” FYERS production driver bridge

**Purpose:** connect the existing FYERS Data Socket adapter to the same `StreamingDriver` lifecycle, retaining FYERS details within `packages/broker-fyers`.

Expected work:

- Add or complete a focused driver/factory that implements the exact `StreamingDriver` contract and translates the existing FYERS structural adapter callbacks.
- Resolve canonical IDs to exact FYERS symbols from existing catalogue mappings.
- Translate the **default data bundle** (Â§6.2) into FYERS symbol and depth subscriptions: set the adapter-local `depth?: boolean` from the bundle, not from any UI selector. `sf`, `if` and `dp` are distinct message types and must be parsed separately; derivatives are not requested from the socket.
- Preserve the existing canonical component split: FYERS `sf` can yield a quote plus L1 depth; `if` is reduced index quote; `dp` contains five-level depth.
- Confirm actual Bun compatibility of the pinned official FYERS SDK under the project's Windows/Bun runtime (**Bun 1.4.5** per `package.json:5`, aligned in `3d40441`; this plan's baseline had 1.4.4). Node compatibility or mocked unit tests are not proof of Bun compatibility.
- Check SDK reconnect behavior, callback registration, close semantics and event schema against the supervisor lifecycle. Prevent nested retry loops and duplicate subscriptions.
- Treat FYERS `last_traded_time` as **evidenced epoch seconds** (official samples: `1690953622`, depth `ltt: 1622184920`, quotes `tt: "1691020800"`), but confirm on a live sample before promoting it to a canonical timestamp. Use receipt-time fallback only for genuinely ambiguous frames; do not permanently label the unit `UNKNOWN` or guess milliseconds.
- Preserve safe integer conversion and explicit field-presence semantics; no fabricated zeros for absent fields.
- Honor `AbortSignal`, close resources on partial start failure and redact tokens from all errors/logs.

**Required tests:** same `StreamingDriver` contract suite as Upstox plus FYERS-specific `sf`/`if`/`dp` event mapping, five-level depth, index reduced fields, reconnect resubscribe, subscription update ordering, Bun import/runtime smoke test and cleanup on failure.

#### G3 â€” Production composition wiring (offline; locked boundary retained)

**Purpose:** connect both verified drivers to the existing production composition without changing the shared ownership model. Real-provider verification is deferred to the single coordinated G4 session (Â§8, row 13).

Expected work:

- Prepare the composition to use the two verified driver factories in `apps/api/src/index.ts`, but keep the `LockedProviderDriver` boundary in place until the single coordinated G4 verification is explicitly authorized. **Preserve the G0 catalog-refresh composition added after this plan's baseline** (`index.ts:244` `CatalogWriteOwnership`, `:252` `CatalogWriteCoordinator`, `:269` `CatalogRefreshChildManager`, startup recovery `:502-551`, shutdown drain `:560-618`); do not describe or rebuild the older root as current, and do not drop the ownership/drain ordering.
- Keep exactly one provider runtime/supervisor per provider and the existing single `SubscriptionCoordinator`.
- Do not create separate subscription repositories, `MarketDataService` instances, tracking sets or independent SSE hubs per provider.
- Keep provider authentication and token acquisition inside the existing provider/auth/credential boundaries. Ensure a token can expire/refresh/re-auth without reconstructing unrelated services or leaking its value.
- Keep Upstox and FYERS independently connectable. If one is unconfigured, expired, rate-limited or disconnected, the other must continue streaming.
- Verify same canonical instrument can retain separate observations/components from both providers; selection/provenance must explain which provider/component is selected and why.
- Verify status distinguishes owner-selected, mapped, provider-supported, actually-submitted, provider-confirmed/subscribed, first-observation-received and fresh. â€œConnectedâ€ alone must not mean every instrument is streaming.
- Ensure shutdown stops coordinator/runtimes before shared hub/database close, preserving the existing Stage F order and guarantees. The G0 shutdown drain (`index.ts:560-618`) must also be preserved: `catalogRefresh.stopAndWait()` â†’ `childManager.shutdown()` â†’ ownership release â†’ coordinator/hub/server/DB close; an UNKNOWN permit is not released.

**Required scenarios:** both connected; Upstox only; FYERS only; neither; one provider fails during subscription update; one disconnects while the other streams; one token expires; unsupported symbol mapping for one provider while the other succeeds; per-provider capacity exceeded; rapid desired-generation changes; stale callbacks from retired drivers; clean shutdown and restart.

#### G4 â€” ONE coordinated real-provider verification and Stage G closeout

This is a **single, separate, explicitly authorized** production operation. It is performed only after both streaming bridges and every REST data path are complete, independently reviewed and fully tested offline. There is **no streaming-only live test followed by a later REST exercise**. The implementation agent must not perform real provider authentication, open real sockets or transmit real user credentials merely because this plan exists.

After the complete integration passes offline review and the owner explicitly authorizes Stage G activation:

> **Contention note:** credential/subscription writes used below fail fast with HTTP 503 `CATALOG_WRITE_BUSY` during a catalog refresh. Treat it as a transient, retryable lock (authoritative scenario in Â§10.1 and Â§13), not a provider/auth failure, and preserve the G0 ownership/drain ordering in the composition root (Â§6.3).

1. Configure approved read-only/data-only provider credentials through the existing local credential UI/flow. Do not paste credentials into chat, task files, logs or fixtures.
2. Start with the small approved smoke basket, not the whole catalogue: at least one liquid equity, one index, one active option, one active future and a BSE SENSEX derivative where the mapping exists.
3. In **one coordinated verification session**, verify each provider independently and then simultaneously for streaming, and exercise one-time quote/depth, historical candles, option-chain and futures-chain retrieval for both providers over the same canonical instruments. Do not split this into a streaming-only test plus a later REST exercise.
4. Record sanitized provider connection state, subscribed native-symbol count, canonical instrument IDs, mode/capabilities, message types, field presence, source/receipt timestamps and error/limit outcomes.
5. Compare a small set of actual quote/depth values with the same provider's documented response or provider UI as an evidence check; do not assert exact equality across providers because update times and feeds can differ.
6. Capture sanitized response fixtures (remove tokens, account identifiers, personal values and signed URLs) and add deterministic regression tests.
7. Verify reconnect, provider isolation, capacity, partial updates, shutdown/restart, and request-time credential retrieval after token rotation (Â§7.2.1).
8. Complete independent code review before changing the production locked boundary. If any acceptance condition fails, retain the safe locked/unavailable behavior and report the blocker.

**Stage G acceptance:** both configured provider runtimes have independently demonstrated real connection and subscription behavior; canonical data reaches MarketDataService and REST/SSE/WebUI; simultaneous operation works; the one-time quote/depth, historical, option-chain and futures-chain paths have been exercised in the same coordinated verification; field gaps and entitlement restrictions are documented; no hidden downgrade or cross-provider contamination exists; all offline and live acceptance evidence is recorded; independent review is clean.

---

## 7. M5 Phase 4B â€” real provider-backed history and option-chain activation

### 7.1 Objective

Wire the already implemented Upstox and FYERS historical/option-chain adapters into the existing `HistoricalCandleService` and `OptionChainSnapshotService`, then verify real broker responses and persistence. Do not create alternative REST services or bypass canonical repositories.

### 7.2 Current blocking composition gap

The inspected `apps/api/src/index.ts` (at this plan's `28a2f34` baseline) created:

```ts
const historicalService = new HistoricalCandleService({
  candles: candleRepo, settings: appSettings, providers: []
});
const snapshotService = new OptionChainSnapshotService({
  snapshots: snapshotRepo, settings: appSettings, providers: []
});
```

> **Updated composition (2026-11-27):** at current HEAD `3c34fba` the same block also threads the G0 write guard (`index.ts:411-420`):
> ```ts
> const appSettings = new AppSettings(db.db, writeCoordinator ?? undefined);
> const candleRepo = new CandleRepository(db.db, db.sqlite, writeCoordinator ?? undefined);
> const snapshotRepo = new SnapshotRepository(db.db, db.sqlite, writeCoordinator ?? undefined);
> const historicalService = new HistoricalCandleService({
>   candles: candleRepo, settings: appSettings, providers: [], writeGuard: writeCoordinator ?? undefined
> });
> const snapshotService = new OptionChainSnapshotService({
>   snapshots: snapshotRepo, settings: appSettings, providers: [], writeGuard: writeCoordinator ?? undefined
> });
> ```
> `HistoricalCandleService.runSync` and `OptionChainSnapshotService.captureScheduled` skip with `{ skipped: true, reason: "CATALOG_WRITE_BUSY", retryable: true }` when the refresh owns the permit (`historical/service.ts:173`, `snapshots/service.ts:139`), and `CandleRepository.upsertCandles` / `SnapshotRepository.putSnapshot` call `assertWritable("I")` before their write transactions (`candles.ts:52`, `snapshots.ts:90`). WP5E must preserve this guard wiring.

The adapter classes exist, but the service provider lists are empty. Provider-backed runtime wiring and live REST verification are therefore the core M5 Phase 4B gap.

### 7.2.1 Credential acquisition at request time (applies to WP5Aâ€“WP5D and WP5Fâ€“WP5I)

The REST adapters currently receive a **fixed string** at construction: `UpstoxHistoricalOptions.token` / `UpstoxOptionChainOptions.token` (`packages/broker-upstox/src/historical.ts:12-18`, `option-chain.ts:11-16`) and `FyersHistoricalOptions.token` / `FyersOptionChainOptions.token` (`packages/broker-fyers/src/historical.ts:16-24`, `option-chain.ts:16-23`, `runtime.ts:6-12`). A long-lived adapter would keep sending a token that has since been rotated or expired.

**Decision:** each adapter must obtain the **current credential safely at request time**, mirroring the stream adapters, which already call `credentials.get(...)` at start (`packages/broker-upstox/src/stream.ts:324`, `packages/broker-fyers/src/stream.ts:574`). Concretely, inject a credential lookup seam (`CredentialStore` plus the provider credential name) or an async `tokenProvider` that reads the store for every request; do not freeze a token string in the constructor. If no current credential exists, fail closed with an explicit auth-needed/expired state; never place the value in logs, errors, URLs or fixtures.

**FYERS constraints are preserved:** the credential is `app_id:access_token` and expires daily at 06:30 IST (`packages/broker-fyers/src/index.ts:47-53`, `nextIstExpiry`; official best practices accessed 2026-11-27 list error codes -8/-15/-16/-17 for expired/invalid tokens). The FYERS SDK `fyersDataSocket.getInstance(token, logPath, logging)` is a **process-wide singleton with single-slot listeners**, and `close()` does not detach them, so every adapter instance re-registers all four events and relies on a generation guard (`packages/broker-fyers/src/stream.ts:45-52`, `:463-505`). SDK-side `autoreconnect()` is deliberately not exposed; the Stage F supervisor remains the single retry owner with a fresh instance. Token rotation must not reconstruct unrelated services or leak the value; re-authentication follows the existing approved WebUI-owned flow.

**Explicit retire-and-recreate rule on credential rotation (required):** a rotated FYERS token must never be handed to the existing singleton, and a stale token must never remain subscribed. On detecting rotation/expiry (including the daily 06:30 IST boundary or error codes -8/-15/-16/-17): (1) bump the driver generation so callbacks from the old instance are rejected; (2) retire and `close()` the old driver/socket and treat its single-slot listeners as orphaned - do not assume `close()` detached them; (3) create a **fresh** singleton with the new `app_id:access_token` and re-register all four event listeners on that new instance; (4) let the Stage F `StreamSupervisor` own reconnection/retry with the fresh generation - no SDK-side `autoreconnect()` and no second retry loop. REST adapters independently re-read the credential at request time (above), so a rotated token is picked up without reconstructing unrelated services. Required tests: rotation while connected, stale-callback rejection by generation, no orphaned listeners, no reuse of the old token, and provider isolation (Upstox unaffected).

### 7.3 WP5A â€” Upstox historical provider activation

Expected work:

- Construct the existing `UpstoxHistoricalAdapter` through the current composition boundary and pass it to `HistoricalCandleService` as the Upstox provider.
- Obtain the current Analytics Token through the existing encrypted credential/provider adapter boundary **at request time** (Â§7.2.1); do not freeze a token string in the adapter constructor.
- Resolve the canonical ID to the exact Upstox active `instrument_key`; for expired history resolve a provider-issued `expired_instrument_key` from the expired-contract API flow.
- Preserve the existing interval mapper, retrieval window validation, retry/throttle behavior, parsing and provenance.
- Test active-history V3 response shapes for every supported canonical interval class.
- Separately test expired history only where the actual account has Upstox Plus; otherwise return a clear entitlement/unavailable state. For expired candles, restrict intervals to `1minute`, `3minute`, `5minute`, `15minute`, `30minute`, `day` - do not reuse the V3 active 1-300 minute / 1-5 hour / day/week/month set.
- Verify candles are stored via the existing `CandleRepository`, with existing first-write-wins and conflict notes intact.

**Real acceptance:** at least one liquid equity and one active F&O contract, where supported, return real candles; OHLC/timestamp/volume/OI parse correctly; cached reads survive restart; repeated fetches do not duplicate or overwrite existing candles; provider/receipt provenance is correct. Include a catalog-refresh contention scenario: a fetch attempted while a refresh owns the write permit returns HTTP 503 `CATALOG_WRITE_BUSY` (or a background `skipped: true` result) and succeeds on retry after the refresh completes â€” it must not be recorded as a provider failure.

### 7.4 WP5B â€” FYERS historical provider activation

Expected work:

- Construct the existing `FyersHistoricalAdapter` and register it with the same `HistoricalCandleService`.
- Obtain the current `app_id:access_token` through the encrypted credential boundary **at request time** (Â§7.2.1); handle daily 6:30 AM token expiry honestly and require the existing approved re-authentication path. Preserve the FYERS SDK singleton/token-rotation constraints.
- Resolve exact FYERS symbols from current Symbol Master/catalogue mappings. Do not synthesize symbols from canonical display names.
- Preserve canonical-to-FYERS interval mapping, `date_format`, `range_from`/`range_to`, `oi_flag`, `cont_flag`, supported resolution differences, chunking, cooldown and error classification.
- Verify regular history and expired F&O history as separate flows. For expired F&O, use the provider's expiry-date â†’ expired-contract â†’ expired-data sequence; respect Standard/Prime and segment/date restrictions. Parse expired rows **`columns`-driven** (map by column name; first six fixed, optional OI/Greeks appended after index 5; Greek values may be `null`; `s=no_data` with empty candles is a valid empty result). Do not positional-map rows. BSE expired history starts **2023-08-07** (NSE 2018-10-10, MCX 2018-10-18); Standard expired intraday is capped at **10 API requests/day**.
- Ensure the FYERS shared REST cooldown/account-block state is shared between the FYERS history and option-chain adapters as intended by the current cooldown design. Do not create independent instances that accidentally bypass an account-level or category-level block.
- Persist candles through the existing repository only after validation.

**Real acceptance:** at least one liquid equity and one supported active F&O contract return real historical candles; OI is present only where actually supplied; all supported intervals/window limits are tested; expired paths are verified only if entitlement permits; history survives restart and respects no-data/permanent-unavailability semantics. Include a catalog-refresh contention scenario: a fetch during a refresh returns HTTP 503 `CATALOG_WRITE_BUSY` (or background `skipped: true`) and succeeds on retry after the refresh completes â€” never misreported as a provider failure.

### 7.5 WP5C â€” Upstox option-chain activation

Expected work:

- Construct existing `UpstoxOptionChainAdapter` and register it with `OptionChainSnapshotService`.
- Obtain the current Analytics Token through the credential boundary **at request time** (Â§7.2.1).
- Resolve underlying `instrument_key` and expiry from provider contract/expiry metadata. Do not guess the option expiry from calendar rules or construct provider symbols manually.
- Preserve the adapter's response parsing for `call_options`, `put_options`, `market_data` and `option_greeks`.
- Verify LTP, close, volume, OI, bid/ask prices and quantities, previous OI and Greek values, including null/missing cases.
- Confirm actual segment availability; the currently documented Upstox Put/Call Option Chain endpoint excludes MCX.
- Verify the response expiry and underlying match the exact owner-selected request before storing a snapshot.
- Persist through the existing `SnapshotRepository` and the existing capture-config/provider-selection behavior; manual on-demand retrieval must not change capture settings.

**Real acceptance:** at least one supported underlying and active expiry returns a real CE/PE chain; returned strikes and field values parse; Greeks are neither invented nor zero-filled; persisted snapshot is readable after restart and retains provider/expiry/capture time provenance. Include a catalog-refresh contention scenario: a capture during a refresh returns HTTP 503 `CATALOG_WRITE_BUSY` (or background `skipped: true`) and succeeds on retry after the refresh completes â€” never misreported as a provider failure.

### 7.6 WP5D â€” FYERS option-chain activation

Expected work:

- Construct existing `FyersOptionChainAdapter` and register it with `OptionChainSnapshotService`.
- Obtain a valid current `app_id:access_token` through the encrypted credential boundary **at request time** (Â§7.2.1).
- Resolve the exact FYERS underlying symbol from Symbol Master.
- Preserve the two-step discovery/selection flow: discover `expiryData`, match exact requested expiry, then submit its documented epoch as the `timestamp` selector. Do not infer expiry from array position or misuse `expiry_flag`.
- Verify `strikecount` bounds (maximum 50 per side), `greeks=1`, underlying entry, India VIX, aggregate call/put OI and per-strike `ltp`, `bid`, `ask`, `oi`, `oich`, `oichp`, `prev_oi`, volume and Greeks.
- Preserve null/missing Greek values and reject malformed/ambiguous expiry metadata.
- Reuse the intended shared FYERS REST cooldown/account-block instance across historical and option-chain adapters.
- Persist with the existing snapshot repository and ensure `provider` is explicit and matches the selected source.

**Real acceptance:** at least one supported underlying and exact active expiry produces a real chain; the selected expiry is proven by the request; all returned contract/metric fields are correct; unavailable fields remain unavailable; a persisted snapshot survives restart. Include a catalog-refresh contention scenario: a capture during a refresh returns HTTP 503 `CATALOG_WRITE_BUSY` (or background `skipped: true`) and succeeds on retry after the refresh completes â€” never misreported as a provider failure.

### 7.7 WP5E â€” M5 application and MCP/REST/WebUI integration

Expected work:

- Keep one `HistoricalCandleService` and one `OptionChainSnapshotService` composed at application startup and shared with REST and MCP, as currently designed. **Thread the G0 `writeGuard` (`writeCoordinator ?? undefined`) into both services and their repositories** (`index.ts:411-420`); account for background `skipped: true` cycles and preserve the G0 ownership/drain ordering in the composition root (`index.ts:244,252,269,502-551,560-618`). Do not rebuild the older root as current.
- Register both providers without introducing duplicate service instances or duplicate request logic in routes/tools.
- Keep explicit provider preference/selection behavior from the accepted WP6B decision. No FYERS default, no hidden â€œAutomaticâ€ option and no silent provider switch.
- Preserve the local-owner boundary for configuration writes and manual capture actions.
- Keep MCP on-demand requests read-only with respect to operational capture/schedule configuration.
- Ensure the WebUI accurately reports no provider, missing credentials, expired credentials, unsupported field, entitlement failure, cooldown, no data, stale data and stored historical/snapshot coverage.
- Verify API, WebUI and MCP see the same canonical persisted records and provider attribution.
- Cover the one-time quote/depth, futures-catalogue import, futures-chain and BSE SENSEX paths from WP5Fâ€“WP5I through the same shared services/contracts; do not add route-local or UI-local provider parsing.

### 7.8 WP5F â€” One-time (on-demand) quote and market depth

Expected work:

- Add read-only on-demand quote/depth retrieval for both providers using the official endpoints in Â§4.7: Upstox `GET /v3/market-quote/quotes` (â‰¤500 keys, includes top-5 depth); FYERS `GET /data/quotes` (â‰¤50 symbols) / `POST /data/quotes` (â‰¤50 Standard, 1,000 Prime) and `GET /data/depth` (max 1 symbol, `ohlcv_flag=1`, five levels plus `oi`/`pdoi`/`oipercent`).
- Obtain the current credential at request time (Â§7.2.1); batch within documented limits; check every per-symbol status; surface `s=error`/no-data honestly.
- Map to canonical `quote`/`depth` components with `provider-rest` provenance and receipt time. Do not persist per-tick data, do not mutate streaming selections or snapshot-capture config, and keep MCP on-demand reads read-only with respect to operational settings.
- Preserve absent fields (especially index volume/depth and FYERS quote OI); never synthesize values or claim a REST snapshot is a streaming update.

**Required tests:** batch boundary (500/50/1,000/1), per-symbol error and no-data handling, depth level counts and field presence, index reduced fields, request-time credential retrieval and rotation, token redaction, no operational-config mutation, catalog-refresh 503 retry.

**Real acceptance:** one-time quote and depth for an instrument **not** in the streaming selections return real values through REST/WebUI/MCP with correct provenance and no selection change; documented limits and errors are surfaced truthfully.

### 7.9 WP5I â€” Futures catalogue import (prerequisite for WP5G/WP5H)

**Why this package exists (blocking dependency):** the current master importers import options only. `packages/market-core/src/sync/upstox-master.ts:146-160` accepts CE/PE options and skips non-CE/PE rows at `:150`, so `FUTIDX` (**index futures**) and `FUTSTK` (**stock futures**) never enter the catalogue. `packages/market-core/src/sync/fyers-master.ts:144-156` accepts only `optType === "CE" | "PE"` and skips futures (`optType === "XX"`) at `:155`. WP5G's Upstox chain derivation and WP5H's SENSEX `FUTIDX` verification therefore have no canonical futures instruments to resolve. This package must complete before either of them can meet real acceptance.

Expected work:

- Extend the Upstox BOD import to retain `FUTIDX` (index futures) and `FUTSTK` (stock futures) rows for the supported underlyings (the six NSE index underlyings and BSE SENSEX; stock futures only where the underlying is in the product universe). Keep the existing option/cash paths and first-write-wins behavior unchanged.
- Extend the FYERS Symbol Master import to retain `optType === "XX"` futures rows for the same supported underlyings, including `BSE_FO` SENSEX futures. Preserve the existing `tradeStatus`/`lastUpdate` freshness handling.
- Record canonical identity and exact provider mappings for each futures row: Upstox `instrument_key` (stable), `exchange_token` (may be reused after expiry), `trading_symbol`; FYERS `fyToken`, `underFyTok`, `symTicker`, `exToken`. Keep provider identity fixed `UPSTOX`/`FYERS` and separately attributed; no "Automatic" option and no FYERS default.
- Keep expiry, strike, lot size, tick size, segment and instrument type **source-driven** from the master rows. Never compute an expiry from weekday rules or synthesize a strike/lot. SENSEX futures are monthly-only (3 serial monthly, last Thursday); do not expect weekly SENSEX futures rows. Record the source circular/file and effective date for each lot and tick value; preserve expiry-series distinctions (for example SENSEX 20 for Nov–Dec 2026 vs 25 from Jan 2027) rather than collapsing them to one current value.
- Fail closed on invalid/ambiguous rows: missing exchange or native key, unresolvable underlying, malformed expiry/lot/tick, duplicate canonical identity, or partial refresh must be reported per row and must never destroy the last known-good catalogue. Do not claim full exchange coverage.
- Publish a per-provider/segment futures coverage report (counts, gaps, skipped-out-of-scope reasons) and feed it into the §9 catalogue coverage work package.

**Required tests:** master filtering for `FUTIDX`/`FUTSTK` and FYERS `XX`; exact canonical/native mapping assertions; source-driven expiry/strike/lot/tick; SENSEX monthly-only scope enforcement; invalid/duplicate/partial-refresh fail-closed behavior; no regression to existing CE/PE option import counts; token redaction; catalog-refresh 503 retry.

**Real acceptance:** futures rows for at least one index future and one stock future from each provider master are imported with exact identity/mapping and source-driven contract metadata; SENSEX `FUTIDX` rows are present where the provider supplies them; gaps are reported honestly. This is the prerequisite for WP5G and WP5H - if it fails, those packages are marked NOT AVAILABLE rather than passed with derived data.

### 7.10 WP5G â€” Futures-chain data

Expected work:

- FYERS: call `GET /data/futures-chain?symbol=...` for supported underlyings, including the documented `BSE:SENSEX-INDEX` example; parse the underlying entry (empty `expiry`) and each contract (`symbol`, `fyToken`, `lp`, `ch`, `chp`, `expiry` epoch, `volume`).
- Upstox: derive the chain from the provider instrument master (`FUTIDX` index futures / `FUTSTK` stock futures) **imported by WP5I (§7.9)** and obtain live fields via Full Market Quotes V3 or the streaming feed. Label the derivation explicitly; do not claim a native Upstox futures-chain endpoint. If WP5I has not imported futures rows, report NOT AVAILABLE rather than deriving from options.
- Produce a canonical futures-contract list with provider attribution; do not compute OI/Greeks; respect plan/rate limits; route expired contracts through the expiry-date flow.

**Required tests:** master filtering by instrument type, derivation path, epoch conversion, missing/invalid symbol, plan-limit handling, no fabricated fields, token redaction.

**Real acceptance:** a futures chain for at least one index and one stock underlying (and SENSEX where mapped) returns real contracts with honest derivation and attribution.

### 7.11 WP5H â€” BSE SENSEX and supported derivatives coverage

Expected work:

- Verify SENSEX index and SENSEX FUTIDX/OPTIDX rows in both provider masters (**FUTIDX rows depend on WP5I, §7.9**); confirm exact canonical identity and Upstox `instrument_key` / FYERS symbol/FY-token mappings; keep expiry, strike, lot/tick and CE/PE source-driven; keep expired SENSEX contracts addressable for history. Enforce the monthly-only SENSEX futures cycle (3 serial monthly, last Thursday; no weekly index futures) against the 7-weekly + 3-monthly + 3-quarterly + 8-semi-annual SENSEX option cycle.
- Confirm FYERS `BSE:SENSEX-INDEX` futures-chain support; verify Upstox BSE keys and FYERS BSE option-chain availability from current master/API rather than assuming them.
- Enforce the product boundary: BANKEX derivatives, SENSEX50 derivatives, other BSE stock derivatives and other unsupported BSE derivatives stay out of scope even if a broker supplies them.
- Publish a per-provider/segment coverage report with gaps; do not claim full BSE coverage.

**Required tests:** exact mapping assertions, scope-filter enforcement (no broadening), expiry discovery, missing/ambiguous mapping handling.

**Real acceptance:** SENSEX and at least one SENSEX derivative path are verified where the provider actually supports them; out-of-scope instruments are not silently included; gaps are reported.

---

## 8. Implementation sequence and dependencies

The sequence is deliberately **build both providers first, connect every data path, test everything offline, then verify once against real providers**. Do not give an agent a single broad instruction to â€œfinish all provider integrationâ€ without package-level acceptance gates, and do not perform a streaming-only live test followed by a later REST exercise.

| Order | Work package | Main output | Dependency / gate |
|---:|---|---|---|
| 0 | **Preflight and evidence refresh** | Exact current local baseline, updated official API/SDK facts, field/mapping gap list, smoke-basket fixtures and sanitized evidence process | No code changes. Must precede implementation. |
| 1 | **G1 Upstox driver bridge** | Production-compatible Upstox `StreamingDriver` implementation using existing adapter and the default bundle (Â§6.2) | Existing M4 Stage B; deterministic driver tests pass. Production lock remains in place. |
| 2 | **G2 FYERS driver bridge** | Production-compatible FYERS `StreamingDriver` implementation using existing adapter and the default bundle | Existing M4 Stage C; Bun SDK compatibility and deterministic tests pass. Production lock remains in place. |
| 3 | **G3 production composition wiring** | Both drivers wired to the existing coordinator/supervisors; G0 ownership/drain ordering preserved | Offline only; locked boundary retained until row 13. |
| 4 | **WP5A Upstox history** | Upstox historical provider wired to the shared M5 service; request-time credential retrieval | Rows 1â€“3 complete; deterministic offline tests pass. |
| 5 | **WP5B FYERS history** | FYERS historical provider wired; request-time credential retrieval; shared cooldown preserved | Rows 1â€“3 complete; deterministic offline tests pass. |
| 6 | **WP5C Upstox option chain** | Upstox option-chain provider wired; field disposition per Â§4.10 | Rows 1â€“3 complete; deterministic offline tests pass. |
| 7 | **WP5D FYERS option chain** | FYERS option-chain provider wired; exact expiry selection; shared cooldown preserved | Rows 1â€“3 complete; deterministic offline tests pass. |
| 8 | **WP5F one-time quote/depth** | On-demand quote/depth for non-subscribed instruments through shared contracts | Rows 1â€“3 complete; deterministic offline tests pass. |
| 9 | **WP5I futures catalogue import** | `FUTIDX`/`FUTSTK` (index/stock futures) and FYERS `XX` futures rows imported with canonical identity, exact expiry/strike/lot/tick and fail-closed validation | Rows 1â€“3 complete; deterministic offline tests pass. **Must precede rows 10 and 11.** |
| 10 | **WP5G futures chain** | Futures-chain data for supported underlyings, with honest Upstox derivation | Row 9 complete (futures rows exist in the catalogue); rows 1â€“3 complete; deterministic offline tests pass. |
| 11 | **WP5H BSE SENSEX coverage** | Verified SENSEX/SENSEX-derivative mappings and scope enforcement, including monthly-only SENSEX futures | Row 9 complete for SENSEX FUTIDX; rows 1â€“3 complete; deterministic offline tests pass. |
| 12 | **WP5E catalogue, API/UI/MCP parity and M5 closeout** | Proven mappings, accurate availability, storage/restart evidence, coverage report | Rows 4â€“11 and catalogue gap analysis complete; all paths tested offline. |
| 13 | **G4 ONE coordinated real-provider verification** | Both providers and all supported data types verified in a single authorized session; canonical component evidence; safe reconnect and status | Separate explicit Stage G authorization; independent review before locked-boundary change. |
| 14 | **Final data integration acceptance** | Signed-off coverage matrix; no unverified item mislabeled supported; WebUI/API/MCP parity confirmed; M4/M5 statuses reconciled | Full regression, end-to-end verification and independent review. |

**Why this order:** build and review both streaming integrations first, then import the futures catalogue (row 9) before attempting futures-chain derivation or SENSEX futures verification (rows 10-11), and connect every quote/depth/history/option-chain/futures-chain path. Test all of them offline so failures can be attributed to the correct SDK, credentials, mapping or feed. Only when the complete integration is ready and reviewed is **one** coordinated real-provider verification performed across both providers and all supported data types. The shared coordinator already exists to support simultaneous operation; do not simplify the test by bypassing it.

> **Post-baseline note (2026-11-27):** the completed G0 catalog-refresh programme is a prerequisite already satisfied at HEAD `049fe841` â€” its write-coordinator/503 contract and composition-root ordering (Â§6.3, Â§7.7) must be preserved by every row above. No work package is invalidated; rows 3â€“13 need 503-retry-aware verification.

---

## 9. Data catalogue and coverage work package

This is not a request to rebuild the catalogue wholesale. It is a bounded verification and gap-closure task based on the existing master-file ingestion.

### Required work

1. Define the product's initial supported exchange/segment universe from existing requirements (do not invent a new universe in the provider adapter task). For stock underlyings, record the exchange eligibility source and effective date from the pinned NSE tracker / BSE F&O underlying list; do not infer eligibility from provider master rows alone.
2. Compare each provider master source with that universe and report record counts by exchange/segment/instrument type.
3. Identify duplicate, missing, stale and ambiguous provider mappings.
4. Verify exact native mapping for the Stage G smoke basket.
5. Verify underlying-to-option-contract, expiry, strike, lot size and tick size relationships for active derivatives, and the underlying-to-futures-contract relationships imported by WP5I (`FUTIDX` index futures / `FUTSTK` stock futures, FYERS `XX`). Confirm futures rows are present before WP5G/WP5H are accepted.
6. Confirm expiry discovery uses the source/provider identity and freshness already represented by the WP4 metadata work.
7. Confirm refresh failures preserve last known-good data and do not make a partial file appear complete.
8. Determine which missing products are genuinely unavailable from a provider versus merely absent from current import filters. Futures were absent from the filters, not from the providers (§4.6, WP5I); Upstox Instrument Search (Beta) is an unverified/optional fallback and is not adopted as a discovery source.

### Acceptance

- A generated, reviewable coverage report lists counts and gaps by provider/segment/type.
- Each smoke-basket canonical item maps to the expected native identifier for the relevant provider, or has an explicit reason why it does not.
- No duplicate canonical instrument is silently created for one exchange instrument.
- No stale/ambiguous mapping is used to open a live subscription or fetch history.
- The plan does not claim complete exchange coverage unless a reconciled authoritative universe proves it.

---

## 10. Testing, evidence and acceptance matrix

### 10.1 Offline tests (must pass before live activation)

| Test group | Required scenarios |
|---|---|
| Provider adapters | SDK/fetch seams, decoding, schema validation, timestamp conversion, malformed frames/responses, safe integer handling, token redaction. |
| Driver lifecycle | Start, update, unsubscribe, stop, abort, partial start failure, connection state, no double close, no nested reconnect. |
| Subscription coordinator | One desired generation owner; same instrument on two providers; mapping failure isolated; capacity error does not silently remove user selections; generation race; stale callback ignored. |
| Canonical data merge | `sf`/`if`/`dp` partial messages; quote/depth split; omitted fields preserved; explicit clear only when provider says clear; equal/untrusted timestamps do not discard valid updates. |
| Live delivery | Service revisions, snapshot/SSE refresh, multi-client behavior, reconnect/replay, bounded buffers and drop behavior. |
| Historical adapters | Every supported interval mapping; chunk boundaries; malformed candle rows; empty/no-data; OI null; date-range limits; rate-limit cooldown; provenance. |
| Option-chain adapters | Exact expiry selection; duplicate/missing expiry metadata; strike bounds; CE/PE shape; nullable Greeks; provider errors/cooldown. |
| Persistence | Fresh migration and upgrade; candle insert/idempotency/first-write-wins/conflict; snapshot save/read/restart; retention remains fail-closed. |
| API/UI/MCP | Same service instances and data; explicit provider selection; local-owner checks; honest empty/stale/unavailable status; MCP on-demand does not mutate config. |
| Security | No credential leakage in logs, diagnostics, fixtures, errors, exported status, URLs or test snapshots. |
| Default data bundle | Every selected instrument yields quote always, depth/derivatives only where the instrument type and provider support them; index reduced fields; no per-component UI selector; capability results stay honest. |
| One-time quote/depth | Batch limits (Upstox 500; FYERS 50/1,000 and depth 1), per-symbol status, depth level counts, no operational-config mutation, no per-tick persistence. |
| Futures catalogue import (WP5I) | Upstox `FUTIDX`/`FUTSTK` and FYERS `XX` rows retained; exact canonical/native identity and source-driven expiry/strike/lot/tick; SENSEX monthly-only scope; invalid/duplicate/partial-refresh fail-closed; no regression to CE/PE option import. |
| Futures chain | FYERS chain parsing including `BSE:SENSEX-INDEX`; Upstox master derivation explicitly labelled and dependent on WP5I rows; epoch conversion; no computed OI/Greeks; NOT AVAILABLE when futures rows are absent. |
| BSE SENSEX scope | Exact SENSEX/SENSEX-derivative mappings; monthly-only futures vs weekly/monthly/quarterly/semi-annual options; BANKEX, SENSEX50 and other BSE derivatives excluded; gaps reported. |
| Request-time credentials | Current credential fetched per request by every REST adapter; rotation/expiry handled; FYERS retire-and-recreate generation rule (bump generation, close old socket, fresh singleton, re-register listeners, supervisor owns retries); no stale token, orphaned listener, or token in logs/errors/fixtures. |
| Timestamp units | Upstox LTT mapping; FYERS LTT treated as evidenced epoch seconds with live confirmation before canonical promotion; receipt-time fallback only for ambiguous frames; no guessed milliseconds. |
| REST field absence | Rho null/absent on REST snapshots (stream-only); previous OI REST-only and never expected from a streaming frame. |
| Catalog-write contention (G0) | Interactive write returns 503 `CATALOG_WRITE_BUSY` while refresh owns the permit; background sync/capture returns `skipped: true, retryable: true`; no partial write; retry after refresh succeeds; ownership/drain ordering preserved. |

### 10.2 Real-provider verification (separate from mocks)

This is **one coordinated verification** (G4, row 13 of Â§8) covering both providers and all supported data types in a single authorized session. It happens only after every path is complete, reviewed and passing offline. Do not record a streaming-only live pass and treat the REST paths as a later, separate exercise.

For each provider record:

- Provider and account entitlement (never record credentials or full account identifiers).
- Date/time, market session and instrument category.
- Native identifier source and canonical ID.
- Requested API/feed mode or REST endpoint and parameters (redacted).
- Actual sanitized response/frame type and field presence.
- Expected canonical component and observed canonical output.
- Timestamp raw value/unit/meaning/trust, receipt time and freshness outcome.
- Subscription count/request window and limit result.
- Status/error code and retry/cooldown/re-auth result.
- Fixture reference and test that replays the sanitized sample.
- Pass/fail/blocked reason and remaining unverified scope.

Do not put tokens, cookies, auth codes, app secrets, `Authorization` headers, signed redirect query strings, personal account profile data or full account identifiers into the report. Sanitized provider fixtures must be reproducible without secrets.

### 10.3 End-to-end acceptance scenarios

**Streaming**

- Upstox alone: real connection, one equity, one index and one supported F&O instrument; received quote and supported depth reach `MarketDataService`, REST/SSE and WebUI.
- FYERS alone: same categories where mapping/capability is supported; correct `sf`/`if`/`dp` separation.
- Both together: same canonical instrument observed from both; component source/selection/provenance is correct; no subscription coordinator conflict.
- Disconnect one provider: the other continues; recovery/resubscription does not duplicate subscriptions or lose the shared desired generation.
- Invalid/expired token: explicit auth-needed state, no retry storm, other provider unaffected.
- Unsupported field/depth or exceeded plan limit: truthful `LIMITED`/`UNSUPPORTED` state, no silent downgrade.

**Historical**

- Fetch one active equity and one supported F&O instrument from each provider.
- Verify candle interval, timestamp, OHLC, nullable volume/OI, provider and received time.
- Request a range beyond the documented limit and verify deterministic rejection/chunking rather than silent truncation.
- Repeat request and restart app; cached records and provenance remain correct.
- Test expired-contract history separately for each provider and entitlement.

**Option chain**

- Retrieve one supported index option chain and one stock option chain where available from each provider.
- Verify exact underlying and expiry, CE/PE strikes, bid/ask, LTP, volume, OI, OI changes and Greek nullability.
- Persist and reload a snapshot after restart.
- Verify a missing expiry, unsupported segment, rate limit and entitlement denial are clearly surfaced.

**One-time quote/depth (on-demand)**

- Retrieve quote and depth for an instrument **not** in the streaming selections from each provider; confirm real values, canonical components, `provider-rest` provenance and receipt time through REST/WebUI/MCP.
- Confirm no streaming selection or capture configuration was changed, and that batch limits and per-symbol errors are surfaced honestly.

**Futures chain**

- Confirm WP5I has imported the corresponding `FUTIDX`/`FUTSTK`/`XX` rows first; otherwise record NOT AVAILABLE rather than a pass.
- Retrieve a futures chain for one index and one stock underlying from each provider (including `BSE:SENSEX-INDEX` on FYERS where mapped).
- Confirm contracts, expiries and LTP/change are real; Upstox derivation from the master is explicitly labelled; no OI/Greeks are computed. SENSEX futures are monthly-only - do not expect or require weekly SENSEX futures.

**BSE SENSEX scope**

- Verify SENSEX and at least one SENSEX derivative path where the provider supports it; confirm monthly-only SENSEX futures (3 serial monthly, last Thursday) and the 7-weekly + 3-monthly + 3-quarterly + 8-semi-annual SENSEX option cycle are not conflated; confirm BANKEX, SENSEX50 and other BSE derivatives are not silently included.

**Consumer parity**

- Compare the same canonical persisted/live data through REST, WebUI and MCP.
- Confirm provider attribution, freshness, unsupported fields and errors agree.
- No consumer calculates its own competing provider-selection or normalization rules.

**Catalog-write contention (G0)**

- Apply the authoritative contention scenario in Â§10.1 and the programme-exit check in Â§13 to every live path above: a 503 `CATALOG_WRITE_BUSY` / background `skipped: true` during refresh is retried after the refresh completes and is never misclassified as a provider or entitlement failure.

### 10.4 Project-level verification commands

At implementation time, OpenCode must inspect `package.json` scripts and existing test conventions first. Run the appropriate targeted provider tests, relevant market/API/WebUI/MCP tests, `bun run typecheck`, `bun run build`, the full test suite and `git diff --check`. Report exact commands and actual outcomes. Do not present local test results as CI results, and do not state that real connectivity passed if only mocks ran.

> **Current baseline (2026-11-27):** at HEAD `3c34fba` the declared runtime is **Bun 1.4.5** (`package.json:5`, commit `3d40441`) and the local full suite is **1253 pass / 0 fail** (14 new G0 test files added since this plan's baseline; recorded in `docs/G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md:31`). The plan's original baseline figures (Bun 1.4.4, 1115 pass / 0 fail at `28a2f34`) are historical. All results are local/agent-reported, not CI.

---

## 11. Security, reliability and operational constraints

1. **Read-only/data-only only.** Continue using the approved Upstox Analytics Token and FYERS non-trading/data-only app. Do not introduce trading scopes or order APIs. FYERS auth docs note SEBI retail-algo regulation changes effective **1 Apr 2026**; re-verify the data-only arrangement under the post-April-2026 rules before live activation and record the result (§5.2, §17).
2. **Credential boundary.** Credentials remain in the encrypted store and are used by backend adapters. REST adapters obtain the current credential at request time (Â§7.2.1); no token is frozen in a long-lived adapter. No token in WebUI JavaScript, MCP output, logs, screenshots, fixture names or plan files.
3. **No hidden activation switch.** The production locked-driver boundary remains locked until the separate Stage G authorization and reviewed activation change. A documentation/plan task is not permission to activate providers.
4. **Single reconnect owner.** The existing Stage F supervisor owns reconnect/backoff/driver retirement. Provider SDK auto-reconnect must not create a second retry state machine. On FYERS credential rotation, bump generation, retire/close the old driver, create a fresh singleton, re-register listeners and let the supervisor own retries (§7.2.1); never reuse a stale token or leave orphaned listeners.
5. **Provider isolation.** Upstox failure must not affect FYERS and vice versa. One missing provider mapping does not make the canonical instrument globally unavailable.
6. **Rate/plan limits.** Use observed/account-specific provider capacity and official current docs. Do not hardcode Prime entitlements or silently reduce the selected instrument set.
7. **Bounded work.** No unbounded message queues, retry storms, per-tick SQLite writes or unbounded concurrent REST jobs. Honor timeout, Retry-After, provider cooldown and shutdown cancellation. Interactive writes during a catalog refresh fail fast with HTTP 503 `CATALOG_WRITE_BUSY` and are retried only after the refresh releases the permit; background sync/capture skip (`skipped: true, retryable: true`) rather than queue.
8. **Honest timestamps.** Preserve source and receipt times separately. Do not infer a unit where docs do not specify one; FYERS LTT is **evidenced as epoch seconds** by official samples and is confirmed-only-on-live-sample before canonical promotion, with receipt-time fallback for genuinely ambiguous frames.
9. **REST cooldown ownership.** Preserve the existing FYERS shared cooldown/account-block semantics across FYERS historical and option-chain consumers. Do not use separate per-adapter state that circumvents a shared provider restriction.
10. **Data integrity.** Keep first-write-wins candle semantics and explicit conflict records. Do not overwrite stored candles merely because a second provider returns a different value.
11. **Privacy-safe evidence.** Store sanitized protocol fixtures only; no user-specific credentials or account data.
12. **No extra dependencies by default.** Keep the current pinned official SDKs and existing `fetch`/SQLite/service patterns unless a documented compatibility blocker requires a separately approved change.
13. **Raw provider data across corporate actions.** Store provider-returned candles, snapshots and contract specifications as-is with provenance. Do not compute adjustment factors, retroactively rewrite stored series, or splice pre- and post-ex-date rows into one canonical series; record an adjustment event only if the source supplies it. No adjustment work package is authorized (§3.2, §4.4, §4.6, §17 Q9).
14. **Per-expiry lot/tick and settlement metadata.** Treat lot and tick as per-expiry contract fields with source, effective date and expiry series; never apply a current value to a historical contract. Record settlement mode (`SttlmMtd`) as source-attributed metadata where supplied; do not model delivery, exercise, assignment or settlement outcomes (§4.6, §5.4).
15. **Dynamic eligibility and boundary re-verification.** Re-verify stock F&O eligibility against the pinned NSE tracker / selection criteria and BSE F&O underlying list, and re-verify the six-underlying NSE index boundary and BSE SENSEX-only boundary, at preflight and each catalogue refresh; do not treat them as permanent (§3.1 item 9, §3.2, §4.6, §17 Q5/Q10).

---

## 12. Risks and unresolved items

| Risk / unknown | Why it matters | Required response |
|---|---|---|
| Upstox SDK feed mode semantics and actual fields | Existing code handles several modes, but account entitlement and live frame contents may differ | Verify live sanitized fixtures for each required field/mode before claiming support. |
| FYERS SDK operation under Bun on Windows | The adapter is pinned and tested structurally, but actual runtime compatibility remains a live validation item | Execute a bounded import/connect/close smoke test only after explicit Stage G authorization; if it fails, investigate a minimal adapter-local compatibility fix. Do not replace the SDK pre-emptively. |
| FYERS LTT unit/precision | Incorrect conversion can make fresh messages look stale or reorder updates | Official samples evidence epoch seconds; confirm on a live sample before canonical promotion; use receipt-time fallback only for ambiguous frames. |
| Field omissions versus explicit zero/clear | Incorrect partial merge can erase valid previous data or manufacture false values | Verify real samples; preserve current omission/clear semantics. |
| Upstox Plus expired-contract entitlement | Expired instruments endpoints are explicitly Plus-gated | Test actual account entitlement; report blocked if unavailable. Do not invent a workaround or assume entitlement. |
| FYERS Standard/Prime limits | Symbol, historical and REST quotas vary by plan | Read current official plan docs and verify actual account; report current limit as metadata, not a permanent universal value. |
| Upstox/FYERS field asymmetry | FYERS OI/IV/Greeks are REST/option-chain data, not Data Socket ticks; index data is reduced | Keep source and surface explicit; no cross-surface mislabeling. |
| Catalogue completeness | Broker masters may not represent every instrument in the desired universe | Publish coverage counts/gaps; scope support to proven provider-available records. |
| Different provider values | Provider prices may be sampled at different times or have different entitlements | Preserve both observations and provenance; do not average/blend values or assume one provider is always authoritative. |
| Token expiry while connected | FYERS access token expires daily at 6:30 AM; Upstox Analytics Token has a one-year validity | Ensure explicit expired/re-auth states, orderly disconnect and no credential leakage. |
| REST rate-limit interactions | History and option-chain adapters can share provider quotas/cooldowns | Use the existing cooldown ownership design and bounded request concurrency. |
| Live verification timing | Real feeds may only be validated during appropriate market sessions | Separate offline code readiness from live-session evidence; do not claim a blocked live test passed. |
| One-time quote/depth limits | Upstox 500 keys; FYERS 50/1,000 quotes and 1 symbol per depth call; plan-dependent | Batch within documented limits; report per-symbol errors; never mutate streaming selections. |
| Futures-chain asymmetry | Upstox has no dedicated futures-chain endpoint; FYERS does and documents `BSE:SENSEX-INDEX` | Derive Upstox chains from the master and label the derivation; do not claim native endpoint parity. |
| Futures absent from catalogue (blocking) | Both master importers skip futures (`FUTIDX`/`FUTSTK` in Upstox, `XX` in FYERS), so WP5G/WP5H have no instruments to resolve | Complete WP5I first; if it fails, mark WP5G/WP5H NOT AVAILABLE rather than passing derived data. |
| BSE SENSEX coverage | SENSEX derivatives may be absent or partially mapped in a provider master; futures are monthly-only while options include weeklies | Verify exact mappings; enforce the SENSEX-only BSE boundary and the futures/options cycle asymmetry; publish gaps. |
| Token rotation in long-lived adapters | A fixed constructor token becomes stale after daily FYERS rotation; the SDK singleton keeps single-slot listeners and `close()` does not detach them | Fetch the current credential at request time (Â§7.2.1); on rotation bump generation, retire/close the old driver, create a fresh singleton, re-register listeners and let the supervisor own retries. |
| Corporate-action interpretation | Exchange-adjusted strikes/lots and provider-specific history adjustment can make a stored series non-continuous across an ex-date | State the raw-data/no-adjustment boundary (§3.2, §4.4); never silently rewrite or splice; any adjustment model requires a separate product decision. |
| Settlement-mode confusion | Physical settlement of stock derivatives creates delivery obligations outside this product; final settlement price is separate from the last traded price | State the market-data-only boundary (§3.2); never infer settlement outcome from stored candles/snapshots. |

---

## 13. Definition of done: M4 Stage G + M5 Phase 4B

Do not close this programme until every required row below is either **PASS** with evidence or explicitly marked **NOT AVAILABLE / NOT ENTITLED / OUT OF SCOPE** with the reason. Unknown must never be silently converted to PASS.

### M4 Stage G

- [ ] Upstox production driver follows the existing `StreamingDriver` lifecycle and uses the existing adapter.
- [ ] FYERS production driver follows the same lifecycle and uses the existing adapter.
- [ ] Current official SDK versions and Bun/Windows compatibility are verified.
- [ ] Both providers independently connect using the approved read-only/data-only credentials.
- [ ] Both providers subscribe/unsubscribe the owner-selected canonical instruments through the one shared coordinator.
- [ ] Real messages reach the canonical `quote`/`depth`/`derivatives` components with correct source and receipt timestamps.
- [ ] Provider-specific limitations (index fields, L1/5/30 depth, FYERS REST-only derivatives, Upstox feed mode/entitlement) are truthfully represented.
- [ ] Both providers can stream simultaneously without shared-state conflicts.
- [ ] Provider isolation, rate-limit handling, token expiry, reconnect, stale callback rejection and shutdown pass.
- [ ] REST snapshot, SSE, WebUI and MCP read paths agree with canonical service state.
- [ ] Sanitized live fixtures and repeatable regression tests exist.
- [ ] The default streaming data bundle (Â§6.2) is the sole source of component requirements; no per-component UI selector was introduced.
- [ ] Both providers and all supported data types were verified in **ONE** coordinated real-provider session (no streaming-only live test followed by a later REST exercise).
- [ ] Independent review is clean and Stage G acceptance evidence is recorded.
- [ ] Stage G activation preserves the G0 catalog-refresh composition/ownership/drain ordering (see the programme-level contention check below).

### M5 Phase 4B

- [ ] Upstox historical provider is wired to `HistoricalCandleService` and real history is verified.
- [ ] FYERS historical provider is wired and real history is verified.
- [ ] Active/expired paths, supported intervals and provider date/entitlement limits are reported truthfully.
- [ ] Upstox option-chain provider is wired to `OptionChainSnapshotService` and real chain retrieval is verified.
- [ ] FYERS option-chain provider is wired and real chain retrieval is verified.
- [ ] Exact underlying/expiry, CE/PE strikes, LTP, bid/ask, volume, OI, OI changes and supported Greeks are verified where supplied.
- [ ] Null, missing, unsupported, no-data, entitlement and rate-limit states are preserved correctly.
- [ ] Candle and snapshot storage survives app restart and retains provenance.
- [ ] REST/WebUI/MCP use the same shared service/repository data without duplicated logic.
- [ ] Local-owner boundaries, explicit provider selection and read-only behavior remain intact.
- [ ] WP5I has imported `FUTIDX`/`FUTSTK` (index/stock futures) and FYERS `XX` futures rows with canonical identity, exact expiry/strike/lot/tick and fail-closed validation; no regression to CE/PE option import.
- [ ] One-time quote/depth for non-subscribed instruments, futures-chain data (dependent on WP5I), and BSE SENSEX/SENSEX-derivative coverage are verified where supported; monthly-only SENSEX futures are not conflated with weekly SENSEX options; out-of-scope BSE derivatives are excluded.
- [ ] All REST adapters obtain the current credential at request time (Â§7.2.1); on FYERS rotation the generation is bumped, the old driver/socket retired, a fresh singleton created with listeners re-registered, and retries owned by the supervisor - no stale token or orphaned listener.
- [ ] Full regression suite, typecheck, build and diff checks pass; independent review is clean.

### Programme exit

- [ ] Catalog-write contention is verified programme-wide: a transient 503 `CATALOG_WRITE_BUSY` / background `skipped: true` during refresh is retried successfully on every live path and never misreported as a provider failure; G0 ownership/drain ordering is preserved.

Only after the above gates pass should the roadmap mark M4 Stage G and M5 Phase 4B complete and authorize M7 implementation. M7 can then consume actual canonical live updates and verified REST snapshots rather than waiting on provider activation.

---

## 14. Recommended first coding assignment

**Start with WP0 (preflight) followed by G1 (Upstox production driver bridge), not M7 and not a simultaneous broad rewrite.**

Why:

- Upstox has the earlier M4 Stage B stream adapter and a documented market-data SDK path.
- The first task can be bounded around the actual difference between `UpstoxMarketDataStream` and `StreamingDriver`, using the default bundle (Â§6.2) as the component-requirement source.
- It reuses the coordinator/supervisor/canonical service already in the app.
- G2 (FYERS) follows against the same proven driver lifecycle, with its SDK runtime-specific uncertainties handled independently.
- Only after both bridges and every data path (WP5Aâ€“WP5H plus WP5I) are complete and tested offline is the single coordinated real-provider verification (G4) authorized. WP5I (futures catalogue import, §7.9) is a bounded, source-driven prerequisite that must be assigned before WP5G/WP5H; it can be prepared during preflight but is not part of the first G1 assignment.

The first implementation task should be an OpenCode assignment for **G1 only**, with G0 preflight evidence included in its report. It should not activate real production connections unless the separate Stage G authorization has been given. The coding agent must not be asked to implement G2, WP5Aâ€“WP5H, WP5I, M7 or the entire programme in one assignment.

---

## 15. Implementation assignment contract (for each future work package)

Every future OpenCode implementation assignment must contain all 12 Project Manager Protocol points:

1. **Objective** â€” one bounded outcome.
2. **Verified current state** â€” exact files, current behavior and evidence from the local checkout.
3. **Exact scope** â€” included behavior only.
4. **Architectural direction** â€” chosen approach and invariants in this plan.
5. **Files/components allowed to change** â€” actual known paths plus justified new files.
6. **Protected areas** â€” `main`, locked activation boundary until authorized, accepted M1â€“M6 behavior, unrelated user changes and credentials.
7. **Non-goals** â€” no unrelated refactor, no M7, no trading, no surprise dependencies.
8. **Acceptance criteria** â€” observable behavior, provider evidence and failure states.
9. **Required tests** â€” targeted provider tests plus relevant regressions.
10. **Verification instructions** â€” real commands, local vs live evidence, exact pass/fail expectations.
11. **Expected report** â€” files, diff, commands/results, limitations, `git status`, complete/incomplete/unverified items.
12. **Option and Metadata Impact Assessment** â€” all 18 questions below, answered before implementation.

No coding assignment is authorized merely by the existence of this plan. The owner must authorize each bounded implementation task. Commit/push, merge/rebase, destructive Git operations and production database changes require separate authorization.

---

## 16. Option and Metadata Impact Assessment (18 required questions)

This programme primarily activates existing provider capabilities and consumes existing catalogue/contracts. It must not create a second provider registry or frontend list. The assessment for the overall programme is:

| # | Required question | Answer / decision |
|---:|---|---|
| 1 | What new selectable options, capabilities, entities or configuration fields are introduced? | No new provider identity and **no per-component streaming selector** â€” the default bundle (Â§6.2) is fixed. It activates existing UPSTOX/FYERS streaming, historical, option-chain, one-time quote/depth and futures-chain capabilities. Any genuinely missing field/depth capability must be identified in G0 and proposed as a narrow shared-contract extension before implementation. |
| 2 | Who owns the source of truth? | `@markethub/contracts` owns fixed provider IDs, canonical field/component schemas and capability contracts; broker adapters own provider protocol mappings; `ProviderRegistry`/provider adapters own runtime provider state; `CatalogRepository` and master refresh own instrument mappings; M5 settings/repositories own persisted history/snapshot configuration. |
| 3 | Are values shared enums, backend capabilities, domain data or user-managed values? | Provider IDs and component/field types are shared contracts; actual provider capability/availability is backend runtime metadata; instrument/contract/expiry choices are changing domain data; selected subscriptions and snapshot capture configuration are owner-managed backend-persisted values. |
| 4 | How do consumers obtain them? | WebUI/REST/MCP consume existing API/service contracts or shared-package schemas. Provider adapters translate backend-owned contracts. No independent frontend option list. |
| 5 | Does an existing API, schema, registry or repository already provide the information? | Yes for provider identity, component schemas, capabilities, provider state, instrument catalogue, mappings, subscriptions, historical and snapshot settings. Audit exact gaps before adding any endpoint or schema. |
| 6 | Is a new discovery/read API necessary? | Not by default. Use direct shared contracts for fixed enums and existing bounded catalogue/capability APIs for dynamic values. Add a new API only if a demonstrated consumer cannot access needed data from existing read services. |
| 7 | How does UI update when provider capabilities change? | It reads the existing backend capability/limit and provider-status surfaces; field selectors derive from shared/backend-owned metadata. No frontend redeploy-only list for provider fields. |
| 8 | What cache invalidation/refresh is needed? | Reuse the existing master refresh freshness and provider status refresh behavior. Provider connection/capability changes update runtime status; catalogue/expiry refresh remains bounded and source-date-based. Cache only bounded metadata with explicit freshness. |
| 9 | Are metadata fields sensitive? | Tokens, app secrets, auth codes, account identifiers, authorization headers and internal credential state are sensitive. Expose only sanitized state/reason/capabilities; never provider credentials or raw auth payloads. |
| 10 | What tests prove frontend/backend consistency and no duplicate definitions? | Contract tests, metadata/status route tests, UI tests using actual shared contracts/API, provider field mapping fixtures and assertions that no second provider/field selector list exists. |
| 11 | Shared contract impact? | Prefer no new enums. If the audit proves required fields absent (for example a newly required canonical metric), add a typed schema in the appropriate dependency-light contracts module and update every consumer/test in the same bounded assignment. |
| 12 | Provider/runtime registration impact? | Keep the fixed `UPSTOX`/`FYERS` identities. Add/activate drivers through existing provider runtime bindings; do not introduce a dynamic plugin marketplace or new provider identity. Capability values remain per provider and per account. |
| 13 | MCP tool/resource/prompt impact? | M6 already exposes shared market data services. No new MCP operation is required merely to activate providers. Any missing capability must be demonstrated against M6 contracts before adding a descriptor. |
| 14 | REST/SSE/WebUI consumer impact? | Live feed uses existing snapshot/SSE routes; historical and snapshot consumers use existing M5 service routes. WebUI displays real service states. Verify parity instead of implementing UI-side broker parsing. |
| 15 | Domain-data discovery impact? | Instrument and expiry lists remain catalogue APIs with existing bounded/paginated behavior. Never copy exchange contracts, symbols or expiries into React constants. |
| 16 | Configuration persistence impact? | Existing WebUI-owned subscription and snapshot capture settings remain authoritative. MCP on-demand reads/fetches must not silently alter them. Credentials remain encrypted and local-owner protected. |
| 17 | Forward compatibility? | Adding a capability must originate in shared/backend-owned metadata and be surfaced by existing consumer discovery. It must not require editing duplicated front-end provider or field arrays. Provider-specific mapping remains adapter-local. |
| 18 | Dependency direction / circular imports? | Keep contracts as dependency-light leaves; provider adapters depend on contracts/market-core interfaces as already designed; app composes adapters/services; no market-core â†’ app or contracts â†’ consumer runtime dependency. Use `import type` where needed. |

---

## 17. Open questions that must be resolved with evidence (not product-owner guesswork)

These are bounded engineering verification tasks, not reasons to defer the whole programme:

1. Does the pinned FYERS SDK operate correctly under the exact Bun version on Windows (**Bun 1.4.5** per `package.json:5`, aligned in `3d40441`; this plan's baseline was 1.4.4), including Data Socket open, event callbacks, close and reconnect? If not, identify the smallest safe provider-package correction and seek approval before changing dependencies/runtime.
2. Official FYERS samples evidence 10-digit epoch **seconds** (`last_traded_time: 1690953622`, depth `ltt: 1622184920`, quotes `tt: "1691020800"`). Confirm on a live sample before promoting to a canonical timestamp; until then use seconds as the evidenced default with receipt-time fallback for ambiguous frames, and do not guess milliseconds.
3. Which exact Upstox feed modes provide each of OI, IV, Greeks, depth levels and extra `eFeedDetails` fields for the real account? Mode descriptions/examples are not sufficient proof of account access.
4. Are the user's actual Upstox Analytics Token and FYERS data-only app entitled for all intended active history, chain and streaming surfaces? What is the actual Upstox Plus status for expired endpoints and FYERS plan for data socket/history quotas?
5. Which product-required universe and segments should be accepted as first complete catalogue coverage? The plan assumes existing documented F&O-focused scope and requires the implementation report to enumerate actual broker coverage rather than claim the entire exchange universe. For stock underlyings, the pinned eligibility sources are the NSE F&O Stock Introduction and Exclusion Tracker and NSE Selection Criteria (16th-of-month), plus the BSE F&O Underlying Asset List and eligibility page (15th-of-month PSF), under SEBI 2024/116. Report the tracker date and the effective dates of any additions/removals affecting the smoke basket. The six-underlying NSE index boundary and BSE SENSEX-only boundary were re-verified on 2026-11-28 and still hold; re-verify at preflight because index derivatives are reviewed semi-annually in April and October.
6. Are any desired provider metrics absent from the canonical contracts (e.g. POP, aggregate PCR/call-put OI, circuit bands, CAS IEP/imbalance or year high/low)? Classify optional extras first; only promote product-required fields into shared contracts with a reviewed schema impact.
7. Which exact Upstox instrument-master rows and FYERS symbols represent BSE SENSEX and its currently available FUTIDX/OPTIDX contracts, and is FYERS BSE option-chain data actually available? Do not assume coverage from the futures-chain example alone. WP5I must first make FUTIDX rows importable; SENSEX futures are monthly-only (3 serial monthly, last Thursday) while SENSEX options have 7 weekly + 3 monthly + 3 quarterly + 8 semi-annual contracts (BSE notice 20250617-11, BSE contract specs).
8. Can the REST adapters read the current credential at request time through the existing store without disturbing the FYERS SDK singleton/generation guard, and does the account remain entitled after daily 06:30 IST token rotation? On rotation, bump generation, retire/close the old driver, create a fresh singleton, re-register listeners and let the supervisor own retries; never reuse a stale token or leave orphaned listeners. Also re-verify the data-only arrangement under SEBI retail-algo changes effective 1 Apr 2026.
9. Should a future phase model corporate-action adjustments for historical candles and option-chain snapshots? NSE/BSE publish adjustment factors and revised contract files on ex-dates (e.g. TECHM 1:1 bonus, factor 2, ex-date 30 Nov 2026), while provider history adjustment is inconsistent and not contractually documented. This programme's answer is "no - raw provider values only"; any change requires a separate authorized design.
10. Are lot and tick being stored as per-expiry contract fields with source, effective date and expiry series rather than as one current constant? NIFTY changed 75→50 (2021, `NSE/FAOP/47854`), 50→25 then 25→75 (2024, `61415`/`64625`) and 75→65 (2025, `70616`); SENSEX is 20 for Nov–Dec 2026 and 25 from Jan 2027 (`20260930-58`). Never apply a current lot/tick to a historical contract.
11. Is settlement mode recorded only as source-attributed metadata (`SttlmMtd` `C` index / `P` stock) with no settlement, exercise, assignment or delivery logic? Confirm the 18 `C` FUTSTK rows are `NSETEST` test symbols, not real stocks (SEBI 2024/116; NSE contract master, accessed 2026-11-28).
12. Are India VIX derivatives (`FUTIVX`; no `OPTIVX` evidenced) confirmed out of scope, with zero VIX rows in the 27 Nov 2026 official contract master (83,326 rows, only FUTIDX/FUTSTK/OPTIDX/OPTSTK), so the legacy `INDIAVIX` quote page is not mistaken for an active product?

---

## 18. Change boundaries and protected work

### Allowed in future authorized implementation tasks

Only the files/packages required for the assigned work package, likely within:

- `packages/broker-upstox/src/` (driver bridge, protocol mapping, adapter tests)
- `packages/broker-fyers/src/` (driver bridge, protocol mapping, adapter tests)
- `apps/api/src/index.ts` and narrowly scoped API composition/lifecycle modules for the authorized activation/wiring task
- `packages/contracts/src/` only for proven missing canonical fields/capabilities
- `packages/market-core/` only for proven provider/service integration gaps
- `tests/providers/`, `tests/market/`, and focused API/WebUI/MCP integration tests
- `docs/` status/decision/coverage evidence when implementation changes verified state

> **G0 preservation note (2026-11-27):** the six G0 catalog-refresh modules (`apps/api/src/catalog-refresh-child-manager.ts`, `catalog-refresh-child-pipeline.ts`, `catalog-refresh-child.ts`, `catalog-refresh-ipc.ts`, `catalog-write-coordinator.ts`, `catalog-write-ownership.ts`) are **protected/preserved**, not to be rewritten during Stage G / Phase 4B activation. WP5E threads the existing `writeGuard` from `catalog-write-coordinator.ts` / `catalog-write-ownership.ts` into the services; it does not redesign them. Add G0 contention tests under `tests/api/` and `tests/market/` alongside the provider tests.

### Protected unless explicitly approved

- `main` and its current stable baseline.
- The Stage G locked production boundary until its explicit authorization and independent review gate.
- Accepted M1â€“M6 behavior, especially Stage F lifecycle/recovery, M6 real-HTTP protocol/conformance behavior, local-owner security and canonical subscription ownership.
- Existing user modifications, untracked files and local test evidence.
- Credentials, production database contents and encryption key material.
- Unrelated UI redesign, database redesign, dependency upgrades and M7 implementation.

### Plan-only statement

This document is a plan, not an implementation grant. The local working tree was not changed while preparing it. No provider was authenticated or connected. No live market data was requested. No commits or pushes were made.

---

## 19. Official and repository references

### Repository references

- [Implementation Roadmap](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/IMPLEMENTATION_ROADMAP.md)
- [Project Status](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/PROJECT_STATUS.md)
- [Provider Integration](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/PROVIDER_INTEGRATION.md)
- [Multi-Provider Streaming Architecture / AD-024](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/MULTI_PROVIDER_STREAMING_ARCHITECTURE.md)
- [M5 Stage 5 Plan](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/STAGE_5_PLAN.md)
- [Project Manager Protocol](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/PROJECT_MANAGER_PROTOCOL.md)
- [Engineering Standards](https://github.com/Rajendertyagi/MarketHubTS/blob/develop/docs/ENGINEERING_STANDARDS.md)

### Upstox official references

- [Analytics Token](https://upstox.com/developer/api-documentation/analytics-token/)
- [Market Data Feed V3](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/)
- [Full Market Quotes V3](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)
- [Historical Candle Data V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/)
- [Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/)
- [Put/Call Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/)
- [Expired Instruments](https://upstox.com/developer/api-documentation/expired-instruments/)
- [Expired Instruments API entitlement announcement](https://upstox.com/developer/api-documentation/announcements/expired-instruments-api/)
- [Expired Historical Candle Data](https://upstox.com/developer/api-documentation/get-expired-historical-candle-data/)
- [Instrument files](https://upstox.com/developer/api-documentation/instruments/)
- [Market Data Feed V3 proto (Rho and field schema)](https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto) (accessed 2026-11-27)
- [API overview (no dedicated futures-chain endpoint)](https://upstox.com/developer/api-documentation/api-overview/) (accessed 2026-11-27)
- [Instrument Search (Beta) - unverified/optional, not adopted](https://upstox.com/developer/api-documentation/instrument-search/) (accessed 2026-11-27)
- [Option Greek (REST surfaces have no Rho)](https://upstox.com/developer/api-documentation/option-greek/) (accessed 2026-11-27)
- [Expired Historical Candle Data (restricted intervals)](https://upstox.com/developer/api-documentation/get-expired-historical-candle-data/) (accessed 2026-11-27)
- [Rate Limiting (429 / UDAPI10005)](https://upstox.com/developer/api-documentation/rate-limiting/) (accessed 2026-11-27)

### FYERS official references

- [FYERS API v3 Overview](https://fyers.in/api-docs/v3/getting-started/)
- [Individual App Authentication](https://fyers.in/api-docs/v3/api/authentication/individual-app/)
- [Individual App Authentication Flow](https://fyers.in/api-docs/v3/api/authentication/individual-app/authentication-flow/)
- [Individual App Security Best Practices](https://fyers.in/api-docs/v3/api/authentication/individual-app/best-practices/)
- [Data Socket Overview](https://fyers.in/api-docs/v3/api/websockets/data-socket/overview/)
- [Data Socket Connect and Subscribe](https://fyers.in/api-docs/v3/api/websockets/data-socket/overview/data-socket-connect-and-subscribe/)
- [Data Socket Symbol Update](https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-symbol-update/)
- [Data Socket Market Depth Update](https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-depth-update)
- [Historical Data](https://fyers.in/api-docs/v3/api/market-data/historical-data/)
- [Option Chain](https://fyers.in/api-docs/v3/api/market-data/option-chain/)
- [Expired F&O Data](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/)
- [Get Expiry Dates](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expiry-dates/)
- [Get Expired Contracts](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expired-contracts/)
- [Get Expired F&O Data](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expired-fo-data)
- [Symbol Master File](https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-file/)
- [Market Data API Index](https://fyers.in/api-docs/v3/api/market-data/)
- [Quotes](https://fyers.in/api-docs/v3/api/market-data/quotes/) (accessed 2026-11-27)
- [Market Depth](https://fyers.in/api-docs/v3/api/market-data/market-depth/) (accessed 2026-11-27)
- [Futures Chain](https://fyers.in/api-docs/v3/api/market-data/futures-chain/) (accessed 2026-11-27)
- [Symbol Master JSON (previousOi, tradeStatus, expiryDate)](https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-json/) (accessed 2026-11-27)
- [Plans & Rate Limits (-429, daily block rule)](https://fyers.in/api-docs/v3/getting-started/plans-and-limits/) (accessed 2026-11-27)
- [Data Socket Indices Update (LTT sample)](https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-indices-update/) (accessed 2026-11-27)

### Exchange and regulator references (expiry authority, accessed 2026-11-27)

- [SEBI circular SEBI/HO/MRD/TPD-1/P/CIR/2025/76 - Final Settlement Day (Expiry Day) for Equity Derivatives Contracts, 26 May 2025, effective 1 Sep 2025](https://www.sebi.gov.in/legal/circulars/may-2025/final-settlement-day-expiry-day-for-equity-derivatives-contracts_94189.html)
- [NSE circular NSE/FAOP/68589 - Tuesday expiry](https://nsearchives.nseindia.com/content/circulars/FAOP68589.pdf)
- [NSE circular NSE/FAOP/68747 - operational revision / contract master files](https://nsearchives.nseindia.com/content/circulars/FAOP68747.pdf)
- [NSE Equity Derivatives Contract Specifications](https://www.nseindia.com/products-services/equity-derivatives-contract-specifications)
- [NSE Equity Derivatives Selection Criteria](https://www.nseindia.com/products-services/equity-derivatives-selection-criteria)
- [NSE F&O market lots (fo_mktlots.csv)](https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv)
- [BSE Derivatives Contract Specifications](https://beta.bseindia.com/static/markets/Derivatives/DeriReports/contractindex.aspx)
- [BSE notice 20250617-11 - Thursday expiry; no fresh weekly index futures from 1 Jul 2025](https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20250617-11)

### Exchange and regulator references (corporate actions, eligibility, lot/tick, settlement, VIX; accessed 2026-11-28)

- [NSE - Adjustments in case of Corporate Actions](https://www.nseindia.com/static/products-services/equity-derivatives-corporate-actions-adjustments)
- [NSE circular NCL/CMPT/77593 - TECHM 1:1 bonus, factor 2, ex-date 30 Nov 2026](https://nsearchives.nseindia.com/content/circulars/CMPT77593.pdf)
- [BSE notice 20250801-29 - HDFC Bank 1:1 bonus adjustment](https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20250801-29)
- [NSE F&O Stock Introduction and Exclusion Tracker (23-11-2026)](https://nsearchives.nseindia.in//web/mediaattachment/2026-11/FO_Stock_Introduction_and_Exclusion_Tracker_23-11-2026_20261123172526.xlsx)
- [NSE Equity Derivatives Selection Criteria](https://www.nseindia.com/products-services/equity-derivatives-selection-criteria)
- [BSE F&O Underlying Asset List](https://www.bseindia.com/markets/Derivatives/DeriReports/folist)
- [SEBI circular SEBI/HO/MRD/MRD-PoD-2/P/CIR/2024/116 - eligibility and physical settlement](https://www.sebi.gov.in/sebi_data/attachdocs/aug-2024/1725027626764.pdf)
- [SEBI circular SEBI/HO/MRD/DOPI/CIR/P/2018/161 - physical settlement mandate](https://www.sebi.gov.in/sebi_data/attachdocs/dec-2018/1546255335099.pdf)
- [SEBI circular SEBI/HO/MRD/DOP1/CIR/P/2019/28 - accelerated physical settlement](https://www.sebi.gov.in/sebi_data/attachdocs/feb-2019/1549625911612.pdf)
- [NSE circular NSE/FAOP/47854 - NIFTY lot 75→50 (2021)](https://nsearchives.nseindia.com/content/circulars/FAOP47854.pdf)
- [NSE circular NSE/FAOP/61415 - NIFTY lot 50→25 (2024)](https://nsearchives.nseindia.com/content/circulars/FAOP61415.pdf)
- [NSE circular NSE/FAOP/64625 - NIFTY lot 25→75 (2024)](https://nsearchives.nseindia.com/content/circulars/FAOP64625.pdf)
- [NSE circular NSE/FAOP/70616 - NIFTY lot 75→65 (2025)](https://nsearchives.nseindia.com/content/circulars/FAOP70616.pdf)
- [NSE tick-size circulars 67134 / 67135 / 70382](https://nsearchives.nseindia.com/content/circulars/FAOP67134.pdf)
- [BSE notice 20260930-58 - SENSEX lot 20→25 from Jan 2027 expiries](https://www.bseindia.com/downloads/UploadDocs/Notices/20260930-58/20260930-58.pdf)
- [BSE notice 20241021-13 - SENSEX lot 10→20 (2024)](https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20241021-13)
- [NSE press release - launch of India VIX futures (NVIX), 26 Feb 2014](https://nsearchives.nseindia.com/content/press/26022014.htm)
- [NSE F&O Consolidated Circular NSE/FAOP/34596 - historical FUTIVX specification](https://nsearchives.nseindia.com/content/circulars/FAOP34596.pdf)

---

## Final recommendation

**The next coding task is G1 â€” Upstox production driver bridge, after a clean local preflight.** Then build the FYERS bridge on the same lifecycle, import the futures catalogue (WP5I) before any futures-chain or SENSEX-futures work, connect both providers' one-time quote/depth, historical, option-chain and futures-chain paths (including BSE SENSEX coverage with monthly-only futures), and test every path offline. Only then perform ONE coordinated, explicitly authorized real-provider verification across both providers and all supported data types, finish the coverage report, and confirm WebUI/API/MCP parity. Do not begin M7 until this programme is complete or every remaining provider limitation is explicitly accepted and documented.
