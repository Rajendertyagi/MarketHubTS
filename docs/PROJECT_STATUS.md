# Project Status

> **Status:** Verified repository and scaffold condition (updated 2026-11-16 for current Git state and documentation alignment).
> **Last updated:** 2026-11-16
> **Related:** [README.md](../README.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)

## 1. Summary

MarketHubTS in this repository is a **fresh Phase 1 scaffold/foundation**. It provides a runnable workspace skeleton (API health endpoint, web health shell, MCP stdio health tool, shared contracts, SQLite/Drizzle scaffolding) but **is not a functioning market-data platform**. No broker integrations, canonical catalog/market engine, live/historical/option-chain pipelines, realtime SSE, alerts/scanners/watchlists, charts, or operational configuration are implemented.

## 2. Verified repository state

### 2.1 Verified Git state (pre-publication `main` base, verified 2026-11-16)

| Item | Verified state |
|---|---|
| Path | `D:\Temp\MarketHubTS` |
| Git repository | **Yes** — `Rajendertyagi/MarketHubTS` |
| Remote | `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`) |
| Verified `main` base | Local `main` and `origin/main` both at `277d5e248ea972c0fea984105b86708563205a6a` (`277d5e2 Correct documentation: git state, FPI 150 date, MCP alert events, dependencies, and NSE index catalogue`) at verification time (synchronized). This is the pre-publication base for the documentation review work; `main` was not modified by that review publication. |
| Documentation review branch (not merged into `main`) | `review/documentation-alignment-2026-11-16` was published from `277d5e2` for independent review (published review commit `ae613bff4ff76aa75a68022c8218c83507c9454c`, with bounded review corrections committed on the same branch). Review-branch documentation is **not** incorporated into `main` unless/until explicitly merged after review. |
| Working tree / current branch | Task-specific and temporary; not recorded as permanent project state. Check current `git status --short --branch`, branch, and HEAD in task reports/session. |
| Previously reported commits | `70c4a873f36e3143d3e5d271ead752ef3409f58f` and `7ebb6abc3bb54710288f80a24dc82a40f3499980` are historical ancestors in lineage context as applicable; history was rewritten earlier (see §2.2) and subsequent documentation commits were added on `main` before the review branch was created. |
| `project-status.json` | **Not present locally and not tracked** (verified 2026-11-15). Historically observed earlier as an unrelated file/task entry; removed during prior cleanup/history rewrite. No project tooling usage identified in this repository. Reported separately for product-owner review. |
| Workspace | Bun workspaces configured (`apps/*`, `packages/*`), `packageManager: bun@1.4.4` |
| Runtime/tooling observed | Bun 1.4.4 installed; TypeScript 7.0.2 in manifests |
| Lockfile | `bun.lock` present |
| Build artifacts present | `apps/web/dist/` present (from prior build); `node_modules/` present; `data/` may be created at runtime |

### 2.2 Historical repository state (before Git initialization, preserved for context)

- Earlier in this environment the directory was **not** a Git repository (`git status` reported: not a git repository, no `.git` history).
- Git was later initialized, connected to `origin`, and project files were committed/pushed; history was subsequently rewritten to the current single-commit state documented above. This subsection is historical context, not the current state.

## 3. Implemented and verified (scaffold)

| Component | Evidence |
|---|---|
| `apps/api` (Hono + Bun) | `GET /health` and `/` implemented; uses shared contracts and DB health check; CORS enabled; graceful shutdown handlers. Manual verification previously returned valid health payload with `checks.database: ok` and created SQLite DB file. |
| `apps/web` (React + Vite) | Shell fetches `/health` via TanStack Query/Router setup and displays status; Vite dev proxy `/health -> http://localhost:3001`; production build succeeded (`apps/web/dist/`). |
| `apps/mcp-server` (STDIO) | `markethub_health` tool registered via `@modelcontextprotocol/server` v2 `serveStdio`; fetches local API and validates contract; diagnostics to stderr. Typechecked/build-checked. |
| `packages/contracts` | Zod schemas/types for health and API error. |
| `packages/shared` | Utility helpers (`nowIso`, `getEnv`). |
| `packages/database` | `bun:sqlite` + Drizzle scaffold: `openDatabase` (WAL, foreign_keys, NORMAL, busy_timeout, mkdir, safe close/checkpoint best-effort), `checkDatabase`, `app_meta` schema, `drizzle.config.ts`, `migrate.ts`; no generated migrations in `drizzle/`. |
| Placeholder packages | `market-core`, `realtime`, `analytics`, `broker-fyers`, `broker-upstox` contain placeholder exports/config only. |
| Tests/checks (scaffold) | `tests/health.test.ts` (2 tests) passed; `bun run typecheck` passed across workspace; `bun run build` passed including web Vite build (as previously verified). |

