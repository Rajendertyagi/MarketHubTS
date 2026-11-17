# Multi-Provider Streaming Architecture and Market-Data Foundation

> **Status: PROPOSED — pending independent review and product-owner approval.** This document is a design reference, not an implementation authorization. No application source, tests, contracts, schemas, dependencies or runtime configuration were changed to produce it. It does not mark any milestone complete.
> **Last updated:** 2026-11-17
> **Related:** [ARCHITECTURE.md](ARCHITECTURE.md), [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) (AD-024), [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md), [REFERENCES.md](REFERENCES.md)

## 1. Purpose and scope

This is the detailed technical reference for how MarketHubTS should stream market data from **Upstox and FYERS simultaneously**, manage subscriptions once, and represent partial provider updates without losing data or provenance. It is written to be durable: the goal is a foundation that does **not** need redesigning when the second provider (FYERS) is added or when more instruments are streamed.

It covers three architecture decisions, recorded as **AD-024 (proposed, pending approval)** in [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md):

- **Decision A — subscription ownership:** one shared coordinator owns desired state and persistence; each provider has an independent runtime.
- **Decision B — canonical data-component model:** quote, depth and derivatives metrics are stored and selected independently, so partial messages cannot erase each other.
- **Decision C — provider-neutral capability contracts:** consumers request capabilities, not broker SDK mode names.

The confirmed product requirements in [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) are **not reopened** here.

## 2. Product requirements (confirmed — not reopened)

- AI-first, local-first Indian market-data platform focused on NSE/BSE F&O. It collects, normalizes, organizes, maintains and exposes market data. It is **not** a trading bot, order-placement app, broker account manager, or AI recommendation/prediction engine.
- Upstox and FYERS operate **independently and simultaneously** when configured; failure of either must not affect the other; the app works with either or neither (local/non-broker data).
- **One canonical data and application-services foundation** serves WebUI, MCP and REST/SSE. Provider-specific logic stays inside adapters. No duplicate market-data interpretation in consumers.
- Source selection considers capability, availability, freshness and reliability. Provider attribution, timestamps and raw provider-supplied values are preserved.
- **Never fabricate** OI, IV, Greeks, volume, depth or prices. Live ticks/depth stay in bounded memory; historical candles and option-chain snapshots have separate persistence strategies.
- Modular monolith; one local application owner with multiple connected clients; Windows-first, Bun + TypeScript. No unnecessary frameworks, microservices or generic plugin systems.

## 3. Current architecture and implementation state (verified from source)

This section reflects the actual `develop` source at HEAD `2e2384b`, not prior summaries.

### 3.1 What exists today

| Area | Verified implementation |
|---|---|
| Canonical service | `packages/market-core/src/live/service.ts` — `MarketDataService` facade over `LiveStateStore`; one instance composed in `apps/api/src/index.ts` and shared by REST, SSE and the supervisor. |
| Live state | `packages/market-core/src/live/store.ts` — `LiveStateStore` holds `LiveItem` per canonical ID; each item has `observations: Partial<Record<ProviderId, ProviderObservation>>` and one derived `selected: SelectedObservation`. Bounded by `maxInstruments`; monotonic revision; synchronous detached notifications; defensive `structuredClone`. |
| Observation model | `packages/contracts/src/live.ts` — `ProviderObservation` carries provider, canonical ID, `CanonicalLiveValue` (ltp, ltq, close, open, high, low, volume, `native`), source/receipt timestamps with unit and meaning, freshness, availability and provenance. `CanonicalLiveValue` has **no depth field**; depth is only ever inside `native`. |
| Source selection | `packages/market-core/src/live/selection.ts` — `selectObservation()` picks **one whole observation from one provider**; connected + FRESH observations win, ranked by compatible source timestamp or `receivedAt`; otherwise LAST_KNOWN fallback. |
| Freshness | `packages/market-core/src/live/freshness.ts` — session-aware (OPEN/CLOSED/UNKNOWN), source-vs-receipt age basis, bounded retained age. |
| Normalization | `packages/market-core/src/live/normalize.ts` — `normalizeObservation()` validates timestamps (MS/SECONDS/UNKNOWN), builds provenance, clones input. |
| Subscription persistence | `packages/database/src/subscriptions.ts` — `SqliteSubscriptionRepository` stores `streaming_subscriptions` rows and one durable generation in `app_meta` (`streaming_subscriptions_generation`); full replacement + generation increment in one serialized `BEGIN IMMEDIATE` transaction; no SDK/network work inside. |
| Supervisor | `apps/api/src/stream-supervisor.ts` — `StreamSupervisor` owns desired-state reconciliation, mapping resolution, shared `service.track/untrack`, and the full driver lifecycle. Stage F hardening: terminal driver instances, at-most-once `stop()`, mandatory `AbortSignal`, five-variant `OperationOutcome`, supervisor-owned logical completion, generation guards after async resolution, stale-callback gating by epoch + instance, explicit retry exhaustion, abort-safe retry sleep, deterministic timer seams. |
| Production boundary | `apps/api/src/index.ts` composes **one** `StreamSupervisor` with `provider` defaulting to `UPSTOX` and `createDriver: () => new LockedUpstoxDriver()`. The locked driver fails safely on `start`/`update`; no SDK, socket or retry is created. Real connection is Stage G and requires separate authorization. |
| Upstox stream | `packages/broker-upstox/src/stream.ts` — `UpstoxMarketDataStream` on pinned `upstox-js-sdk@2.31.0`; SDK behind a structural seam; emits `NormalizeObservationInput`; owns subscriptions, normalization, freshness and reconnection. Workarounds: `autoReconnect(false)` before connect, never SDK `changeMode()` (unsubscribe+subscribe), protobuf-readiness gate, defensive payload decoding. |
| FYERS | `packages/broker-fyers/src/index.ts` — V3 non-trading-app OAuth adapter only. **No Data Socket streaming adapter exists** (Stage C, on hold). |
| REST/SSE | `apps/api/src/market-routes.ts` — `GET /api/market/snapshot`, `GET /api/market/stream` (SSE), `GET/PUT /api/market/subscriptions` (PUT local-owner-only). `packages/realtime/src/hub.ts` — bounded replay/per-client queues, drop counters, coalesced `snapshot-required`, periodic `refresh`, cursor precedence. |
| WebUI | `apps/web/src/lib/live.ts` — pure reducer + canonical-field-only display projection; `value.native` and provider-native fields are never displayed. Stage E live-data tab exists. |
| MCP | `apps/mcp-server/src/index.ts` — STDIO `markethub_health` only; no market tools. |

