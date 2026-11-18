# M5 (Stage 5) — Historical Candles and Option-Chain Snapshot Persistence Plan (Optimized)

> **Status:** Planning only. No implementation, source/test modification, commit, push, merge, or DB change performed for M5. Awaiting independent review and explicit implementation authorization.
> **Baseline:** M5 planning baseline `2e7ec2799ef73401f355075088501cd6dfdc2195` (the commit on which M5 planning began); `main` @ `865d86f393a29bc1ec8d455a51d9efa82d722c48`. Final reviewed Stage C state `e8ce409eddbaf50c1363dfa0d4e5bc9e82d31ddd`; original Stage C implementation `e236e254b90b390077613c7f055ae1bb070bd13e`. The active `develop` HEAD is intentionally not recorded here — re-check with `git log -1`.
> **Governing docs:** `AGENTS.md`, `PROJECT_MANAGER_PROTOCOL.md`, `ENGINEERING_STANDARDS.md` (canonical), `PRODUCT_REQUIREMENTS.md` §6.2–6.4, `DATA_LIFECYCLE_AND_STORAGE.md` §3–4, `IMPLEMENTATION_ROADMAP.md` M5, `ARCHITECTURE.md`, `MULTI_PROVIDER_STREAMING_ARCHITECTURE.md` §6.2/§7.1, `REFERENCES.md`.
> **Revision:** optimized after independent architecture review — five tables (not six), derived coverage, offline adapter code, weekday-only gap heuristic, resolved v2 deprecation question.

## 1. Settled direction (do not re-litigate)

M5 delivers two persistent lifecycles — **historical candles** and **option-chain snapshots** — through the existing canonical services. Build the provider-agnostic core (contracts, storage, services) first with deterministic fakes. Provider REST adapters are written against **documented** contracts with mocked `fetchImpl` (offline, unblocked); **activation** (real requests, wiring into services) is Stage-G-gated. No broker-DB replication, no fabricated raw fields, no new runtime dependencies, no new permanent branch, no live auth/socket/network in M5.

Preserved without change: Stage C structural-adapter seam, AD-024 foundation, `isLocalPeer` local-owner boundary, `fetchWithTimeout`/`fetchWithRetry`/`sanitizeError`, `app_meta` validated-read pattern, `SqliteProviderSettings` boundary, ComponentStore/service patterns, WebUI ownership of operational config, no fixed provider priority, MCP market tools are M6.

## 2. Verified current state (inspected, not assumed)

| Area | Verified fact |
|---|---|
| `packages/contracts` | `market.ts` (Provenance, AvailabilityState, ProviderId), `provider.ts`, `live.ts`, `live-components.ts` (component model, capability contracts). **No candle/snapshot schemas.** |
| `packages/database` | `schema.ts`: `app_meta(key,value,updated_at)`, catalog tables, `provider_settings`, `provider_credentials`, `streaming_subscriptions`. Migrations `0000`–`0004`. `SqliteSubscriptionRepository` uses a serialized `BEGIN IMMEDIATE` transaction + durable generation in `app_meta` (`streaming_subscriptions_generation`) — the pattern to reuse. `SqliteProviderSettings` is provider-specific non-secret KV only. |
| `packages/market-core` | `identity.ts`, `sync.ts` + `sync/{resolve,normalize,apply}`, `provider.ts` (`fetchWithTimeout`, `fetchWithRetry`, `parseRetryAfter`, `sanitizeError`, `FetchLike`), `live/{store,service,selection,freshness,normalize,components}`. **No historical/snapshot service.** |
| `packages/broker-upstox` / `broker-fyers` | Auth adapters + Stage C streaming adapters only. Structural seams (`SdkStreamer`, `StreamerFactory`), no `apps/api` imports, `fetchImpl` injection. **No REST historical/option-chain calls.** |
| `apps/api` | `market-routes.ts` (snapshot/SSE/subscriptions, PUT guarded by `isLocalPeer`), `provider-routes.ts`, `stream-supervisor.ts`, `subscription-coordinator.ts`, `app.ts`, `lib/net.ts`. |
| `apps/web` | `lib/{live,live-stream,subscriptions,status,retry-sleep}.ts`, `components/{LivePanel,SubscriptionPanel,StatusBadge}.tsx`. |
| `apps/mcp-server` | STDIO `markethub_health` only. MCP market tools are M6. |
| Manifests | `contracts`→zod 4.6.7; `database`→drizzle-orm 0.45.4; `market-core`→contracts only. `db:generate` = `drizzle-kit generate`. **No new runtime dependency is needed.** |

