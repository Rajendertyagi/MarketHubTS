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

## 1. Executive decision

**Do not start M7 implementation yet.** MarketHubTS has substantial provider-independent infrastructure and offline adapter code, but it is not yet receiving live Upstox/FYERS data in its production application.

The next implementation programme is:

1. **M4 Stage G â€” activate and verify real-time streaming** from Upstox and FYERS through the existing provider runtimes and canonical market-data pipeline.
2. **M5 Phase 4B â€” activate and verify real provider-backed REST retrieval** for historical candles and option-chain snapshots from both providers.
3. **Complete the provider/data coverage audit** for instrument identity, quote/depth/derivatives fields, history, option chains, expiry data, entitlements and limits.
4. **Run end-to-end acceptance** across the real API, canonical services, persistence, REST/SSE, WebUI and MCP consumers.
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

1. Both providers can authenticate using the already approved **read-only/data-only** app arrangements.
2. Both streaming adapters are connected to the production runtime through the existing supervisor/coordinator design.
3. User-selected canonical instruments can be mapped to each provider's native symbol/key and actually subscribed.
4. Real provider messages are decoded, normalized and delivered through canonical quote/depth/derivatives components with provider attribution, timestamps and freshness.
5. One provider can fail, expire or hit a limit without disabling the other provider or corrupting shared desired state.
6. Historical candles can be fetched from each supported provider, validated, cached and read after restart.
7. Option-chain data can be fetched from each supported provider for an explicitly selected underlying/expiry and stored as snapshots.
8. Actual limitations, unsupported fields, entitlements, stale data, request failures and no-data results are visible and truthful.
9. Tests prove the flow with both deterministic offline fixtures and explicitly authorized real-provider evidence.

### 3.2 What this plan does not claim to implement

This is not a plan to mirror every endpoint in the Upstox or FYERS platform. It covers the read-only market-data foundation required by the current F&O-focused product: catalogue identity/mappings, live quotes, market depth, provider-supported derivative metrics, historical candles, active option-chain contracts/data and the supported expired-F&O history paths.

The following remain separate workstreams unless current product requirements explicitly include them: account/portfolio data, funds, positions, order APIs, trading, news, fundamentals, screeners, webhooks for broker events, and market-wide analytics beyond the market-data inputs defined here. The existence of an endpoint in a broker API is not permission to add it to this product scope.

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
| Last traded time | LTPC `ltt` | `last_traded_time` is documented as an integer, but the official docs inspected do not establish its unit/precision | Upstox mapping exists. FYERS must remain `UNKNOWN`/untrusted until a live sample and authoritative clarification support conversion. Use receipt ordering when untrusted. |
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
| Rho | Not established as an available field in the current Upstox contract/surface inspected | Not listed in the FYERS documented option-chain Greek set inspected | Do not add as a required supported metric without official confirmation. |
| Previous OI / OI change / OI percentage change | Upstox option-chain `prev_oi`; current feed may expose previous OI in specific full quote details | FYERS option-chain `prev_oi`, `oich`, `oichp` | Existing canonical derivatives contract may not include all of these. Audit schemas before mapping; add only deliberate, typed fields. |
| PCR / total call OI / total put OI | Upstox option-chain includes `pcr` per strike/chain response context | FYERS option-chain includes `callOi` and `putOi` | These are chain-level aggregate metrics, not per-contract derivative values. They need an explicit snapshot/aggregate contract if required. |

### 4.4 Historical candle data

