# MarketHubTS

**AI-first, local-first Indian stock-market data platform** focused on comprehensive NSE and BSE F&O market information.

> **Status:** Application foundation (M1), canonical catalog (M2), provider auth framework (M3), M4 Stages A/B/C/D/E/F, **M5 offline historical/snapshot persistence (Phases 1–4A)**, M6-A/B1/B2/B3 (MCP transport, read seams, tools, resources/prompts) and M6-C (durable activity history, accepted and closed) are implemented on `develop`. **Backend-Driven Metadata and Capability Discovery Phases 1, 2, 3, 4 and 5 are also implemented and published** — shared-contract options, instrument picker, MCP operation selector, provider-backed derivative expiry discovery (WP4A `03adab1` + fixes `bcec6ab`/`8785670`, WP4B `e99c5f3`, WP4C `9862464` + fix `13061da`, canonical plan `ed967e3`; all audited KEEP), and provider status/capability rendering with safe bounded refresh. Phase 4 builds a local catalogue from public Upstox BOD + FYERS Symbol Master files (no credentials, no live calls) and exposes a bounded `GET /api/catalog/derivative-expiries` with honest FRESH/STALE/UNKNOWN freshness plus a Snapshot Panel expiry selector with manual fallback clearly marked unverified; provider identity stays fixed `UPSTOX`/`FYERS` (no Automatic option, no FYERS default), with no live provider connection or activation and no full exchange catalogue claim. **Phase 6 is complete: WP6A (retention consistency), WP6B (explicit snapshot provider selection) and WP6C (Overview accuracy) are all implemented, audited KEEP and published on `develop`.** Stages D and E are accepted; Stage F passed independent review and was integrated into `main` by an authorized fast-forward. Stage C (FYERS Data Socket adapter) is adapter-only at final reviewed state `e8ce409`. M6-D/E source and tests are present but not accepted; M6-B4 is separately owned. **No provider is connected**: the API composes services with empty provider collections, Phase 4B activation is Stage-G gated, and no live REST verification has been performed. **Not** a functioning live market-data platform. See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).

## What MarketHubTS is (confirmed)

- **Only intended future MarketHub application:** a clean, independent TypeScript solution. The original Python MarketHub is a reference for domain knowledge and useful requirements only (no migration/copy/reproduction of its code, architecture, or accumulated complexity).
- Collects, normalizes, organizes, maintains, and exposes market data for humans and AI agents/applications.
- One **canonical data and application-services foundation** serves all consumers (MCP, REST/SSE, WebUI) — no duplicate market-data interpretation or business logic.
- Planned coverage: NSE (major cash indices via a discoverable catalogue of official NSE index definitions, organized by official categories and individually configurable for streaming/historical sync — distinct from the six approved index F&O underlyings; NSE F&O stocks; cash for supported F&O stocks; futures/options for supported stock and currently eligible index-derivative underlyings [approved six]; current/expired contracts; relevant expiries/strikes) and BSE (SENSEX, SENSEX futures/options), plus market-wide information (India VIX, breadth, sectors, FII/DII, participant-wise derivatives OI, reports/bhavcopies, calendars/status) subject to source availability. See [docs/MARKET_DATA_AND_CATALOG.md](docs/MARKET_DATA_AND_CATALOG.md).
- Initial providers: **Upstox** and **FYERS** (independent, simultaneous when configured; one provider failing must not break the other; app continues with available local/non-broker data when disconnected).

## What it is not

Not an automated trading platform, not an AI trading recommendation/prediction/signal engine, not sentiment analysis, not chat, not broker account management (orders/positions/holdings/funds/margin/personal trade history), and not general CSV/Excel market-data export.

## Current implementation

