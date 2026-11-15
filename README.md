# MarketHubTS

**AI-first, local-first Indian stock-market data platform** focused on comprehensive NSE and BSE F&O market information.

> **Status:** Phase 1 scaffold/foundation verified in this repository — **not** a functioning market-data platform yet. See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).

## What MarketHubTS is (confirmed)

- Collects, normalizes, organizes, maintains, and exposes market data for humans and AI agents.
- One **canonical data and application-services foundation** serves all consumers (MCP, REST/SSE, WebUI) — no duplicate market-data interpretation or business logic.
- Planned coverage: NSE (major indices, NSE F&O stocks, cash for supported F&O stocks, futures/options for supported stock and eligible index-derivative underlyings, current/expired contracts, relevant expiries/strikes) and BSE (SENSEX, SENSEX futures/options), plus market-wide information (India VIX, breadth, sectors, FII/DII, participant-wise derivatives OI, reports/bhavcopies, calendars/status) subject to source availability.
- Initial providers: **Upstox** and **FYERS** (independent, simultaneous when configured; app continues with available local/non-broker data when disconnected).

## What it is not

Not an automated trading platform, not an AI trading recommendation/prediction/signal engine, not sentiment analysis, not chat, not broker account management (orders/positions/holdings/funds/margin/personal trade history), and not general CSV/Excel market-data export.

## Current scaffold (implemented & verified)

- Bun workspace monorepo (`apps/*`, `packages/*`), strict TypeScript baseline.
- `apps/api`: Hono API with `GET /health` and SQLite health check.
- `apps/web`: React + Vite shell (TanStack Router/Query, Tailwind) displaying backend health.
- `apps/mcp-server`: stdio MCP server with `markethub_health` tool reusing local API.
- `packages/contracts`, `packages/shared`, `packages/database` (`bun:sqlite` + Drizzle scaffold, WAL/foreign_keys/NORMAL/busy_timeout).
- Placeholder packages: `market-core`, `realtime`, `analytics`, `broker-fyers`, `broker-upstox`.
- Basic contract test, typecheck, and build passing at scaffold verification.

## Prerequisites

- [Bun](https://bun.sh/) 1.4.4+

## Quick start

```bash
bun install

# Terminal 1 — API (http://localhost:3001)
bun run dev:api

# Terminal 2 — Web UI (http://localhost:5173, proxies /health to API)
bun run dev:web

# MCP stdio server (for MCP hosts; optional MARKETHUB_API_URL=http://localhost:3001)
bun run dev:mcp
```

## Checks

```bash
bun run typecheck
bun test
bun run build
```

Database helpers (scaffold): `bun run db:generate`, `bun run db:migrate` (see `packages/database`).

## Documentation

Start here: [`AGENTS.md`](AGENTS.md) and [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md).

| Area | Document |
|---|---|
| Product scope & requirements | [`docs/PRODUCT_REQUIREMENTS.md`](docs/PRODUCT_REQUIREMENTS.md) |
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

- Windows-first, local-first, LAN-accessible design (planned); no cloud hosting, no public internet exposure, no app-level user login (broker credentials/tokens handled responsibly).
- Technical details pending official verification are explicitly marked in docs (provider APIs/limits/entitlements, MCP 2026-07-28 transport semantics, Vela compatibility, secure Windows credential storage, etc.).
- This repository currently has no `.git` history; preserve existing files and follow the project protocol for any future changes.