| Capability | Upstox | FYERS | Repository requirement |
|---|---|---|---|
| Active-contract OHLCV candles | V3 historical candle API | `/data/history` | Both offline adapters already exist. Activate service providers and verify real response parsing, interval mapping and window handling. |
| Open interest in candles | V3 candle row includes OI where supplied | `oi_flag=1` requests OI | Keep OI nullable; missing OI is not zero. |
| Intraday intervals | Official V3 API supports minute intervals 1â€“300 and hours 1â€“5 with endpoint-specific maximum windows | Official API supports the documented minute resolutions; up to 100 days per request for the documented intraday intervals | Confirm supported canonical intervals against both adapters; chunk requests to provider windows without gaps/overlap errors. |
| Daily/weekly/monthly | Official V3 supports day/week/month; published historical availability extends back further for daily/weekly/monthly than intraday | `1D`, `1W`, `1M`; max 366 days per request for these resolutions | Verify date-boundary conversion, timezone/calendar semantics and duplicate candle handling. |
| Active F&O | Uses native active contract identifiers | Uses native F&O symbols and `cont_flag` as applicable | Resolve canonical IDs to the exact provider-native contract. Do not construct symbols by string guessing. |
| Expired F&O | Separate expired-instruments APIs; expired historical candle access is documented as Upstox Plus-only | Separate expiry-date â†’ expired-contract â†’ expired-data API flow | Treat entitlement and date coverage as provider-specific. A denied Plus endpoint is not an adapter bug if the account lacks entitlement. |
| History window / account plan | Endpoint limits vary by interval and endpoint; expired history has separate rules | Current docs publish plan- and resolution-specific windows and request sizes | Expose the actual account/provider limitation. Never hardcode entitlement as guaranteed. |

### 4.5 Option-chain data

| Capability | Upstox | FYERS | Repository requirement |
|---|---|---|---|
| Active option contracts | `GET /v2/option/contract` | Current symbols from Symbol Master; option-chain/expiry API metadata | Resolve underlying and selected expiry against provider metadata. |
| Active option chain | `GET /v2/option/chain` | `options-chain-v3` | Both offline adapters exist; connect them to M5 service and verify live. |
| Expiry selection | Upstox accepts explicit expiry date and documents relative expiry keywords | FYERS returns `expiryData`; exact expiry epoch is passed to select the requested expiry | Continue using exact requested expiry; do not rely on list order or ambiguous expiry flags. |
| Strike coverage | Provider returns supported strikes/contract rows | `strikecount` supports up to 50 strikes on each side of ATM | Show actual returned strike range/count; do not claim a full chain if limited by API request or account. |
| Per-strike market data | LTP, close, volume, OI, bid/ask and quantities, previous OI | LTP, bid/ask, OI, OI change/percentage, previous OI, volume | Map fields to the existing snapshot contract; identify omissions before expanding the contract. |
| Greeks | Delta, gamma, theta, vega, IV; current docs also list POP | Delta, gamma, theta, vega, IV | Audit whether POP is represented. Do not silently discard a required metric or cram it into untyped payload. |
| Underlying/VIX/aggregates | Underlying spot price and PCR in response | Underlying chain entry/forward data, India VIX, aggregate call/put OI | Store only if the canonical snapshot envelope models the metric; otherwise propose a specific contract change. |
| Exchange/product availability | Upstox Put/Call Option Chain currently documents an MCX exclusion | FYERS option-chain availability varies by instrument/segment and must be verified | Report per-provider/segment coverage; do not claim universal NSE/BSE/MCX support. |

### 4.6 Instrument catalogue and provider-native mapping

Existing WP4Aâ€“4C imports public Upstox BOD and FYERS Symbol Master files and exposes provider-aware derivative expiry discovery. This is a useful foundation, but current documentation explicitly limits claims to broker-available coverage rather than a complete exchange catalogue.

The completion audit must prove, per supported exchange/segment:

- The instrument/contract exists in the latest provider master source.
- Its canonical instrument identity is stable and unambiguous.
- Its Upstox `instrument_key` and FYERS symbol/FY token mapping are exact and separately attributed.
- The derivative underlying, expiry, strike, CE/PE, lot size, tick size, segment and instrument type are correct where supplied.
- Expired instruments remain addressable for historical data without corrupting current active contract identity.
- Master source date/freshness reflects the source's own published date/version, not merely download time.
- Partial/failed refresh never destroys the last valid catalogue.

Do not claim full NSE/BSE coverage based only on successful imports. The work package must compare the intended product universe with the actual rows/segments available in each provider master and report missing/unmapped/ambiguous cases.

---

## 5. Official API research and verified constraints

