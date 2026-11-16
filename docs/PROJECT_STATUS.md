# Project Status

> **Status:** Milestone 1 (application foundation/runtime) implemented; Milestone 2 (canonical contracts, catalog foundation, persistence/sync primitives) implemented in the real application (uncommitted working tree at verification). Not a functioning market-data platform yet.
> **Last updated:** 2026-11-16
> **Related:** [README.md](../README.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)

## 1. Summary

MarketHubTS now has a **working application foundation** (M1) and an **initial canonical market-domain foundation** (M2). M1 provides centralized validated runtime configuration, reliable SQLite initialization with versioned Drizzle migrations, an API with health/readiness/lifecycle and deliberate network boundaries, a WebUI application shell showing real backend/runtime status, LAN-capable local operation, and Windows-compatible development/production workflows. M2 adds provider-independent canonical market contracts, stable identity rules, catalog persistence, repository/transaction primitives, and a source-independent transactional catalog synchronization service with conflict/failure handling, verified with synthetic fixtures in isolated temporary databases.

This is **not** a functioning market-data platform: no Upstox/FYERS API/SDK integration, no live/historical/option-chain feeds, no bulk exchange catalog download/seeding, no instrument search UI, no market-data REST/SSE endpoints, no MCP market tools/Streamable HTTP transport, no watchlists/alerts/scanners/charts, no operational market-data configuration UI, no backup/restore, and no News/X/Twitter/market-wide integrations are implemented.

## 2. Verified repository state

### 2.1 Git workflow (permanent branches)

| Item | State |
|---|---|
| Repository | `Rajendertyagi/MarketHubTS` |
| Remote | `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`) |
| Permanent branches | `main` (stable) and `develop` (active development). No additional permanent branches; no PR workflow required by project protocol. |
| `main` / `origin/main` | `277d5e248ea972c0fea984105b86708563205a6a` (unchanged) |
| `develop` / `origin/develop` (last pushed) | `ccbb66b41cd213c7595e236d443beb94efd83cf0` — "Harden Milestone 1 test quality and shutdown verification" |
| Working tree at verification | **Uncommitted M2 implementation work present** on `develop` (contracts, market-core, database schema/migration/repository, tests, docs). Branch/HEAD/remote sync and working-tree state are task-specific; re-check with `git status --short --branch`. |

### 2.2 Historical context (preserved)

- The directory was previously not a Git repository; Git was later initialized and history rewritten during early setup.
- `project-status.json` is not present locally and not tracked (historically observed as unrelated and removed earlier). If it reappears, treat as out-of-scope unless explicitly assigned and report for product-owner review.

### 2.3 Workspace and tooling

- Bun workspaces (`apps/*`, `packages/*`), `packageManager: bun@1.4.4`, TypeScript 7.0.2, `bun.lock` present.
- `apps/web/dist/`, `node_modules/`, and runtime `data/` may exist locally depending on build/run activity.

## 3. Implemented and verified

### 3.1 Milestone 1 — application foundation (implemented, pushed baseline)
| Component | Implemented behavior |
|---|---|
| `packages/config` | Centralized, validated runtime configuration (Zod): env/host/port/LAN/db/log/web settings, defaults, clear invalid-config errors, compatibility with `PORT` and `MARKETHUB_DB_PATH`, public/redacted config views. `.env.example` provided. |
| `packages/database` | Reliable SQLite open/init (directory creation, WAL/foreign_keys/NORMAL/busy_timeout), versioned Drizzle migrations, safe migration execution/failure handling, health checks, safe close/checkpoint behavior, repo-root path resolution. |
| `packages/contracts` | Shared contracts for health (compatible), readiness, system status, and API errors. |
| `apps/api` | Application composition/startup lifecycle, DB initialized/migrated before ready, Hono API with `/health`, `/ready`, `/api/status`, structured error handling/logging, deliberate CORS policy, graceful shutdown/resource cleanup, production static serving of built WebUI when available. |
| `apps/web` | Application shell and system overview consuming real backend status (`/api/status`) with loading/success/error/degraded/retry states; honest foundation notes (no fabricated market data). Vite dev proxy for `/health`, `/ready`, `/api`. |
| `apps/mcp-server` | Existing MCP STDIO `markethub_health` tool preserved; health contract compatibility maintained. |
| Scripts/tooling | Windows-compatible `bun run dev`, `bun run build`, `bun run start`, plus individual dev/db/check commands. |

