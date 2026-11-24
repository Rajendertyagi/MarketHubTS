# Implementation Roadmap

> **Status:** Dependency-based roadmap from verified scaffold to product milestones. No arbitrary dates/estimates.
> **Last updated:** 2026-11-22 (metadata initiative expanded into dependency-sequenced Phases 0–7 with a bounded first milestone)
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

### M2 — Canonical contracts, catalog foundation, and persistence primitives (real application) — **Published on `develop` (`fa40420`, `484c0a6`)**
**Objective:** establish shared canonical schemas, instrument identity/catalog model, and DB/migration foundations used by all services, as part of the real MarketHubTS application.

**Prerequisites:** M1; verification of exchange universe rules and key provider identifier formats (sufficient to model mappings).

**Key work (completed):** canonical market-domain contracts (Zod/shared types), instrument/derivative/index-eligibility/mapping/alias/provenance/sync models, normalized identity-key rules, `market-core` domain/sync service and repository ports, SQLite schema + additive migration (`0001`), `SqliteCatalogRepository`, and transactional source-independent sync primitives. Supports synthetic/limited fixtures while designed for full intended catalogue expansion; no hardcoded changing exchange information.

**User-visible deliverables:** none (internal domain foundation); enables subsequent provider ingestion and data features.

**Acceptance criteria (met in verification):** schemas/types compile and are consumed by domain/database code; migrations run safely (clean install and M1→M2 upgrade preserving `app_meta`); catalog can be loaded/updated transactionally without destroying previous valid state; duplicate/ambiguous identities and mappings handled safely; identity/mapping/sync rules documented and implemented; M1 regression intact.

**Verification:** automated tests for schema/domain validation, migrations, persistence, transactional sync safety/failure recovery, and required M2 scenarios (`tests/market/catalog.test.ts`) plus full typecheck/test/build.

**Risks/remaining verification:** incomplete provider/exchange metadata; current NSE index F&O eligibility and provider-native identifier formats require official verification before M3.

**Non-goals (preserved):** live broker connectivity, bulk catalog downloads/seeding, UI market views/search, MCP market tools/HTTP transport.
---

### M3 — Provider adapter framework and resilient connectivity (Upstox + FYERS) — **Published on `develop`**
**Objective:** connect/configure providers independently with health, auth lifecycle handling, and normalized capability reporting.

**Prerequisites (met):** M2 published; official Upstox/FYERS auth, rate-limit and app-type research complete and recorded in [REFERENCES.md](REFERENCES.md) and [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md); credential-storage decision approved by owner.

**Owner-directed technical decisions (approved):**
- **Portable, self-contained folder:** no Windows Credential Manager, no `Bun.secrets`, no DPAPI, no OS keychain, no native modules. Secrets encrypted inside SQLite with one random key file in the same app folder, using built-in Bun crypto. Copying the folder preserves credentials; losing the key requires re-authentication. Accepted tradeoff (documented): a folder copy includes the key. Never plaintext.
- **Upstox:** Analytics Token (free, read-only, 1-year, no OAuth, no static IP for market-data categories), entered in local WebUI; validate with `GET /v2/market/status/NSE` (Market Information category, non-sensitive GET). No daily OAuth, no trading/account APIs. One token per account; explain regeneration/revocation in UI.
- **FYERS:** V3 individual-app authorization-code flow using a **non-trading (data-only) app** (no static IP, no order placement). Random state verified on callback; `appIdHash = SHA-256(app_id:app_secret)` computed backend; single-use code exchange; daily 6:30 AM expiry; no assumed refresh; profile used only to validate; logout on removal. Loopback callback on a configurable port matching the registered redirect URI; no public callback collector.
- **HTTP:** Bun native `fetch` for REST/auth. M4 Stage B scoped exception: pinned `upstox-js-sdk@2.31.0` for Upstox market-data streaming only.
- **Limits:** no hardcoded plan caps; design for FYERS Standard limits and report actual capability/restrictions; unknown entitlements stay unknown.