Official documentation was checked on **25 November 2026**. The links below are the sources for the provider facts in this plan. Recheck them at the start of implementation because broker docs, subscription tiers and limits can change.

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
| Expired candle retrieval | [Get Expired F&O Data](https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expired-fo-data) | Supports expired-contract candles and optional OI/Greek fields with segment limitations; monthly timeframe is not yet available per the page inspected. |
| Symbol Master | [Symbol Master File](https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-file/) | Segment-specific CSVs; provider symbols must be used exactly as supplied. Symbol Master JSON contains additional metadata not in the CSV. |
| Market-data REST catalogue | [Market Data APIs](https://fyers.in/api-docs/v3/api/market-data/) | Lists history, quotes, depth, option chain, futures chain and expired F&O endpoints. |

**Published FYERS plan constraints to verify against the actual account:** current Data Socket docs show Standard up to 100 symbols and Prime up to 5,000 symbols per user across connections. The project must not assume Prime. Current history documentation distinguishes Standard and Prime date windows. Rate limits and plan entitlement must be obtained from the current official Plans & Rate Limits page and then verified against actual account responses; the local adapters' cooldown logic must not be treated as proof of account limits.

### 5.3 Provider documentation versus actual account truth

For every provider feature, record four separate statuses:

1. **Documented:** official documentation describes the endpoint or field.
2. **Implemented offline:** an adapter/parser/contract exists and deterministic mocked tests pass.
3. **Account entitlement verified:** the user's configured account can access it under its current plan/token.
4. **Live application verified:** a real request/feed reached MarketHub and the correct canonical/API/UI/persistence output was observed.

Never collapse these four statuses into a single â€œsupportedâ€ badge.

---

## 6. M4 Stage G â€” production live-stream activation

### 6.1 Objective

Replace the locked production streaming boundary with real provider drivers **only through the approved Stage G gate**, using the already implemented provider stream adapters, one shared subscription coordinator and independent per-provider supervisors.

### 6.2 Stage G work packages

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
- Translate provider-neutral requested quote/depth/derivatives requirements into valid Upstox feed mode(s); group by mode only where the SDK/API requires it.
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
- Translate neutral quote/depth needs to FYERS symbol and depth subscriptions. `sf`, `if` and `dp` are distinct message types and must be parsed separately.
- Preserve the existing canonical component split: FYERS `sf` can yield a quote plus L1 depth; `if` is reduced index quote; `dp` contains five-level depth.
- Confirm actual Bun compatibility of the pinned official FYERS SDK under the project's Windows/Bun runtime (**Bun 1.4.5** per `package.json:5`, aligned in `3d40441`; this plan's baseline had 1.4.4). Node compatibility or mocked unit tests are not proof of Bun compatibility.
- Check SDK reconnect behavior, callback registration, close semantics and event schema against the supervisor lifecycle. Prevent nested retry loops and duplicate subscriptions.
- Treat FYERS `last_traded_time` as untrusted until its unit/precision is confirmed by authoritative docs or controlled live samples. Use receipt-time fallback; do not guess seconds versus milliseconds.
- Preserve safe integer conversion and explicit field-presence semantics; no fabricated zeros for absent fields.
- Honor `AbortSignal`, close resources on partial start failure and redact tokens from all errors/logs.

**Required tests:** same `StreamingDriver` contract suite as Upstox plus FYERS-specific `sf`/`if`/`dp` event mapping, five-level depth, index reduced fields, reconnect resubscribe, subscription update ordering, Bun import/runtime smoke test and cleanup on failure.

#### G3 â€” Production composition and simultaneous-provider verification

**Purpose:** connect both verified drivers to the existing production composition without changing the shared ownership model.

Expected work:

