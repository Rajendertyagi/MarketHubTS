# M5 (Stage 5) — Historical Candles and Option-Chain Snapshot Persistence Plan

> **Status:** Planning only. No implementation, source/test modification, commit or push of code performed for M5. Awaiting independent review and explicit implementation authorization.
> **Order:** D → E → F → C → G complete through Stage C. Stage G (live verification / production driver unlock) remains locked and out of scope.
> **Baseline:** `develop` @ `2e7ec2799ef73401f355075088501cd6dfdc2195`; `main` @ `865d86f393a29bc1ec8d455a51d9efa82d722c48`. Final reviewed Stage C state `e8ce409eddbaf50c1363dfa0d4e5bc9e82d31ddd`; original Stage C implementation `e236e254b90b390077613c7f055ae1bb070bd13e`.

## 1. Decision (settled direction — do not re-litigate)

M5 delivers two persistent data lifecycles — **historical candles** and **option-chain snapshots** — through the existing canonical services. Build the provider-agnostic core (contracts, storage, services) first with deterministic fakes; add provider REST adapters only after Stage G verifies the actual endpoints, field shapes and entitlements. No broker-database replication, no fabricated raw fields, no new runtime dependencies, no new permanent branch.

## 2. Hard prerequisite: Stage G verification gate

M5's roadmap prerequisite is "verified historical/expired/option-chain APIs and entitlements". No live provider connection has been performed. Therefore:

- **Phases 1–2 (offline core) may proceed now** — they depend only on local contracts/storage and fake providers.
- **Phase 3 (provider REST adapters) is BLOCKED** until Stage G verifies: Upstox V3 historical candle endpoint + expired-instruments entitlement (Plus); FYERS history endpoint + expired F&O entitlement (Prime); option-chain REST endpoints and per-field availability (OI/IV/Greeks).
- No claim of live historical or option-chain support may be made before that verification. Capabilities stay `UNKNOWN`/`UNVERIFIED` with source attribution.

## 3. What exists already (foundation — do not rebuild)

- `packages/contracts`: `market.ts`, `provider.ts`, `live.ts`, `live-components.ts` (canonical live components, capability contracts, provenance/freshness/availability). No candle or snapshot schemas yet.
- `packages/database`: `schema.ts` with `app_meta`, catalog tables, `provider_settings`, `provider_credentials`, `streaming_subscriptions`; migrations `0000`–`0004`; `SqliteSubscriptionRepository` with durable generation in `app_meta`; transactional catalog writes via `SqliteCatalogRepository`.
- `packages/market-core`: `identity.ts`, `provider.ts`, `sync.ts`, `live/` (ComponentStore, MarketDataService, freshness, selection, normalization). No historical/snapshot service.
- `packages/broker-upstox` / `packages/broker-fyers`: auth adapters + streaming adapters only. No REST historical or option-chain calls. `fetchWithTimeout` / `fetchWithRetry` / `sanitizeError` already in market-core.
- `apps/api`: `market-routes.ts`, `provider-routes.ts`, `stream-supervisor.ts`, `subscription-coordinator.ts`, `app.ts`. `apps/web`: live/subscription panels + lib clients. `apps/mcp-server`: health tool only (MCP market tools are M6).
- Tests: 459 pass / 0 fail / 5452 assertions / 37 files (local verification at `2e7ec27`).

## 4. Verified facts and open verifications (from docs, not re-derived)

- Upstox V3 Historical Candle Data endpoint documented; candle shape `[ts, open, high, low, close, volume, open_interest]`; no static IP under Analytics Token. Expired-instruments APIs require Upstox Plus — entitlement **verify**.
- FYERS Standard: daily 5 yrs, intraday 1 yr, expired F&O daily 2 yrs; broader access Prime-only — entitlement **verify**. OI/IV/Greeks are REST-only (`include_oi` / `include_greeks`), absent from Data Socket.
- Option chain per-strike fields: OI, change in OI, volume, IV, LTP, net change, bid/ask quantity and price — live market fields, never catalog fields; availability **verify** per provider.
- Retention is user-controlled via WebUI; no permanently fixed policy. Live ticks/depth stay in memory; historical candles and snapshots are the persisted lifecycles.
- MCP on-demand retrieval may cache historical candles but must not mutate saved snapshot-capture config (service-level invariant even though MCP wiring is M6).