- Bun workspace monorepo (`apps/*`, `packages/*`), strict TypeScript baseline.
- **Runtime/configuration:** centralized validated config (`packages/config`, Zod), `.env.example`, compatibility with `PORT`/`MARKETHUB_DB_PATH`, LAN/local modes, no secret exposure in public diagnostics.
- **Database:** `packages/database` (`bun:sqlite` + Drizzle) with reliable initialization, WAL/foreign_keys/NORMAL/busy_timeout, versioned migrations, and initial `app_meta` migration.
- **API (`apps/api`):** Hono + Bun with startup/shutdown lifecycle, `/health` (compatible), `/ready`, `/api/status`, structured errors/logging, deliberate CORS policy, and production static serving of the built WebUI.
- **WebUI (`apps/web`):** React + Vite application shell (TanStack Router/Query, Tailwind) showing real backend/runtime status with loading/error/recovery states (no fabricated market data), plus the Stage E live-data tab (streaming selections and canonical-field-only live views with a deterministic SSE client).
- **MCP (`apps/mcp-server`):** stdio `markethub_health` tool preserved (uses local API health contract).
- **Workflows:** Windows-compatible `bun run dev`, `bun run build`, `bun run start` (single local instance serving API + built WebUI in production).
- **Market domain (`packages/contracts`, `packages/market-core`):** canonical instrument identity/catalog with transactional sync; canonical live contracts, observation normalization, session-aware freshness, deterministic source selection, and bounded in-memory live state with change notifications.
- **Providers (`packages/broker-upstox`, `packages/broker-fyers`):** portable encrypted credential store, independent Upstox/FYERS auth adapters, an Upstox V3 SDK streaming adapter, and a FYERS Data Socket streaming adapter (M4 Stage C, official `fyers-api-v3@2.4.1`) — both market-data streaming only. Production drivers remain locked.
- **Live backend (`packages/realtime`, `apps/api`):** bounded realtime hub, subscription persistence with durable generation, supervisor, and REST/SSE market endpoints (`/api/market/snapshot`, `/api/market/stream`, `/api/market/subscriptions`). Production uses a locked driver: no SDK construction, socket or provider connection.
- **Historical & snapshots (M5, `packages/contracts`, `packages/database`, `packages/market-core`, `packages/broker-upstox`, `packages/broker-fyers`, `apps/api`, `apps/web`):** five-table persistence with additive migration `0005`, derived coverage and interval-aware unconfirmed gaps, first-write-wins conflicts, fail-closed retention; canonical historical/snapshot services; offline Upstox/FYERS REST adapters (mocked fetch only); local API (`/api/historical/*`, `/api/snapshots/*`, `/api/retention*`) and WebUI panels. India-local (Asia/Kolkata) calendar helpers with strict date validation. **No provider is connected** — on-demand requests honestly report no provider; Phase 4B activation is Stage-G gated.
- **Tests (local verification, 2026-11-19):** `bun test` — 551 passed, 0 failed, 5856 assertions, 46 files; `bun run typecheck` — 12/12 workspaces; `bun run build` — all packages and apps passed; `git diff --check` — clean. No real network or live provider connection in tests. These are local verification figures, **not GitHub CI evidence**; see [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) §3.12. Earlier snapshots (423/459 tests) are historical.
- Placeholder package remains: `analytics`. The FYERS streaming adapter (Stage C) is implemented and final-reviewed at `e8ce409`; live verification (Stage G) is pending and locked; WebUI live views (Stage E) and reconnect/recovery hardening (Stage F) are implemented.

## Prerequisites

