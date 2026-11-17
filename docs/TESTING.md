# Testing

> **Status:** Aligned summary. Authoritative details: [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md), [PROJECT_STATUS.md](PROJECT_STATUS.md).
> **Last updated:** 2026-11-17

## Current checks (verified 2026-11-17)
- `bun test`: **PASS** — 235 tests, 0 fail, 889 expect() calls, 23 files (local verification; not CI evidence).
- Focused Stage D tests: **PASS** — 48 tests, 0 fail, 156 expect() calls, 6 files.
- `bun run typecheck`: **PASS** — all 12 workspace packages/apps.
- `bun run build`: **PASS** — package/app checks and web Vite production build.
- `git diff --check`: **PASS** (exit 0).
- Manual smoke: API started and `GET /health` returned OK with database check OK.

## Target validation strategy
- Layered: unit, integration, end-to-end, and non-functional (performance/soak/resilience).
- Provider-state matrix (both/Upstox-only/FYERS-only/neither) and multi-client isolation.
- Scenarios: disconnect/reconnect, limits/capacity, stale/unavailable data, provider-specific fields, missing historical periods, expired contracts, failed catalog sync safety, snapshot capture/recovery, alerts waiting for streaming, scanner limitation reporting, MCP on-demand without config mutation, full backup/restore on clean install, MCP/REST/SSE/WebUI parity, LAN access.
- Use sanitized fixtures/recorded captures (verified no secrets); do not place orders.
- No feature considered complete from a single passing test; report executed commands and evidence.

See [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md) for full matrix, scenarios, and milestone acceptance criteria.