## 4. Not implemented (confirmed gaps)

- Provider adapters and live broker connectivity (Upstox/FYERS auth, REST/WS, subscriptions, normalization).
- Canonical instrument catalog, identity/mapping, transactional sync.
- Canonical market engine and normalization/provenance/freshness pipeline.
- Live in-memory market state, realtime SSE delivery, bounded buffers/drop policy.
- Historical candle retrieval/sync/caching and option-chain snapshot capture/storage.
- Watchlists, alerts, scanners, condition evaluation, delivery channels.
- Market-data REST/MCP tools/resources/events beyond health; Streamable HTTP MCP transport.
- WebUI operational configuration, market modules, charts (Vela integration), customization persistence.
- Secure credential storage, backup/restore, integrity maintenance, diagnostics UI.
- News and X/Twitter integrations (later phase).

## 5. Documentation status

Documentation baseline on verified `main` (`277d5e2`, §2.1) includes `AGENTS.md`, `README.md`, and `docs/` covering overview, requirements, protocol, architecture/decisions, market data/catalog, provider integration, MCP interface, WebUI/config, data lifecycle/storage, roadmap, testing/acceptance, operations/backup/recovery, project status, open questions/risks, and references.

**2026-11-16 documentation alignment (review branch, not merged into `main`):** on `review/documentation-alignment-2026-11-16` (published from `277d5e2` for independent review), `docs/ENGINEERING_STANDARDS.md` was added as canonical practical standards and linked from relevant docs; specified documentation was aligned on confirmed product direction (MarketHubTS as only intended future app, original Python MarketHub as reference only, single local owner/application instance with **LAN access required** for WebUI/MCP/multiple clients, browser-based WebUI acceptable/native desktop wrapper optional, no cloud/public exposure/no app-level login, provider independence, News/X/Twitter/market-wide as phased priorities) and on Git-state reporting discipline (no temporary branch/working-tree state treated as permanent project state). Bounded review corrections on the same branch clarify Git-state reporting, LAN exposure-boundary review needs, and test-development timing. Existing valid market-domain requirements, provider research, data lifecycle, backup/recovery requirements, and phased roadmap were preserved. These changes remain under independent review until merged.

## 6. Known repository notes

- `project-status.json` is not present locally and not tracked (see §2.1); historically observed with unrelated content and removed during prior cleanup/history rewrite.
- `tsconfig.tsbuildinfo` files and `apps/web/dist/` may exist from prior work/builds; not modified by this documentation correction task.
- Git-backed repository state is recorded in §2.1 (stable identity/branch/HEAD at verification time); the pre-initialization "not a git repository" condition is historical only (§2.2). Working-tree status must be reported per task, not treated as permanent documentation.

## 7. Readiness for next phase

**Ready:** documented architecture/requirements/protocol/roadmap baseline; working scaffold and shared foundations to extend.

**Next dependencies (per roadmap):** verify key official provider/MCP/chart/credential-storage details; implement canonical contracts/catalog and persistence primitives (M1), then provider connectivity and live pipeline (M2/M3) with measured, test-backed increments.

## 8. Notes for future work

- Re-run `git status --short --branch` before future work; §2.1 records the verified pre-publication `main` base (`277d5e2`, synchronized at verification time) and distinguishes it from the unmerged documentation review branch. Record current branch/HEAD/working-tree status in task reports, not as permanent project documentation.
- If `project-status.json` reappears, treat as out-of-scope unless explicitly assigned and report for product-owner review.
- Any implementation must follow [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md), preserve existing work, and obtain explicit authorization for scope-expanding or destructive actions.