## 3. Provider facts (official docs fetched 2026-11-18; full URL list in §12)

### FYERS — Standard is NOT excluded from expired data
| Capability | Standard | Prime |
|---|---|---|
| Historical daily | last 5 years (from 2021) | 25+ years |
| Historical intraday | last 1 year (from 2025) | 5+ years |
| Seconds | unavailable | last 30 days |
| **Expired F&O daily** | **last 2 years** | 7+ years |
| **Expired F&O intraday** | **10 API requests/day** | overall rate limits |
| Data APIs | 5/s, 50/min, 5,000/day | 10/s, 500/min, 500,000/day |

- Regular history: `range_from`/`range_to` (epoch or `yyyy-mm-dd`), `cont_flag=1` continuous F&O, `oi_flag=1` OI; candle `[epoch,O,H,L,C,volume]`(+OI); 100 days/req for 1–240 min (from 3 Jul 2017), 366 days for 1D/1W/1M; use previous completed minute as `range_to`.
- Expired F&O: expired contracts only; `include_oi`, `include_greeks` (CE/PE only); first six columns fixed, **optional columns must be read by name from `columns`** (official table says `implied_volatility`, success example says `iv` — do not hardcode indexes); HTTP 422/`-50` invalid input; `s:"no_data"` + empty candles = empty result; **Greek values may be `null` — never zero-fill or copy-fill**; monthly "coming soon"; seconds 30 days/req; availability NSE 10 Oct 2018, BSE 7 Aug 2023, MCX 11 Oct 2018; Greeks unavailable for MCX, NCOM has no historical F&O.
- **Phase 3 must not require Prime.** Expired F&O is a narrower Standard capability.

### Upstox — two distinct endpoints
| | Active contracts | Expired contracts |
|---|---|---|
| Path | `GET /v3/historical-candle/{instrument_key}/{unit}/{interval}/{to_date}/{from_date}` | `GET /v2/expired-instruments/historical-candle/{expired_instrument_key}/{interval}/{to_date}/{from_date}` |
| Family | V3 | **v2 (separate family)** |
| Entitlement | Analytics Token (Historical Data) | **Upstox Plus** (official badge) |
| Intervals | minutes 1–300, hours 1–5, days/weeks/months 1 | `1minute,3minute,5minute,15minute,30minute,day` |
| Availability | min/hr from Jan 2022; day/week/month from Jan 2000 | duration limits **unverified** (SDK figures not on endpoint page) |
| Window | 1 month (1–15m), 1 quarter (>15m/hr), 1 decade (day), none (week/month) | **unverified** |
| Response | `{status,data:{candles:[[ts,O,H,L,C,volume,open_interest],...]}}` | same shape |

- `from_date` optional; over-limit → invalid-request error. `expired_instrument_key` = key + expiry (sample `NSE_FO|73507|24-04-2025`), obtained from expired-contract APIs.
- **v2 deprecation resolved:** the 30 Jun 2025 deprecation notice lists 9 v2 APIs (orders, historical/intraday candle, OHLC/LTP quotes, feed, feed-authorize) and does **not** include the expired-instruments historical-candle endpoint, which remains on current docs. Account entitlement still unverified.

### Option chain (REST-only for FYERS)
- FYERS `optionchain`: per-strike `oi, oich, oichp, prev_oi, volume, ltp, ltpch, ltpchp, bid, ask`, nested `greeks{delta,gamma,theta,vega,iv}` when `greeks=1`; first entry is the underlying (`strike_price:-1`); `expiryData`, `indiavixData`; `strikecount` max 50.
- Upstox exposes Option Contracts and Put/Call Option chain endpoints; **detail field shape unverified** (only index page fetched) — gate mapping on Stage G.
- FYERS OI/IV/Greeks are **not** Data Socket fields (AD-024 §6.2); they are REST-only and belong to M5, never to a live tick.

