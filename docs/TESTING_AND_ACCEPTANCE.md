# Testing and Acceptance

> **Status:** Validation strategy and acceptance criteria; automated coverage spans foundation, catalog, provider auth, live contracts, Upstox stream, the M4 Stage D backend vertical slice, and the Stage E WebUI live-data experience.
> **Last updated:** 2026-11-22 (metadata acceptance expanded to project-wide centralization assertions mapped to roadmap phases)
> **Related:** [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [MCP_INTERFACE.md](MCP_INTERFACE.md), [PROJECT_STATUS.md](PROJECT_STATUS.md)

## 1. Validation strategy

- **Layered testing:** unit (schemas, pure logic, mappers), integration (DB, services, adapters with mocks/fixtures), end-to-end (API/MCP/WebUI flows), and non-functional (performance, soak, resilience), aligned with [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md).
- **Test-development timing:** test-first development is an option. Tests may be designed and written before or alongside implementation, and tests and implementation should evolve together within the same bounded assignment. Introduce automated guardrails progressively, with actual implementation.
- **Evidence-based:** tests must be executed and reported with commands/results; no feature considered complete based on a single passing test. Do not claim functionality is implemented merely because tests exist, and do not claim tests validate a feature that has not been implemented.
- **Canonical parity:** verify same canonical instrument/data state across MCP, REST, SSE, and WebUI.
- **Provider realism with safety:** use mocks/simulators and sanitized recorded fixtures/captures (verified free of secrets) for deterministic tests; controlled live verification only when authorized and without placing orders.
- **Failure-focused:** explicitly test disconnects, limits, stale/unavailable data, partial sync failures, and recovery (including fault containment in a shared-process modular monolith).

## 2. Current checks (verified 2026-11-17)

> These are the historical verification figures recorded on that date and are preserved as-is. For the current suite size and latest results, see [PROJECT_STATUS.md](PROJECT_STATUS.md).

| Check | Command | Result |
|---|---|---|
| Full test suite | `bun test` | PASS — **301 tests, 0 fail, 1162 expect() calls, 26 files** (local verification; not GitHub CI evidence) |
| Focused web tests | `bun test ./tests/web/` | PASS — **45 tests, 0 fail, 159 expect() calls, 3 files** (local verification; not CI evidence) |
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

### 2.2 Stage E WebUI client coverage (implemented, accepted)

- **Named SSE events:** listeners for all six backend event names with removal on close/supersede; fake EventSource records actual listener invocations, not just a dispatch log.
- **Initial vs recovery connection:** initial no-cursor stream stays `connecting` until a validated snapshot; recovery/`?since=` streams enter `live` on `open`; a refresh that supplies the first snapshot also completes initial sync.
- **Recovery:** `snapshot-required` and `provider-connection-changed` trigger close → REST snapshot → atomic replacement → reconnect with `?since=`; single-flight dedup; capped backoff; shutdown cancellation via `AbortSignal`; visible error and manual retry; stale recovery snapshots are rejected so `appliedRevision` cannot regress.
- **Refresh:** fetch-only with EventSource kept open; superseded generations ignored; stale revisions rejected; bounded retry with periodic-control suppression after exhaustion and manual retry; invalidated by recovery.
- **Subscriptions:** serialized PUT writes with generation guard; 403/400/500-persistence/500-other/200-with-runtime-error classification; manual canonical-ID entry.
- **Display:** canonical-field-only projection excludes `native`/depth; `item-removed` removes items; `streamStatus = live` is not presented as a streaming provider feed; StrictMode remount resumes with `?since=` from the stored snapshot.

No real network call occurs in any Stage D or Stage E test; all SSE/fetch behavior uses deterministic fakes.

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
- LAN access from a second device is outside the revised M6 scope (user-approved change); the composed LAN-facing behavior is covered by the in-process simulation test instead.
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
- **M4 Stage D (accepted):** server-side live pipeline, bounded buffers/overflow rule, subscription persistence/generation, SSE cursor/replay, multi-client isolation, locked production boundary and all independent-review lifecycle corrections verified (see §2.1). Final commit `f51e7db`; 69 focused tests pass.
- **M4 Stage E (accepted):** WebUI streaming selections, canonical-field-only live views, named SSE client with recovery/refresh, manual retry and StrictMode resume verified with deterministic fakes (see §2.2). Implementation commits `ea0cae0`, `00e6830`, `a8f4eef` plus the final closeout fixes; 45 focused web tests pass. Deep reconnect/soak hardening is Stage F; live provider verification is Stage G.
- **M5:** historical cache/snapshot persistence, retention, and config-independence verified.
- **M6-A:** in-process SDK client tests over `handler.fetch` plus **one real HTTP smoke test** — start the actual Hono/Bun application on an available local port, connect the official `StreamableHTTPClientTransport` pinned to `2026-07-28`, verify `server/discover` and `markethub_health` through `/mcp`, and verify clean shutdown. `@modelcontextprotocol/client` at the matching SDK version is a **development-only** test dependency, never a runtime dependency. M6-A does not cover market-data tools, activity history or event delivery.
- **M6:** MCP transport/capability/permission/parity tests pass, including alert-event resource/subscription/read-after-notify, cursor/reconnect recovery, multi-client isolation, and polling/tool fallback behavior (per verified spec/SDK). **M6 also requires: one named test per mandatory server-side requirement C1–C21 in [M6_PLAN.md](M6_PLAN.md) §3.1; the M6-A real HTTP smoke test plus broader M6-E integration with a real Streamable HTTP MCP client pinned to the latest stable revision against a running Hono/Bun HTTP listener; STDIO modern-protocol verification; legacy compatibility tests if dual-era is retained; concurrent clients/subscriptions; error/cancellation/reconnect/shutdown scenarios; and one standalone in-process LAN simulation test. Physical LAN reachability is not verified and is outside the revised M6 scope (user-approved change); the simulation is not proof of real LAN connectivity. An in-process `handler.fetch` test is useful but cannot replace real HTTP integration testing. M6 is not complete until the target revision's mandatory requirements are verified and conformance tests pass.**
- **M7:** alert waiting-state, scanner limitation reporting, delivery and shared-history tests pass.
- **M8:** chart/data correctness (backend source of truth), UI responsiveness/customization verified.
- **M9:** clean-install backup/restore (incl. key material) and diagnostics/config tests pass.
- **M10:** full end-to-end and non-functional acceptance evidence complete.

### 7.1 Future acceptance — backend-driven metadata and capability discovery

Owner-approved architecture requirement, **not yet implemented**; see [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) §10 and AD-025. Acceptance distinguishes three consistency paths — do not collapse them into one generic "metadata" test:

1. **Direct shared-contract-to-WebUI consistency** (no HTTP discovery): the WebUI derives fixed options from `@markethub/contracts` Zod schemas (for example `candleIntervalSchema`, activity status/transport). Prove that a contract value change reaches the UI without a component edit and that no duplicate literal list exists in React. No metadata endpoint is involved.
2. **Backend-registration-to-metadata-API-to-WebUI consistency** (only if technical validation justifies an endpoint): a newly registered MCP operation (tool/resource/prompt) appears in the WebUI selector without a frontend options-list edit, and descriptors remain consistent with actual registrations. If no endpoint is needed, prove descriptors are sourced from the owning registration module by another non-duplicating route.
3. **Domain-search-API-to-WebUI consistency**: existing catalog results from `GET /api/catalog/search` populate instrument selectors, with bounded/paginated query behavior, loading/empty/error states and cancellation.

Implementation order for these tests follows the canonical sequence in [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) §4.1: shared-contract consistency + interval selector first, instrument picker second, operation selector third. Roadmap phase numbers are not implementation order. No metadata endpoint is assumed for shared enum values.

Additional required assertions (map to roadmap Phases 1–7):

- **one shared provider identity definition** used by all relevant contracts; no redundant `z.enum(["UPSTOX","FYERS"])` declarations without a documented cycle exception;
- **shared SSE event-name consistency** between hub, API and WebUI (a single `as const` source; `snapshot` handled explicitly);
- **shared CE/PE and HTTP/STDIO definitions** consumed instead of re-declared; DB SQL CHECKs remain literal by design;
- **provider-status response schema validation in WebUI** (replace the current raw cast) and iteration over providers rather than fixed-key access;
- **operation descriptor parity** with actual MCP registrations (9 tools, 7 resource registrations, 3 prompts) and no SDK-internal access;
- **newly registered MCP operations visible** without an independent WebUI list edit;
- **catalog search populating all intended selectors** with context-aware filters only where the repository supports them, and bounded pagination;
- **expiry options from real derivative records** — never weekday-derived or hardcoded; honest empty/unavailable state while the DB is empty;
- **retention controls preserving contract validation** (fail-closed behavior unchanged);
- **snapshot automatic/manual provider-selection semantics** (explicit = exclusive, omitted = try configured providers) tested without changing service ordering;
- **metadata responses containing no credentials, tokens, secrets or sensitive configuration**;
- **unavailable capabilities never presented as available** (SUPPORTED/LIMITED/UNSUPPORTED/UNAVAILABLE and `entitlementUnverified` honored);
- **backend validation and permission enforcement remain authoritative**; UI validation is usability only.

Tests must verify behavior and actual ownership relationships, not merely assert that named files or constants exist. Do not add tests merely to match a filename; add them when the behavior exists. Do not weaken existing integration or regression tests.

## 8. Reporting requirements

For each test cycle/report: environment, commands executed, pass/fail counts, failures/blockers, unverified areas, and evidence links/logs as applicable. Distinguish automated vs manual verification.