- Replace the two `LockedProviderDriver` factories in `apps/api/src/index.ts` only as part of explicitly authorized Stage G activation. **Preserve the G0 catalog-refresh composition added after this plan's baseline** (`index.ts:244` `CatalogWriteOwnership`, `:252` `CatalogWriteCoordinator`, `:269` `CatalogRefreshChildManager`, startup recovery `:502-551`, shutdown drain `:560-618`); do not describe or rebuild the older root as current, and do not drop the ownership/drain ordering.
- Keep exactly one provider runtime/supervisor per provider and the existing single `SubscriptionCoordinator`.
- Do not create separate subscription repositories, `MarketDataService` instances, tracking sets or independent SSE hubs per provider.
- Keep provider authentication and token acquisition inside the existing provider/auth/credential boundaries. Ensure a token can expire/refresh/re-auth without reconstructing unrelated services or leaking its value.
- Keep Upstox and FYERS independently connectable. If one is unconfigured, expired, rate-limited or disconnected, the other must continue streaming.
- Verify same canonical instrument can retain separate observations/components from both providers; selection/provenance must explain which provider/component is selected and why.
- Verify status distinguishes owner-selected, mapped, provider-supported, actually-submitted, provider-confirmed/subscribed, first-observation-received and fresh. â€œConnectedâ€ alone must not mean every instrument is streaming.
- Ensure shutdown stops coordinator/runtimes before shared hub/database close, preserving the existing Stage F order and guarantees. The G0 shutdown drain (`index.ts:560-618`) must also be preserved: `catalogRefresh.stopAndWait()` â†’ `childManager.shutdown()` â†’ ownership release â†’ coordinator/hub/server/DB close; an UNKNOWN permit is not released.

**Required scenarios:** both connected; Upstox only; FYERS only; neither; one provider fails during subscription update; one disconnects while the other streams; one token expires; unsupported symbol mapping for one provider while the other succeeds; per-provider capacity exceeded; rapid desired-generation changes; stale callbacks from retired drivers; clean shutdown and restart.

#### G4 â€” Authorized live verification and Stage G closeout

This is a separate, explicitly authorized production operation. The implementation agent must not perform real provider authentication, open real sockets or transmit real user credentials merely because this plan exists.

After driver code passes offline review and the owner explicitly authorizes Stage G activation:

> **Contention note (2026-11-27):** credential/subscription writes used in steps 1 and 3 now fail fast with HTTP 503 `CATALOG_WRITE_BUSY` while a catalog refresh owns the write permit (`provider-routes.ts`, `market-routes.ts:122`, `app.ts:150-157`). Treat a 503 as a transient, retryable lock â€” not a provider/auth failure â€” and retry after the refresh completes. Preserve the G0 ownership/drain ordering in the composition root (Â§6.3).

1. Configure approved read-only/data-only provider credentials through the existing local credential UI/flow. Do not paste credentials into chat, task files, logs or fixtures.
2. Start with the small approved smoke basket, not the whole catalogue.
3. Verify each provider independently during a market session; then verify simultaneous operation.
4. Record sanitized provider connection state, subscribed native-symbol count, canonical instrument IDs, mode/capabilities, message types, field presence, source/receipt timestamps and error/limit outcomes.
5. Compare a small set of actual quote/depth values with the same provider's documented response or provider UI as an evidence check; do not assert exact equality across providers because update times and feeds can differ.
6. Capture sanitized response fixtures (remove tokens, account identifiers, personal values and signed URLs) and add deterministic regression tests.
7. Verify reconnect, provider isolation, capacity, partial updates and shutdown/restart.
8. Complete independent code review before changing the production locked boundary. If any acceptance condition fails, retain the safe locked/unavailable behavior and report the blocker.

**Stage G acceptance:** both configured provider runtimes have independently demonstrated real connection and subscription behavior; canonical data reaches MarketDataService and REST/SSE/WebUI; simultaneous operation works; field gaps and entitlement restrictions are documented; no hidden downgrade or cross-provider contamination exists; all offline and live acceptance evidence is recorded; independent review is clean.

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

### 7.3 WP5A â€” Upstox historical provider activation

Expected work:

