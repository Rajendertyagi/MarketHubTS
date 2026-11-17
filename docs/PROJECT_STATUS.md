# Project Status

> **Status:** Milestones 1–3, M4 Stages A/B, and **M4 Stages D and E are published on `develop` and accepted**. **M4 Stage F is implemented and published on `develop` (`35b5d2e`), pending independent review before any merge into `main`.** Stage D delivers the provider-ready backend, Stage E delivers the WebUI live-data experience, and Stage F hardens reconnect/recovery/concurrency/resource paths — but none constitutes a functioning live-market-data connection: the production Upstox driver remains deliberately locked, no real provider socket or live feed has been tested, and no historical or option-chain data exists. Stages C and G remain outstanding.
> **Last updated:** 2026-11-17
> **Related:** [README.md](../README.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)

## 1. Summary

MarketHubTS has a **working application foundation** (M1), an **initial canonical market-domain foundation** (M2), a **provider adapter framework with resilient connectivity** (M3), and the **live-data pipeline** (M4 Stages A/B/D/E). M1 provides centralized validated runtime configuration, reliable SQLite initialization with versioned Drizzle migrations, an API with health/readiness/lifecycle and deliberate network boundaries, a WebUI application shell showing real backend/runtime status, LAN-capable local operation, and Windows-compatible development/production workflows. M2 adds provider-independent canonical market contracts, stable identity rules, catalog persistence, repository/transaction primitives, and a source-independent transactional catalog synchronization service. M3 adds a portable encrypted credential store, independent Upstox/FYERS auth adapters, and a provider registry. M4 Stage A adds canonical live contracts and bounded in-memory live state; Stage B adds the Upstox V3 SDK streaming adapter; Stage D adds the provider-ready backend vertical slice (service notifications, bounded realtime hub, subscription persistence with durable generation, supervisor, REST/SSE, and a locked production driver boundary); Stage E adds the WebUI live-data experience (streaming selections, canonical-field-only live views, and a deterministic SSE client with recovery and refresh); Stage F adds reconnect/recovery/concurrency/resource hardening (terminal driver-instance retirement with at-most-once stop, typed logical-completion outcomes, callback-gated lifecycle ownership, explicit retry exhaustion, abort-safe retry sleep, and deterministic timer seams).

This is **not** a functioning market-data platform: no live provider connection is attempted in Stage D (the production Upstox driver is locked/disabled and real SDK construction is unreachable), no real socket is opened, no live/historical/option-chain feeds, no bulk exchange catalog download/seeding, no instrument search UI, no MCP market tools/Streamable HTTP transport, no watchlists/alerts/scanners/charts, no operational market-data configuration UI, no backup/restore, and no News/X/Twitter/market-wide integrations are implemented. Live-provider verification remains Stage G and requires separate authorization.

## 2. Verified repository state

### 2.1 Git workflow (permanent branches)

| Item | State |
|---|---|
| Repository | `Rajendertyagi/MarketHubTS` |
| Remote | `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`) |
| Permanent branches | `main` (stable) and `develop` (active development). No additional permanent branches; no PR workflow required by project protocol. |
| `main` / `origin/main` | `277d5e248ea972c0fea984105b86708563205a6a` (unchanged) |
| `develop` / `origin/develop` | Current HEAD is the Stage F implementation commit `35b5d2e82b04984fd36ef84fd25410730459623c` (synced with remote). Pre-Stage-D baseline: `e736af42c82891f35db1a5ae3dde311e65bcb267`. Re-check with `git log -1` / `git status --short --branch`. |
| Publication history | M1 (`eceb02c`, `62ed5d9`, `ccbb66b`); M2 (`fa40420`, `484c0a6`); M3 (`0cd1c34`, `ef1aa39`, `bcc84c2`, `9b76fb0`, `7448a9f`); M4 Stage A (`2dfe969`, `0cdb6dc`); M4 Stage B (`084969e`, `e02c64e`, `81d2900`, `9a31a8b`, `ff23b53`, `b731823`); M4 Stage D (`4dcce71` implementation, `650c8ff` first fix-forward, `d2f72fc` final review corrections + V3 references, `a0aa0ae` reconnect/pending-update lifecycle, `f51e7db` stale reconnect-timer cancellation); M4 Stage E (`ea0cae0` initial implementation, `00e6830` named SSE / manual retry / review fixes, `a8f4eef` initial-sync and retry-cancellation corrections, plus this documentation closeout which also includes the final refresh-before-snapshot and stale-snapshot fixes); M4 Stage F (`bf1044b` supervisor lifecycle/retirement/retry ownership, `21c92c7` retry sleep + hub timer seam + stress tests, `06b644c` hub scheduler typing, `35b5d2e` final-review fixes). `main` untouched throughout. |

