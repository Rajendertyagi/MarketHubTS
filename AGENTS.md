# AGENTS.md — MarketHubTS

> **Scope:** Documentation and repository navigation for MarketHubTS. This file is the entry point for humans and coding agents working in this repository.
> **Last updated:** 2026-11-22 (metadata first-slice plan added to documentation map)

## 1. Project identity (confirmed)

MarketHubTS is the **only intended future MarketHub application**: a clean, independent TypeScript solution and an **AI-first, local-first Indian stock-market data platform** focused on comprehensive NSE and BSE F&O market information. The original Python MarketHub is a **reference for domain knowledge and useful requirements only** — do not migrate, copy, or automatically reproduce its code, architecture, or accumulated complexity.

**Primary purpose:** collect, normalize, organize, maintain, and expose market data.

**Operating model:** single local owner/application instance running on the user’s PC. **LAN access is required** so other applications, devices, and multiple MCP clients can connect to the same running application. Local browser-based WebUI is acceptable; a native desktop wrapper is optional (do not prematurely force either). No cloud hosting or public internet exposure. No application-level login/authentication system. **Single-user means one local application owner, not one connected client.**

**Not the product:** automated trading/order placement, AI trading recommendations/predictions/signals, sentiment analysis, chat, broker account management (positions/holdings/funds/margin/personal trade history), or general CSV/Excel market-data export. (Watchlist import/export, if retained, is separate.)

**Required phased priorities (not unwanted):** News integration, X/Twitter integration, and market-wide information must be preserved in architecture/roadmap.

**Fundamental architecture requirement:** one canonical data and application-services foundation must serve all consumers (MCP, REST/SSE, WebUI). No independent market-data interpretation or duplicate business logic in MCP and WebUI. Upstox and FYERS must work independently (one provider failing must not break the other).

## 2. Repository status (verified)

- **State:** application foundation (M1), canonical catalog (M2), provider auth framework (M3), M4 Stages A/B/C/D/E/F, and **M5 offline historical/snapshot persistence (Phases 1–4A)** are implemented on `develop`. M5 Phase 4B provider-backed activation and all Stage G verification remain gated; **M6-A (Streamable HTTP at `/mcp` + retained STDIO, shared factory), M6-B1 (catalog-search and event-feed read seams) and M6-B2 (nine tools over both transports) are implemented and published on `develop`; M6-B3 (resources/prompts/cache hints and snapshot pagination) is implemented and published on `develop` at `0d58bbb`; M6-C (durable activity history and WebUI inspection) is **accepted and closed** at final reviewed commit `32b034a` (acceptance record in [`docs/M6_C_PLAN.md`](docs/M6_C_PLAN.md) §0). **M6-D/E source and tests are present on `develop` but neither phase is accepted or complete** (independent review gate in [`docs/M6_D_E_PLAN.md`](docs/M6_D_E_PLAN.md) §8.1–§8.3); **M6-B4 remains separately owned and not accepted.** Physical LAN reachability is outside the revised M6 scope by user decision. Production drivers remain locked — no live provider connection or live REST verification has been performed. **Not** a functioning live market-data platform. See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for the detailed, current status authority.
- **Git workflow:** two permanent branches — `main` (stable) and `develop` (active development). Repository `Rajendertyagi/MarketHubTS`, remote `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`). Branch/HEAD/working-tree state is task-specific; check `git status --short --branch` and report exact SHAs in task reports.
- **Workspace:** Bun workspaces (`apps/*`, `packages/*`), Bun 1.4.4, TypeScript 7.0.2.
- **Implemented:** centralized validated runtime config (`@markethub/config`, `.env.example`); SQLite + Drizzle with versioned migrations (`0000`–`0006`, including the M6-C `mcp_activity` migration); Hono API with `/health`, `/ready`, `/api/status`, structured errors/logging and deliberate CORS; React+Vite WebUI shell with live-data views; Windows-compatible dev/prod scripts with production static serving; MCP stdio `markethub_health` compatibility. Canonical catalog/identity/transactional sync (`@markethub/contracts`, `@markethub/market-core`); portable encrypted credential store and independent Upstox/FYERS auth adapters; Upstox V3 SDK streaming adapter and FYERS Data Socket streaming adapter (M4 Stage C, official `fyers-api-v3@2.4.1`) — market-data streaming only. M4 Stages D/E/F: canonical live service notifications, bounded realtime hub, subscription persistence with durable generation, supervisor, REST/SSE market endpoints, WebUI live-data experience, reconnect/recovery hardening, and a locked production driver boundary. M5 offline implementation (Phases 1–4A): five-table historical/snapshot persistence with validated `app_meta` retention, canonical historical/snapshot services with derived coverage and first-write-wins conflicts, offline Upstox/FYERS REST adapters (mocked fetch), and local API/WebUI panels — all with empty provider collections in production composition.
- **Not implemented / gated:** live provider connection and live REST verification (production drivers locked; Stage G requires separate authorization), FYERS Data Socket production activation/live verification (the Stage C adapter is implemented), **M5 Phase 4B provider-backed activation and M5 Stage G REST verification**, M6-B4 conformance/parity (separately owned); M6-D/E formal acceptance (source and tests present, independent review gate pending) — M6-A/B1/B2/B3 are implemented and published on `develop`; M6-C is accepted and closed at `32b034a`; see [`docs/M6_PLAN.md`](docs/M6_PLAN.md), [`docs/M6_C_PLAN.md`](docs/M6_C_PLAN.md) and [`docs/M6_B3_PLAN.md`](docs/M6_B3_PLAN.md) — alerts/scanners/watchlists, charts, operational WebUI config, backup/restore, News/X/Twitter, etc. Placeholder package remains: `analytics`.

