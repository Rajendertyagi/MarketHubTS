# MarketHubTS

**AI-first, local-first Indian stock-market data platform** focused on comprehensive NSE and BSE F&O market information.

> **Status:** Application foundation implemented (runtime/configuration, SQLite migrations, API health/readiness, WebUI system-status shell, LAN-capable local operation, dev/prod workflows). **Not** a functioning market-data platform yet. See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).

## What MarketHubTS is (confirmed)

- **Only intended future MarketHub application:** a clean, independent TypeScript solution. The original Python MarketHub is a reference for domain knowledge and useful requirements only (no migration/copy/reproduction of its code, architecture, or accumulated complexity).
- Collects, normalizes, organizes, maintains, and exposes market data for humans and AI agents/applications.
- One **canonical data and application-services foundation** serves all consumers (MCP, REST/SSE, WebUI) — no duplicate market-data interpretation or business logic.
- Planned coverage: NSE (major cash indices via a discoverable catalogue of official NSE index definitions, organized by official categories and individually configurable for streaming/historical sync — distinct from the six approved index F&O underlyings; NSE F&O stocks; cash for supported F&O stocks; futures/options for supported stock and currently eligible index-derivative underlyings [approved six]; current/expired contracts; relevant expiries/strikes) and BSE (SENSEX, SENSEX futures/options), plus market-wide information (India VIX, breadth, sectors, FII/DII, participant-wise derivatives OI, reports/bhavcopies, calendars/status) subject to source availability. See [docs/MARKET_DATA_AND_CATALOG.md](docs/MARKET_DATA_AND_CATALOG.md).
- Initial providers: **Upstox** and **FYERS** (independent, simultaneous when configured; one provider failing must not break the other; app continues with available local/non-broker data when disconnected).

## What it is not

Not an automated trading platform, not an AI trading recommendation/prediction/signal engine, not sentiment analysis, not chat, not broker account management (orders/positions/holdings/funds/margin/personal trade history), and not general CSV/Excel market-data export.

## Current implementation (foundation milestone)

- Bun workspace monorepo (`apps/*`, `packages/*`), strict TypeScript baseline.
- **Runtime/configuration:** centralized validated config (`packages/config`, Zod), `.env.example`, compatibility with `PORT`/`MARKETHUB_DB_PATH`, LAN/local modes, no secret exposure in public diagnostics.
- **Database:** `packages/database` (`bun:sqlite` + Drizzle) with reliable initialization, WAL/foreign_keys/NORMAL/busy_timeout, versioned migrations, and initial `app_meta` migration.
- **API (`apps/api`):** Hono + Bun with startup/shutdown lifecycle, `/health` (compatible), `/ready`, `/api/status`, structured errors/logging, deliberate CORS policy, and production static serving of the built WebUI.
- **WebUI (`apps/web`):** React + Vite application shell (TanStack Router/Query, Tailwind) showing real backend/runtime status with loading/error/recovery states (no fabricated market data).
- **MCP (`apps/mcp-server`):** stdio `markethub_health` tool preserved (uses local API health contract).
- **Workflows:** Windows-compatible `bun run dev`, `bun run build`, `bun run start` (single local instance serving API + built WebUI in production).
- **Tests:** automated coverage for config, database/migrations, API/health/readiness/errors, runtime startup/shutdown, production serving, and MCP contract regression; typecheck/build passing.
- Placeholder packages remain: `market-core`, `realtime`, `analytics`, `broker-fyers`, `broker-upstox`.

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
| Catalog & market data | [`docs/MARKET_DATA_AND_CATALOG.md`](docs/MARKET_DATA_AND_CATALOG.md) |
| Providers (Upstox/FYERS) | [`docs/PROVIDER_INTEGRATION.md`](docs/PROVIDER_INTEGRATION.md) |
| MCP interface | [`docs/MCP_INTERFACE.md`](docs/MCP_INTERFACE.md) |
| WebUI & configuration | [`docs/WEBUI_AND_CONFIGURATION.md`](docs/WEBUI_AND_CONFIGURATION.md) |
| Data lifecycle & storage | [`docs/DATA_LIFECYCLE_AND_STORAGE.md`](docs/DATA_LIFECYCLE_AND_STORAGE.md) |
| Roadmap | [`docs/IMPLEMENTATION_ROADMAP.md`](docs/IMPLEMENTATION_ROADMAP.md) |
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