### 2.2 Historical context (preserved)

- The directory was previously not a Git repository; Git was later initialized and history rewritten during early setup.
- `project-status.json` is not present locally and not tracked (historically observed as unrelated and removed earlier). If it reappears, treat as out-of-scope unless explicitly assigned and report for product-owner review.

### 2.3 Workspace and tooling

- Bun workspaces (`apps/*`, `packages/*`), `packageManager: bun@1.4.4`, TypeScript 7.0.2, `bun.lock` present.
- `apps/web/dist/`, `node_modules/`, and runtime `data/` may exist locally depending on build/run activity.

## 3. Implemented and verified

### 3.1 Milestone 1 — application foundation (published)
| Component | Implemented behavior |
|---|---|
| `packages/config` | Centralized, validated runtime configuration (Zod): env/host/port/LAN/db/log/web settings, defaults, clear invalid-config errors, compatibility with `PORT` and `MARKETHUB_DB_PATH`, public/redacted config views. `.env.example` provided. |
| `packages/database` | Reliable SQLite open/init (directory creation, WAL/foreign_keys/NORMAL/busy_timeout), versioned Drizzle migrations, safe migration execution/failure handling, health checks, safe close/checkpoint behavior, repo-root path resolution. |
| `packages/contracts` | Shared contracts for health (compatible), readiness, system status, and API errors. |
| `apps/api` | Application composition/startup lifecycle, DB initialized/migrated before ready, Hono API with `/health`, `/ready`, `/api/status`, structured error handling/logging, deliberate CORS policy, graceful shutdown/resource cleanup, production static serving of built WebUI when available. |
| `apps/web` | Application shell and system overview consuming real backend status (`/api/status`) with loading/success/error/degraded/retry states; honest foundation notes (no fabricated market data). Vite dev proxy for `/health`, `/ready`, `/api`. |
| `apps/mcp-server` | Existing MCP STDIO `markethub_health` tool preserved; health contract compatibility maintained. |
| Scripts/tooling | Windows-compatible `bun run dev`, `bun run build`, `bun run start`, plus individual dev/db/check commands. |

### 3.2 Milestone 2 — canonical catalog foundation (published)
| Component | Implemented behavior |
|---|---|
| `packages/contracts` | Zod-validated canonical market-domain schemas/types: exchange/segment/classification, canonical instruments, derivative specs, index-eligibility metadata, provider mappings, aliases, provenance/freshness/availability concepts, sync scope/batch/result/conflicts. |
| `packages/market-core` | Normalized identity-key computation independent of provider-native IDs, repository/transaction/sync interfaces, and `CatalogSyncService` applying validated normalized batches transactionally with stable identity preservation, conflict/failure handling, and rollback on error. |
| `packages/database` | Additive migrations for `canonical_instruments`, `derivative_contracts`, `provider_instrument_mappings`, `instrument_aliases`, `instrument_identifier_history`, `catalog_sync_runs`; `SqliteCatalogRepository` with lookups and transaction boundaries. |
| Tests | `tests/market/catalog.test.ts`: clean-install migration, M1→M2 upgrade preserving `app_meta`, cash/index/underlying/future/option creation, independent Upstox/FYERS mappings, aliases, duplicate/ambiguous identity handling, transactional apply/rollback, partial batch safety. |

