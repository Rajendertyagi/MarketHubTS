# Testing

> **Status:** Aligned summary. Authoritative details: [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md), [PROJECT_STATUS.md](PROJECT_STATUS.md).
> **Last updated:** 2026-11-15

## Current checks (verified scaffold)
- `bun test`: **PASS** — 2 tests, 0 fail (`tests/health.test.ts`, health contract schema).
- `bun run typecheck`: **PASS** — all workspace packages/apps.
- `bun run build`: **PASS** — package/app checks and web Vite production build.
- Manual smoke: API started and `GET /health` returned OK with database check OK.

## Target validation strategy
- Layered: unit, integration, end-to-end, and non-functional (performance/soak/resilience).
- Provider-state matrix (both/Upstox-only/FYERS-only/neither) and multi-client isolation.
- Scenarios: disconnect/reconnect, limits/capacity, stale/unavailable data, provider-specific fields, missing historical periods, expired contracts, failed catalog sync safety, snapshot capture/recovery, alerts waiting for streaming, scanner limitation reporting, MCP on-demand without config mutation, full backup/restore on clean install, MCP/REST/SSE/WebUI parity, LAN access.
- Use sanitized fixtures/recorded captures (verified no secrets); do not place orders.
- No feature considered complete from a single passing test; report executed commands and evidence.

See [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md) for full matrix, scenarios, and milestone acceptance criteria.