### 3.2 Milestone 2 — canonical catalog foundation (implemented in working tree)
| Component | Implemented behavior (verified by code/tests/build in this task) |
|---|---|
| `packages/contracts` | `market.ts` adds Zod-validated canonical market-domain schemas/types: exchange/segment/classification, canonical instruments, derivative specs (future/option), index-eligibility metadata, provider mappings, aliases, provenance/freshness/availability concepts, sync scope/batch/result/conflicts. Validation rejects invalid derivative combinations (e.g. future with option type/strike, option without strike/type, cash/index modeled as derivative). |
| `packages/market-core` | Real domain foundation: normalized identity-key computation independent of provider-native IDs (`identity.ts`), repository/transaction/sync interfaces (`types.ts`), and `CatalogSyncService` (`sync.ts`) applying validated normalized batches transactionally with stable identity preservation, duplicate/ambiguous identity & mapping conflict reporting, metadata merge without canonical ID change, no cross-source mapping removal, no removal of absent instruments in partial batches, rollback on error conflicts (no partial catalog writes), and best-effort failed-run recording. |
| `packages/database` | Corrected unshipped additive migration `0001_lively_mauler.sql` (additive; `0000_tan_la_nuit.sql` unchanged) for `canonical_instruments`, `derivative_contracts` (one-to-one structured core derivative fields), `provider_instrument_mappings`, `instrument_aliases`, `instrument_identifier_history`, and `catalog_sync_runs` with PK/FK/unique/index constraints and JSON fields for extensible/provider-specific/supplemental metadata. `SqliteCatalogRepository` implements persistence, lookups, identifier/derivative-contract queries, and transaction boundaries. |
| Tests | `tests/market/catalog.test.ts` exercises actual service/persistence with isolated temp DBs: clean-install migration, M1→M2 upgrade preserving `app_meta`, cash/index/underlying/future/option creation, independent Upstox/FYERS mappings to same canonical instrument, aliases/safe resolution, duplicate identity/mapping detection, ambiguous mapping handling, metadata updates without canonical ID change, provider-specific attribute preservation, sync run metadata, valid transactional apply, invalid batch rejection without partial writes, failed/conflicting sync preserving previous valid catalog, partial batch not removing absent instruments or other-source mappings, explicit lifecycle changes. Existing M1 tests remain passing. |

### 3.3 Canonical identity, mapping, and sync decisions (M2)

- **Canonical identity:** internal `canonicalId` is independent of provider-native IDs. A normalized `identityKey` enforces uniqueness and stability: cash/index/other instruments keyed by exchange+segment+category+normalized symbol; futures/options keyed by exchange+segment+category+underlying reference+expiry (+strike+option type for options). Existing identity keeps its canonical ID across sync/metadata updates.
- **Provider mappings:** separate `provider_instrument_mappings` records keyed uniquely by `(provider, nativeIdentifier)` and linked to canonical instruments; Upstox/FYERS mappings are independent and never treated as interchangeable. Conflicting remaps are reported, not guessed.
- **Aliases:** stored with type/source/context/status; lookup can be contextual (exchange/segment) to avoid silent ambiguous resolution.
- **Index/derivative separation:** index instruments can carry `indexEligibility` metadata distinguishing cash-index catalogue membership, derivative eligibility, approved product scope, and verified exchange eligibility (source/time-aware fields). NSE cash-index catalogue is not treated as NSE index F&O eligibility; BSE derivative scope remains limited to SENSEX/SENSEX F&O by design.
- **Sync semantics:** source-independent validated batches (`COMPLETE`/`PARTIAL`/`INCREMENTAL`) applied in DB transactions. Invalid/conflicting batches do not leave partial catalog writes; failed/incomplete sync preserves previous valid data; partial batches do not mark absent instruments removed; a source does not remove another source's mappings; ambiguous conflicts reported. Sync runs record scope/status/counts/conflicts/timestamps for diagnostics/auditability (failed-run persistence best-effort outside rolled-back catalog transaction).
- **Provenance/extensibility:** provider-specific/source-native attributes preserved in structured JSON metadata/provenance fields without breaking canonical consumers; raw provider-supplied market fields are never fabricated (no live market fields implemented in M2).

