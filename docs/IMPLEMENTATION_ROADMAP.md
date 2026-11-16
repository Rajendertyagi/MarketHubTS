# Implementation Roadmap

> **Status:** Dependency-based roadmap from verified scaffold to product milestones. No arbitrary dates/estimates.
> **Last updated:** 2026-11-16
> **Related:** [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md), [PROJECT_STATUS.md](PROJECT_STATUS.md)

## 1. Planning principles

- **Agreed development sequence:** (1) establish essential product requirements, architecture, and engineering standards; (2) research and verify technical choices using current official documentation, supported versions, and actual compatibility information; (3) start building the real MarketHubTS application in controlled phases; (4) verify and test actual components as they are implemented; (5) integrate features progressively and verify the complete application.
- **Evidence-driven, research-first:** technical decisions must be supported by evidence, not assumptions. Research official documentation first; when a significant technical uncertainty cannot be resolved through research, a narrowly scoped experiment may be used to answer it (proportionate, reused in the actual product wherever practical). Do not create separate throwaway prototypes or an experimental development phase before building the application.
- **Real application, thin end-to-end vertical slice:** the first meaningful implementation milestone must prove one complete market-data flow through the actual MarketHubTS application and its consumers (not a temporary discarded demonstration). Build in controlled phases, verify/test actual components as implemented, and integrate progressively.
- **Incremental NSE catalogue:** start with a limited initial instrument set, but design for full intended catalogue expansion. Never hardcode changing exchange information.
- **Coherent end-to-end milestones:** each milestone delivers verifiable capability/value in the real application, not disconnected scaffolding.
- **Dependency-driven order:** prerequisites and verification gates precede dependent work.
- **Canonical foundation first:** shared contracts/catalog/services before consumer-specific duplication risks.
- **Automated guardrails:** introduce module-boundary, integration, data-integrity, and failure-recovery tests progressively as actual code is developed (do not test functionality that has not been implemented).
- **Lean documentation:** maintain useful requirements, architecture decisions, contracts, references, and acceptance criteria; avoid repeated documentation polishing.
- **Measure and prove:** performance/reliability claims backed by tests/measurements. Preserve confirmed product scope/features (lean means avoiding unnecessary implementation complexity, not reducing required product scope).

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

### M0 — Documentation and verification baseline (complete)
**Objective:** authoritative, cross-consistent documentation and verified scaffold status.

**Prerequisites:** repository inspection, existing scaffold present.

**Deliverables:** required docs/README/AGENTS created or updated; references and open risks recorded; scaffold status verified.

**Acceptance criteria:** docs align on scope/architecture/permissions/roadmap; implemented vs planned clearly separated; no application source/tests/manifests/lockfiles/DB modified for doc task.

**Risks/blockers:** official docs access limitations; evolving MCP/provider details.

**Non-goals:** feature implementation.

---

### M1 — Application foundation and runtime (real application)
**Objective:** turn the minimal scaffold into a properly structured, runnable, maintainable local application foundation (runtime, configuration, database initialization/migrations, API foundation, initial WebUI, LAN capability, development/production workflows, diagnostics and verification) without implementing market-domain features.

**Prerequisites:** M0; existing Bun + TypeScript + React + Hono + SQLite scaffold.

**Key work:** application composition/startup and graceful shutdown lifecycle; centralized validated runtime configuration (`.env.example`, compatibility with existing env vars, no secret exposure); reliable SQLite initialization and versioned Drizzle migrations (including initial app metadata migration) with safe failure handling and data preservation; API foundation (health/readiness, structured errors, logging, deliberate CORS/network boundaries, production static serving of built WebUI where practical); initial WebUI application shell and real system-status screen (honest states, no fabricated market data); configurable LAN-capable local operation (documented, no app-level login, no public exposure); Windows-compatible development (`bun run dev`) and production (`bun run build`, `bun run start`) workflows; automated tests and regression verification (including MCP STDIO health compatibility).

**User-visible deliverables:** runnable local application with real backend status in WebUI, working dev/prod commands, documented LAN mode, and verified foundation behavior.