**Key work:** adapter interfaces, portable encrypted credential store, connection/auth/token lifecycle, health/error/limit reporting, provider capability discovery, independent connect/disconnect/remove behavior, loopback-only privileged boundary, minimal WebUI diagnostics.

**User-visible deliverables:** WebUI/diagnostics show honest provider states (disabled/not configured/auth required/authenticated/expired/degraded/error), expiry, capability restrictions and sanitized errors; app operates with both, either, or neither provider. Streaming status explicitly "not started" until M4.

**Acceptance criteria:** provider-state matrix satisfied; one provider failure does not impact the other; no plaintext secrets; LAN clients cannot submit/replace credentials or initiate privileged provider configuration; clear diagnostics; no app-level login introduced.

**Verification:** mocked integration tests for all provider states and failure scenarios; real local credential-store round trip; full typecheck/test/build; no live broker authentication without separate authorization.

**Risks:** FYERS loopback redirect registration must match exactly (report concrete blocker if unsupported); Analytics Token generation eligibility on the account; Bun crypto/SQLite integration details; no live verification in this assignment.

**Non-goals:** live WebSocket/tick ingestion (M4), historical candles/caching (M5), option-chain snapshots (M5), bulk catalogue download, search UI, MCP market tools/HTTP transport, watchlists/alerts/scanners, charts, trading/order/account functionality, backup/restore implementation.

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

#### M4 staged execution (agreed order D → E → F → C → G)

| Stage | Responsibility | Status |
|---|---|---|
| A | Canonical live contracts, per-provider observations, bounded in-memory state, monotonic revision, defensive copies, session-aware freshness, source selection | **Published** (`2dfe969`, `0cdb6dc`) |
| B | Upstox V3 streaming adapter on pinned `upstox-js-sdk@2.31.0`; SDK used for market-data streaming only; lifecycle/decoder corrections | **Published** (`084969e`, `e02c64e`, `81d2900`, `9a31a8b`, `ff23b53`, `b731823`) |
| D | Provider-ready live-data backend vertical slice: service notifications, subscription persistence + durable generation, bounded realtime hub, REST/SSE, minimal supervisor, locked production driver boundary | **Published on `develop` and accepted** (final commit `f51e7db`) |
| E | WebUI streaming selections and live-data experience, incl. EventSource close/fetch/reconnect and `refresh` client behavior | **Published on `develop` and accepted** (`ea0cae0` initial, `00e6830` named SSE / manual retry / review fixes, `a8f4eef` initial-sync and retry-cancellation corrections, plus final closeout fixes) |
| F | Deep reconnect/recovery/concurrency/resource hardening; race/fault injection, sustained-load/soak tests | **Published and integrated into `main`** (`bf1044b`, `21c92c7`, `06b644c`, `35b5d2e`, `0c6e2fb`, `d95c3ac`, `cca0eb1`); independent code review passed; authorized fast-forward synchronized `main` and `develop` at `865d86f` |
| C | FYERS Data Socket adapter, after D/E/F prove the first provider path | **Published on `develop`; final reviewed state `e8ce409`** (original implementation `e236e25`). Adapter-only; final independent review of the complete range `e236e25` → `e8ce409` is approved. Corrective commits addressed typed LIMITED handling, supervisor generation ownership, retry timer lifecycle, and FYERS index timestamp mapping. Built on the implemented AD-024 foundation ([MULTI_PROVIDER_STREAMING_ARCHITECTURE.md](MULTI_PROVIDER_STREAMING_ARCHITECTURE.md)): shared subscription coordinator, canonical data-component model, provider-neutral capability contracts. Production driver activation, real provider authentication, socket connection and live verification remain Stage G (pending and locked). |
| G | First live provider verification, separately authorized after the single-pass gate | Pending |

**Stage D boundary:** production composition uses a locked/disabled driver — no real Upstox SDK driver is instantiated, no socket is opened, and no real provider connection is attempted. The supervisor is exercised with deterministic fake drivers in tests only. Basic retry/backoff is a fake-driver test concern; the locked boundary fails safely on any start attempt and never schedules retries. Real driver construction and connection behavior may only be unlocked by a separately authorized, independently reviewed Stage G change.