### 3.2 Key issues discovered in existing code

These are the concrete problems the proposed architecture must solve. They are observations about the current code, not criticism of its correctness for the single-provider Stage D slice.

1. **One supervisor, hardwired to one provider.** `StreamSupervisor` is instantiated once with `provider: "UPSTOX"` and a locked Upstox driver. There is no FYERS runtime. Its `provider` field is a single `ProviderId`, and mapping resolution uses a hardcoded reason string `NO_ACTIVE_UPSTOX_MAPPING` (`stream-supervisor.ts:288`) even though the seam is provider-agnostic.
2. **Two supervisors would conflict.** `StreamSupervisor` owns persistence (via `SubscriptionRepository`), the durable generation, **and** shared `service.track/untrack` (`trackedIds`). Two instances would both write the same repository/generation and both mutate the same shared live state; one provider's `untrack()` could remove an instrument the other still needs. This is the central reason not to simply add a second supervisor.
3. **Partial-message data loss (Decision B).** `LiveStateStore.applyObservation()` does `item.observations = { ...item.observations, [provider]: stored }` — a **full replacement** of that provider's observation. FYERS sends price (`sf`) and depth (`dp`) as separate messages (§6). A depth-only message would erase a prior price observation from the same provider, and vice versa. `CanonicalLiveValue` has no depth field, so depth lives only in `native`, and `SelectedObservation` selects one whole observation — per-component source selection is impossible today.
4. **No provider-neutral capability request.** Shared contracts expose only `{canonicalId, enabled}` for subscriptions. `UpstoxFeedMode` (`ltpc`/`full`/`option_greeks`/`full_d30`) is adapter-local. There is no way for a consumer to request "quote + five-level depth" without knowing broker SDK terminology, and no way to report an unmet capability without silently downgrading.
5. **Mapping failure is conflated with global availability.** `applySelections()` marks an instrument `available: false` when no ACTIVE mapping exists for the one provider; with two providers this must become per-provider, and a missing mapping at one provider must not disable the canonical instrument globally.
6. **Locked boundary must be preserved.** Any design must keep real SDK construction/sockets unreachable in production until a separately authorized Stage G change.

### 3.3 Stage F guarantees that must be preserved

The proposed design reuses `StreamSupervisor` as the per-provider runtime lifecycle engine specifically to keep these guarantees: terminal driver instances with at-most-once `stop()`; mandatory `AbortSignal`; supervisor-owned logical completion so the serialized queue is released independently of driver settlement; generation re-check after every async resolution; stale callbacks ignored by epoch + active-instance checks; explicit retry exhaustion; abort-safe retry sleep; deterministic timer seams; shutdown releases all outstanding operations.

## 4. Indian NSE/BSE equity F&O domain considerations

Grounded in current official publications; see [REFERENCES.md](REFERENCES.md) §4–§7 and [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md) §1.4 for source URLs and access dates. **Rules and framework are not substitutes for actual listed-contract data.**

### 4.1 Supported universe (confirmed)

