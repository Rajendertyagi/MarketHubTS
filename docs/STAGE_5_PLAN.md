# M5 (Stage 5) — Historical Candles and Option-Chain Snapshot Persistence Plan (Optimized)

> **Status:** **M5 offline implementation complete and published.** Phases 1–4A (contracts/storage, canonical services, offline provider REST adapters with mocked fetch, and local API/WebUI) are implemented on `develop`. **Phase 4B (provider-backed activation) is NOT activated and remains Stage-G gated.** Live REST verification has not been performed; live provider data availability is not established. The current API composition deliberately wires empty provider collections — the existence of REST adapters does not mean providers are connected or that live historical/option-chain retrieval works in the running application. See §15 for the implementation-status record.
> **Historical baseline (pre-implementation observations, not current state):** M5 planning baseline `2e7ec2799ef73401f355075088501cd6dfdc2195` (the commit on which M5 planning began); `main` @ `865d86f393a29bc1ec8d455a51d9efa82d722c48`. Final reviewed Stage C state `e8ce409eddbaf50c1363dfa0d4e5bc9e82d31ddd`; original Stage C implementation `e236e254b90b390077613c7f055ae1bb070bd13e`. The active `develop` HEAD is intentionally not recorded here — re-check with `git log -1`.
> **Governing docs:** `AGENTS.md`, `PROJECT_MANAGER_PROTOCOL.md`, `ENGINEERING_STANDARDS.md` (canonical), `PRODUCT_REQUIREMENTS.md` §6.2–6.4, `DATA_LIFECYCLE_AND_STORAGE.md` §3–4, `IMPLEMENTATION_ROADMAP.md` M5, `ARCHITECTURE.md`, `MULTI_PROVIDER_STREAMING_ARCHITECTURE.md` §6.2/§7.1, `REFERENCES.md`.
> **Revision:** optimized after independent architecture review — five tables (not six), derived coverage, offline adapter code, resolved v2 deprecation question. Refined with interval/session-aware gap labeling, manual-review conflict policy, explicit Stage G REST verification scenarios (§3A), exact test-file allocation, and a fail-closed retention fallback. Corrected daily/weekly/monthly/intraday gap semantics and separated transient throttling from permanent unavailability. Final corrections reconcile 503 `Retry-After` with the actual helper (minimal extension required), define `Retry-After: 0` and over-`max` handling, give known/unknown-reset cooldowns an exact non-blocking lifecycle, and scope quotas correctly — Upstox per API (not the "Other Standard APIs" heading), FYERS per documented category, with the repeated-limit daily block represented as a separate account-level REST restriction spanning all three REST categories (WebSocket impact and counter/reset details unverified, deferred to Stage G).

## 1. Settled direction (do not re-litigate)

M5 delivers two persistent lifecycles — **historical candles** and **option-chain snapshots** — through the existing canonical services. Build the provider-agnostic core (contracts, storage, services) first with deterministic fakes. Provider REST adapters are written against **documented** contracts with mocked `fetchImpl` (offline, unblocked); **activation** (real requests, wiring into services) is Stage-G-gated. No broker-DB replication, no fabricated raw fields, no new runtime dependencies, no new permanent branch, no live auth/socket/network in M5.

Preserved without change: Stage C structural-adapter seam, AD-024 foundation, `isLocalPeer` local-owner boundary, `fetchWithTimeout`/`fetchWithRetry`/`sanitizeError`, `app_meta` validated-read pattern, `SqliteProviderSettings` boundary, ComponentStore/service patterns, WebUI ownership of operational config, no fixed provider priority, MCP market tools are M6.

## 2. Historical baseline observations (pre-implementation; inspected at planning time, not current state)

> The table below records what existed **before M5 implementation began**. It is preserved as the planning baseline and rationale for the design decisions in this plan; it is **not** a description of the current repository. Current status is in §15 and [`PROJECT_STATUS.md`](PROJECT_STATUS.md).

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

## 3A. Stage G — M5 REST verification scenarios (prerequisite)

Successful Stage G **streaming** verification does **not** prove historical or option-chain REST support. These scenarios are separate, explicitly authorized Stage G work. Each requires real credentials and live requests — **none is authorized by this plan**. For every scenario record: preconditions/entitlement, request + response evidence (sanitized), expected result, pass criteria, fail criteria, sanitized fixture capture, and what remains unverified if it cannot run. Sanitized fixtures must strip tokens, account identifiers and request signatures; only response shape, field names, status/error codes and non-sensitive metadata are retained for offline tests.