## 5. Scope and phases (lean, ordered by dependency)

### Phase 1 — Canonical contracts and storage (offline, unblocked)
1. `packages/contracts/src/historical.ts` (new) — Zod schemas/types: `CandleInterval`, `HistoricalCandle`, `CandleRangeRequest`, `CandleCoverage`, `OptionChainSnapshot`, `OptionChainCaptureConfig`, `DataUnavailableReport`. Reuse `Provenance`, `ProviderId`, `AvailabilityState`.
2. `packages/contracts/src/index.ts` (changed) — re-export.
3. `packages/database/src/schema.ts` (changed) + generated migration `0005_*` (new, via `bun run db:generate`) — four lean tables:
   - `historical_candles`: PK `(canonical_id, interval, ts_ms)`; OHLC required, volume/OI nullable; provider, provenance_json, received_at; index on `(canonical_id, interval, ts_ms)`.
   - `candle_sync_state`: PK `(canonical_id, interval, provider)`; last_ts_ms, status, error, updated_at — coverage tracking, not per-tick rows.
   - `option_chain_capture_configs`: id PK; underlying_canonical_id, expiry_date, strike_range_json (null = all), capture_enabled, streaming_enabled (independent), provider, timestamps.
   - `option_chain_snapshots`: id PK; config_id FK, captured_at, provider, underlying_ltp nullable, payload_json (strikes as supplied), provenance_json; index `(config_id, captured_at)`.
4. `packages/database/src/candles.ts`, `packages/database/src/snapshots.ts` (new) — repositories: batched upsert, bounded range reads, transactional config writes, retention delete. `packages/database/src/index.ts` (changed) — exports.

### Phase 2 — Provider-agnostic services (offline, unblocked)
5. `packages/market-core/src/historical/service.ts` (new) — `HistoricalCandleService`: request range → read cache → detect gaps via `candle_sync_state` → fetch through an injected provider seam → batch upsert → report unavailable periods. Gap fill tries an alternate configured provider when available; never fabricates. On-demand fetch does not mutate sync config.
6. `packages/market-core/src/snapshots/service.ts` (new) — `OptionChainSnapshotService`: capture-config CRUD (WebUI-owned), capture/store/retrieve snapshots, streaming selection independent of capture, no pre-collection claims. Enforces "on-demand request must not change saved config".
7. `packages/market-core/src/index.ts` (changed) — exports.
8. Tests: `tests/market/historical.test.ts`, `tests/market/snapshots.test.ts` (new) — fake provider seam, deterministic; cover cache preservation across provider disconnect/removal, gap detection/fill, unavailable-period reporting, config immutability on on-demand, retention cleanup, restart persistence.

### Phase 3 — Provider REST adapters (BLOCKED on Stage G)
9. `packages/broker-upstox/src/historical.ts`, `packages/broker-fyers/src/historical.ts` (new) — thin REST adapters with their own structurally compatible interfaces (no `apps/api` imports, mirroring Stage C), using existing `fetchWithTimeout` / `fetchWithRetry`; map provider payloads to canonical candles; report entitlements/limits honestly; never fabricate OI/volume.
10. Option-chain REST adapters (same files or a sibling `option-chain.ts` per provider) — map per-strike fields only when supplied; report unavailable fields explicitly.
11. Tests with mocked `fetchImpl` — no live network.

### Phase 4 — API and WebUI integration (after Phases 1–3)
12. `apps/api/src/historical-routes.ts`, `apps/api/src/snapshot-routes.ts` (new); `apps/api/src/app.ts` (changed) — read-only candle/snapshot endpoints + local-owner-only config writes, reusing shared services (no duplicate logic).
13. WebUI: `apps/web/src/lib/historical.ts`, `apps/web/src/lib/snapshots.ts` + config/capture components (new) — historical sync selection, snapshot capture config (underlying/expiry/strikes/capture independent of streaming), retention controls.
14. Tests for routes and WebUI clients with fakes.

**MCP exposure is M6**, not M5. M5 only guarantees the service-level invariant that on-demand retrieval cannot mutate capture config.