**Acceptance criteria:** validated config startup; SQLite/migrations initialize safely (fresh and restart, preserving data); accurate health/readiness; WebUI shows real backend information and handles loading/error/recovery; LAN binding/access supported and documented; production build/start serves the application; existing MCP STDIO health functionality remains operational; typecheck/tests/build pass; no market-domain features added.

**Verification:** automated tests (config, database/migrations, API/health/readiness/errors, runtime startup/shutdown, production serving, MCP contract regression) and manual verification (startup, WebUI, API, DB init, production serving, LAN behavior as environment allows, MCP regression).

**Risks:** Windows process/signal behavior, LAN/firewall environment constraints, migration/path edge cases, serving/proxy configuration mismatches.

**Non-goals:** instrument/catalog sync, provider integrations/auth, live/historical/option-chain data, charts, watchlists/alerts/scanners, News/X/Twitter, MCP HTTP transport.

---

### M2 — Canonical contracts, catalog foundation, and persistence primitives (real application)
**Objective:** establish shared canonical schemas, instrument identity/catalog model, and DB/migration foundations used by all services, as part of the real MarketHubTS application.

**Prerequisites:** M1; verification of exchange universe rules and key provider identifier formats (sufficient to model mappings).

**Key work:** canonical data contracts (Zod/shared types), catalog entities/mappings/aliases/status/sync metadata, migration framework and initial domain schema, transactional catalog sync design, provenance/freshness/availability model. Support a **limited initial instrument set** while designing for full intended catalogue expansion; never hardcode changing exchange information.

**User-visible deliverables:** none or minimal internal diagnostics; enables subsequent data features and the first end-to-end vertical slice.

**Acceptance criteria:** schemas/types compile and are consumed by services; migrations run safely; catalog can be loaded/updated transactionally without destroying previous valid state in tests; identity/mapping rules documented and implemented.

**Verification:** unit/integration tests for schema validation, migrations, transactional sync failure safety (automated guardrails introduced progressively).

**Risks:** incomplete provider/exchange metadata; identity edge cases for expired/changed contracts.

**Non-goals:** live broker connectivity, UI market views, MCP market tools beyond scaffolding.

---

### M3 — Provider adapter framework and resilient connectivity (Upstox + FYERS)
**Objective:** connect/configure providers independently with health, auth lifecycle handling, and normalized capability reporting.

**Prerequisites:** M2 (canonical contracts/mappings), verified official auth/connection/API basics, secure credential storage mechanism decision/verification.

**Key work:** adapter interfaces, credential/config handling (secure), connection/auth/token lifecycle, health/error/limit reporting, provider capability discovery, independent connect/disconnect/remove behavior.

**User-visible deliverables:** WebUI/diagnostics can show provider states (connected/disconnected/degraded/error) and restrictions; app operates with either/neither provider.

**Acceptance criteria:** provider-state matrix behaviors satisfied for connectivity; one provider failure does not impact other; no plaintext secrets; clear diagnostics.

**Verification:** integration tests/mocks + controlled live verification where authorized; reconnect/failure scenarios.

**Risks:** SDK/Bun incompatibility, auth/session complexity, undocumented limits/entitlements.

**Non-goals:** full market feature set, order placement.

---

### M4 — Live market data pipeline and in-memory realtime state (first end-to-end vertical slice target)
**Objective:** stream/ingest live quotes/depth/ticks (as supported), normalize into canonical live state, and expose via shared services as part of the real application.

**Prerequisites:** M3, verified feed protocols/subscription limits/field mappings.

**Key work:** subscriptions management (WebUI-owned selections), normalization/provenance/freshness, in-memory bounded live state, source selection, REST/SSE delivery foundations with bounded buffers and drop-overflow-not-subscriber policy. Deliver a **thin end-to-end vertical slice** for a limited initial instrument set proving one complete market-data flow through the actual application and its consumers (e.g. provider → canonical normalization/live state → shared service → REST/SSE and/or MCP/WebUI as implemented), becoming part of the real MarketHubTS application.

**User-visible deliverables:** live quotes/depth views for configured instruments; freshness/source indicators; verified end-to-end flow for the initial slice.

**Acceptance criteria:** live updates flow for supported instruments in the slice; no per-tick/depth persistence; restart repopulates from streams; overflow drops events not subscribers; multi-client isolation; parity across implemented consumers for the slice.

