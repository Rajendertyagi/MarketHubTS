# Implementation Roadmap

> **Status:** Dependency-based roadmap from verified scaffold to product milestones. No arbitrary dates/estimates.
> **Last updated:** 2026-11-15
> **Related:** [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md), [PROJECT_STATUS.md](PROJECT_STATUS.md)

## 1. Planning principles

- **Coherent end-to-end milestones:** each milestone delivers verifiable capability/value, not disconnected scaffolding.
- **Dependency-driven order:** prerequisites and verification gates precede dependent work.
- **Canonical foundation first:** shared contracts/catalog/services before consumer-specific duplication risks.
- **Verify before commit:** provider APIs/limits/entitlements, MCP transport semantics, chart compatibility, and secure credential storage verified from official sources/evidence.
- **Measure and prove:** performance/reliability claims backed by tests/measurements.

## 2. Workstreams (major)

1. Documentation, architecture, and technical verification (baseline established; ongoing updates required).
2. Common catalog and provider-independent data contracts.
3. Simultaneous Upstox/FYERS integration and reliable live data.
4. Historical data retrieval, caching, and option-chain snapshots.
5. AI-first MCP data access and event streaming.
6. Watchlists, alerts, and scanner services.
7. F&O WebUI, charts, and market-wide data.
8. Operational configuration, diagnostics, and backup/restore.
9. Performance and end-to-end reliability.
10. News and X/Twitter future integration.

## 3. Milestones

### M0 — Documentation and verification baseline (current milestone: complete for this task scope)
**Objective:** authoritative, cross-consistent documentation and verified scaffold status.

**Prerequisites:** repository inspection, existing scaffold present.

**Deliverables:** required docs/README/AGENTS created or updated; references and open risks recorded; scaffold status verified.

**Acceptance criteria:** docs align on scope/architecture/permissions/roadmap; implemented vs planned clearly separated; no application source/tests/manifests/lockfiles/DB modified for doc task.

**Risks/blockers:** official docs access limitations; evolving MCP/provider details.

**Non-goals:** feature implementation.

---

### M1 — Canonical contracts, catalog foundation, and persistence primitives
**Objective:** establish shared canonical schemas, instrument identity/catalog model, and DB/migration foundations used by all services.

**Prerequisites:** M0; verification of exchange universe rules and key provider identifier formats (sufficient to model mappings).

**Key work:** canonical data contracts (Zod/shared types), catalog entities/mappings/aliases/status/sync metadata, migration framework and initial domain schema, transactional catalog sync design, provenance/freshness/availability model.

**User-visible deliverables:** none or minimal internal diagnostics; enables subsequent data features.

**Acceptance criteria:** schemas/types compile and are consumed by services; migrations run safely; catalog can be loaded/updated transactionally without destroying previous valid state in tests; identity/mapping rules documented and implemented.

**Verification:** unit/integration tests for schema validation, migrations, transactional sync failure safety.

**Risks:** incomplete provider/exchange metadata; identity edge cases for expired/changed contracts.

**Non-goals:** live broker connectivity, UI market views, MCP market tools beyond scaffolding.

---

### M2 — Provider adapter framework and resilient connectivity (Upstox + FYERS)
**Objective:** connect/configure providers independently with health, auth lifecycle handling, and normalized capability reporting.

**Prerequisites:** M1 (canonical contracts/mappings), verified official auth/connection/API basics, secure credential storage mechanism decision/verification.

**Key work:** adapter interfaces, credential/config handling (secure), connection/auth/token lifecycle, health/error/limit reporting, provider capability discovery, independent connect/disconnect/remove behavior.

**User-visible deliverables:** WebUI/diagnostics can show provider states (connected/disconnected/degraded/error) and restrictions; app operates with either/neither provider.

**Acceptance criteria:** provider-state matrix behaviors satisfied for connectivity; one provider failure does not impact other; no plaintext secrets; clear diagnostics.

**Verification:** integration tests/mocks + controlled live verification where authorized; reconnect/failure scenarios.

**Risks:** SDK/Bun incompatibility, auth/session complexity, undocumented limits/entitlements.

**Non-goals:** full market feature set, order placement.