- Construct the existing `UpstoxHistoricalAdapter` through the current composition boundary and pass it to `HistoricalCandleService` as the Upstox provider.
- Supply the Analytics Token through the existing encrypted credential/provider adapter boundary. Avoid freezing an expired token inside a long-lived adapter if the service can obtain the current credential at request time.
- Resolve the canonical ID to the exact Upstox active `instrument_key`; for expired history resolve a provider-issued `expired_instrument_key` from the expired-contract API flow.
- Preserve the existing interval mapper, retrieval window validation, retry/throttle behavior, parsing and provenance.
- Test active-history V3 response shapes for every supported canonical interval class.
- Separately test expired history only where the actual account has Upstox Plus; otherwise return a clear entitlement/unavailable state.
- Verify candles are stored via the existing `CandleRepository`, with existing first-write-wins and conflict notes intact.

**Real acceptance:** at least one liquid equity and one active F&O contract, where supported, return real candles; OHLC/timestamp/volume/OI parse correctly; cached reads survive restart; repeated fetches do not duplicate or overwrite existing candles; provider/receipt provenance is correct. Include a catalog-refresh contention scenario: a fetch attempted while a refresh owns the write permit returns HTTP 503 `CATALOG_WRITE_BUSY` (or a background `skipped: true` result) and succeeds on retry after the refresh completes â€” it must not be recorded as a provider failure.

### 7.4 WP5B â€” FYERS historical provider activation

Expected work:

- Construct the existing `FyersHistoricalAdapter` and register it with the same `HistoricalCandleService`.
- Pass the current `app_id:access_token` through the encrypted credential boundary; handle daily 6:30 AM token expiry honestly and require the existing approved re-authentication path.
- Resolve exact FYERS symbols from current Symbol Master/catalogue mappings. Do not synthesize symbols from canonical display names.
- Preserve canonical-to-FYERS interval mapping, `date_format`, `range_from`/`range_to`, `oi_flag`, `cont_flag`, supported resolution differences, chunking, cooldown and error classification.
- Verify regular history and expired F&O history as separate flows. For expired F&O, use the provider's expiry-date â†’ expired-contract â†’ expired-data sequence; respect Standard/Prime and segment/date restrictions.
- Ensure the FYERS shared REST cooldown/account-block state is shared between the FYERS history and option-chain adapters as intended by the current cooldown design. Do not create independent instances that accidentally bypass an account-level or category-level block.
- Persist candles through the existing repository only after validation.

**Real acceptance:** at least one liquid equity and one supported active F&O contract return real historical candles; OI is present only where actually supplied; all supported intervals/window limits are tested; expired paths are verified only if entitlement permits; history survives restart and respects no-data/permanent-unavailability semantics. Include a catalog-refresh contention scenario: a fetch during a refresh returns HTTP 503 `CATALOG_WRITE_BUSY` (or background `skipped: true`) and succeeds on retry after the refresh completes â€” never misreported as a provider failure.

### 7.5 WP5C â€” Upstox option-chain activation

Expected work:

- Construct existing `UpstoxOptionChainAdapter` and register it with `OptionChainSnapshotService`.
- Supply the current Analytics Token through the credential boundary.
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
- Supply valid current `app_id:access_token` through the encrypted credential boundary.
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

---

## 8. Implementation sequence and dependencies

The recommended sequence is intentionally incremental. Do not give an agent a single broad instruction to â€œfinish all provider integrationâ€ without package-level acceptance gates.

| Order | Work package | Main output | Dependency / gate |
|---:|---|---|---|
| 0 | **Preflight and evidence refresh** | Exact current local baseline, updated official API/SDK facts, field/mapping gap list, smoke-basket fixtures and sanitized evidence process | No code changes. Must precede implementation. |
| 1 | **G1 Upstox driver bridge** | Production-compatible Upstox `StreamingDriver` implementation using existing adapter | Existing M4 Stage B; deterministic driver tests pass. Production lock remains in place until authorized. |
| 2 | **G2 FYERS driver bridge** | Production-compatible FYERS `StreamingDriver` implementation using existing adapter | Existing M4 Stage C; Bun SDK compatibility and deterministic tests pass. |
| 3 | **G3/G4 Stage G activation + live verification** | Independently verified and simultaneous real streaming, canonical component evidence, safe reconnect and status | Separate explicit Stage G authorization; independent review before locked-boundary change. |
| 4 | **WP5A Upstox history** | Upstox historical provider wired to the shared M5 service and real-history verified | Stage G gate passed; current Analytics Token and entitlement. |
| 5 | **WP5B FYERS history** | FYERS historical provider wired and verified | Stage G gate passed; current FYERS data token and entitlement. |
| 6 | **WP5C Upstox option chain** | Upstox option-chain provider wired and verified | Stage G gate passed; supported underlying/expiry and Option Chain entitlement. |
| 7 | **WP5D FYERS option chain** | FYERS option-chain provider wired and verified | Stage G gate passed; current FYERS token and supported underlying/expiry. |
| 8 | **WP5E catalogue, API/UI/MCP parity and M5 closeout** | Proven mappings, accurate availability, storage/restart evidence and provider coverage report | WP5Aâ€“D and catalogue gap analysis complete. |
| 9 | **Final data integration acceptance** | Signed-off data coverage matrix; no unverified item mislabeled supported; M4/M5 statuses reconciled | Full regression, end-to-end verification and independent review. |