- **NSE:** cash-market indices via a discoverable catalogue (distinct from F&O underlyings); NSE F&O stocks; cash instruments for supported F&O stocks; stock futures/options; index futures/options for the approved six underlyings; current and expired contracts; relevant expiries and available strikes.
- **Approved six NSE index F&O underlyings:** NIFTY 50, NIFTY BANK (BANK NIFTY), FINNIFTY, MIDCPNIFTY, NIFTY NEXT 50, NIFTY INDIA FPI 150. These are a derivatives scope, **not** the wider cash-index catalogue. NIFTY India FPI 150 introduction date (08 Dec 2025) is distinct from current eligibility and actual contracts. NSE's underlyings table names item 4 "Nifty FPI 150" (symbol `NIFTYFPI`) while its products navigation says "Nifty India FPI 150 F&O" — the same product; `MIDCPNIFTY` is NSE's symbol for "Nifty MIDCAP SELECT". NSE also lists **discontinued** F&O products (NIFTY Midcap 50, NIFTY PSE, NIFTY Infrastructure, NIFTY CPSE) — product-level expiry, distinct from expired contracts of a live product.
- **BSE:** SENSEX and SENSEX futures/options only. BANKEX, SENSEX50 and BSE single-stock derivatives are **out of the approved product scope** (not a claim they do not exist).

### 4.2 Contract identity (canonical, provider-independent)

A derivative contract is identified by: **exchange + market segment + instrument type (`FUTIDX`/`OPTIDX`/`FUTSTK`/`OPTSTK`) + underlying + expiry date + strike + option type (`CE`/`PE`)**. `CE` = Call European, `PE` = Put European. The implemented identity key (`packages/market-core/src/identity.ts`) is `v1|EXCHANGE|SEGMENT|<CATEGORY>|<underlyingCanonicalId>|<YYYY-MM-DD>` for futures, plus `|<normalized strike>|<CE|PE>` for options. Upstox `instrument_key` and FYERS `fyToken`/symbol are **separate mappings** to the same canonical contract; unstable tokens (Upstox `exchange_token`, FYERS `exToken`) are never canonical identity.

### 4.3 Dynamic contract information — never hardcoded

Lot sizes, quantity freezes, strike schemes, expiries, active-contract lists and F&O eligibility are source-attributed, time-aware fields from authoritative exchange files: NSE `NSE_FO_contract_ddmmyyyy.csv.gz` (lot size + quantity freeze), `fo_mktlots.csv` (permitted lot size), `NSE_FO_SosScheme.csv` (stock-option strike scheme), `Strike Interval File.pdf` (index-option strike intervals), and daily `contract.gz` (active contract set). NSE reviews lot size every six months (basis SEBI CIR/MRD/DP/14/2015) and tick size monthly (NSE/FAOP/67135). **Expiry dates must be read from contract data, never computed from weekday rules.** SEBI's 26 May 2025 circular (SEBI/HO/MRD/MRD-TPD-1/P/CIR/2025/76, effective 1 Sep 2025; NSE implementing circular FAOP68589) sets one expiry weekday per exchange (NSE Tuesday, BSE Thursday), one weekly benchmark index option per exchange, and minimum one-month tenor for other equity derivatives; a holiday expiry moves to the previous trading day. These are rules, not contract values. BSE SENSEX futures/options are European style (asset code `BSX`); BANKEX, SENSEX50/SX50, BSE FOCUSED IT and BSE single-stock derivatives exist but are outside the approved product scope.

### 4.4 Implication for streaming

The catalogue may contain thousands of contracts, but only **owner-selected** instruments are streamed. Streaming selection is independent of snapshot capture and of catalogue membership. The architecture must distinguish catalogue-available, owner-selected, provider-supported, provider-actually-subscribed, fresh-observation, and incomplete/unavailable-component states (§10).

## 5. Verified Upstox V3 behavior

Official sources and the exact `upstox-js-sdk@2.31.0` source were reviewed on 2026-11-17 (full URL list in §16).

