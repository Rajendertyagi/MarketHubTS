# AGENTS.md — MarketHubTS

> **Scope:** Documentation and repository navigation for MarketHubTS. This file is the entry point for humans and coding agents working in this repository.
> **Last updated:** 2026-11-15

## 1. Project identity (confirmed)

MarketHubTS is the **only intended future MarketHub application**: a clean, independent TypeScript solution and an **AI-first, local-first Indian stock-market data platform** focused on comprehensive NSE and BSE F&O market information. The original Python MarketHub is a **reference for domain knowledge and useful requirements only** — do not migrate, copy, or automatically reproduce its code, architecture, or accumulated complexity.

**Primary purpose:** collect, normalize, organize, maintain, and expose market data.

**Operating model:** single local owner/application instance running on the user’s PC. **LAN access is required** so other applications, devices, and multiple MCP clients can connect to the same running application. Local browser-based WebUI is acceptable; a native desktop wrapper is optional (do not prematurely force either). No cloud hosting or public internet exposure. No application-level login/authentication system. **Single-user means one local application owner, not one connected client.**

**Not the product:** automated trading/order placement, AI trading recommendations/predictions/signals, sentiment analysis, chat, broker account management (positions/holdings/funds/margin/personal trade history), or general CSV/Excel market-data export. (Watchlist import/export, if retained, is separate.)

**Required phased priorities (not unwanted):** News integration, X/Twitter integration, and market-wide information must be preserved in architecture/roadmap.

**Fundamental architecture requirement:** one canonical data and application-services foundation must serve all consumers (MCP, REST/SSE, WebUI). No independent market-data interpretation or duplicate business logic in MCP and WebUI. Upstox and FYERS must work independently (one provider failing must not break the other).

## 2. Repository status (verified)

- **State:** fresh Phase 1 scaffold/foundation (not a functioning market-data platform).
- **Git (verified 2026-11-16):** repository `Rajendertyagi/MarketHubTS`, remote `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`), branch `main`; local HEAD and `origin/main` both `277d5e248ea972c0fea984105b86708563205a6a` (`277d5e2 Correct documentation: git state, FPI 150 date, MCP alert events, dependencies, and NSE index catalogue`), synchronized at verification time. Working-tree status is task-specific (not recorded as permanent project state); check `git status --short --branch` in task reports/current session.
- **Workspace:** Bun workspaces (`apps/*`, `packages/*`), Bun 1.4.4, TypeScript 7.0.2.
- **Implemented (verified):** Hono API `/health` with SQLite check, React+Vite web shell fetching health, MCP stdio server with `markethub_health` tool reusing local API, shared Zod contracts, `bun:sqlite`+Drizzle database scaffold (`app_meta`, WAL/foreign_keys/NORMAL/busy_timeout), basic tests/typecheck/build passing at scaffold time.
- **Not implemented:** broker integrations, canonical market engine/catalog, live/historical/option-chain data pipelines, realtime SSE, alerts/scanners/watchlists, charts, operational WebUI config, backup/restore, Streamable HTTP MCP, etc. Package scaffolds exist for future modules.

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

## 6. Quick commands (current scaffold)

```bash
bun install
bun run dev:api   # http://localhost:3001
bun run dev:web   # http://localhost:5173 (proxies /health)
bun run dev:mcp   # stdio MCP server
bun run typecheck
bun test
bun run build
```