**Why sequential provider activation:** implement and verify each adapter independently first so failures can be attributed to the correct SDK, credentials, mapping or feed. Then test the same canonical instrument set with both providers simultaneously. The shared coordinator already exists to support this; do not simplify the test by bypassing it.

> **Post-baseline note (2026-11-27):** the completed G0 catalog-refresh programme is a prerequisite already satisfied at HEAD `3c34fba` â€” its write-coordinator/503 contract and composition-root ordering (Â§6.3, Â§7.7) must be preserved by every row above. No work package is invalidated; rows 3â€“8 simply need 503-retry-aware verification.

---

## 9. Data catalogue and coverage work package

This is not a request to rebuild the catalogue wholesale. It is a bounded verification and gap-closure task based on the existing master-file ingestion.

### Required work

1. Define the product's initial supported exchange/segment universe from existing requirements (do not invent a new universe in the provider adapter task).
2. Compare each provider master source with that universe and report record counts by exchange/segment/instrument type.
3. Identify duplicate, missing, stale and ambiguous provider mappings.
4. Verify exact native mapping for the Stage G smoke basket.
5. Verify underlying-to-option-contract, expiry, strike, lot size and tick size relationships for active derivatives.
6. Confirm expiry discovery uses the source/provider identity and freshness already represented by the WP4 metadata work.
7. Confirm refresh failures preserve last known-good data and do not make a partial file appear complete.
8. Determine which missing products are genuinely unavailable from a provider versus merely absent from current import filters.

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
| Catalog-write contention (G0) | Interactive write returns 503 `CATALOG_WRITE_BUSY` while refresh owns the permit; background sync/capture returns `skipped: true, retryable: true`; no partial write; retry after refresh succeeds; ownership/drain ordering preserved. |

### 10.2 Real-provider verification (separate from mocks)

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

**Consumer parity**

- Compare the same canonical persisted/live data through REST, WebUI and MCP.
- Confirm provider attribution, freshness, unsupported fields and errors agree.
- No consumer calculates its own competing provider-selection or normalization rules.

**Catalog-write contention (G0, 2026-11-27)**

- While a catalog refresh owns the write permit, an interactive historical fetch / snapshot capture / credential or subscription write returns HTTP 503 `CATALOG_WRITE_BUSY`; a background sync/capture returns `{ skipped: true, reason: "CATALOG_WRITE_BUSY", retryable: true }`.
- Retry after the refresh completes succeeds with no partial or duplicate write; the 503 is not misclassified as a provider/entitlement failure.

### 10.4 Project-level verification commands

At implementation time, OpenCode must inspect `package.json` scripts and existing test conventions first. Run the appropriate targeted provider tests, relevant market/API/WebUI/MCP tests, `bun run typecheck`, `bun run build`, the full test suite and `git diff --check`. Report exact commands and actual outcomes. Do not present local test results as CI results, and do not state that real connectivity passed if only mocks ran.