### 3.3 Milestone 3 — provider adapter framework (published)
- Portable encrypted SQLite credential store with one local key file; no OS credential store, no plaintext secrets.
- Upstox Analytics Token adapter (REST validation via `GET /v2/market/status/NSE`); FYERS V3 non-trading-app OAuth with loopback callback; independent `ProviderRegistry`.
- Credential/provider routes on the main app behind a single local-peer check; LAN-safe read-only diagnostics; minimal WebUI provider status.
- Reliability: bounded timeouts/retries, atomic credential updates, fail-closed key handling, provider independence. No live broker authentication; all provider tests use mocks.

### 3.4 M4 Stage A — canonical live contracts and bounded state (published)
- `packages/contracts`: canonical live contracts (per-provider observations, freshness/availability, source selection, bounded snapshot with monotonic revision, defensive copies, session-aware freshness).
- `packages/market-core`: `LiveStateStore` / `MarketDataService` with bounded in-memory state, explicit tracking, monotonic revision, and consistent snapshot reads.

### 3.5 M4 Stage B — Upstox V3 streaming adapter (published)
- `packages/broker-upstox`: `UpstoxMarketDataStream` using the pinned official `upstox-js-sdk@2.31.0` for market-data streaming only; custom protobuf decoder removed.
- Lifecycle/decoder corrections: per-mode frames, connect race guard, CAS/IEP/full-feed field preservation, lossless int64 handling, close ownership and readiness guards. No real socket opened in tests.

### 3.6 M4 Stage D — provider-ready live-data backend vertical slice (published, accepted)
- **Contracts:** `LiveSnapshot.connections`; Zod schemas for snapshots, change/control events, provider status and subscriptions; `StreamingState` aliased to the single authoritative `ProviderConnectionState`; `LiveEventSource` / `SubscriptionRepository` ports.
- **Canonical service:** `MarketDataService.subscribe(listener)` — one synchronous notification per successful revision change, detached data, isolated listener failures, no events for no-ops.
- **Realtime hub (`packages/realtime`):** `LiveEventHub` with bounded replay (count + approximate bytes), bounded per-client queues, drop counters, coalesced `snapshot-required`, periodic `refresh` control event, atomic replay-to-live registration, cursor precedence (`Last-Event-ID` authoritative), client isolation and clean shutdown.
- **Persistence (`packages/database`):** `streaming_subscriptions` table + migration `0004_flat_spitfire.sql` (SQL, journal, snapshot); `SqliteSubscriptionRepository` with transactional row replacement and durable generation in `app_meta`, serialized writes, duplicate rejection.
- **Supervisor (`apps/api`):** provider-agnostic driver seam, serialized reconciliation against the latest committed generation, ACTIVE Upstox mapping resolution (no fabricated identifiers), bounded retry with fake drivers, shutdown guards, runtime state written through `MarketDataService`. Final corrections: DISCONNECTED/ERROR retire the driver so retry performs a fresh `start()` (not an in-place update); pending start/update operations are tracked until settlement with final cleanup after shutdown/retirement; desired and applied generations are tracked separately; driver retirement cancels any stale reconnect timer so a newer epoch can schedule its retry.
- **Locked production boundary:** `LockedUpstoxDriver` fails safely on any start/update attempt; no SDK construction, sockets or retry scheduling. Real driver construction is unreachable through startup/API/config and requires a separately authorized, independently reviewed Stage G change.
- **REST/SSE:** `GET /api/market/snapshot`, `GET /api/market/stream`, `GET/PUT /api/market/subscriptions` (PUT local-owner-only); `/api/providers/status` composes auth status with runtime streaming state.
- **Config:** small validated live policy with defensible defaults; no user-controlled live-connection authorization setting.
- **Tests:** 69 focused Stage D server-side tests across 6 files (notifications, hub, persistence/migration, supervisor + locked boundary, routes/SSE, provider-status composition), including deterministic regression tests for every independent-review correction. Stage E client tests are recorded separately in §3.7; no real network.

### 3.7 M4 Stage E — WebUI live-data experience (published, accepted)