See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) for details.

## 3. Documentation map (authoritative)

| Document | Purpose |
|---|---|
| [`README.md`](README.md) | Concise project intro, how to run/check the current scaffold, links to docs |
| [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md) | Vision, identity, boundaries, consumers, high-level principles |
| [`docs/PRODUCT_REQUIREMENTS.md`](docs/PRODUCT_REQUIREMENTS.md) | Confirmed product requirements, scope, exclusions, later phases |
| [`docs/PROJECT_MANAGER_PROTOCOL.md`](docs/PROJECT_MANAGER_PROTOCOL.md) | Roles, mandatory development lifecycle, strict rules, task format |
| [`docs/ENGINEERING_STANDARDS.md`](docs/ENGINEERING_STANDARDS.md) | **Canonical** practical engineering standards (architecture/isolation, reliability, code quality, config/data, UI, testing, dependencies) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System/subsystem architecture, diagrams, invariants, boundaries |
| [`docs/ARCHITECTURE_DECISIONS.md`](docs/ARCHITECTURE_DECISIONS.md) | Established decisions, rationale, constraints, provisional items |
| [`docs/METADATA_AND_CAPABILITY_DISCOVERY.md`](docs/METADATA_AND_CAPABILITY_DISCOVERY.md) | **Authoritative:** backend/contract-owned options, capabilities and domain metadata; WebUI discovery instead of duplicated frontend lists (AD-025) |
| [`docs/METADATA_DISCOVERY_FIRST_SLICE_PLAN.md`](docs/METADATA_DISCOVERY_FIRST_SLICE_PLAN.md) | Bounded, source-verified implementation plan for the first WebUI options slice (tool selector, instrument picker, interval selector) |
| [`docs/MARKET_DATA_AND_CATALOG.md`](docs/MARKET_DATA_AND_CATALOG.md) | Supported universe, canonical catalog/identity, normalization, provenance |
| [`docs/PROVIDER_INTEGRATION.md`](docs/PROVIDER_INTEGRATION.md) | Upstox/FYERS adapter design, independence, source selection, verification needs |
| [`docs/MCP_INTERFACE.md`](docs/MCP_INTERFACE.md) | MCP capability design, transports, permissions, events, parity with services |
| [`docs/WEBUI_AND_CONFIGURATION.md`](docs/WEBUI_AND_CONFIGURATION.md) | WebUI modules, operational configuration ownership, customization, charts |
| [`docs/DATA_LIFECYCLE_AND_STORAGE.md`](docs/DATA_LIFECYCLE_AND_STORAGE.md) | Live/historical/snapshot lifecycles, retention, persistence, backup/restore |
| [`docs/IMPLEMENTATION_ROADMAP.md`](docs/IMPLEMENTATION_ROADMAP.md) | Dependency-based workstreams, milestones, acceptance criteria, risks |
| [`docs/TESTING_AND_ACCEPTANCE.md`](docs/TESTING_AND_ACCEPTANCE.md) | Validation strategy, provider-state matrix, scenarios, parity checks |
| [`docs/OPERATIONS_BACKUP_AND_RECOVERY.md`](docs/OPERATIONS_BACKUP_AND_RECOVERY.md) | Local/LAN operation, diagnostics, startup/shutdown, backup/restore/recovery |
| [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) | Verified current repository/scaffold condition |
| [`docs/OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md`](docs/OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md) | Confirmed vs established vs pending verification, risks, approvals needed |
| [`docs/REFERENCES.md`](docs/REFERENCES.md) | Official sources reviewed, access dates, verified facts, limitations |