## 4. Lean storage design — five tables + validated `app_meta`

Every table is justified by a distinct, non-derivable responsibility. Nothing else is created.

| Table | Why it exists | Key / constraints |
|---|---|---|
| `historical_candles` | The candle cache itself. Required. | PK `(canonical_id, interval, ts_ms)`; OHLC required, volume/OI nullable; `provider`, `provenance_json`, `received_at`. **No FK to catalog** (deliberate: history survives catalog/expiry removal). |
| `candle_range_notes` | The only **non-derivable** range facts: `UNAVAILABLE` (reason code + detail + provider) and `CONFLICT` (competing provider + values). `COVERED`/`PARTIAL` are derived from candle rows, not stored. | PK `(canonical_id, interval, provider, range_start_ts, kind)`; `range_end_ts`, `reason_code`, `reason_json`, `requested_at`, `updated_at`. |
| `historical_sync_configs` | WebUI-owned user sync config (per instrument/interval/range/schedule/provider policy). Distinct lifecycle from streaming subscriptions and provider settings. | `id` PK; `canonical_id`, `interval`, `enabled`, `date_range_json`, `schedule_json` (nullable), `provider_policy_json`, timestamps. |
| `option_chain_capture_configs` | WebUI-owned capture config (underlying/expiry/strikes/capture mode/schedule/streaming flag/provider). Needed before any snapshot exists. | `id` PK; `underlying_canonical_id`, `expiry_date`, `strike_range_json` (null = all), `capture_enabled`, `capture_mode`, `schedule_json`, `streaming_enabled`, `provider`, timestamps. |
| `option_chain_snapshots` | The snapshot archive. Separate persistence strategy from candles and live state (required). | `id` PK; `config_id` **nullable** `REFERENCES option_chain_capture_configs(id) ON DELETE SET NULL`; `captured_at`, `provider`, `envelope_json`, `provenance_json`; index `(config_id, captured_at)`. |

**Retention lives in `app_meta`** under key `retention_settings` as a Zod-validated JSON value, read/written through a small `AppSettings` service that mirrors `readGeneration()`'s validated-read pattern. It is **not** a new table and **not** `provider_settings` (which is provider-specific non-secret config). Retention applies by data class (`CANDLE`, `SNAPSHOT`) with user-controlled bounds; no hidden fixed policy.