**Stage G single-pass gate:** all implementation stages complete; independent code review complete; scenarios and explicit pass/fail criteria written; sanitized fixture capture/handling ready; separate explicit user authorization and a separately reviewed change to the locked boundary before any real connection.

**Architecture prerequisite for Stage C (implemented):** the streaming foundation adopted the decisions in AD-024 / [MULTI_PROVIDER_STREAMING_ARCHITECTURE.md](MULTI_PROVIDER_STREAMING_ARCHITECTURE.md): (1) one shared subscription coordinator with independent per-provider runtimes so two providers never write the same durable generation or untrack each other's instruments; (2) a canonical data-component model so FYERS partial price/depth messages do not overwrite each other; (3) provider-neutral capability contracts so no broker SDK mode name leaks into shared contracts. Stage C built on this foundation; it does not unlock the production boundary or authorize live verification (Stage G).

---

### M5 — Historical candles and option-chain snapshot persistence
**Status:** **Offline implementation complete and published (Phases 1–4A); Phase 4B provider-backed activation is not activated and remains Stage-G gated.** Live REST verification has not been performed; live provider data availability is not established. See [`STAGE_5_PLAN.md`](STAGE_5_PLAN.md) §15 and [`PROJECT_STATUS.md`](PROJECT_STATUS.md) §3.12.

**Objective:** reliable historical retrieval/caching and configurable option-chain snapshot capture/storage.

**Prerequisites:** M2–M4 foundations as applicable; verified historical/expired/option-chain APIs and entitlements. **The offline phases did not require live verification**; provider capabilities/limits remain `UNVERIFIED` pending Stage G REST scenarios (plan §3A).

**Key work (offline, implemented):** historical request/sync workflows, local candle cache, derived coverage and gap fill policy, unavailable-period reporting; snapshot schema/store, WebUI capture config (underlying/expiry/strikes/capture independent of streaming), retention integration; offline Upstox/FYERS REST adapters with mocked fetch; local API/WebUI (Phase 4A).

**User-visible deliverables (implemented):** cached historical reads and coverage status; snapshot capture configuration and stored snapshot retrieval (per collected data). No live provider data is exposed because no provider is connected.

**Acceptance criteria (offline portion met):** cached candles preserved across disconnect/removal; missing periods handled/reported; snapshots stored separately per config; on-demand requests do not mutate capture config; no pre-collection claims without provider support. **Provider-backed acceptance remains gated on Stage G.**

**Verification:** persistence/restart tests, provider-unavailable tests, retention/cleanup tests, mocked-fetch adapter tests — all offline and passing locally (see `PROJECT_STATUS.md` §3.12 for current figures; local verification, not CI).

**Risks:** provider historical limits/entitlements, large data volumes, schema evolution — all remain unverified until Stage G.

**Non-goals:** exhaustive broker DB replication; Phase 4B activation without Stage G authorization.

---