## 4. Working rules for agents (summary)

- **Inspect before acting:** read relevant files, manifests, docs, and `git status` (if repo exists) before/after tasks.
- **Preserve existing work:** do not delete or overwrite unrelated user changes; update/extend docs instead of blind replacement.
- **No guessing:** mark unverified technical details explicitly; never invent APIs, provider capabilities, limits, or data.
- **Scope discipline:** a request to investigate/document is not permission to implement; implementation is not permission to commit/push.
- **No destructive actions:** no force-push, history rewrite, branch/file deletion, or production/user DB changes without explicit authorization.
- **Protected boundaries:** do not modify application source/tests/manifests/lockfiles/DB unless explicitly assigned; do not duplicate market-data/business logic across MCP/WebUI.
- **Evidence-based reporting:** distinguish implemented vs planned/proposed; report tests only if actually executed.
- **Engineering standards:** follow [`docs/ENGINEERING_STANDARDS.md`](docs/ENGINEERING_STANDARDS.md) (canonical) for architecture/isolation, reliability, code quality, configuration/data, UI, testing, and dependencies.

Full protocol: [`docs/PROJECT_MANAGER_PROTOCOL.md`](docs/PROJECT_MANAGER_PROTOCOL.md). Canonical engineering standards: [`docs/ENGINEERING_STANDARDS.md`](docs/ENGINEERING_STANDARDS.md).

## 5. Key invariants (must not be violated)

- One canonical data and application-services foundation serves MCP, REST/SSE, and WebUI.
- Provider-specific logic stays inside adapters; canonical identity/normalization is shared.
- Raw provider-supplied market fields (OI, IV, Greeks, prices, depth, volume) are never fabricated; unavailable means unavailable.
- Live ticks/depth are in-memory (not permanently stored per tick/change); historical candles and option-chain snapshots follow configured persistence rules.
- AI/MCP must not modify operational configuration (credentials, connections, streaming/sync/capture/retention/provider prefs, startup/network). WebUI owns operational config.
- Alerts requiring non-streamed instruments are saved as waiting (not auto-subscribed).
- No order placement/trading/account-management features.

## 6. Quick commands

```bash
bun install

# Development (Windows-compatible, API + Web)
bun run dev

# Individual processes (troubleshooting)
bun run dev:api   # API (default http://127.0.0.1:3001)
bun run dev:web   # Web UI dev server (default http://127.0.0.1:5173, proxies /health,/ready,/api)
bun run dev:mcp   # MCP stdio server (MARKETHUB_API_URL=http://localhost:3001)

# Production
bun run build
bun run start     # serves built WebUI + API from one local instance (requires build)

# Checks and database helpers
bun run typecheck
bun test
bun run db:generate
bun run db:migrate
```
