# Testing and Acceptance

> **Status:** Target validation strategy and acceptance criteria; current automated coverage is minimal (health contract test only).
> **Last updated:** 2026-11-16
> **Related:** [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [MCP_INTERFACE.md](MCP_INTERFACE.md), [PROJECT_STATUS.md](PROJECT_STATUS.md)

## 1. Validation strategy

- **Layered testing:** unit (schemas, pure logic, mappers), integration (DB, services, adapters with mocks/fixtures), end-to-end (API/MCP/WebUI flows), and non-functional (performance, soak, resilience), aligned with [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md).
- **Evidence-based:** tests must be executed and reported with commands/results; no feature considered complete based on a single passing test.
- **Canonical parity:** verify same canonical instrument/data state across MCP, REST, SSE, and WebUI.
- **Provider realism with safety:** use mocks/simulators and sanitized recorded fixtures/captures (verified free of secrets) for deterministic tests; controlled live verification only when authorized and without placing orders.
- **Failure-focused:** explicitly test disconnects, limits, stale/unavailable data, partial sync failures, and recovery (including fault containment in a shared-process modular monolith).

## 2. Current checks (verified scaffold)

| Check | Command | Result (scaffold verification) |
|---|---|---|
| Contract/schema test | `bun test` | PASS — 2 tests, 0 fail (`tests/health.test.ts`) |
| Typecheck | `bun run typecheck` | PASS — all workspace packages/apps |
| Build | `bun run build` | PASS — packages/apps checks; web Vite build succeeded |
| Manual smoke | run API + request `/health` | PASS — API returned `ok` with DB check `ok` |

## 3. Provider-state matrix (required)

| Upstox | FYERS | Expected result |
|---|---|---|
| Connected | Connected | Both work simultaneously |
| Connected | Disconnected | Upstox continues |
| Disconnected | Connected | FYERS continues |
| Disconnected | Disconnected | Application continues with available local/non-broker data |

**Acceptance:** no cascading failure, correct health/status reporting, source selection/freshness reflects actual availability, and consumers receive consistent canonical state.

## 4. Required scenario coverage

### 4.1 Connectivity and providers
- Multiple MCP clients connected simultaneously (shared data/services, client isolation).
- Broker disconnect and reconnect (per provider, independent).
- Provider capacity exhaustion / subscription & rate limits (exposed clearly; no silent selection changes).
- Stale and unavailable quotes/data (explicit freshness/availability states).
- Provider-specific fields preserved and attributed alongside canonical fields.
- MCP alert-event delivery: durable trigger records/history, discoverable alert-event resources/feeds, supported `subscriptions/listen` notifications (e.g. `resources/updated`/list changes as applicable) with read-after-notify, event IDs/cursors/sequence preventing missed/duplicate processing, reconnect recovery from last cursor, independent multi-client consumption, and polling/tool fallback when notifications/subscriptions are unavailable. No arbitrary alert-trigger notification type.

### 4.2 Data and catalog
- Missing historical data periods and provider restrictions reported clearly.
- Expired contracts discovery/handling (as supported/verified).
- Incomplete/failed catalog synchronization **never destroys previous valid catalog** (transactional safety).
- Option-chain snapshot capture and recovery per WebUI config; no pre-collection claims without provider support.
- Historical cache preserved across broker disconnect/removal.

### 4.3 Workflows and permissions
- Alerts waiting for streaming when required instrument not streamed (saved, explained, no auto-subscribe; activates after user enables streaming).
- Scanner results explicitly identify stale/unavailable/not-streamed limitations.
- MCP on-demand retrieval does not modify saved operational settings (streaming/sync/capture/retention/preferences/config).
- AI/MCP cannot modify operational configuration boundaries.

### 4.4 Operations and parity
- Full backup and restore on a **clean installation**, including required key material/state for encrypted credential recovery.
- WebUI/MCP/REST/SSE parity: same canonical instrument and data state presented consistently.
- LAN access from a second device (WebUI and MCP HTTP when implemented).
- Graceful shutdown/restart and recovery (DB integrity, live state repopulation from streams).

## 5. Non-functional acceptance (targets to be defined/measured)

| Area | Expectations |
|---|---|
| Startup & responsiveness | Fast startup; UI remains responsive during frequent updates |
| Resource usage | Bounded memory/queues; no unbounded growth during sustained operation |
| Data pipeline | Controlled DB writes/batching; efficient normalization/dispatch |
| Latency | Acceptable API/SSE delivery and update propagation (measured) |
| Reliability | Correct reconnect/recovery behavior; deterministic handling of overflow (drop events, not subscribers) |

Specific numeric targets must be established and evidenced during implementation/hardening (M9).

## 6. Test data and fixtures

- Use sanitized fixtures and recorded broker captures as independent test data **after verifying they contain no secrets**.
- Maintain representative cases: multi-provider, missing fields, expired contracts, partial failures, limit errors, stale streams.
- Do not place orders during any testing.

## 7. Acceptance criteria by milestone (summary)

- **M1:** schema/migration/catalog-sync safety tests pass.
- **M2:** provider-state matrix (connectivity) and secret-handling checks pass.
- **M3:** live pipeline, bounded buffers/overflow rule, restart repopulation, multi-client isolation verified.
- **M4:** historical cache/snapshot persistence, retention, and config-independence verified.
- **M5:** MCP transport/capability/permission/parity tests pass, including alert-event resource/subscription/read-after-notify, cursor/reconnect recovery, multi-client isolation, and polling/tool fallback behavior (per verified spec/SDK).
- **M6:** alert waiting-state, scanner limitation reporting, delivery and shared-history tests pass.
- **M7:** chart/data correctness (backend source of truth), UI responsiveness/customization verified.
- **M8:** clean-install backup/restore (incl. key material) and diagnostics/config tests pass.
- **M9:** full end-to-end and non-functional acceptance evidence complete.

## 8. Reporting requirements

For each test cycle/report: environment, commands executed, pass/fail counts, failures/blockers, unverified areas, and evidence links/logs as applicable. Distinguish automated vs manual verification.
