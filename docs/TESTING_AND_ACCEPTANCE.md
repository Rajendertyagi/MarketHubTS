# Testing and Acceptance

> **Status:** Validation strategy and acceptance criteria; automated coverage now spans foundation, catalog, provider auth, live contracts, Upstox stream, and the M4 Stage D backend vertical slice.
> **Last updated:** 2026-11-17
> **Related:** [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [MCP_INTERFACE.md](MCP_INTERFACE.md), [PROJECT_STATUS.md](PROJECT_STATUS.md)

## 1. Validation strategy

- **Layered testing:** unit (schemas, pure logic, mappers), integration (DB, services, adapters with mocks/fixtures), end-to-end (API/MCP/WebUI flows), and non-functional (performance, soak, resilience), aligned with [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md).
- **Test-development timing:** test-first development is an option. Tests may be designed and written before or alongside implementation, and tests and implementation should evolve together within the same bounded assignment. Introduce automated guardrails progressively, with actual implementation.
- **Evidence-based:** tests must be executed and reported with commands/results; no feature considered complete based on a single passing test. Do not claim functionality is implemented merely because tests exist, and do not claim tests validate a feature that has not been implemented.
- **Canonical parity:** verify same canonical instrument/data state across MCP, REST, SSE, and WebUI.
- **Provider realism with safety:** use mocks/simulators and sanitized recorded fixtures/captures (verified free of secrets) for deterministic tests; controlled live verification only when authorized and without placing orders.
- **Failure-focused:** explicitly test disconnects, limits, stale/unavailable data, partial sync failures, and recovery (including fault containment in a shared-process modular monolith).

## 2. Current checks (verified 2026-11-17)

| Check | Command | Result |
|---|---|---|
| Full test suite | `bun test` | PASS — **256 tests, 0 fail, 1003 expect() calls, 23 files** (local verification; not CI evidence) |
| Focused Stage D tests | `bun test tests/market/notifications.test.ts tests/market/realtime-hub.test.ts tests/market/subscriptions.test.ts tests/market/supervisor.test.ts tests/market/stream-routes.test.ts tests/providers/status-composition.test.ts` | PASS — **69 tests, 0 fail, 270 expect() calls, 6 files** |
| Focused supervisor tests | `bun test tests/market/supervisor.test.ts` | PASS — 24 tests, 0 fail, 121 expect() calls |
| Typecheck | `bun run typecheck` | PASS — all 12 workspace packages/apps |
| Build | `bun run build` | PASS — packages/apps checks; web Vite build succeeded |
| Whitespace check | `git diff --check` | PASS (exit 0) |
| Manual smoke | run API + request `/health` | PASS — API returned `ok` with DB check `ok` |

### 2.1 Stage D server-side coverage (implemented)

- **Service notifications:** one event per successful revision change; no event for no-ops; untrack emits only on removal; detached item data; connection change signals resync; listener exceptions isolated; unsubscribe stops notifications.
- **Snapshot/schema:** Zod-valid snapshot with connection statuses; provider status schemas validate; `/api/providers/status` composes auth + runtime state with preserved response structure.
- **Realtime hub:** initial snapshot + live; replay after valid cursor with no gaps/duplicates; expired/invalid/future/empty `Last-Event-ID` cursors emit one `snapshot-required` and terminate; atomic registration; bounded replay and client queues by count and bytes; overflow drops data with counters and one coalesced `snapshot-required`; client isolation; abort cleanup; hub shutdown; control events never advance revision; `refresh` emitted without advancing revision.
- **Persistence/routes:** clean-install migration; M3→M4 upgrade preserving data; repository round-trip; empty replacement advances generation; invalid canonical IDs rejected atomically; missing/inactive mappings reported unavailable with no fabricated identifiers; serialized reconciliation with durable generation guard; snapshot route validated; subscription routes local-owner-only; SSE cursor/replay via `app.request()`; multi-client isolation/cleanup.
- **Supervisor:** fake driver; loads persisted state and latest generation; ACTIVE Upstox mappings only; empty/no-eligible handling; reconciles changes via driver; propagates runtime state to the service; bounded retry deterministic with a fake driver; stop prevents late callbacks; one driver failure cannot corrupt shared state; locked production driver fails safely on any start attempt and never instantiates an SDK, opens a socket or schedules retries. Final corrections covered by deterministic tests: DISCONNECTED/ERROR retire the driver and retry with a fresh `start()` (never an in-place update of a dead driver); old-driver callbacks are invalidated; pending start/update operations settle with final cleanup after shutdown/retirement without advancing applied generation or overwriting `NOT_STARTED`; desired and applied generations are tracked separately; a stale reconnect timer is cancelled on retirement so a newer epoch can schedule its retry (manual timer scheduler seam).

Stage E client behavior (EventSource close/fetch/reconnect after `provider-connection-changed` and `snapshot-required`, and `refresh` handling) is specified as a contract but is explicitly out of Stage D scope and not tested here. No real network call occurs in any Stage D test.

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
- **M3:** provider auth states, secret handling and provider independence verified with mocks.
- **M4 Stage A/B:** canonical live contracts, bounded state, freshness/source selection and Upstox stream adapter tests pass.
- **M4 Stage D (accepted):** server-side live pipeline, bounded buffers/overflow rule, subscription persistence/generation, SSE cursor/replay, multi-client isolation, locked production boundary and all independent-review lifecycle corrections verified (see §2.1). Final commit `f51e7db`; 69 focused tests pass. WebUI client behavior is Stage E; deep reconnect/soak hardening is Stage F; live provider verification is Stage G.
- **M5:** historical cache/snapshot persistence, retention, and config-independence verified.
- **M5:** MCP transport/capability/permission/parity tests pass, including alert-event resource/subscription/read-after-notify, cursor/reconnect recovery, multi-client isolation, and polling/tool fallback behavior (per verified spec/SDK).
- **M6:** alert waiting-state, scanner limitation reporting, delivery and shared-history tests pass.
- **M7:** chart/data correctness (backend source of truth), UI responsiveness/customization verified.
- **M8:** clean-install backup/restore (incl. key material) and diagnostics/config tests pass.
- **M9:** full end-to-end and non-functional acceptance evidence complete.

## 8. Reporting requirements

For each test cycle/report: environment, commands executed, pass/fail counts, failures/blockers, unverified areas, and evidence links/logs as applicable. Distinguish automated vs manual verification.