### M6 — MCP market-data and event interface (AI-first parity)
**Status:** **M6-A, M6-B1 and M6-B2 are implemented and published on `develop`** (Streamable HTTP at `/mcp` + retained STDIO, shared factory, catalog/event seams, nine tools). **M6-B3 is implemented and published at `0d58bbb`** ([`M6_B3_PLAN.md`](M6_B3_PLAN.md)); **M6-C is accepted and closed at `32b034a`** (acceptance record in [`M6_C_PLAN.md`](M6_C_PLAN.md) §0). **M6-B4, M6-D and M6-E are all ACCEPTED (2026-11-25)** — the independent review gate in [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md) §8.1–§8.3 passed (reviewer `opencode/iceman-free`, verdict **KEEP**, no blockers/majors), the combined §8.3 gate is **PASSED**, and **M6 is complete and closed**. B4 evidence: `tests/mcp/parity.test.ts` + named C3/C6/C18/C19/C21 assertions in `tests/mcp/conformance.test.ts`; acceptance records in [`M6_B_PLAN.md`](M6_B_PLAN.md) §12 and [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md) §14/§8.3.1. **MarketHub must support the latest stable official MCP protocol, not merely a working HTTP endpoint (verified target `2026-07-28` / SDK `2.4.0`; re-verify at implementation start and retarget if newer stable versions exist). Streamable HTTP MCP is a mandatory M6 deliverable — fully implemented and working at `/mcp` over localhost with real HTTP integration, with the existing LAN configuration/binding and Host/Origin security implementation retained, not optional or deferrable. Physical second-device LAN verification is outside the revised M6 scope by explicit user decision; physical LAN reachability is not verified and the in-process simulation is not proof of it. M6 was not to be declared complete until the target revision's mandatory requirements were verified, the HTTP transport worked, and the conformance tests passed (M6-E); those conditions are now satisfied as recorded in the 2026-11-25 acceptance records.** The canonical completion plan [`M6_B4_D_E_COMPLETION_PLAN.md`](M6_B4_D_E_COMPLETION_PLAN.md) governed the remaining B4/D/E work; its "Corrections published in `9f99b9a`; awaiting independent review; not implementation-authorized" wording is **historical** (superseded by the 2026-11-25 acceptance records). **M6 is complete and closed (2026-11-25); the full M6 completion rule is satisfied.**

> **M6 reconciliation note (2026-11-25):** the earlier "not accepted / not complete / awaiting independent review" wording above is preserved as historical and is superseded by this note. All three phases (B4, D, E) are accepted and the combined §8.3 gate passed; final full verification is **1115 pass / 0 fail**, 9164 `expect()` calls, 96 files (local, **not CI**), with `bun run typecheck` and `bun run build` exit 0 and `git diff --check` clean. The closeout changes are **uncommitted** at HEAD `9b47bdd`; `main` remains untouched at `865d86f`. Stage G, M5 Phase 4B and M7 remain locked; no live provider verification or production activation occurred. This note changes only the M6 status — M7–M11 and Stage G are untouched.

**Objective:** comprehensive MCP access over shared services with correct transport/event behavior and permission boundaries.

**Prerequisites:** M2–M5 service capabilities; verified MCP 2026-07-28 spec/SDK transport and subscription/event semantics (including `subscriptions/listen`, supported notifications, and the installed `@modelcontextprotocol/server` 2.4.0 behavior — confirmed from the lockfile and installed package, not assumed). M6 must work while M5 Phase 4B remains gated; it does not require provider activation.

**Key work (phase assignments):** **M6-A** — implement the actual Streamable HTTP endpoint at `/mcp` with `createMcpHandler` on Hono/Bun, explicit protocol-version opt-in, Host/Origin validation, correct route registration before the SPA catch-all, lifecycle/shutdown, and retained STDIO compatibility. **M6-B** — expose shared tools/resources/prompts through both transports without duplicating business logic. **M6-C** — durable activity history and WebUI inspection. **M6-D** — `subscriptions/listen`, SSE-based notifications/event delivery, read-after-notify, cursor/reconnect handling and multi-client isolation over Streamable HTTP; **do not implement deprecated legacy HTTP+SSE**. **M6-E** — end-to-end integration acceptance with a real Streamable HTTP MCP client over an actual HTTP listener, plus one standalone in-process LAN simulation test (physical LAN reachability is outside the revised M6 scope by user decision). Tool/resource/prompt set covers discovery/quotes/depth/candles/option chains/futures/market-wide/freshness/on-demand and discoverable alert-event resources/feeds with cursor/sequence retrieval.

**User-visible deliverables:** AI agents can query/subscribe to supported market data and receive/retrieve alert events; parity with REST/WebUI data.

**Acceptance criteria:** **Streamable HTTP MCP fully implemented and working over localhost with Host/Origin security; M6 cannot be declared complete unless HTTP transport and event-delivery criteria pass. A passing mocked or in-process `handler.fetch` test alone never satisfies Streamable HTTP acceptance — real-HTTP integration evidence from M6-E is mandatory, including the standalone in-process LAN simulation. Physical LAN reachability is not verified and is outside the revised M6 scope (user-approved change).** No duplicate market logic; permission boundaries enforced; on-demand fetch does not alter operational config; multi-client scenarios pass; transport behavior matches verified spec; alert-event delivery uses durable records + supported protocol notifications/read-after-notify (no arbitrary alert-trigger notification type), with reconnect recovery and polling/tool fallback. Provider activation and Stage G remain separately gated.