- **Streaming selections (`apps/web/src/lib/subscriptions.ts`, `components/SubscriptionPanel.tsx`):** typed GET/PUT client for `/api/market/subscriptions` with serialized full-replacement writes and a generation guard; explicit 403 local-owner, 400 validation, 500 persistence, 500 internal and 200-with-runtime-error classification; manual canonical-ID entry (instrument search is a documented limitation).
- **SSE client (`apps/web/src/lib/live-stream.ts`):** named-event listeners for all six backend events (`snapshot`, `item-updated`, `item-removed`, `provider-connection-changed`, `snapshot-required`, `refresh`) with removal on close/supersede; initial no-cursor stream stays `connecting` until a validated snapshot, recovery/`?since=` streams enter `live` on `open`; single-flight recovery with capped backoff, shutdown cancellation via `AbortSignal`, visible error and manual retry; fetch-only refresh with generation guards, stale rejection, bounded retry and periodic-control suppression after exhaustion; monotonic snapshot application prevents revision regression; fresh terminal-per-instance controller per React effect lifecycle with `?since=` resume from the stored snapshot.
- **Display (`apps/web/src/lib/live.ts`, `components/LivePanel.tsx`):** pure reducer with duplicate/gap detection and full invalidation for `provider-connection-changed`; canonical display-model projection renders only agreed `CanonicalLiveValue`, observation and provenance fields — `value.native`, provider-native fields and market depth are never read or displayed. `streamStatus = live` denotes SSE transport only, never a streaming provider feed.
- **State (`apps/web/src/store/live-store.ts`):** Zustand store persisting across StrictMode controller remounts.
- **Tests:** 45 focused web tests across 3 files with deterministic fake EventSource/fetch; no real network, no fake production endpoint, no driver unlock.

### 3.8 M4 Stage F — reconnect/recovery/concurrency/resource hardening (published on `develop`, pending independent review)

- **Supervisor (`apps/api/src/stream-supervisor.ts`):** mandatory `AbortSignal` on driver `start`/`updateSubscriptions`; `createDriver` factory with lazy acquisition; typed five-variant `OperationOutcome` (`applied`, `failed`, `timed-out`, `callback-retired`, `shutdown`) with supervisor-owned logical completion so the serialized queue is released independently of driver settlement; `appliedGeneration` advances only on `applied`. Every driver instance is terminal — one idempotent retirement owner calls `stop()` at most once, and every restart uses a fresh factory instance (disconnect, error, failed start/update, timeout, callback retirement, shutdown). Instance-level callback gate closed synchronously before abort; both timeout quiescence branches retire; callback-triggered retirement owns the single retry decision; explicit retry exhaustion after both ERROR and DISCONNECTED sets canonical ERROR with a meaningful `lastError`; jittered backoff with no budget reset on start resolution; shutdown releases all outstanding logical completions with `shutdown`.
- **Composition (`apps/api/src/index.ts`):** `createDriver: () => new LockedUpstoxDriver()` — no real SDK, socket or provider connection; locked driver schedules no retries; factory failure is retried and never classified as locked.
- **WebUI (`apps/web/src/lib/retry-sleep.ts` new, `components/LivePanel.tsx`):** abort-safe retry sleep with listener removal on every terminal path and immediate resolution for an already-aborted signal.
- **Realtime (`packages/realtime/src/hub.ts`, `types.ts`):** narrow `IntervalScheduler` seam with global defaults; refresh timer armed/cleared deterministically; no production telemetry.
- **Tests:** six new Stage F files (supervisor await points, timeout/lifecycle/quarantine/exhaustion, hub soak/timer, store stress, WebUI recovery/refresh, retry-sleep) plus in-place migration of `tests/market/supervisor.test.ts` to `createDriver` and mandatory-signal fakes. All deterministic; no real-time waiting in new tests. A fresh-context final review found 0 Critical and 2 Important findings, both fixed with RED→GREEN tests and a green full suite.
- **Status:** implemented, verified and published on `develop`; **not yet accepted** — independent review and explicit authorization are required before merging into `main`.

### 3.9 Verification snapshot (final, 2026-11-17)