**Verification:** integration/end-to-end tests for the slice, load/concurrency tests, reconnect tests, memory/buffer bounds checks (automated guardrails introduced progressively).

**Risks:** high-rate feeds, provider limits, parsing/protobuf complexity, memory growth.

**Non-goals:** complete historical/snapshot persistence, full alert/scanner automation, full universe coverage in the first slice.

---

### M5 — Historical candles and option-chain snapshot persistence
**Objective:** reliable historical retrieval/caching and configurable option-chain snapshot capture/storage.

**Prerequisites:** M2–M4 foundations as applicable; verified historical/expired/option-chain APIs and entitlements.

**Key work:** historical request/sync workflows, local candle cache, gap fill from suitable provider, unavailable-period reporting; snapshot schema/store, WebUI capture config (underlying/expiry/strikes/capture independent of streaming), retention integration.

**User-visible deliverables:** historical candle access/charts data source readiness; snapshot capture configuration and stored snapshot retrieval (per collected data).

**Acceptance criteria:** cached candles preserved across disconnect/removal; missing periods handled/reported; snapshots stored separately per config; MCP on-demand does not mutate capture config; no pre-collection claims without provider support.

**Verification:** persistence/restart tests, provider-unavailable tests, retention/cleanup tests.

**Risks:** provider historical limits/entitlements, large data volumes, schema evolution.

**Non-goals:** exhaustive broker DB replication.

---

### M6 — MCP market-data and event interface (AI-first parity)
**Objective:** comprehensive MCP access over shared services with correct transport/event behavior and permission boundaries.

**Prerequisites:** M2–M5 service capabilities; verified MCP 2026-07-28 spec/SDK transport and subscription/event semantics (including `subscriptions/listen`, supported notifications, and `@modelcontextprotocol/server` v2.4.0 behavior).

**Key work:** Streamable HTTP MCP endpoint (LAN), SSE-based event/subscription delivery as specified, STDIO compatibility, tool/resource/prompt set for discovery/quotes/depth/candles/option chains/futures/market-wide/freshness/on-demand, discoverable alert-event resources/feeds with cursor/sequence retrieval, multi-client support and isolation.

**User-visible deliverables:** AI agents can query/subscribe to supported market data and receive/retrieve alert events; parity with REST/WebUI data.

**Acceptance criteria:** no duplicate market logic; permission boundaries enforced; on-demand fetch does not alter operational config; multi-client scenarios pass; transport behavior matches verified spec; alert-event delivery uses durable records + supported protocol notifications/read-after-notify (no arbitrary alert-trigger notification type), with reconnect recovery and polling/tool fallback.

**Verification:** MCP conformance/integration tests, parity tests, security/input validation tests, subscription/reconnect/multi-client event-retrieval tests.

**Risks:** spec/SDK evolution, transport complexity, LAN exposure considerations.

**Non-goals:** AI modification of operational config.

---

### M7 — Watchlists, alerts, and scanners (shared workflows)
**Objective:** full workflow services usable from WebUI and MCP with correct state, evaluation, and delivery behavior.

**Prerequisites:** M2 (persistence/contracts), M4 (live data) and/or M5 as needed for conditions; M6 for MCP workflow parity.

**Key work:** watchlist CRUD/organization; alert/scanner definition models, condition evaluator (canonical + provider-specific fields, supported operators), durable trigger/event records with event IDs/cursors/sequence, trigger/history persistence, alert states (waiting/active/unavailable/triggered), scanner modes (manual/scheduled/continuous), delivery channels (WebUI/desktop/MCP/webhook).

**User-visible deliverables:** manage and run watchlists/alerts/scanners; receive notifications/events and retrieve alert-event history; clear waiting/limitation explanations.

**Acceptance criteria:** no auto-subscribe; waiting-for-streaming behavior correct; AI cannot bypass config boundaries; stale/unavailable/not-streamed limitations reported; shared definitions/history across interfaces; MCP alert-event access works via durable resources/feeds and supported notifications with reconnect recovery, independent multi-client consumption, and polling/tool fallback.

**Verification:** scenario tests (waiting alerts, continuous scanners, delivery, multi-client events, cursor/reconnect recovery, notification-failure fallback to history retrieval).