**Verification:** two required, non-substitutable test classes — (a) unit/in-process tests including `conformance.test.ts` (one named assertion per mandatory requirement C1–C21 in [`M6_PLAN.md`](M6_PLAN.md) §3.1) and `handler.fetch` (`transport.test.ts`), and (b) real-HTTP integration tests (`http-integration.test.ts`) connecting a **real Streamable HTTP MCP client pinned to the target revision** to the running Hono/Bun server over an actual HTTP listener, covering discovery/version negotiation, tool execution, resource access, event subscriptions, simultaneous clients/subscriptions, and error/cancellation/reconnect/shutdown. Plus `stdio-modern.test.ts` (modern-pinned STDIO verification), `legacy-compat.test.ts` if dual-era is retained, parity, security/input validation, and the standalone in-process LAN simulation test. Optional extensions (Tasks, Skills over MCP, MCP Apps, auth extensions) are evaluated separately in §3.2 and none are advertised in M6.

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
- **Official verification gates:** Upstox/FYERS auth and published limits verified for M3 (see [REFERENCES.md](REFERENCES.md)); remaining — actual account entitlements, NSE/BSE universe/contract details, MCP 2026-07-28 transport semantics, Vela compatibility. Credential storage is decided (portable encrypted SQLite + local key file); backup/restore design remains M9.
- **Security gate:** no plaintext secrets, no credential exposure/logging, safe LAN behavior documented (LAN access required, no app-level login).
- **Parity gate:** MCP/REST/SSE/WebUI consistency on canonical data/state.
- **Recoverability gate:** clean-install restore proof including credential recovery requirements.
- **Metadata source-of-truth gate (cross-cutting initiative — Backend-Driven Metadata and Capability Discovery):** backend and shared contracts own every backend-owned identity, contract, capability, selectable option and domain-data value; consumers reuse or discover them instead of duplicating lists. Requirement, decision and source-verified inventory in [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) §10 and AD-025 in [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md). This initiative does **not** block accepted M6-C, does not change M6-D/E/B4 ownership, and does not reopen physical LAN testing. Future WebUI development introducing backend-owned selectors depends on it. Phases and dependencies are defined in §4.1.

### 4.1 Backend-Driven Metadata and Capability Discovery — phased initiative

Documentation and architecture protocol (Phase 0 design) and the read-only source-of-truth inventory are **done** (architecture doc §6 and §10). Phase 1 (shared contract consistency), Phase 3 WP 3a (historical interval selector), Phase 3 WP 3b–3c (instrument picker), Phase 2 WP 2a–2c (MCP operation discovery + Activity selector) and Phase 5 WP 5A/5B/5C.1/5C.2 (provider status and capability rendering) are **implemented, tested and published on `develop`** — see the Phase 2/3/5 plan §12 close-outs. Phase 6 WP6A (retention consistency) and WP6B (snapshot provider selection) are **implemented, independently audited to KEEP and published on `develop`** (WP6A: `f25d514`/`128e44a`/`2866bae`; WP6B: `d132894`, explicit-only provider selection derived from `providerIdSchema`, no FYERS default and no "Automatic" option). Phase 6 WP6C (Overview accuracy) is implemented and published at `b37fa67` (independent audit KEEP), so Phase 6 is complete (all three WPs published). Phase 4 (derivative expiry discovery) is **complete and published on `develop`** — WP4A (`03adab1` + fixes `bcec6ab`/`8785670`), WP4B (`e99c5f3`), WP4C (`9862464` + fix `13061da`), canonical plan (`ed967e3`); all independently audited KEEP with no findings. It delivers a local catalogue from public Upstox BOD + FYERS Symbol Master files (no credentials, no live calls), a bounded provider-aware expiry API `GET /api/catalog/derivative-expiries` with honest FRESH/STALE/UNKNOWN freshness, and a Snapshot Panel expiry selector with manual fallback clearly marked unverified; provider identity stays fixed `UPSTOX`/`FYERS` (no Automatic option, no FYERS default), with no live provider connection or activation and no full exchange catalogue claim. The remaining phase below (7) is **planned, not implemented** and requires separate authorization. Group small changes where sensible; do not create artificial milestones.