- [Bun](https://bun.sh/) 1.4.4+

## Quick start (Windows)

```powershell
bun install

# Development (API + Web, Windows-compatible)
bun run dev
# API:  http://127.0.0.1:3001 (default)
# Web:  http://127.0.0.1:5173 (default, proxies /health, /ready, /api)

# Individual processes (optional)
bun run dev:api
bun run dev:web
bun run dev:mcp   # MCP stdio server (MARKETHUB_API_URL=http://localhost:3001)

# Production (single local instance serving built WebUI + API)
bun run build
bun run start
```

**LAN mode (documented):** set `MARKETHUB_LAN=true` (and/or explicit `MARKETHUB_HOST`/`MARKETHUB_WEB_HOST`) in `.env` to bind for local-network access. LAN access is required by product design but has no app-level login; review exposure boundaries and Windows Firewall implications before enabling on shared networks. Do not expose publicly.

## Checks and database helpers

```bash
bun run typecheck
bun test
bun run build
bun run db:generate
bun run db:migrate
```

## Documentation

Start here: [`AGENTS.md`](AGENTS.md) and [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md).

| Area | Document |
|---|---|
| Product scope & requirements | [`docs/PRODUCT_REQUIREMENTS.md`](docs/PRODUCT_REQUIREMENTS.md) |
| Engineering standards (canonical) | [`docs/ENGINEERING_STANDARDS.md`](docs/ENGINEERING_STANDARDS.md) |
| Architecture & decisions | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md) |
| Metadata & capability discovery (authoritative) | [`docs/METADATA_AND_CAPABILITY_DISCOVERY.md`](docs/METADATA_AND_CAPABILITY_DISCOVERY.md) |
| First implementation slice plan | [`docs/METADATA_DISCOVERY_FIRST_SLICE_PLAN.md`](docs/METADATA_DISCOVERY_FIRST_SLICE_PLAN.md) |
| Detailed phase-wise implementation plan | [`docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md`](docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md) |
| Phase 1 implementation assignment | [`docs/METADATA_DISCOVERY_PHASE_1_PLAN.md`](docs/METADATA_DISCOVERY_PHASE_1_PLAN.md) |
| Phase 3 instrument picker plan | [`docs/METADATA_DISCOVERY_PHASE_3_PLAN.md`](docs/METADATA_DISCOVERY_PHASE_3_PLAN.md) |
| Catalog & market data | [`docs/MARKET_DATA_AND_CATALOG.md`](docs/MARKET_DATA_AND_CATALOG.md) |
| Providers (Upstox/FYERS) | [`docs/PROVIDER_INTEGRATION.md`](docs/PROVIDER_INTEGRATION.md) |
| MCP interface | [`docs/MCP_INTERFACE.md`](docs/MCP_INTERFACE.md) |
| WebUI & configuration | [`docs/WEBUI_AND_CONFIGURATION.md`](docs/WEBUI_AND_CONFIGURATION.md) |
| Data lifecycle & storage | [`docs/DATA_LIFECYCLE_AND_STORAGE.md`](docs/DATA_LIFECYCLE_AND_STORAGE.md) |
| Roadmap | [`docs/IMPLEMENTATION_ROADMAP.md`](docs/IMPLEMENTATION_ROADMAP.md) |
| M5 plan (offline implementation complete) | [`docs/STAGE_5_PLAN.md`](docs/STAGE_5_PLAN.md) |
| M6 plan (MCP, planned) | [`docs/M6_PLAN.md`](docs/M6_PLAN.md) |
| Testing & acceptance | [`docs/TESTING_AND_ACCEPTANCE.md`](docs/TESTING_AND_ACCEPTANCE.md) |
| Operations & backup/restore | [`docs/OPERATIONS_BACKUP_AND_RECOVERY.md`](docs/OPERATIONS_BACKUP_AND_RECOVERY.md) |
| Project status | [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) |
| Open questions & risks | [`docs/OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md`](docs/OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md) |
| References | [`docs/REFERENCES.md`](docs/REFERENCES.md) |
| Development protocol | [`docs/PROJECT_MANAGER_PROTOCOL.md`](docs/PROJECT_MANAGER_PROTOCOL.md) |

## Notes

- **Operating model:** single local owner/application instance on the user’s PC (Windows-first, local-first). **Single-user means one local application owner, not one connected client.** **LAN access is required** so other applications/devices/multiple MCP clients can connect to the same running application (WebUI now; MCP HTTP planned). Local browser-based WebUI is acceptable; a native desktop wrapper is optional. No cloud hosting, no public internet exposure, no app-level user login (broker credentials/tokens handled responsibly).
- **Phased priorities preserved:** News integration, X/Twitter integration, and market-wide information are required later-phase priorities (not unwanted features).
- Technical details pending official verification are explicitly marked in docs (provider APIs/limits/entitlements, MCP 2026-07-28 transport semantics, Vela compatibility, secure Windows credential storage, etc.).
- **Git workflow:** two permanent branches — `main` (stable) and `develop` (active development). Repository `Rajendertyagi/MarketHubTS` (`origin`). Branch/HEAD/working-tree state is task-specific; follow the project protocol for any future changes (no commit/push without explicit authorization).
