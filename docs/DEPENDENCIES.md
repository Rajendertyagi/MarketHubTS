# Dependencies

> **Status:** Verified baseline for Phase 1 scaffold; some selections provisional/pending validation. Authoritative cross-references: [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md), [REFERENCES.md](REFERENCES.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md).
> **Last updated:** 2026-11-15 (verified for Bun 1.4.4 on Windows)

## 1. Runtime / tooling (installed)

| Dependency | Version | Role | Status |
|---|---|---|---|
| Bun | 1.4.4 | Runtime, package manager, test runner, bundler | Installed/verified |
| TypeScript | 7.0.2 | Language/type checking | Installed (latest major; scaffold checks passed) |
| bun-types | 1.4.4 | Bun type definitions | Installed |

## 2. Core libraries (installed)

| Dependency | Version | Role | Status |
|---|---|---|---|
| React / React DOM | 19.3.1 | Web UI | Installed |
| Vite | 8.3.8 | Frontend dev/build | Installed (scaffold build passed) |
| @vitejs/plugin-react | 6.0.1 | React integration for Vite | Installed |
| Hono | 4.13.18 | HTTP API framework | Installed |
| Zod | 4.6.7 | Schema validation/contracts | Installed |
| Drizzle ORM | 0.45.4 | Database ORM | Installed (scaffold) |
| Drizzle Kit | 0.31.11 | Migrations/tooling | Installed (scaffold) |
| `bun:sqlite` | built-in | SQLite driver | Available in Bun |

## 3. Frontend state/data/UI (installed/selected)

| Dependency | Version | Role | Status |
|---|---|---|---|
| @tanstack/react-router | 1.170.46 | Routing | Installed (basic shell) |
| @tanstack/react-query | 5.107.1 | Server/API state | Installed (basic shell) |
| @tanstack/react-table | 9.3.1 | Data tables | Selected, not integrated |
| @tanstack/react-virtual | 3.14.26 | Virtualization | Selected, not integrated |
| Zustand | 5.1.0 | UI state | Installed/available, minimal use |
| Tailwind CSS | 4.3.5 | Styling | Installed (v4) |
| @tailwindcss/vite | 4.3.5 | Tailwind Vite integration | Installed |
| shadcn/ui | n/a (component patterns) | UI components | Selected, not generated/integrated |

## 4. MCP (installed)

| Dependency | Version | Role | Status |
|---|---|---|---|
| @modelcontextprotocol/server | 2.4.0 | MCP server SDK (v2) | Installed; STDIO `serveStdio` used in scaffold |
| @modelcontextprotocol/client | — | MCP client SDK (v2) | **Not installed/declared/resolved** in current manifests, `bun.lock`, or imports (verified 2026-11-15). Possible future testing dependency only; do not treat as available. |

**Transport note:** scaffold uses STDIO; the latest stable official MCP protocol is a mandatory M6 product requirement (verified target `2026-07-28` / SDK `2.4.0`, re-verify at implementation start). Streamable HTTP/SSE event delivery is fully implemented in M6; no new third-party dependency is required because the installed `@modelcontextprotocol/server@2.4.0` provides `createMcpHandler` and `serveStdio`. A real pinned modern client is required for acceptance; if `@modelcontextprotocol/client` is needed for testing, adding it requires separate authorization (no dependency change in this documentation task). See [M6_PLAN.md](M6_PLAN.md) §3.1–§3.3, [MCP_INTERFACE.md](MCP_INTERFACE.md), [REFERENCES.md](REFERENCES.md).

## 5. Charts (candidate, not integrated)

| Dependency | Version | Role | Status |
|---|---|---|---|
| @luxalgo/vela | 0.10.8 | Financial charting | **Candidate/provisional** — compatibility, features, performance, and licensing/attribution must be verified before final adoption |

## 6. Broker integrations (not installed)

| Item | Status |
|---|---|
| Upstox official SDK/API packages | Not selected/installed — verify official package names, APIs, and Bun compatibility |
| FYERS official SDK/API packages | Not selected/installed — verify official package names, APIs, and Bun compatibility |

## 7. Notes and risks

- Exact versions pinned in manifests; `bun.lock` captures resolved graph.
- No release-candidate dependencies intentionally added for Phase 1 foundation.
- Vite 8 and TypeScript 7 are current latest majors; monitor ecosystem compatibility as project grows.
- Do not install/remove/upgrade dependencies as part of documentation tasks; changes require justification and approval per protocol.
- Secure Windows credential storage mechanism is a requirement but no dependency/implementation selected yet (verify).