**Why not six tables:** `app_settings` was a generic 4th KV store; `candle_coverage_ranges` duplicated information already in `historical_candles` and could drift (a `COVERED` row for provider B while the stored candles are provider A's, because first-write-wins). Deriving coverage from candle rows makes provenance truthful by construction and removes a whole write path that had to be kept transactionally consistent with candle writes.

**Why not merge the two config tables:** they have different validation schemas, different consumers (candle service vs snapshot service), and different lifecycles. A discriminated JSON blob would weaken DB constraints and clarity for no real gain at the expected (small, user-authored) row counts.

## 5. Coverage, gaps, and conflicts (correctness first)

- **Coverage is derived**, never stored as a claim: for `(canonical_id, interval)`, the covered timestamps are exactly the `ts_ms` values in `historical_candles`, each with its own `provider`. A requested window minus covered timestamps minus `UNAVAILABLE` notes = candidate gaps.
- **`UNAVAILABLE` notes are authoritative**: written only from a provider response that explicitly reports entitlement failure, date-range limit, or `no_data`. They carry a stable `reason_code` (`ENTITLEMENT`, `DATE_LIMIT`, `NO_DATA`, `RATE_LIMITED`) and a sanitized detail. They are not retried against the same provider until config/entitlement changes.
- **Candidate gaps are explicitly approximate in M5.** No exchange-calendar source exists in this repo and calendars are a later-phase market-wide source. Gap derivation uses a **weekday-only** filter (weekends excluded) and labels every gap with `gapBasis: "WEEKDAY_ONLY"`. Exchange holidays are therefore *not* asserted as missing candles; calendar-backed detection is deferred until a verified calendar source exists. **No candle is ever fabricated to fill a gap.**
- **Alternate-provider fill**: a candidate gap or `UNAVAILABLE` range may be fetched from another provider per the configured policy. Successful fills write candles attributed to that provider; the original `UNAVAILABLE` note is retained (so we do not pointlessly retry the first provider).
- **Conflicts**: PK is provider-agnostic. **First valid write wins** — an existing candle is never overwritten by an alternate fill or duplicate response. Same-provider refresh replaces only on explicit re-sync with a newer `received_at`, and is idempotent for identical payloads. A differing value from another provider is **not applied**; a `CONFLICT` note records the competing provider and values for visibility. Stored provenance is never changed by a rejected conflict.
- **Automatic selection** uses the configured provider policy plus existing capability/availability/freshness logic — no hardcoded priority.

## 6. Snapshot envelope and field semantics

- **Canonical envelope**: `underlying_canonical_id`, `expiry_date`, `captured_at` (local), `observation_timestamp` (provider, **nullable**), `underlying_ltp` (nullable), `strikes[]`, `provider_extensions`.
- **Minimal canonical strike fields**: `strike`, `optionType`, `ltp`, `oi`, `volume`, `bid`, `ask`, `iv`, `greeks{delta,gamma,theta,vega,rho?}`. Provider extras (`oich`, `oichp`, `prev_oi`, `ltpch`, `ltpchp`, `greeks_at`, `fyToken`, `fp`) stay in `provider_extensions` until explicitly promoted.
- **Field presence**: missing = key absent; explicit `null` = key present with `null` (provider sent null, e.g. FYERS Greeks); unsupported = reported in availability, not fabricated; valid `0` = stored as `0`. Optional FYERS columns are mapped **by name from `columns`**, never by fixed index.
- **`observation_timestamp` is never defaulted to `captured_at`.** When the provider supplies no observation time, it is `null` and availability says `UNKNOWN`. The two timestamps are always distinct fields.
- **`capture_enabled`** is the master switch; `capture_mode` = `MANUAL` | `SCHEDULED` | `BOTH`; cadence is a simple bounded interval, no scheduler framework. Streaming selection is independent of capture.
- **No pre-collection claims**: snapshots before local collection began are never claimed unless a provider actually supplies historical snapshot data (none verified).

## 7. Ownership, immutability, and deletion safety

- **WebUI owns** sync config, capture config, and retention. Writes go through routes guarded by `isLocalPeer` (no new auth framework). AI/MCP cannot mutate them (service-level invariant, enforced now even though MCP wiring is M6).
- **On-demand immutability**: `HistoricalCandleService.fetchOnDemand()` and `OptionChainSnapshotService.captureOnDemand()` take explicit request objects and **never read or write** `historical_sync_configs` / `option_chain_capture_configs`. Only `runSync()` / scheduled capture read config. On-demand candles may be cached; on-demand option-chain results are returned without changing saved capture config.
- **Deletion safety**: candles/snapshots have no FK to catalog, so catalog sync, expiry, and provider removal never erase history. Deleting a capture config sets `snapshot.config_id = NULL` (snapshots retained under global retention). Only explicit retention cleanup deletes rows, bounded by class and age, FK-safe. Provider removal never deletes candles/snapshots (they are keyed by canonical ID, not provider).

## 8. Phases, gates, and dependency ordering

| Phase | Content | Gate |
|---|---|---|
| **1 — Contracts + storage** (offline) | `contracts/src/historical.ts`, `contracts/src/snapshots.ts`, `index.ts` re-exports; `database/src/schema.ts` + generated migration `0005_*`; `repositories/candles.ts`, `repositories/snapshots.ts`, `app-settings.ts`; `index.ts` exports. | None. |
| **2 — Canonical services** (offline) | `market-core/src/historical/{service,gaps}.ts`, `market-core/src/snapshots/service.ts`, `index.ts` exports; deterministic fake-provider tests. | Phase 1. |
| **3 — Provider REST adapters** (offline code + mocked fetch) | `broker-upstox/src/{historical,option-chain}.ts`, `broker-fyers/src/{historical,option-chain}.ts`, `index.ts` re-exports. Structural seams, no `apps/api` imports, `fetchImpl` injection, `fetchWithTimeout`/`fetchWithRetry`/`sanitizeError`. Capability/limit status stays `UNKNOWN`/`UNVERIFIED`. | **Unblocked** (documented contracts + mocked fetch only). No live request. |
| **4A — Local API + WebUI** (offline) | `apps/api/src/historical-routes.ts`, `snapshot-routes.ts`, `app.ts`; `apps/web/src/lib/{historical,snapshots}.ts`, `components/{HistoricalPanel,SnapshotPanel}.tsx`. Cached reads, config CRUD, retention, manual capture with fakes. | Phases 1–2. |
| **4B — Provider-backed activation** | Wire verified adapters into services; integration tests at adapter/service boundary. Capability status may move from `UNVERIFIED` only after Stage G. | **Stage G** (separately authorized). No live auth/socket/network in M5. |

MCP exposure is M6. M5 only guarantees the service-level on-demand immutability invariant.

## 9. Files (exact)

- **New contracts:** `packages/contracts/src/historical.ts`, `packages/contracts/src/snapshots.ts`; changed `index.ts`.
- **Changed:** `packages/database/src/schema.ts`; **new** `packages/database/drizzle/0005_*` (generated via `bun run db:generate`), `packages/database/src/repositories/candles.ts`, `repositories/snapshots.ts`, `app-settings.ts`; changed `index.ts`.
- **New:** `packages/market-core/src/historical/service.ts`, `historical/gaps.ts`, `snapshots/service.ts`; changed `index.ts`.
- **New:** `packages/broker-upstox/src/historical.ts`, `option-chain.ts`; `packages/broker-fyers/src/historical.ts`, `option-chain.ts`; changed both `index.ts`.
- **New:** `apps/api/src/historical-routes.ts`, `snapshot-routes.ts`; changed `app.ts`.
- **New:** `apps/web/src/lib/historical.ts`, `lib/snapshots.ts`, `components/HistoricalPanel.tsx`, `components/SnapshotPanel.tsx`.
- **New tests:** `tests/market/historical.test.ts`, `tests/market/snapshots.test.ts`; **extend** `tests/database.test.ts` for migration `0004→0005` upgrade preserving `app_meta`/catalog/subscriptions.

## 10. Required deterministic regression tests (name the scenario)

1. **Disjoint coverage**: two non-contiguous fetched windows; gap between them reported with `gapBasis`; no candle fabricated in the gap.
2. **Provider conflict**: same key from A and B with different OHLC → first write wins, `CONFLICT` note recorded, stored provenance unchanged; duplicate identical response is idempotent; explicit same-provider refresh only with newer `received_at`.
3. **Alternate fill**: A returns `UNAVAILABLE` for a range; B fills it; candles attributed to B; A's note retained; no overwrite of A's valid candles.
4. **Weekday-only gaps**: weekend dates never reported as gaps; a weekday with no candle is reported as approximate (`WEEKDAY_ONLY`), never as a definite missing candle; no calendar dependency introduced.
5. **Snapshot field semantics**: provider `null` Greek → key present with `null`; omitted field → key absent; provider `0` → stored as `0`; `observation_timestamp` absent → `null` (never `captured_at`); optional FYERS column mapped by name from `columns` despite doc inconsistency.
6. **Config immutability**: on-demand fetch/capture with a config-shaped payload creates/modifies no config rows; only `runSync()`/scheduled capture reads config.
7. **Deletion safety**: candles survive provider removal and catalog/expiry removal; snapshots survive capture-config deletion (`config_id` nulled); retention cleanup bounded, FK-safe, no cascade history loss.
8. **Retention**: user-configured values in `app_meta` validated on read; invalid value falls back safely; no hidden fixed policy.
9. **Restart persistence**: candles, snapshots, configs, retention survive close + reopen.
10. **Local-owner-only**: non-loopback PUT to config routes → 403 via `isLocalPeer`.
11. **Migration**: `0005` applies on a fresh DB and on upgrade from `0004` without touching `app_meta`, catalog, or subscriptions.
12. **Adapter mapping (mocked fetch)**: Upstox V3/expired 7-element candles and FYERS regular/expired `columns`-based mapping; `no_data`, 422/`-50`, null Greeks, rate-limit, malformed-200 all handled explicitly; no live network.

## 11. Acceptance criteria

- Cached candles survive provider disconnect/removal and restart; disjoint coverage, unavailable periods, and partial failures reported explicitly, never fabricated.
- Gap derivation is weekday-only and labeled approximate; calendar-backed detection is explicitly deferred; alternate fill respects policy and never overwrites valid candles.
- Provider conflicts deterministic (first-valid-wins), provenance preserved, conflicts visible via `candle_range_notes`.
- Snapshots use the canonical envelope with provider extensions; missing/null/unsupported/zero distinguishable; observation and capture timestamps distinct; manual/scheduled capture works; streaming independent of capture.
- Retention user-configurable in validated `app_meta`; deletion rules in §7 hold; cleanup bounded and FK-safe.
- On-demand retrieval never mutates saved config; operational config writes local-owner-only.
- Capabilities/limits stay `UNKNOWN`/`UNVERIFIED` until Stage G; no live claim without verification.
- Focused + full suite, typecheck, build, `git diff --check` pass locally; independent diff review before any merge. Report actual commands/results; do not claim unexecuted tests.

## 12. Official sources (all fetched 2026-11-18)

- FYERS Plans & Limits — `https://fyers.in/api-docs/v3/getting-started/plans-and-limits/`
- FYERS Historical Data — `https://fyers.in/api-docs/v3/api/market-data/historical-data/`
- FYERS Get Expired F&O Data — `https://fyers.in/api-docs/v3/api/market-data/expired-fo-data/get-expired-fo-data/`
- FYERS Option Chain — `https://fyers.in/api-docs/v3/api/market-data/option-chain/`
- Upstox Historical Candle V3 — `https://upstox.com/developer/api-documentation/v3/get-historical-candle-data`
- Upstox Get Expired Historical Candle (v2) — `https://upstox.com/developer/api-documentation/get-expired-historical-candle-data`
- Upstox Option Chain (index) — `https://upstox.com/developer/api-documentation/option-chain`
- Upstox Announcements — `https://upstox.com/developer/api-documentation/announcements`
- Upstox v2 Deprecation Notice — `https://upstox.com/developer/api-documentation/announcements/deprecation-notice-v2`
- Governing docs: `PRODUCT_REQUIREMENTS.md` §6.2–6.4; `DATA_LIFECYCLE_AND_STORAGE.md` §3–4; `IMPLEMENTATION_ROADMAP.md` M5; `MULTI_PROVIDER_STREAMING_ARCHITECTURE.md` §6.2/§7.1; `ARCHITECTURE.md`.

## 13. Approval required before implementation

1. M5 implementation authorization (this plan is study-only).
2. Stage G verification/authorization before Phase 4B activation (no live auth/socket/network in M5).
3. Any dependency or schema decision beyond generated migration `0005`.

## 14. Bounded items to verify during implementation (offline where possible)

- Upstox v2 expired duration limits (SDK figures unconfirmed on endpoint page); account entitlements (Upstox Plus, FYERS plan).
- Upstox Put/Call option-chain detail field shape (only index page fetched).
- FYERS live `null`-Greeks / field-omission vs explicit-zero behavior and `greeks_at` semantics.
- Any verified exchange-calendar source before enabling calendar-backed gap detection (deferred).
- Re-run the full suite and record actual counts; the prior baseline was not re-verified in this review.

## Steps

- [ ] Obtain M5 implementation authorization and Stage G authorization for Phase 4B
- [ ] Phase 1: contracts (`historical.ts`, `snapshots.ts`), migration `0005`, five tables + validated `app_meta` retention, repositories
- [ ] Phase 2: `HistoricalCandleService` + pure `gaps.ts` + `OptionChainSnapshotService` with fake-provider tests
- [ ] Phase 3: Upstox/FYERS REST + option-chain adapters with mocked-fetch tests (offline; status stays UNVERIFIED)
- [ ] Phase 4A: local API routes and WebUI config/capture panels with offline tests
- [ ] Phase 4B: provider-backed activation + integration tests after Stage G verification
- [ ] Run focused + full suite, typecheck, build, `git diff --check`; independent diff review before merge