| Phase | Objective | Prerequisites / dependencies | Expected modules (verify at implementation) | Non-goals | Acceptance & tests | Risks / unresolved |
|---|---|---|---|---|---|---|
| **0 — Architecture & contract design** | Dependency-safe shared identity design; canonical SSE event contracts; shared provider-status response; MCP operation descriptor model; discovery/API boundaries | Done: architecture doc §10 inventory. Remaining: resolve open questions | `@markethub/contracts` (leaf identity module, event-name const, provider-status schema, operation descriptor schema) | No implementation, no new dependency | Design record updated with evidence; no code tests | Leaf-module import direction; `snapshot` event has no payload schema; endpoint necessity |
| **1 — Shared contract consistency** | Centralize provider identity, transport/option-type contracts, event names; remove redundant declarations preserving exports; use shared `ProviderId` for WebUI `ProviderStatusView.id` (type only) | Phase 0 | `contracts/src/provider-identity.ts` (new leaf module), `contracts/src/{provider,market,live,live-components,historical,snapshots,mcp-activity}.ts`, `mcp-core/src/activity.ts`, `realtime/src/{types,hub}.ts`, `apps/api/src/market-routes.ts`, `web/src/{lib/status.ts,lib/live.ts,lib/live-stream.ts,components/ActivityPanel.tsx}` | No behavior change; DB SQL CHECKs stay literal; `live.ts:12` now uses the shared leaf schema (no local exception); provider-status response validation, fixed-key rendering and enumeration deferred to Phase 5 | Contract tests for one identity definition, SSE name consistency (hub/API/WebUI incl. `lib/live.ts`), CE/PE and HTTP/STDIO parity; existing suites green | Circular imports; public export compatibility |
| **2 — Runtime capability discovery** — **IMPLEMENTED (WP 2a–2c; published on `develop`)** | MCP tool/resource/prompt descriptor source from actual registrations; read-only validated response; Activity operation selector | Phase 0 decision on endpoint vs shared-module import; Phase 1 types | `mcp-core/src/operation-descriptors.ts` (new), `tools.ts`, `resources.ts`, `prompts.ts`, `index.ts`, `api/src/mcp-operation-routes.ts`, `web/src/lib/mcp-operations.ts`, `ActivityPanel.tsx` | No SDK internals; no universal form engine; no second list; keep `toolName` filter contract (no migration for `operationType`) | Descriptor parity with `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`; newly registered operation visible without frontend edit; selector states; no secrets | Endpoint decision resolved (dedicated read-only route); `category` deferred; no-DOM test approach proven |
| **3 — Instrument discovery UX** — **IMPLEMENTED (WP 3a, 3b–3c; published on `develop`)** | Reusable catalog search selector adopted by Subscription, Historical, Snapshot panels | Phase 1 shared types; existing `/api/catalog/search` | `web/src/lib/catalog.ts` (new), `web/src/components/InstrumentPicker.tsx` (new), three panels | No faceted filters without repository support; no full-catalogue download | Catalog results populate all selectors; bounded pagination; debounce/cancellation; panel request shapes unchanged | Faceted filters need repo/API extension; bounded Load More pagination is implemented (single-flight, 100-result cap) |
| **4 — Derivative domain discovery** — **COMPLETE (WP4A/WP4B/WP4C implemented, audited KEEP and published on `develop`)** | Provider-backed expiry discovery from local Upstox BOD + FYERS Symbol Master files (no credentials, no live calls); bounded provider-aware expiry API `GET /api/catalog/derivative-expiries` with honest FRESH/STALE/UNKNOWN freshness; Snapshot Panel expiry selector with manual fallback marked unverified | Local catalogue imported from public provider master files; bounded query (WP4A `03adab1` + fixes `bcec6ab`/`8785670`, WP4B `e99c5f3`, WP4C `9862464` + fix `13061da`, plan `ed967e3`) | `market-core` repository/service, new read-only API, WebUI expiry selector | No weekday-derived expiries; no hardcoded dates; no speculative strikes; no live provider connection or activation; no full exchange catalogue claim (broker-available coverage only); provider identity fixed `UPSTOX`/`FYERS` (no Automatic option, no FYERS default) | All three WPs independently audited KEEP with no findings; expiry options from real master records; bounded query; honest empty/unavailable state | Stage G untouched; broker-available coverage only, not a full exchange catalogue |
| **5 — Provider & capability extensibility** — **IMPLEMENTED (WP 5A/5B/5C.1/5C.2; published on `develop`)** | Enumerable provider-status model; capability rendering; per-provider runtime capability rendering; custom auth workflows retained | Phase 1 identity; Phase 2 descriptor pattern | `contracts/src/provider.ts`, `api/src/provider-routes.ts`, `web/src/lib/status.ts`, `App.tsx`, `components/ProviderStatus.tsx`, `components/SubscriptionRuntimeView.tsx`, `lib/subscription-poller.ts`, `lib/subscriptions.ts` | No dynamic extensibility claim before contract/registry support; no universal credential form | WebUI iterates validated provider status; capability states honest; no hardcoded capability list; safe bounded refresh | Fixed `UPSTOX`/`FYERS` contract retained; three capability vocabularies kept separate; all capability metadata now rendered honestly |
| **6 — Configuration & correctness** — **COMPLETE (WP6A/WP6B/WP6C implemented, audited KEEP and published on `develop`)** | Retention control consistency; snapshot provider selection semantics; correct overview status text | Phases 1–3 | `HistoricalPanel.tsx`, `SnapshotPanel.tsx`, `App.tsx`, related contracts/routes | No silent service-order change; no invented fallback | All three WPs independently audited KEEP and published (WP6A: `f25d514`/`128e44a`/`2866bae`; WP6B: `d132894`; WP6C: `b37fa67`); Phase 6 is complete | Explicit-only provider selection resolved and implemented in WP6B (options from `providerIdSchema`, no FYERS default, no "Automatic" option); WP6C is presentation-only using existing `data.mcp.httpHandlerMounted` |
| **7 — Cross-system acceptance** | Prove source-to-consumer consistency and forward compatibility | All prior phases | Tests across contracts, API, MCP, WebUI | No new production behavior | New MCP operation discoverable without frontend edit; new enum value via shared contracts; new provider follows documented extension; existing API/persisted-data compatibility; no secrets; backend validation authoritative | Full cross-package test coordination |