---

### M3 — Live market data pipeline and in-memory realtime state
**Objective:** stream/ingest live quotes/depth/ticks (as supported), normalize into canonical live state, and expose via shared services.

**Prerequisites:** M2, verified feed protocols/subscription limits/field mappings.

**Key work:** subscriptions management (WebUI-owned selections), normalization/provenance/freshness, in-memory bounded live state, source selection, REST/SSE delivery foundations with bounded buffers and drop-overflow-not-subscriber policy.

**User-visible deliverables:** live quotes/depth views for configured instruments; freshness/source indicators.

**Acceptance criteria:** live updates flow for supported instruments; no per-tick/depth persistence; restart repopulates from streams; overflow drops events not subscribers; multi-client isolation.

**Verification:** load/concurrency tests, reconnect tests, memory/buffer bounds checks.

**Risks:** high-rate feeds, provider limits, parsing/protobuf complexity, memory growth.

**Non-goals:** complete historical/snapshot persistence, full alert/scanner automation.

---

### M4 — Historical candles and option-chain snapshot persistence
**Objective:** reliable historical retrieval/caching and configurable option-chain snapshot capture/storage.

**Prerequisites:** M1–M3 foundations as applicable; verified historical/expired/option-chain APIs and entitlements.

**Key work:** historical request/sync workflows, local candle cache, gap fill from suitable provider, unavailable-period reporting; snapshot schema/store, WebUI capture config (underlying/expiry/strikes/capture independent of streaming), retention integration.

**User-visible deliverables:** historical candle access/charts data source readiness; snapshot capture configuration and stored snapshot retrieval (per collected data).

**Acceptance criteria:** cached candles preserved across disconnect/removal; missing periods handled/reported; snapshots stored separately per config; MCP on-demand does not mutate capture config; no pre-collection claims without provider support.

**Verification:** persistence/restart tests, provider-unavailable tests, retention/cleanup tests.

**Risks:** provider historical limits/entitlements, large data volumes, schema evolution.

**Non-goals:** exhaustive broker DB replication.

---

### M5 — MCP market-data and event interface (AI-first parity)
**Objective:** comprehensive MCP access over shared services with correct transport/event behavior and permission boundaries.

**Prerequisites:** M1–M4 service capabilities; verified MCP 2026-07-28 spec/SDK transport and subscription/event semantics.

**Key work:** Streamable HTTP MCP endpoint (LAN), SSE-based event/subscription delivery as specified, STDIO compatibility, tool/resource/prompt set for discovery/quotes/depth/candles/option chains/futures/market-wide/freshness/on-demand, multi-client support and isolation.

**User-visible deliverables:** AI agents can query/subscribe to supported market data and receive events; parity with REST/WebUI data.

**Acceptance criteria:** no duplicate market logic; permission boundaries enforced; on-demand fetch does not alter operational config; multi-client scenarios pass; transport behavior matches verified spec.

**Verification:** MCP conformance/integration tests, parity tests, security/input validation tests.

**Risks:** spec/SDK evolution, transport complexity, LAN exposure considerations.

**Non-goals:** AI modification of operational config.

---

### M6 — Watchlists, alerts, and scanners (shared workflows)
**Objective:** full workflow services usable from WebUI and MCP with correct state, evaluation, and delivery behavior.

**Prerequisites:** M1 (persistence/contracts), M3 (live data) and/or M4 as needed for conditions; M5 for MCP workflow parity.

**Key work:** watchlist CRUD/organization; alert/scanner definition models, condition evaluator (canonical + provider-specific fields, supported operators), trigger/history persistence, alert states (waiting/active/unavailable/triggered), scanner modes (manual/scheduled/continuous), delivery channels (WebUI/desktop/MCP/webhook).

**User-visible deliverables:** manage and run watchlists/alerts/scanners; receive notifications/events; clear waiting/limitation explanations.

**Acceptance criteria:** no auto-subscribe; waiting-for-streaming behavior correct; AI cannot bypass config boundaries; stale/unavailable/not-streamed limitations reported; shared definitions/history across interfaces.

**Verification:** scenario tests (waiting alerts, continuous scanners, delivery, multi-client events).