- **Lifecycle:** `WSS /feed/market-data-feed` with `Authorization: Bearer <token>` and `followRedirects: true`. Successful auth returns **302** and redirects to the authorized endpoint; the manual path is `GET /feed/market-data-feed/authorize` → `data.authorized_redirect_uri` with a **single-use** `code`. First message is `market_info` (segment status, CAS/pre-open status); second is a snapshot (`initial_feed` on the wire); then `live_feed` updates. Server sends ping frames; clients pong. Requests are **binary** frames.
- **Encoding:** Protobuf via the public `MarketDataFeed.proto`. `Feed` is a oneof of `ltpc`, `fullFeed`, `firstLevelWithGreeks`. Modes: `ltpc`, `option_greeks`, `full` (5-level), `full_d30` (30-level, **Plus-only**). `Type` enum: `initial_feed=0`, `live_feed=1`, `market_info=2`.
- **Fields:** LTPC = `ltp`, `ltt`, `ltq`, `cp`, conditional `iep`. Full = LTPC + 5 `Quote{bidQ,bidP,askQ,askP}` + `optionGreeks{delta,theta,gamma,vega,rho}` + `marketOHLC` + `oi`, `iv`, `atp`, `vtt`, `tbq`, `tsq`, CAS fields. **IV is a separate field, not inside `OptionGreeks`.** Index feed = LTPC + OHLC only (no depth/greeks).
- **Limits (verified):** 2 connections/user normal (5 Plus); LTPC 5000 individual / 2000 combined; Option Greeks 3000/2000; Full 2000/1500; Full D30 50/1500 (Plus). Over-limit behavior is not feed-specific.
- **SDK workarounds (verified from SDK source):** `autoReconnect` defaults **ON** — call `autoReconnect(false)` before connect; `changeMode()` sends `sub` instead of `change_mode` — never use it, do unsubscribe+subscribe; protobuf readiness is async — gate on `protobufRoot != null` with a bounded timeout; payloads may be `null`/string/Buffer — decode defensively. The existing `UpstoxMarketDataStream` already implements all four and should be **reused, not replaced**.
- **Historical:** V3 historical candle API is available under Analytics Token with no static IP; candle = `[timestamp, open, high, low, close, volume, open_interest]`. Expired-instruments APIs are reported as Plus-only (project finding; not confirmed on the official pages fetched).
- **Not verified:** account entitlements (Plus/D30), exact wire mapping of `firstLevelWithGreeks` and `full_d30`, feed-specific WebSocket error payloads/close codes, and why the proto says `full_d5` while docs say `full`.

## 6. Verified FYERS V3 Data Socket behavior

Official sources reviewed on 2026-11-17 (full URL list in §16).

- **Auth:** token format `appid:accesstoken`; access tokens **expire daily at 06:30** (error codes `-8`/`-15`/`-16`/`-17`). No in-socket refresh is documented; a long-running socket must reconnect with a fresh token after expiry.
- **Lifecycle:** Node SDK is EventEmitter-style with `connect`, `message`, `error`, `close`; subscribe from the `connect` callback. Dedicated thread. FYERS documents "create only one WebSocket instance at a time" for Data Socket/General WebSocket.
- **Message types:** `cn` (connection), `sub` (subscribe), `sf` (equity **and option** data), `if` (index data), `dp` (five-level depth), `unsub` (unsubscribe confirmation with `code:200`, `s:"ok"`). Exact `cn`/`sub` confirmation schemas are **not documented**.
- **CRITICAL — price and depth are separate messages.** `sf` carries LTP, day OHLC, `prev_close_price`, `ch`, `chp`, `vol_traded_today`, `last_traded_qty`, `last_traded_time`, `exch_feed_time`, and **only the single best bid/ask** (`bid_price`/`ask_price`/`bid_size`/`ask_size`). `dp` carries five-level depth (`bid/ask_price1..5`, `size1..5`, `order1..5`) and **no price fields**. They require distinct subscriptions (Node `subscribe(symbols)` vs `subscribe(symbols, true)`; Python `SymbolUpdate` vs `DepthUpdate`) and arrive on distinct ticks. A consumer must join them by symbol. **This is the direct cause of the Decision B requirement.**
- **Index (`if`):** LTP, OHLC, `prev_close_price`, `ch`, `chp`, `exch_feed_time`; **no volume, no bid/ask**. Sample values are **strings** (vs numbers in `sf`) — handle defensively.
- **OHLC is PRESENT** in `sf` and `if` (`open_price`, `high_price`, `low_price`); there is no separate current-day close field (`ltp` is latest, `prev_close_price` is prior day). This corrects the older saved plan's claim that FYERS has no OHLC.
- **OI / IV / Greeks are ABSENT from Data Socket** — available only via REST (`getOptionChain` / `get_fno_historical_data` with `include_greeks`/`include_oi`). No 30-level depth tier; 50-level is the separate TBT socket (Protobuf).
- **Limits (verified):** Data Socket 100 symbols Standard / 5,000 Prime, **per user across all connections**; TBT 1/15. Over-limit → connection not established. Current limits need at least Node SDK v1.1.1.
- **Reconnection:** opt-in; Node `autoReconnect(count)` (max 50), docs also spell `autoreconnect(trycount)` — casing discrepancy, requires live verification. With auto-reconnect on, previous symbols are resubscribed automatically. MarketHubTS should keep its own reconnection ownership (§9).
- **SDK:** `fyers-api-v3@2.4.1`; `DataSocket.getInstance(token, logPath, loggingFlag)` (README) vs `new FyersSocket(...)` (docs) — construction form and logging-flag polarity require live verification. `engines: node >=14`. Dependencies include `ws`, `axios`, `protobufjs`; shipped code is **obfuscated** (`javascript-obfuscator`). `setQueueProcessInterval(ms)` 1–2000 ms.
- **Timestamps:** `last_traded_time`/`exch_feed_time` are 10-digit Unix epoch **seconds** (inferred from sample values, not explicitly documented); `exch_feed_time` is not in the attribute tables.
- **Bun compatibility:** **not documented.** Node compatibility must not be assumed to imply Bun compatibility.