## 6. Why this is lean / optimized / doable

- **Lean:** four focused tables, two services, no new dependencies, no broker DB replication, no new branch; reuses existing contracts, repositories, fetch helpers, and the Stage C adapter pattern.
- **Optimized:** PK/unique indexes on the natural candle key; coverage state instead of per-tick bookkeeping; batched upserts and bounded range reads; snapshot payload stored as one indexed JSON blob rather than per-strike rows; retention applied by one configurable cleanup path.
- **Doable:** Phases 1–2 are fully offline and testable now; Phase 3 is explicitly gated on Stage G so no unverified API is coded against; each phase has a small, reviewable diff and deterministic tests.

## 7. Protected / non-goals

- No changes to live streaming, supervisor, coordinator, Stage C adapter behavior, contracts' live components, Upstox/FYERS auth, database migrations `0000`–`0004`, WebUI live views, REST/SSE live endpoints, MCP, Stage G boundary, or dependencies beyond the generated migration `0005`.
- No fabricated OI/IV/Greeks/prices/volume; no pre-collection snapshot claims; no auto-subscribe; no AI mutation of operational config; no exhaustive broker DB replication; no trading/account features.

## 8. Acceptance criteria

- Cached candles survive provider disconnect/removal and process restart; missing periods are reported, never silently filled with fabricated data.
- Gap fill uses an alternate provider only when configured and available; unavailable periods and provider restrictions are explicit.
- Snapshots are stored separately per capture config; streaming selection is independent of capture; no snapshot from before local collection is claimed unless a provider actually supplies it.
- On-demand retrieval never mutates saved capture/sync config; retention is user-configurable with no hidden fixed policy.
- Provider entitlements/limits are reported as UNKNOWN/UNVERIFIED until Stage G; no live claim without verification.
- Focused + full suite, typecheck, build, `git diff --check` pass locally; independent diff review before any merge.

## 9. Verification plan

- Persistence/restart tests (candles and snapshots survive restart and provider removal).
- Provider-unavailable and partial-failure tests (gap reporting, alternate-provider fill, no fabrication).
- Retention/cleanup tests (bounded, configurable, dependency-safe).
- Config-immutability test (on-demand request does not change capture config).
- Mocked provider REST tests (no live network); Stage G smoke test separately authorized.

## 10. Requires owner approval before implementation

1. M5 implementation authorization (this plan is study-only).
2. Stage G verification of historical/expired/option-chain endpoints and entitlements before Phase 3.
3. Any dependency or schema decision beyond the generated migration `0005`.

## 11. Bounded items to verify during implementation (offline where possible)

- Exact Upstox V3 historical candle request/response shape and expired-instrument entitlement (official docs + Stage G).
- Exact FYERS history endpoint, interval/date-range limits, and expired F&O entitlement (official docs + Stage G).
- Option-chain REST field availability per provider; confirm OI/IV/Greeks are REST-only and never from the Data Socket.
- Retention interaction with catalog FKs and snapshot config references (no broken history on cleanup).

## 12. Official sources (already reviewed; see REFERENCES.md)

- Upstox V3 Historical Candle Data; Expired Instruments / Get Expired Historical Candle Data.
- FYERS API v3 history / option chain; rate-limit notice 16 Oct 2026 (Standard vs Prime).
- `PRODUCT_REQUIREMENTS.md` §6.2–6.4; `DATA_LIFECYCLE_AND_STORAGE.md` §3–4; `IMPLEMENTATION_ROADMAP.md` M5; `MULTI_PROVIDER_STREAMING_ARCHITECTURE.md` §7.1 field matrix.

## Steps

- [ ] Obtain M5 implementation authorization and Stage G verification of provider historical/option-chain APIs and entitlements
- [ ] Phase 1: add historical/snapshot contracts, migration `0005`, four tables and repositories
- [ ] Phase 2: add `HistoricalCandleService` and `OptionChainSnapshotService` with fake-provider tests
- [ ] Phase 3: add Stage-G-gated Upstox/FYERS REST adapters with mocked-fetch tests
- [ ] Phase 4: add API routes and WebUI config/capture panels with integration tests
- [ ] Run focused + full suite, typecheck, build, `git diff --check`; independent diff review before merge