**Risks:** condition complexity, evaluation performance, event ordering/duplication semantics.

**Non-goals:** trading actions or recommendations.

---

### M7 — WebUI F&O experience, charts, and market-wide views
**Objective:** complete human-facing data and analysis interface on shared services.

**Prerequisites:** M1–M6 data/services; Vela compatibility validation (or approved alternative decision if required later).

**Key work:** dashboard/market/options/futures/historical/market-wide modules, customizable layouts/tables/watchlist views, chart integration (candles/indicators/drawings/timeframes/multi-chart/workspace persistence as supported), responsive high-frequency rendering.

**User-visible deliverables:** usable F&O-focused WebUI with charts and configurable views.

**Acceptance criteria:** backend remains candle/data source of truth; UI responsive under updates; customization persisted; parity with canonical data.

**Verification:** UI/integration tests, rendering/perf checks, compatibility proof for charting.

**Risks:** chart library fit/performance/licensing, UI complexity.

**Non-goals:** broker account/trading UI.

---

### M8 — Operational configuration, diagnostics, and backup/restore
**Objective:** production-grade local operation controls and recoverability.

**Prerequisites:** M2–M7 components/config surfaces; secure credential storage/key-material strategy verified.

**Key work:** complete WebUI settings (providers, streaming/sync/capture, retention, preferences, startup/LAN/network, delivery, logging), diagnostics dashboards/logs, full backup/restore including required key material/state, integrity checks.

**User-visible deliverables:** configure and operate entire app from WebUI; perform and restore verified backups.

**Acceptance criteria:** no silent config changes; restrictions visible; backup/restore succeeds on clean install with credentials recoverable as designed; graceful shutdown/recovery.

**Verification:** clean-install restore drills, failure/recovery tests, security checks for secret handling.

**Risks:** Windows credential/key management complexity, incomplete restore if key material omitted.

**Non-goals:** cloud sync/public hosting/auth system.

---

### M9 — Performance, reliability hardening, and end-to-end acceptance
**Objective:** meet non-functional requirements across sustained real-world operation.

**Prerequisites:** M1–M8 feature-complete for in-scope product.

**Key work:** profiling/optimization (startup, memory, CPU, DB writes, API/SSE latency, render responsiveness), soak tests, fault injection (disconnects, limits, stale data), finalize acceptance evidence.

**User-visible deliverables:** stable, responsive application under expected workloads.

**Acceptance criteria:** measurable targets defined and met (to be specified during implementation planning), no unbounded growth, provider-state and parity matrices pass, documented evidence.

**Verification:** automated + manual acceptance suite per [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md).

**Risks:** provider variability, environment-specific performance issues.

**Non-goals:** new feature scope beyond hardening.

---

### M10 — Future integrations: News and X/Twitter (later phase)
**Objective:** add confirmed later-phase information sources without violating core architecture.

**Prerequisites:** stable canonical/services foundation (post-M9 or when architecture/contracts ready), verified source APIs/terms.

**Key work:** source adapters/services, storage/provenance/freshness models, UI/MCP exposure as appropriate.

**Acceptance criteria:** integrated as additive data sources with clear attribution/limitations; no impact on core trading-data correctness or exclusions.

**Risks:** API access/terms/rate limits, content handling complexity.

**Non-goals:** sentiment/trading recommendations/chat.

## 4. Cross-cutting dependencies and gates

- **Official verification gates:** Upstox/FYERS capabilities/limits/entitlements/SDK-Bun fit; NSE/BSE universe/contract details; MCP 2026-07-28 transport semantics; Vela compatibility; Windows secure credential storage and backup key material.
- **Security gate:** no plaintext secrets, no credential exposure/logging, safe LAN behavior documented.
- **Parity gate:** MCP/REST/SSE/WebUI consistency on canonical data/state.
- **Recoverability gate:** clean-install restore proof including credential recovery requirements.

## 5. Out-of-scope reminders (all milestones)

No order placement/trading automation, no broker account management, no AI recommendations/predictions/signals, no sentiment/chat, no general CSV/Excel market-data export, no cloud/public hosting.