**Upstox**
| Scenario | Preconditions / entitlement | Evidence | Expected / pass | Fail | Fixture | Unverified if not run |
|---|---|---|---|---|---|---|
| Active-contract V3 historical candles | Analytics Token with Historical Data category | `GET /v3/historical-candle/...` request + response | 200, `data.candles` 7-element arrays, requested interval/window honored | 4xx/5xx, wrong shape, silent truncation | Candle arrays, interval/window params, status | Actual account entitlement, live field delivery |
| Expired-contract v2 historical candles | **Upstox Plus** | `GET /v2/expired-instruments/historical-candle/...` with a known `expired_instrument_key` | 200, same 7-element shape, expired key accepted | 403/entitlement error, v2 retired, wrong shape | Candle arrays, expired-key format, status | Plus entitlement, v2 endpoint current status, duration limits |
| Option Contracts + Put/Call Option Chain fields | Analytics Token (Option Chain category) | Both endpoint responses | Documented per-strike fields present; unknown fields reported, not fabricated | Missing/unexpected fields, entitlement error | Field names, sample values (no account data) | Detail field shape (only index page fetched) |
| Entitlement behavior (Analytics Token vs Plus) | Both token types available | Responses from a Plus-gated and a non-gated endpoint | Plus-gated call succeeds only with Plus; non-gated works with Analytics Token | Gating not as documented | Status codes, error codes | Account-specific plan state |
| Date-range / interval / rate limits | Valid token | Requests at documented boundaries and just beyond | Documented windows honored; over-limit returns documented error | Silent truncation or undocumented error | Status/error codes, window params | Actual per-account limits |

**FYERS**
| Scenario | Preconditions / entitlement | Evidence | Expected / pass | Fail | Fixture | Unverified if not run |
|---|---|---|---|---|---|---|
| Regular historical candles | Market Data permission; Standard sufficient | `range_from`/`range_to`, `oi_flag`, `cont_flag` responses | Candle arrays, OI when flagged, 100-day/366-day limits honored | 422/`-50`, wrong shape, silent truncation | Candle arrays, params, status | Live field delivery, partial-candle behavior |
| Expired F&O daily | Standard (last 2 yrs) | Expired F&O daily response | 200, `columns`-named optional fields, `no_data` handled | Entitlement error, wrong shape | `columns`, candle arrays, `s` status | Standard entitlement, live availability dates |
| Expired F&O intraday | Standard (10 req/day) | Expired F&O intraday response | 200 within 10/day; 11th request returns documented limit error | Undocumented limit behavior | Status/error codes, request count | Live 10/day enforcement |
| Option-chain fields (OI/IV/Greeks) | Market Data permission | `optionchain` response with `greeks=1` | Per-strike fields + nested greeks; `null` Greeks preserved as null | Missing fields, zero-filled nulls | Field names, null positions, `strikecount` | Live null-Greek behavior, `greeks_at` semantics |
| Standard vs Prime entitlement | Both plan states available | Same request under each plan | Standard/Prime coverage matches documented limits | Plan behavior differs from docs | Status codes, coverage metadata | Actual account plan |
| Request limits / error semantics | Valid token | Requests at 5/s, 50/min, 5,000/day boundaries | `-429` on breach; `no_data` = empty result, not failure | Silent failure or wrong code | Error codes, `s` values | Live rate-limit enforcement |

Each scenario's pass/fail is recorded in the Stage G report; capability status in M5 stays `UNVERIFIED` until the relevant scenario passes. A scenario that cannot run leaves its specific facts explicitly unverified — never assumed.

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

**Retention fail-safe (critical):** validation happens on every read. If the stored value is missing, malformed, or fails Zod validation, the service reports an explicit invalid/unavailable status and **disables all retention cleanup** — it must never substitute an arbitrary default duration and must never delete rows. Cleanup resumes only after valid user-controlled settings are restored through the WebUI. This differs from `readGeneration()`'s fallback-to-zero: a bad retention value fails closed toward *no deletion*. Cleanup itself is bounded (per-class batch limits) and foreign-key-safe.