### 6.1 Native Bun WebSocket vs official SDK — recommendation

**Use the official `fyers-api-v3` SDK behind the adapter boundary; do not write a native Bun WebSocket client.** The raw Data Socket wire protocol (handshake, subscribe frames, token encoding, HSM framing) is **undocumented**; only the obfuscated SDK implements it. A native implementation would require reverse-engineering obfuscated code — brittle, unsupported, and contrary to the project's "no guessing / no invented APIs" rule. Node compatibility ≠ Bun compatibility: the SDK targets Node (`engines >=14`) and depends on `ws`/`axios`; running it under Bun is **Requires live verification**. Keep the adapter isolated so that if Bun execution fails, only the process boundary changes (e.g. a small Node subprocess) and the canonical service layer is untouched. This mirrors the accepted Upstox SDK exception. **No dependency is installed or changed by this document.**

## 7. Provider capability matrix

Statuses: **Verified** / **Plan-dependent** / **Not documented** / **Not available** / **Requires live verification**. "Not available" means the field does not appear in the documented live feed; it may exist via REST (noted).

| Capability | Upstox | FYERS |
|---|---|---|
| LTP | Verified (`LTPC.ltp`) | Verified (`ltp` in `sf`/`if`/lite) |
| OHLC | Verified (`MarketOHLC`, full mode) | Verified (`open/high/low_price` in `sf`/`if`; no current-day close field) |
| Volume | Verified (`OHLC.vol`, `vtt`) | Verified (`vol_traded_today` in `sf` only; not in `if`/lite) |
| Last traded qty / time | Verified (`ltq`, `ltt`) | Verified (`last_traded_qty`, `last_traded_time`; seconds inferred) |
| Best bid/ask | Verified (`Quote`, `firstDepth`) | Verified (single-level in `sf`; not in `if`/lite) |
| Five-level depth | Verified (full mode) | Verified (`dp`, separate subscription) |
| Thirty-level depth | Plan-dependent (`full_d30`, Plus-only) | Not available (5-level Data Socket; 50-level is TBT) |
| Open interest | Verified (`oi` in full/greeks feed) | Not available in Data Socket (REST `include_oi`) |
| Implied volatility | Verified (`iv` field, not in `OptionGreeks`) | Not available in Data Socket |
| Option Greeks | Verified (`delta/theta/gamma/vega/rho`) | Not available in Data Socket (REST `include_greeks`) |
| Index updates | Verified (`IndexFullFeed`: LTPC + OHLC) | Verified (`if`: LTP/OHLC/change, no volume/bid-ask) |
| Subscription limits | Verified (LTPC 5000/2000, Greeks 3000/2000, Full 2000/1500, D30 50/1500) | Verified (100 Standard / 5,000 Prime, per user across connections) |
| Connection limits | Verified (2/user normal, 5 Plus) | Not documented (only "one instance at a time"; TBT 3×5 on Prime) |
| Historical data | Verified (V3 candles, OHLCV+OI, no static IP) | Not available in Data Socket (REST, plan-dependent depth) |

**Rules for using this matrix:** a "Not available" live field must be reported as unavailable, never calculated from other fields. Plan-dependent capabilities (Upstox D30) must not be assumed for an account. Capability status is source-attributed and may change; do not hardcode a plan entitlement as a permanent architectural assumption (AD-023).

## 8. Decision A — shared subscription ownership + independent provider runtimes

### 8.1 Recommended design

Split the current `StreamSupervisor` responsibilities into two layers, reusing its Stage F lifecycle engine:

**Shared `SubscriptionCoordinator` (one instance, single writer):**
- Owns desired selections, the durable generation and `SubscriptionRepository` (the **only** writer).
- Validates canonical instruments against the catalog.
- Owns shared instrument tracking/untracking with **reference counting across providers** — an instrument is untracked only when no provider runtime still needs it.
- Fans out desired-state updates to each configured provider runtime; never blocks a healthy provider because another fails.
- Exposes the public `SubscriptionStateView` (desired generation + per-runtime status).

**Independent provider runtime (one per configured provider, e.g. `ProviderStreamRuntime` wrapping the existing `StreamSupervisor` lifecycle):**
- Resolves its **own** provider-native mappings (`listMappingsByCanonicalId` filtered by its provider id) and reports missing/unsupported mappings **per provider**.
- Applies the desired generation to its own driver; maintains its **own applied generation**.
- Owns connection, retry, timeout, error and driver-instance lifecycle (the existing Stage F engine).
- Reports: connection state, desired generation, applied generation, resolved instruments, unsupported/missing mappings, subscription-limit failures, last error, retry state.
- **Never writes** the shared desired-subscription repository and **never untracks** a shared instrument on its own.

### 8.2 Why this design