Bounded first milestone (completed): **Phase 1 + Phase 3's interval selector** (direct shared-contract consumption, lowest risk), followed by the **completed** Phase 3 instrument picker and the **completed** Phase 2 operation selector. See [METADATA_DISCOVERY_FIRST_SLICE_PLAN.md](METADATA_DISCOVERY_FIRST_SLICE_PLAN.md), [METADATA_DISCOVERY_PHASE_3_PLAN.md](METADATA_DISCOVERY_PHASE_3_PLAN.md) §12 and [METADATA_DISCOVERY_PHASE_2_PLAN.md](METADATA_DISCOVERY_PHASE_2_PLAN.md) §12.

**Phase numbers are not implementation order.** The table groups work by architectural concern; the actual increment order was: (1) Phase 1 shared-contract consistency + the historical interval selector, (2) the Phase 3 instrument picker using the existing catalog API, (3) the Phase 2 MCP operation selector after the descriptor-delivery decision. All three are now implemented and published. No discovery endpoint is a prerequisite for shared contract values; the Phase 2 endpoint decision was resolved with evidence (dedicated read-only route).

## 5. Out-of-scope reminders (all milestones)

No order placement/trading automation, no broker account management, no AI recommendations/predictions/signals, no sentiment/chat, no general CSV/Excel market-data export, no cloud/public hosting.