| Check | Result |
|---|---|
| `bun run typecheck` | Pass (exit 0) — all 12 workspaces |
| `bun test` | Pass — **349 tests, 0 failures, 4990 expect() calls, 32 files** (local verification; not GitHub CI evidence) |
| Focused web tests | Pass — **55 tests, 0 failures, 777 expect() calls, 5 files** (local verification; not CI evidence) |
| Focused Stage D tests | Pass — 69 tests, 0 failures, 270 expect() calls, 6 files |
| Focused supervisor tests | Pass — 24 tests, 0 failures, 121 expect() calls (migrated to `createDriver` + mandatory signals) |
| Focused Stage F tests | Pass — 69 tests across 6 new files (timeout/lifecycle 19, supervisor await 8, hub 6, store 5, recovery/refresh 5, retry-sleep 5) |
| `bun run build` | Pass (exit 0) — packages/apps checks; web Vite build succeeded |
| `git diff --check` | Pass (exit 0) |
| Migration safety | Clean-install and M3→M4 upgrade tests pass on isolated temporary databases |
| Locked boundary | No SDK construction, socket or provider contact in API/realtime/contracts source; production composes only `LockedUpstoxDriver` |

### 3.10 Manual/official verification notes

- **LAN:** configurable bind/LAN mode implemented and documented; external second-device LAN testing was not performed in this environment.
- **Official provider/exchange research:** Upstox instrument-key/field concepts and SDK version reviewed from official docs; NSE equity-derivatives contract specifications and products pages verified as current NSE publications. BSE/FYERS detailed identifier/master specifics and actual listed contracts/specs/expiries remain to be verified from authoritative sources before integration. No live provider connection or real exchange/provider data was used in Stage D.

## 4. Not implemented (confirmed gaps)

- Live provider connection and real streaming (Stage D production driver is locked/disabled; Stage G requires separate authorization).
- FYERS Data Socket streaming adapter (Stage C, on hold).
- Historical candle retrieval/sync/caching and option-chain snapshot capture/storage.
- Watchlists, alerts, scanners, condition evaluation, delivery channels.
- MCP market tools/resources/events beyond health/status foundation; Streamable HTTP MCP transport.
- Instrument search UI (manual canonical-ID entry is the Stage E limitation), operational configuration UI, charts.
- Backup/restore, integrity maintenance, diagnostics UI.
- News and X/Twitter integrations (later phase).

## 5. Documentation status

- Roadmap updated to reflect M1–M3 and M4 Stages A/B/D/E published and accepted.
- Architecture/catalog/semantics/lifecycle/decisions/references updated to record the live-data pipeline, persistence ownership, locked production boundary, and remaining unverified/provider-integration gaps.
- `AGENTS.md` and `README.md` remain aligned with the two-branch workflow and current foundation state; task reports must record exact Git state.

## 6. Known notes and limitations

- M1–M3, M4 Stages A/B/D/E and Stage F are published on `develop`; `main` remains unchanged. Stage D and Stage E are accepted; Stage F is implemented and published but pending independent review before merge.
- The canonical catalog and live pipeline are now consumed by WebUI live views; MCP market surfaces remain unwired and no real provider data is loaded.
- Current NSE index F&O eligibility, BSE contract details, and provider-native identifier/field mappings require verification from current official sources before live integration.
- Production start requires a prior build (`bun run build` then `bun run start`).
- `project-status.json` remains out-of-scope if it reappears.

## 7. Readiness for next phase

**Ready:** M1 runtime foundation, M2 catalog/persistence/sync, M3 provider auth framework, and M4 Stages A/B/D/E/F live-data pipeline, WebUI experience and hardening are implemented, verified and published on `develop`. **Stage D and Stage E are accepted; Stage F is implemented and published but pending independent review before merge into `main`.** The production driver remains locked; no live provider connection is attempted and no real feed has been tested.

**Next:** independent review of Stage F and a decision on merging `develop` into `main`; then **Stage C** (FYERS Data Socket adapter), then **Stage G** (first live provider verification). Agreed order remains **D → E → F → C → G**. Stage G requires a single-pass gate: all implementation stages complete, independent review, written scenarios/pass-fail criteria, sanitized fixture handling, explicit authorization, and a separately reviewed change to the locked boundary before any real connection.