**Why not six tables:** `app_settings` was a generic 4th KV store; `candle_coverage_ranges` duplicated information already in `historical_candles` and could drift (a `COVERED` row for provider B while the stored candles are provider A's, because first-write-wins). Deriving coverage from candle rows makes provenance truthful by construction and removes a whole write path that had to be kept transactionally consistent with candle writes.

**Why not merge the two config tables:** they have different validation schemas, different consumers (candle service vs snapshot service), and different lifecycles. A discriminated JSON blob would weaken DB constraints and clarity for no real gain at the expected (small, user-authored) row counts.

## 5. Coverage, gaps, and conflicts (correctness first)

- **Coverage is derived**, never stored as a claim: for `(canonical_id, interval)`, the covered timestamps are exactly the `ts_ms` values in `historical_candles`, each with its own `provider`. A requested window minus covered timestamps minus `UNAVAILABLE` notes = candidate gaps.
- **`UNAVAILABLE` notes are authoritative and permanent-only**: written only for **request-specific or permanent** unavailability — entitlement failure (`ENTITLEMENT`), unsupported interval/date range (`DATE_LIMIT`), or an explicit provider `no_data` for the requested range (`NO_DATA`) where the response semantics support that conclusion. They carry provider attribution, a stable `reason_code`, and sanitized evidence. They are not retried against the same provider until config/entitlement changes. Do not generalize an endpoint-specific restriction into instrument-wide permanent unavailability. **Transient throttling is never written as an `UNAVAILABLE` note** — see the rate-limit contract below.
- **Gap assessment is interval-aware and explicitly labeled.** No verified exchange-calendar or session source exists in this repo (calendars are a later-phase market-wide source), so M5 must not assert confirmed missing candles. The contract:
  - **`1D` (daily):** weekends may be excluded by the weekday rule. A weekday with no stored candle is only an **approximate candidate** (`gapBasis: "WEEKDAY_ONLY"`, `confirmed: false`). Without a verified exchange calendar the system **cannot determine** whether that weekday was an exchange holiday, a trading day with a provider omission, or a non-trading day — holiday/session status is explicitly **unknown**. Do not claim holidays are algorithmically excluded; no calendar exists. Such a weekday is never a confirmed missing candle.
  - **`1W` (weekly):** compare available **weekly candle periods/buckets** against the requested period range — not a daily weekday-by-weekday check. A missing weekly bucket is an unconfirmed candidate (`gapBasis: "WEEKLY_BUCKET"`, `confirmed: false`); without verified calendar evidence it cannot be attributed to a holiday or a provider omission.
  - **`1M` (monthly):** compare available **monthly candle periods/buckets** against the requested period range — not a daily weekday-by-weekday check. A missing monthly bucket is an unconfirmed candidate (`gapBasis: "MONTHLY_BUCKET"`, `confirmed: false`).
  - **Intraday (minutes/hours):** retain `SESSION_UNKNOWN`. Overnight, pre-open, post-market and cross-session windows (including different exchange/segment sessions such as NSE vs BSE, equity vs F&O) cannot be distinguished from genuine missing candles; report only "no candle stored in this window; session status unverified", never a confirmed missing candle.
  - **Every gap result carries its basis** (`WEEKDAY_ONLY` | `WEEKLY_BUCKET` | `MONTHLY_BUCKET` | `SESSION_UNKNOWN` | later `CALENDAR_BACKED`) and `confirmed: false` in M5. Do not conflate exchange, segment, provider timezone or candle timestamp semantics. No calendar dependency or subsystem in M5; no fabricated candles.
- **Alternate-provider fill**: a candidate gap or `UNAVAILABLE` range may be fetched from another provider per the configured policy. Successful fills write candles attributed to that provider; the original `UNAVAILABLE` note is retained (so we do not pointlessly retry the first provider). Filling never converts an indeterminate gap into a confirmed one.
- **Conflicts — smallest safe policy (manual review, no automated re-resolution in M5):**
  - PK is provider-agnostic. **First valid write wins** — an existing candle is never overwritten by an alternate fill, a duplicate, or a late-arriving response.
  - A **differing value** from another provider is **not applied**. A `CONFLICT` note records the competing provider, the competing values, and the timestamp, while the stored candle and its original provenance (`provider`, `provenance_json`, `received_at`) remain unchanged. Conflicts are surfaced for **manual review** through the local API/WebUI; M5 does **not** implement automated re-resolution or an owner-authorized "make provider X authoritative" operation.
  - **Duplicate** (identical payload) responses are idempotent — no new row, no new note. **Late-arriving** responses for an already-stored key are treated as duplicates/conflicts under the same rule; `received_at` ordering never silently replaces stored data.
  - **Same-provider refresh** replaces only on an explicit re-sync with a newer `received_at`, and is idempotent for identical payloads. This is the only replacement path, and it is owner-initiated, not automatic.
  - If automated re-resolution is ever needed, it requires a separately authorized operation with explicit provenance handling — not a silent provider priority.
- **Automatic selection** uses the configured provider policy plus existing capability/availability/freshness logic — no hardcoded priority.

### Rate-limit and transient throttling (never a permanent negative cache)

Transient throttling — HTTP 429/503, provider rate-limit error codes, temporary request throttling, quota cooldowns — must **not** create a permanent `UNAVAILABLE` note that suppresses future attempts indefinitely. Reuse the existing helpers in `packages/market-core/src/provider.ts`; do not invent new capabilities. Verified semantics (inspected, not assumed):

- `parseRetryAfter(value, nowMs)` returns a delay in ms for **delta-seconds** (`^\d+$`) and **HTTP-date** forms; returns `null` when the header is missing, malformed, or the date is in the past. It **accepts `0`** and returns `0` ms.
- `fetchWithRetry` retries only transient failures (network errors, 429, 5xx), bounded to 1–5 attempts (default 3), base 250 ms, max 2000 ms, with jitter. **Only the 429 branch reads `Retry-After`**: it sleeps exactly the parsed delay and never retries before it, stopping when the header is missing/invalid/past (`null`), when the delay exceeds `max`, or on the final attempt. **The 5xx branch does not read `Retry-After`** — it uses exponential backoff + jitter. Therefore the current helper does **not** honor `Retry-After` on HTTP 503.
- Engineering standard §3A requires: honour `Retry-After` in both delta-seconds and HTTP-date forms; stop when the header is missing, invalid, in the past, or implies an unsafe delay; never retry in a tight loop or amplify rate-limit violations.

**Required minimal helper extension (M5 implementation, not this task):** extend `fetchWithRetry` so the 503 branch also reads `Retry-After` using the same `parseRetryAfter` logic as 429 — preserving delta-seconds and HTTP-date support and the `null`/`> max`/final-attempt stop conditions. **Both 429 and 503 require a usable positive `Retry-After`; a missing, malformed, expired, zero or over-max header stops the sequence for either status — there is no backoff fallback for 429 or 503.** Only other 5xx statuses (500, 502, 504, …) keep bounded exponential backoff and jitter. Until that extension is implemented, M5 must **not claim** that 503 `Retry-After` is honored; the guarantee applies only to 429. This is a small change to an existing helper, not a new dependency or subsystem.

M5 contract:

1. Honor valid `Retry-After` (429 and, after the extension, 503) in both delta-seconds and HTTP-date forms; never retry before the indicated time.
2. **`Retry-After: 0` is treated as unusable** (no trustworthy cooldown): stop the current retry sequence, do **not** call `sleep(0)` for an immediate retry, leave the range unresolved, and report the restriction. This prevents an immediate retry burst while staying safe; it does not substitute an arbitrary delay.
3. A valid delay **exceeding the helper's configured `max`** is unsafe: stop the current retry sequence and **preserve the trustworthy cooldown** (`notBeforeMs`) in runtime state so no later attempt retries early. Do not clamp it to `max` and retry.
4. If `Retry-After` is missing, invalid, expired or zero, **stop the current retry sequence** — no tight loop, no `UNAVAILABLE` note.
5. Distinguish short rate-limit cooldowns from **daily quota exhaustion or account-level temporary blocking**. For a daily quota/account block, do not retry before a trustworthy reset time; if the reset time is unknown, leave the range **unresolved** and report the provider restriction. No retry is guaranteed before a trustworthy reset when the reset is unknown.
6. Preserve provider attribution and sanitized error information (`sanitizeError`); never log tokens or account identifiers.
7. Do not silently change user-selected providers, sync schedules or operational configuration.

**Cooldown lifecycle — exact behavior (runtime state only, no new table/dependency):**

- **Known reset** (`notBeforeMs` from a trustworthy `Retry-After`/reset): the cooldown blocks only its scoped operations until `now >= notBeforeMs`. It expires **by time alone** — no successful request is needed to clear it. At expiry the next scheduled or owner-requested attempt proceeds; on success the entry is removed. A delay beyond `max` is preserved here as `notBeforeMs` rather than retried early.
- **Unknown reset** (no trustworthy reset time): the marker is **advisory only** — it records the restriction for status reporting but **never blocks** future attempts. This avoids the deadlock where a blocking marker with no expiry cannot be cleared because requests are blocked. Scheduled and owner-requested attempts may proceed and may discover the reset; no retry is guaranteed before a trustworthy reset. On success the marker is cleared. It is discarded on process restart.
- **Scope — provider-specific, never inferred from documentation headings:**
  - **Upstox: API-specific cooldowns.** Upstox enforces limits **per API, per user**. A throttle on the historical-candle API must **not** suppress option-chain requests, or vice versa, without evidence of a shared quota. The "Other Standard APIs" heading is a documentation grouping, **not** a shared quota category — do not use it as a cooldown scope. Default to the single API/endpoint that was throttled; widen only if a shared quota is actually documented and Stage G confirms it.
  - **FYERS: category-scoped cooldowns.** FYERS explicitly groups APIs into separate categories with separate limits: **Data APIs** (regular history, expired F&O, option chain), **Transaction APIs**, and **User Info APIs**. A Data API throttle scopes to the Data API category — it must not suppress Transaction or User Info operations. Do not assume a Data API cooldown affects WebSocket (Data Socket/TBT) connections; that is unverified.
  - **FYERS repeated-limit account block — account-level REST restriction.** Official FYERS API Standards and Plans & Limits state that if the per-minute limit is exceeded more than three times in a day, **the user is blocked from making further requests for the rest of that day**. This is distinct from ordinary category cooldowns: while active it is an **account-level REST restriction applying across all three REST API categories** (Data, Transaction, User Info), **regardless of which category triggered it** — not a per-API or per-category cooldown. Represent it as a separate runtime restriction with its own reset handling; do not model it as a shared category quota. **Do not assume it affects WebSocket (Data Socket/TBT) connections** — that impact is unverified. Official docs do **not** establish whether the breach counter aggregates across categories, nor the exact reset timezone/day boundary; both are **Stage G verification items**, not assumptions to encode.
  - In all cases, do not suppress unrelated provider operations unless the documented quota is actually shared with them. Stage G verifies the real scope.
- **Restart:** all cooldown state is instance-owned and discarded on shutdown. After restart the provider/range is **not** permanently suppressed — a fresh attempt is allowed. This is safe precisely because no permanent negative cache is persisted; if restart-safe daily-quota handling is later required it needs separate justification. M5 leaves the range unresolved across restart rather than persisting a suppression.

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

### Test-file allocation (exact paths and harness)

| Test file | Boundary | Harness |
|---|---|---|
| `tests/market/historical.test.ts` | `HistoricalCandleService` + pure `gaps.ts` | fake provider seam, in-memory/temp DB |
| `tests/market/snapshots.test.ts` | `OptionChainSnapshotService` | fake provider seam, in-memory/temp DB |
| `tests/providers/upstox-historical.test.ts` | Upstox historical adapter (V3 active + v2 expired) | mocked `fetchImpl`, no network |
| `tests/providers/upstox-option-chain.test.ts` | Upstox option-chain adapter | mocked `fetchImpl`, no network |
| `tests/providers/fyers-historical.test.ts` | FYERS historical adapter (regular + expired F&O) | mocked `fetchImpl`, no network |
| `tests/providers/fyers-option-chain.test.ts` | FYERS option-chain adapter | mocked `fetchImpl`, no network |
| `tests/market/historical-routes.test.ts` | API historical/snapshot/config routes | fake services, `isLocalPeer` local/non-local requests |
| `tests/web/historical.test.ts` | WebUI historical client | fake fetch, deterministic |
| `tests/web/snapshots.test.ts` | WebUI snapshot client | fake fetch, deterministic |
| `tests/database.test.ts` (extend) | migration `0004→0005` upgrade | temp DB, preserves `app_meta`/catalog/subscriptions |

All M5 tests are offline: fake providers, mocked `fetchImpl`, temp/in-memory DB, or fake fetch. **No test uses live credentials or network.** Stage G live verification is a separate, authorized activity recorded in §3A — it is not part of the M5 test suite. Follows existing `tests/market/`, `tests/providers/`, `tests/web/` organization; no generic test framework.

## 10. Required deterministic regression tests (name the scenario)

1. **Disjoint coverage**: two non-contiguous fetched windows; gap between them reported with `gapBasis`; no candle fabricated in the gap.
2. **Provider conflict / resolution**: same key from A and B with different OHLC → first write wins, `CONFLICT` note records competing provider + values + timestamp, stored provenance unchanged, conflict surfaced for manual review; duplicate identical response is idempotent (no new row/note); late-arriving response for a stored key is treated as duplicate/conflict and never silently replaces; explicit same-provider refresh only with newer `received_at`; no automated re-resolution or fixed provider priority in M5.
3. **Alternate fill**: A returns `UNAVAILABLE` for a range; B fills it; candles attributed to B; A's note retained; no overwrite of A's valid candles; an indeterminate gap is never converted into a confirmed one by a fill.
4. **Gap/session semantics**: daily weekday with no candle → approximate `WEEKDAY_ONLY`, `confirmed: false`; weekend and exchange-holiday dates never asserted as missing; intraday window with no candle (including overnight, pre-open, post-market, and cross-session boundaries) → `SESSION_UNKNOWN`, `confirmed: false`, reported only as "no candle stored; session status unverified"; different exchange/segment sessions (NSE vs BSE, equity vs F&O) are not conflated; every gap result carries its basis; no calendar dependency introduced.
5. **Snapshot field semantics**: provider `null` Greek → key present with `null`; omitted field → key absent; provider `0` → stored as `0`; `observation_timestamp` absent → `null` (never `captured_at`); optional FYERS column mapped by name from `columns` despite doc inconsistency.
6. **Config immutability**: on-demand fetch/capture with a config-shaped payload creates/modifies no config rows; only `runSync()`/scheduled capture reads config.
7. **Deletion safety**: candles survive provider removal and catalog/expiry removal; snapshots survive capture-config deletion (`config_id` nulled); retention cleanup bounded, FK-safe, no cascade history loss.
8. **Retention fail-safe (invalid config deletes nothing)**: user-configured values in `app_meta` validated on read; a missing, malformed or schema-invalid value reports an explicit invalid/unavailable status and **disables all cleanup** — assert zero rows deleted (candles and snapshots) after a cleanup attempt with invalid config; no arbitrary default duration is substituted; cleanup resumes only after valid user-controlled settings are restored; cleanup is bounded and FK-safe when enabled.
9. **Restart persistence**: candles, snapshots, configs, retention survive close + reopen.
10. **Local-owner-only**: non-loopback PUT to config routes → 403 via `isLocalPeer`.
11. **Migration**: `0005` applies on a fresh DB and on upgrade from `0004` without touching `app_meta`, catalog, or subscriptions.
12. **Adapter mapping (mocked fetch)**: Upstox V3/expired 7-element candles and FYERS regular/expired `columns`-based mapping; `no_data`, 422/`-50`, null Greeks, rate-limit, malformed-200 all handled explicitly; no live network.
13. **Daily weekday candidate**: a weekday with no stored candle → `WEEKDAY_ONLY`, `confirmed: false`, approximate; never a confirmed missing candle.
14. **Weekend exclusion**: weekend dates never appear as daily candidate gaps.
15. **Weekday holiday unknown**: a weekday that was an exchange holiday cannot be identified without a calendar; result states holiday/session status unknown and is never confirmed missing; no claim that holidays are algorithmically excluded.
16. **Weekly buckets**: `1W` compares weekly period buckets against the requested range; a missing weekly bucket → `WEEKLY_BUCKET`, `confirmed: false`; no daily weekday-by-weekday check.
17. **Monthly buckets**: `1M` compares monthly period buckets against the requested range; a missing monthly bucket → `MONTHLY_BUCKET`, `confirmed: false`; no daily weekday-by-weekday check.
18. **Intraday session windows**: overnight, pre-open, post-market and cross-session windows remain `SESSION_UNKNOWN`, `confirmed: false`; never classified as missing.
19. **429 with delta-seconds `Retry-After`**: mocked time/fetch; no retry before the indicated time; retry occurs at/after it.
20. **429 with HTTP-date `Retry-After`**: same guarantee using an HTTP-date header.
21. **Missing/malformed/expired/unsafe `Retry-After`**: retry sequence stops, no tight loop; no `UNAVAILABLE` note written.
22. **Quota exhaustion not permanent**: FYERS intraday/daily quota exhaustion (or account block) is not stored as a permanent `UNAVAILABLE` note; range left unresolved with provider restriction reported.
23. **Retry after cooldown/reset**: a subsequent scheduled or owner-requested attempt after a known reset is allowed; not suppressed by a stale note.
24. **Restart / stale cooldown**: runtime cooldown state is discarded on shutdown; after restart the provider/range is not permanently suppressed.
25. **Permanent vs transient distinction**: `ENTITLEMENT`/`DATE_LIMIT`/`NO_DATA` produce attributed `UNAVAILABLE` notes; 429/rate-limit codes produce runtime cooldown only — the two remain distinguishable in status.
26. **503 with delta-seconds `Retry-After`**: after the minimal helper extension, mocked time/fetch; no retry before the indicated time; retry occurs at/after it (assert the helper does not fall back to plain backoff for 503).
27. **503 with HTTP-date `Retry-After`**: same guarantee using an HTTP-date header; before the extension, assert the plan does not claim this guarantee.
28. **503 missing/malformed/expired/excessive delay**: retry sequence stops, no tight loop, no `UNAVAILABLE` note; an excessive (over-`max`) delay preserves the trustworthy cooldown rather than clamping and retrying early.
29. **`Retry-After: 0`**: no immediate `sleep(0)` retry burst; sequence stops, range left unresolved, restriction reported; no arbitrary delay substituted.
30. **Known-reset cooldown expiry**: cooldown blocks only its scoped operations until `notBeforeMs`, then expires by time alone (no successful request needed); next scheduled/manual attempt proceeds; success clears the entry.
31. **Unknown-reset behavior and restart boundary**: advisory marker never blocks attempts; scheduled/manual attempts may proceed and discover the reset; no retry guaranteed before a trustworthy reset; marker discarded on restart and provider/range not permanently suppressed.
32. **Quota scope — Upstox API isolation**: throttle the Upstox historical-candle API and assert option-chain requests are **not** suppressed (and vice versa); the "Other Standard APIs" documentation heading is not treated as a shared quota; cooldown is keyed to the single throttled API.
33. **Quota scope — FYERS category isolation**: a Data API throttle (history/expired F&O/option chain) suppresses only Data API operations; Transaction API and User Info API operations remain unaffected; no assumption that a Data API cooldown affects WebSocket connections.
34. **FYERS account-level REST block**: the documented >3 per-minute-breach daily block is represented as a distinct **account-level REST restriction** that, while active, suppresses requests across all three REST categories (Data, Transaction, User Info) regardless of which category triggered it — unlike ordinary category cooldowns; it has its own reset handling and is not a per-API/category cooldown. WebSocket (Data Socket/TBT) impact is not assumed. Breach-counter aggregation across categories and the exact reset timezone/day boundary are not encoded as facts and are recorded as Stage G verification items.

## 11. Acceptance criteria

- Cached candles survive provider disconnect/removal and restart; disjoint coverage, unavailable periods, and partial failures reported explicitly, never fabricated.
- Gap assessment is interval-aware and labeled: `1D` → `WEEKDAY_ONLY`, `1W` → `WEEKLY_BUCKET`, `1M` → `MONTHLY_BUCKET`, intraday → `SESSION_UNKNOWN`, all `confirmed: false` in M5. Weekends are excluded from daily candidates; a weekday holiday cannot be identified without a calendar and is never confirmed missing; weekly/monthly use period buckets, not daily weekday checks; overnight/non-session periods are never asserted as missing. Calendar-backed detection is explicitly deferred; alternate fill respects policy and never overwrites valid candles or converts an indeterminate gap into a confirmed one.
- Provider conflicts deterministic (first-valid-wins), provenance preserved, competing values recorded in `candle_range_notes` for manual review; no automated re-resolution or fixed provider priority; duplicates and late responses never silently replace stored data.
- Snapshots use the canonical envelope with provider extensions; missing/null/unsupported/zero distinguishable; observation and capture timestamps distinct; manual/scheduled capture works; streaming independent of capture.
- Retention user-configurable in validated `app_meta`; invalid/missing retention config disables all cleanup and deletes nothing (no arbitrary default); cleanup resumes only after valid settings are restored; deletion rules in §7 hold; cleanup bounded and FK-safe.
- On-demand retrieval never mutates saved config; operational config writes local-owner-only.
- Transient throttling (429/503/rate-limit codes/quota cooldowns) never becomes a permanent `UNAVAILABLE` note: valid `Retry-After` (delta-seconds or HTTP-date) is honored with no retry before the indicated time; 503 support requires the documented minimal `fetchWithRetry` extension and is not claimed before it exists; `Retry-After: 0` and missing/invalid/expired/over-`max` headers stop the sequence without a tight loop (over-`max` preserves the trustworthy cooldown). Known-reset cooldowns expire by time alone; unknown-reset markers are advisory and never block; no retry is guaranteed before a trustworthy reset. Cooldowns are scoped to the narrowest documented quota — Upstox per API (never inferred from the "Other Standard APIs" heading), FYERS per documented API category (Data / Transaction / User Info), with the repeated-limit daily block represented as a separate **account-level REST restriction applying across all three REST categories while active** (regardless of triggering category, with WebSocket impact unverified and breach-counter aggregation / reset boundary left as Stage G verification items) — are instance-owned, and are discarded on restart with no new table or dependency; unrelated provider operations and WebSocket connections are never suppressed without verified shared scope. Permanent `ENTITLEMENT`/`DATE_LIMIT`/`NO_DATA` failures remain distinguishable from throttling.
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
2. Stage G verification/authorization before Phase 4B activation (no live auth/socket/network in M5), **including the separate M5 REST verification scenarios in §3A** — streaming verification alone does not satisfy this prerequisite.
3. Any dependency or schema decision beyond generated migration `0005`.

## 14. Bounded items to verify during implementation (offline where possible)

- Upstox v2 expired duration limits (SDK figures unconfirmed on endpoint page); account entitlements (Upstox Plus, FYERS plan).
- Upstox Put/Call option-chain detail field shape (only index page fetched).
- FYERS live `null`-Greeks / field-omission vs explicit-zero behavior and `greeks_at` semantics.
- Any verified exchange-calendar / session source before enabling calendar-backed gap detection (deferred); until then daily gaps remain `WEEKDAY_ONLY` (holiday status unknown), weekly/monthly use period buckets, and intraday gaps remain `SESSION_UNKNOWN`.
- All §3A Stage G REST scenarios (Upstox V3 active, v2 expired, option chain, entitlements, limits; FYERS regular/expired history, option chain, Standard vs Prime, limits/errors) — each run only under separate Stage G authorization with sanitized fixture capture.
- FYERS repeated-limit daily account block: whether the >3 per-minute-breach counter aggregates across REST categories or is per-category, and the exact reset timezone/day boundary — official docs do not establish either; verify in Stage G before encoding. WebSocket (Data Socket/TBT) impact of the block is also unverified.
- Re-run the full suite and record actual counts; the prior baseline was not re-verified in this review.

## 15. Implementation status (verified from code, post-implementation)

M5's offline implementation and corrective work are published on `develop`. This section records actual status; the architectural decisions, rationale, Stage G scenarios (§3A) and authorization requirements above are preserved unchanged.

| M5 area | Status |
|---|---|
| Contracts and persistence (Phase 1) | **Implemented** — five tables + additive migration `0005`, repositories, validated `app_meta` retention |
| Historical candle services and coverage (Phase 2) | **Implemented** — canonical service, derived coverage, interval-aware unconfirmed gaps, first-write-wins/conflicts |
| Option-chain snapshot persistence and services (Phase 2) | **Implemented** — canonical envelope, capture config, on-demand immutability, deletion safety |
| Upstox and FYERS offline REST adapters (Phase 3) | **Implemented with mocked fetch** — no live requests; documented contracts encoded; capabilities remain `UNVERIFIED` |
| Local API and WebUI (Phase 4A) | **Implemented** — cached reads, config CRUD, retention, manual capture with fakes, local-owner-only writes |
| Provider-backed activation (Phase 4B) | **Not activated; Stage G gated** — no live provider wiring, auth, sockets or network |
| Live REST verification (§3A) | **Not performed** — all §3A scenarios remain pending separate authorization |
| Live provider data availability | **Not established** — no live historical or option-chain data has been retrieved |

**Important:** `apps/api/src/app.ts` composes `HistoricalCandleService` and `OptionChainSnapshotService` with **empty provider collections**. The REST adapters exist as offline, tested code, but no provider is connected in the running application; on-demand historical/capture requests honestly report no provider. This is deliberate: activation requires Stage G authorization and a separately reviewed change to the locked boundary. M6 must work against existing cached/stored data and honest empty/unavailable states without using MCP as a reason to activate providers.

Post-implementation corrections (offline, no live access) addressed provider request contracts, exact option-chain expiry selection, India-local calendar-date handling, strict date validation, retry/cooldown semantics and shared FYERS cooldown ownership; each has deterministic regression tests. See [`PROJECT_STATUS.md`](PROJECT_STATUS.md) §3.12 and [`REFERENCES.md`](REFERENCES.md) for current verification figures and sources.

## Steps

- [x] Obtain M5 implementation authorization (offline phases 1–4A implemented and published)
- [ ] Stage G authorization for Phase 4B, including the separate M5 REST verification scenarios in §3A (still required; not performed)
- [x] Phase 1: contracts (`historical.ts`, `snapshots.ts`), migration `0005`, five tables + validated `app_meta` retention, repositories
- [x] Phase 2: `HistoricalCandleService` + pure `gaps.ts` + `OptionChainSnapshotService` with fake-provider tests
- [x] Phase 3: Upstox/FYERS REST + option-chain adapters with mocked-fetch tests (offline; status stays UNVERIFIED)
- [x] Phase 4A: local API routes and WebUI config/capture panels with offline tests
- [ ] Phase 4B: provider-backed activation + integration tests after Stage G verification (gated; not started)
- [x] Run focused + full suite, typecheck, build, `git diff --check`; independent diff review before merge