- It gives **exactly one durable generation owner** (acceptance criterion 1) and avoids two supervisors writing the same repository (§3.2 issue 2).
- It preserves Stage F guarantees by keeping the lifecycle engine intact per runtime.
- It makes provider independence structural: each runtime has its own epoch, driver factory, retry budget and error state; one failure cannot retire or block the other.
- It is a modest refactor, not a generic framework: the coordinator is a thin owner; the runtime is the existing supervisor with persistence and shared tracking removed.

### 8.3 Alternatives considered and rejected

- **Refactor the existing supervisor with minimal changes (keep one supervisor, add a provider list).** Rejected: it would still couple persistence, shared tracking and multiple provider lifecycles in one class, reintroducing the cross-provider untrack hazard and a single point of failure. It also cannot give each provider an independent applied generation cleanly.
- **Two independent supervisors, each writing the repository.** Rejected: violates the single-writer invariant and the "do not create two supervisors writing the same repository" constraint.
- **A generic plugin/framework layer.** Rejected: unnecessary abstraction for two known providers; contrary to "no generic plugin systems."

## 9. Decision B — canonical data-component model

### 9.1 Model

Replace "one whole observation per provider" with **independently updated components** per canonical instrument. A proposed component classification (justified by the provider message shapes in §5–§6, not five arbitrary abstractions):

| Component | Contents | Upstox source | FYERS source |
|---|---|---|---|
| `quote` | LTP, day OHLC, close, volume, last traded qty/time, best bid/ask | LTPC + full/index feed | `sf` / `if` |
| `depth` | Five-level (or D30) bid/ask price, size, order count | full / full_d30 `marketLevel` | `dp` |
| `derivatives` | OI, IV, Greeks | full / option_greeks feed | **not in Data Socket** (REST only) |
| `index` | Index LTP/OHLC/change | `IndexFullFeed` | `if` |
| `extended` | Provider-native fields preserved verbatim, attributed | `native` | `native` |

Each component instance carries: provider, canonical ID, value, source timestamp (+ unit + meaning), receipt timestamp, freshness, availability, provenance, and a component-level revision/sequence where available. Components are updated **only** by messages that actually contain them; a `dp` message updates `depth` and leaves `quote` untouched.

### 9.2 Where aggregation belongs

- **Provider adapter:** translates one provider message into one or more **component updates** (it alone knows `sf` vs `dp` vs `fullFeed` semantics). It does **not** aggregate across messages or providers.
- **Canonical market-data service:** owns component storage, freshness evaluation, and per-component source selection. This is the single source of truth for all consumers.
- This split keeps provider logic in adapters (invariant 3) and avoids duplicate interpretation in consumers (invariant 2).

### 9.3 Source selection — per component, with explicit attribution

Selection is performed **independently per component**: the best fresh `quote` may come from Upstox while the best fresh `depth` comes from FYERS. The result exposes, for each component, its own provider, timestamp, freshness and provenance. It must **never** present a single atomic "selected observation" that mixes fields from two providers as if they arrived together. Missing components are reported as unavailable/unsupported, not filled from another component or fabricated. Timestamp compatibility (§3.1 `timestampsCompatible`) is evaluated per component, not across components.

### 9.4 Alternatives considered and rejected

- **Keep one observation per provider and merge fields at read time.** Rejected: still loses a component when a partial message replaces the whole observation (§3.2 issue 3), and cannot represent two providers contributing different components with independent provenance.
- **Aggregate partial messages inside each adapter into a full observation.** Rejected: the adapter would need to retain cross-message state and would still force a single-provider selection; it also duplicates canonical storage logic in adapters.
- **Five fully separate services.** Rejected: unnecessary; components are fields within one canonical item, not independent services.

## 10. Decision C — provider-neutral capability contracts

### 10.1 Requirement

Consumers must never see broker SDK mode names (`ltpc`, `full`, `option_greeks`, `full_d30`, `SymbolUpdate`, `DepthUpdate`). Define a provider-neutral capability vocabulary in shared contracts, e.g. `quote`, `depth5`, `depth30`, `greeks`, `index`, with mandatory / optional / provider-dependent classification. A consumer requests capabilities per canonical instrument (or a defined selection layer); each adapter translates the request into its own subscription/mode calls.

### 10.2 Rules

- **No silent downgrade.** If a requested capability is unsupported or over a provider's limit, report it explicitly (availability `UNSUPPORTED`/`LIMITED` with a reason) rather than quietly dropping it.
- **No silent instrument removal** to fit a plan. Provider limits are enforced per runtime and reported; the shared desired state is unchanged.
- **WebUI** communicates unavailable capabilities clearly; the user never needs broker terminology.
- Capability availability is source-attributed and plan-aware (AD-023); do not hardcode a plan entitlement as permanent architecture.

## 11. F&O subscription management