**Risks:** condition complexity, evaluation performance, event ordering/duplication semantics.

**Non-goals:** trading actions or recommendations.

---

### M8 — WebUI F&O experience, charts, and market-wide views
**Objective:** complete human-facing data and analysis interface on shared services.

**Prerequisites:** M2–M7 data/services; Vela compatibility validation (or approved alternative decision if required later).

**Key work:** dashboard/market/options/futures/historical/market-wide modules, customizable layouts/tables/watchlist views, chart integration (candles/indicators/drawings/timeframes/multi-chart/workspace persistence as supported), responsive high-frequency rendering.

**User-visible deliverables:** usable F&O-focused WebUI with charts and configurable views.

**Acceptance criteria:** backend remains candle/data source of truth; UI responsive under updates; customization persisted; parity with canonical data.

**Verification:** UI/integration tests, rendering/perf checks, compatibility proof for charting.

**Risks:** chart library fit/performance/licensing, UI complexity.

**Non-goals:** broker account/trading UI.

---

### M9 — Operational configuration, diagnostics, and backup/restore
**Objective:** production-grade local operation controls and recoverability.

**Prerequisites:** M3–M8 components/config surfaces; secure credential storage/key-material strategy verified.

**Key work:** complete WebUI settings (providers, streaming/sync/capture, retention, preferences, startup/LAN/network, delivery, logging), diagnostics dashboards/logs, full backup/restore including required key material/state, integrity checks.

**User-visible deliverables:** configure and operate entire app from WebUI; perform and restore verified backups.

**Acceptance criteria:** no silent config changes; restrictions visible; backup/restore succeeds on clean install with credentials recoverable as designed; graceful shutdown/recovery.

**Verification:** clean-install restore drills, failure/recovery tests, security checks for secret handling.

**Risks:** Windows credential/key management complexity, incomplete restore if key material omitted.

**Non-goals:** cloud sync/public hosting/auth system.

---

### M10 — Performance, reliability hardening, and end-to-end acceptance
**Objective:** meet non-functional requirements across sustained real-world operation.

**Prerequisites:** M2–M9 feature-complete for in-scope product.

**Key work:** profiling/optimization (startup, memory, CPU, DB writes, API/SSE latency, render responsiveness), soak tests, fault injection (disconnects, limits, stale data), finalize acceptance evidence.

**User-visible deliverables:** stable, responsive application under expected workloads.

**Acceptance criteria:** measurable targets defined and met (to be specified during implementation planning), no unbounded growth, provider-state and parity matrices pass, documented evidence.

**Verification:** automated + manual acceptance suite per [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md).

**Risks:** provider variability, environment-specific performance issues.

**Non-goals:** new feature scope beyond hardening.

---

### M11 — Future integrations: News and X/Twitter (later phase)
**Objective:** add confirmed later-phase information sources without violating core architecture.

**Prerequisites:** stable canonical/services foundation (post-M10 or when architecture/contracts ready), verified source APIs/terms.

**Key work:** source adapters/services, storage/provenance/freshness models, UI/MCP exposure as appropriate.

**Acceptance criteria:** integrated as additive data sources with clear attribution/limitations; no impact on core trading-data correctness or exclusions.

**Risks:** API access/terms/rate limits, content handling complexity.

**Non-goals:** sentiment/trading recommendations/chat.

## 4. Cross-cutting dependencies and gates

- **Engineering standards gate:** implementation follows [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) (modular monolith boundaries, fault containment, validation, bounded resources, testing, dependency discipline).
- **Official verification gates:** Upstox/FYERS capabilities/limits/entitlements/SDK-Bun fit; NSE/BSE universe/contract details; MCP 2026-07-28 transport semantics; Vela compatibility; Windows secure credential storage and backup key material.
- **Security gate:** no plaintext secrets, no credential exposure/logging, safe LAN behavior documented (LAN access required, no app-level login).
- **Parity gate:** MCP/REST/SSE/WebUI consistency on canonical data/state.
- **Recoverability gate:** clean-install restore proof including credential recovery requirements.

## 5. Out-of-scope reminders (all milestones)

No order placement/trading automation, no broker account management, no AI recommendations/predictions/signals, no sentiment/chat, no general CSV/Excel market-data export, no cloud/public hosting.