### 3.4 Verification snapshot (2026-11-16)

| Check | Result |
|---|---|
| `bun run typecheck` | Pass (exit 0) |
| `bun test` | Pass - 56 tests, 0 failures, 237 expect() calls, 8 files |
| `bun run build` | Pass (exit 0) |
| M1 regression | Config, database, API, runtime, production serving, MCP health-contract, and contract tests pass |
| M2 migration safety | Clean-install migration and M1 (`app_meta`) → M2 upgrade pass on isolated temporary databases |

### 3.5 Manual/official verification notes

- **LAN:** configurable bind/LAN mode implemented and documented; external second-device LAN testing was not performed in this environment.
- **Official provider/exchange research:** Upstox instrument-key/field concepts reviewed from official docs (2026-11-16). NSE equity-derivatives contract specifications (updated 11 Aug 2026), products page (updated 12 Aug 2026), and NIFTY India FPI 150 product page (FUTIDX/OPTIDX) were verified as current NSE publications supporting the six approved NSE index underlyings; SEBI Annual Report 2025–26 (five eligible NSE indices as of 31 Mar 2026) reconciled as a different observation date. BSE/FYERS detailed identifier/master specifics and actual listed contracts/specs/expiries remain to be verified from authoritative sources before integration. No provider APIs/SDKs integrated; no real exchange/provider data loaded.

## 4. Not implemented (confirmed gaps)

- Provider adapters and live broker connectivity (Upstox/FYERS auth, REST/WS, subscriptions, normalization).
- Bulk exchange catalog downloads, production instrument data seeding, real provider catalog ingestion.
- Canonical market engine for live/historical/option-chain data processing.
- Live in-memory market state, realtime SSE market delivery, bounded buffers/drop policy.
- Historical candle retrieval/sync/caching and option-chain snapshot capture/storage.
- Watchlists, alerts, scanners, condition evaluation, delivery channels.
- Market-data REST/MCP tools/resources/events beyond health/status foundation; Streamable HTTP MCP transport.
- Instrument search UI, market-data WebUI screens, operational configuration UI, charts.
- Secure credential storage, backup/restore, integrity maintenance, diagnostics UI.
- News and X/Twitter integrations (later phase).

## 5. Documentation status

- Roadmap updated to reflect M1 implemented and M2 implemented in application (pending commit) with M3 as next dependency gate.
- Architecture/catalog/semantics/lifecycle/decisions/references updated to record M2 implementation, persistence ownership, sync semantics, and remaining unverified/provider-integration gaps.
- `AGENTS.md` and `README.md` remain aligned with the two-branch workflow and current foundation state; task reports must record exact Git state.

## 6. Known notes and limitations

- M2 work is currently **uncommitted** on `develop`; no commit/push performed without authorization.
- Catalog domain is not yet wired to API/UI/MCP market surfaces and has no real provider data.
- Current NSE index F&O eligibility, BSE contract details, and provider-native identifier/field mappings require verification from current official sources before M3.
- Production start requires a prior build (`bun run build` then `bun run start`).
- `project-status.json` remains out-of-scope if it reappears.

## 7. Readiness for next phase

**Ready:** M1 runtime foundation and M2 canonical catalog/persistence/sync primitives are implemented and verified in the real application.

**Next dependencies (per roadmap):** verify official Upstox/FYERS instrument/auth/market-data details and current NSE/BSE eligibility/contracts from authoritative sources; then proceed to **M3 — Provider integration: Upstox and FYERS** (adapters, auth/config, catalog ingestion/mapping, independent connectivity) without starting bulk downloads/search UI prematurely. Commit/push M2 only with explicit authorization.