- Distinguish six states per instrument: **catalogue-available**, **owner-selected**, **provider-supported**, **provider-actually-subscribed**, **fresh observation**, **incomplete/unavailable components**.
- A provider mapping failure is **provider-specific**: it does not disable the canonical instrument globally; another provider may still serve it.
- Subscription-budget exhaustion at one provider affects only that runtime; the other continues.
- **Efficient updates:** compute the diff between desired and applied native identifiers; subscribe/unsubscribe only changed symbols. Upstox mode changes are unsubscribe+subscribe (§5); FYERS symbol-list changes are unsubscribe-then-resubscribe (§6). Do **not** rebuild all subscriptions on every generation, and never auto-subscribe every catalogue contract.

## 12. Failure handling, recovery and concurrency

The design must account for: both connected; only Upstox; only FYERS; both disconnected; one reconnecting while the other streams; a provider failing during a subscription update; a newer desired generation arriving during mapping resolution; stale callbacks from retired instances; a provider reaching its symbol limit; missing mappings; partial quote/depth messages; out-of-order and duplicate messages; stale source timestamps; shutdown with an operation pending; and multiple WebUI/REST/SSE/MCP clients.

Mechanisms: Stage F generation re-check after async resolution; epoch + instance callback gating; terminal instances with at-most-once stop; bounded retry with explicit exhaustion; per-component monotonic guards (ignore stale/duplicate source timestamps per component); bounded queues and memory (existing `LiveEventHub` bounds); coordinator fan-out that isolates a failing runtime; shutdown that stops runtimes before the hub and DB close.

## 13. API / WebUI / MCP implications

- **REST/SSE:** `GET /api/market/snapshot` and the SSE stream must expose the component model with per-component provenance. This is a **breaking shape change** to `LiveSnapshot`/`LiveItem`/`LiveChangeEvent` contracts; the realtime hub's revision/cursor logic is reused, but event payloads change.
- **WebUI:** `apps/web/src/lib/live.ts` projects only canonical fields from `item.selected`; it must be extended to render per-component values and provenance, still excluding `native`. Connection status remains composed from the canonical service.
- **MCP:** currently STDIO health only. When market tools are added (M6), they must consume the same canonical component data via shared services — no separate interpretation. On-demand retrieval must not mutate operational config.
- **Provider status:** `apps/api/src/provider-routes.ts` composes auth status with `service.getConnectionStatus(provider).state`; with per-runtime status this composition extends to applied generation, mapping failures and retry state, exposed read-only for LAN clients.

## 14. Migration strategy (proposed, not authorized)

1. **Contracts first (additive):** introduce component types and a provider-neutral capability vocabulary alongside existing live contracts; keep the old observation shape during transition.
2. **Canonical service:** add component storage and per-component selection behind the `MarketDataService` facade; keep `applyProviderUpdate` as a compatibility shim that maps to the `quote` component.
3. **Coordinator extraction:** split persistence + shared tracking from `StreamSupervisor` into `SubscriptionCoordinator`; keep the lifecycle engine as `ProviderStreamRuntime`. Verify Stage F tests still pass unchanged where behavior is preserved.
4. **Adapters:** add the FYERS Data Socket adapter (separately authorized Stage C) emitting component updates; reuse `UpstoxMarketDataStream` with component-aware output.
5. **Consumers:** update WebUI projection and REST/SSE payloads; add MCP market tools later.
6. **Locked boundary:** real driver construction remains gated by Stage G; this migration does not unlock it.

Each step is independently testable and reversible; no step changes the locked production boundary.

## 15. Acceptance criteria and required tests

Acceptance criteria (measurable):

1. Exactly one durable desired-subscription generation owner.
2. Both providers independently reconcile the same desired state.
3. Each provider reports its own applied generation.
4. One provider failure does not interrupt the other.
5. One provider cannot untrack an instrument still required by shared canonical state.
6. Quote and depth updates cannot overwrite each other.
7. Every component preserves independent provenance and freshness.
8. Source selection does not fabricate fields or hide missing data.
9. Provider mapping failures remain provider-specific.
10. Subscription limits are enforced without silent downgrades.
11. Existing Stage F lifecycle and cancellation guarantees remain intact.
12. API and WebUI expose both provider states accurately.
13. MCP and REST/SSE consume the same canonical data.
14. Tests use deterministic fake providers and fixtures.

Required regression tests (to be written with implementation, not by this document):

- Single-writer generation: concurrent PUTs produce one committed generation; two runtimes never both write the repository.
- Two-runtime reconciliation: same desired state applied independently; distinct applied generations; one runtime failing does not change the other's state.
- Shared tracking: runtime A untracking an instrument still desired by runtime B does not remove it from canonical state (reference counting).
- Partial messages: a `dp`-only update leaves `quote` intact; an `sf`-only update leaves `depth` intact; both preserve independent timestamps/provenance.
- Per-component selection: fresh Upstox quote + fresh FYERS depth coexist with correct per-component attribution; no mixed atomic snapshot.
- No fabrication: absent OI/IV/Greeks/depth reported unavailable; no cross-field calculation.
- Mapping failure: missing FYERS mapping does not disable an instrument served by Upstox, and vice versa.
- Limits: over-limit request reported as `LIMITED` with reason; desired state unchanged; no silent downgrade.
- Stage F regression: terminal-instance retirement, at-most-once stop, stale-callback gating, generation re-check, retry exhaustion, shutdown release — all existing Stage F tests remain green.
- Consumer parity: REST/SSE snapshot and WebUI projection expose identical component data; MCP (when added) uses the same service.
- Deterministic fakes only; no live broker connection or credentials.