> **Current baseline (2026-11-27):** at HEAD `3c34fba` the declared runtime is **Bun 1.4.5** (`package.json:5`, commit `3d40441`) and the local full suite is **1253 pass / 0 fail** (14 new G0 test files added since this plan's baseline; recorded in `docs/G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md:31`). The plan's original baseline figures (Bun 1.4.4, 1115 pass / 0 fail at `28a2f34`) are historical. All results are local/agent-reported, not CI.

---

## 11. Security, reliability and operational constraints

1. **Read-only/data-only only.** Continue using the approved Upstox Analytics Token and FYERS non-trading/data-only app. Do not introduce trading scopes or order APIs.
2. **Credential boundary.** Credentials remain in the encrypted store and are used by backend adapters. No token in WebUI JavaScript, MCP output, logs, screenshots, fixture names or plan files.
3. **No hidden activation switch.** The production locked-driver boundary remains locked until the separate Stage G authorization and reviewed activation change. A documentation/plan task is not permission to activate providers.
4. **Single reconnect owner.** The existing Stage F supervisor owns reconnect/backoff/driver retirement. Provider SDK auto-reconnect must not create a second retry state machine.
5. **Provider isolation.** Upstox failure must not affect FYERS and vice versa. One missing provider mapping does not make the canonical instrument globally unavailable.
6. **Rate/plan limits.** Use observed/account-specific provider capacity and official current docs. Do not hardcode Prime entitlements or silently reduce the selected instrument set.
7. **Bounded work.** No unbounded message queues, retry storms, per-tick SQLite writes or unbounded concurrent REST jobs. Honor timeout, Retry-After, provider cooldown and shutdown cancellation. Interactive writes during a catalog refresh fail fast with HTTP 503 `CATALOG_WRITE_BUSY` and are retried only after the refresh releases the permit; background sync/capture skip (`skipped: true, retryable: true`) rather than queue.
8. **Honest timestamps.** Preserve source and receipt times separately. Do not infer a unit where docs do not specify one; FYERS LTT remains a specific verification item.
9. **REST cooldown ownership.** Preserve the existing FYERS shared cooldown/account-block semantics across FYERS historical and option-chain consumers. Do not use separate per-adapter state that circumvents a shared provider restriction.
10. **Data integrity.** Keep first-write-wins candle semantics and explicit conflict records. Do not overwrite stored candles merely because a second provider returns a different value.
11. **Privacy-safe evidence.** Store sanitized protocol fixtures only; no user-specific credentials or account data.
12. **No extra dependencies by default.** Keep the current pinned official SDKs and existing `fetch`/SQLite/service patterns unless a documented compatibility blocker requires a separately approved change.

---

## 12. Risks and unresolved items

| Risk / unknown | Why it matters | Required response |
|---|---|---|
| Upstox SDK feed mode semantics and actual fields | Existing code handles several modes, but account entitlement and live frame contents may differ | Verify live sanitized fixtures for each required field/mode before claiming support. |
| FYERS SDK operation under Bun on Windows | The adapter is pinned and tested structurally, but actual runtime compatibility remains a live validation item | Execute a bounded import/connect/close smoke test only after explicit Stage G authorization; if it fails, investigate a minimal adapter-local compatibility fix. Do not replace the SDK pre-emptively. |
| FYERS LTT unit/precision | Incorrect conversion can make fresh messages look stale or reorder updates | Keep untrusted until verified; use receipt ordering. |
| Field omissions versus explicit zero/clear | Incorrect partial merge can erase valid previous data or manufacture false values | Verify real samples; preserve current omission/clear semantics. |
| Upstox Plus expired-contract entitlement | Expired instruments endpoints are explicitly Plus-gated | Test actual account entitlement; report blocked if unavailable. Do not invent a workaround or assume entitlement. |
| FYERS Standard/Prime limits | Symbol, historical and REST quotas vary by plan | Read current official plan docs and verify actual account; report current limit as metadata, not a permanent universal value. |
| Upstox/FYERS field asymmetry | FYERS OI/IV/Greeks are REST/option-chain data, not Data Socket ticks; index data is reduced | Keep source and surface explicit; no cross-surface mislabeling. |
| Catalogue completeness | Broker masters may not represent every instrument in the desired universe | Publish coverage counts/gaps; scope support to proven provider-available records. |
| Different provider values | Provider prices may be sampled at different times or have different entitlements | Preserve both observations and provenance; do not average/blend values or assume one provider is always authoritative. |
| Token expiry while connected | FYERS access token expires daily at 6:30 AM; Upstox Analytics Token has a one-year validity | Ensure explicit expired/re-auth states, orderly disconnect and no credential leakage. |
| REST rate-limit interactions | History and option-chain adapters can share provider quotas/cooldowns | Use the existing cooldown ownership design and bounded request concurrency. |
| Live verification timing | Real feeds may only be validated during appropriate market sessions | Separate offline code readiness from live-session evidence; do not claim a blocked live test passed. |

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
- [ ] Independent review is clean and Stage G acceptance evidence is recorded.
- [ ] Stage G activation preserves the G0 catalog-refresh composition/ownership/drain ordering and treats 503 `CATALOG_WRITE_BUSY` as a transient retryable lock, not a provider failure.

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
- [ ] Full regression suite, typecheck, build and diff checks pass; independent review is clean.
- [ ] Catalog-write contention is verified: a transient 503 `CATALOG_WRITE_BUSY` / background `skipped: true` during refresh is retried successfully and never misreported as a provider failure; G0 ownership/drain ordering is preserved.

### Programme exit

Only after the above gates pass should the roadmap mark M4 Stage G and M5 Phase 4B complete and authorize M7 implementation. M7 can then consume actual canonical live updates and verified REST snapshots rather than waiting on provider activation.

---

## 14. Recommended first coding assignment

**Start with WP0 (preflight) followed by G1 (Upstox production driver bridge), not M7 and not a simultaneous broad rewrite.**

Why:

- Upstox has the earlier M4 Stage B stream adapter and a documented market-data SDK path.
- The first task can be bounded around the actual difference between `UpstoxMarketDataStream` and `StreamingDriver`.
- It reuses the coordinator/supervisor/canonical service already in the app.
- It gives a concrete end-to-end provider path before introducing the FYERS SDK runtime-specific uncertainties.
- FYERS is then implemented against the proven driver lifecycle and verified independently before the two providers are tested together.

The first implementation task should be an OpenCode assignment for **G1 only**, with G0 preflight evidence included in its report. It should not activate real production connections unless the separate Stage G authorization has been given. The coding agent must not be asked to implement WP5Aâ€“WP5E, M7 or the entire programme in one assignment.

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
| 1 | What new selectable options, capabilities, entities or configuration fields are introduced? | No new provider identity. It activates existing UPSTOX/FYERS streaming, historical and option-chain capabilities. Any genuinely missing field/depth capability must be identified in G0 and proposed as a narrow shared-contract extension before implementation. |
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
2. What exact FYERS `last_traded_time` unit and precision is used in real messages? Until confirmed, do not trust it for ordering/freshness.
3. Which exact Upstox feed modes provide each of OI, IV, Greeks, depth levels and extra `eFeedDetails` fields for the real account? Mode descriptions/examples are not sufficient proof of account access.
4. Are the user's actual Upstox Analytics Token and FYERS data-only app entitled for all intended active history, chain and streaming surfaces? What is the actual Upstox Plus status for expired endpoints and FYERS plan for data socket/history quotas?
5. Which product-required universe and segments should be accepted as first complete catalogue coverage? The plan assumes existing documented F&O-focused scope and requires the implementation report to enumerate actual broker coverage rather than claim the entire exchange universe.
6. Are any desired provider metrics absent from the canonical contracts (e.g. POP, aggregate PCR/call-put OI, circuit bands, CAS IEP/imbalance or year high/low)? Classify optional extras first; only promote product-required fields into shared contracts with a reviewed schema impact.

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

---

## Final recommendation

**The next coding task is G1 â€” Upstox production driver bridge, after a clean local preflight.** Then implement and verify FYERS using the same lifecycle, authorize and pass Stage G live activation, wire Upstox/FYERS history and option-chain providers into M5, verify instrument/field coverage, and complete end-to-end acceptance. Do not begin M7 until this programme is complete or every remaining provider limitation is explicitly accepted and documented.