## 16. Official sources and access dates

All accessed **2026-11-17** unless noted.

**Upstox**
- Market Data Feed V3: https://upstox.com/developer/api-documentation/v3/get-market-data-feed/
- Market Data Feed Authorize V3: https://upstox.com/developer/api-documentation/get-market-data-feed-authorize-v3
- Public V3 proto: https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto
- Streamer functions: https://upstox.com/developer/api-documentation/streamer-function
- Analytics Token: https://upstox.com/developer/api-documentation/analytics-token/
- Rate limits: https://upstox.com/developer/api-documentation/rate-limiting/
- Error codes: https://upstox.com/developer/api-documentation/error-codes
- Historical Candle Data V3: https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/
- Proto deprecation notice: https://upstox.com/developer/api-documentation/announcements/market-proto-changes-notice
- SDK install: https://upstox.com/developer/api-documentation/installing-sdk
- SDK source (v2.31.0 commit): https://github.com/upstox/upstox-nodejs

**FYERS**
- Data Socket overview: https://fyers.in/api-docs/v3/api/websockets/data-socket/overview/
- Symbol update: https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-symbol-update/
- Indices update: https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-indices-update/
- Depth update: https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-depth-update/
- Lite mode: https://fyers.in/api-docs/v3/api/websockets/data-socket/data-socket-lite-mode/
- Connect and subscribe: https://fyers.in/api-docs/v3/api/websockets/data-socket/overview/data-socket-connect-and-subscribe/
- Unsubscribe and connection management: https://fyers.in/api-docs/v3/api/websockets/data-socket/overview/data-socket-unsubscribe-and-connection-management/
- Advanced configuration: https://fyers.in/api-docs/v3/api/websockets/data-socket/overview/advanced-configuration/
- WebSocket overview: https://fyers.in/api-docs/v3/api/websockets/websocket-overview/
- SDKs and libraries: https://fyers.in/api-docs/v3/getting-started/sdks-and-libraries/
- Plans and limits: https://fyers.in/api-docs/v3/getting-started/plans-and-limits/
- Authentication: https://fyers.in/api-docs/v3/api/authentication/
- `fyers-api-v3` npm: https://www.npmjs.com/package/fyers-api-v3

**NSE / BSE / SEBI** (see [REFERENCES.md](REFERENCES.md) §4–§7 for full list and observation dates)
- NSE equity derivatives contract specifications: https://www.nseindia.com/products-services/equity-derivatives-contract-specifications
- NSE equity derivatives contract information: https://www.nseindia.com/products-services/equity-derivatives-contract-information
- NSE equity derivatives products: https://www.nseindia.com/products-services/equity-derivatives-products
- SEBI final settlement/expiry day circular (26 May 2025): https://www.sebi.gov.in/legal/circulars/may-2025/final-settlement-day-expiry-day-for-equity-derivatives-contracts_94189.html

## 17. Known risks and unverified questions

- **FYERS SDK on Bun:** not documented; requires a live, credentialed smoke test before committing to Bun-native execution. Node compatibility is not proof of Bun compatibility.
- **FYERS discrepancies:** `autoReconnect` vs `autoreconnect` casing; `getInstance` vs `new FyersSocket`; logging-flag polarity; timestamp units (seconds inferred); `cn`/`sub` confirmation schemas; `exch_feed_time` not in attribute tables. All require live verification.
- **Upstox entitlements:** account Plus/D30 access, exact wire mapping of `firstLevelWithGreeks`/`full_d30`, feed-specific error payloads/close codes, `full_d5` vs `full` naming — require live verification.
- **Contract data:** current F&O eligibility, listed contracts, expiries, strikes, lot/tick/freeze and provider-native identifiers must come from current official sources before integration; introduction/observation dates are not current eligibility. NSE product pages are behind anti-bot protection; their content was obtained from NSE static mirrors and circulars. The SEBI circular 2025/76 PDF body was not directly parseable — its provisions rest on official-adjacent reproductions and NSE's implementing circular (FAOP68589); re-verify the primary PDF before implementation.
- **Breaking contract change:** the component model changes `LiveSnapshot`/`LiveItem`/`LiveChangeEvent` shapes; all consumers (WebUI, REST/SSE, future MCP) must migrate together.
- **Stage G gate:** no live connection is authorized; the locked production boundary must remain until a separately authorized, independently reviewed change.
- This document is a **proposal**; it requires independent review and product-owner approval before any implementation.
