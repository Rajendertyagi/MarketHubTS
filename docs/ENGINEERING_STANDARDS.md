# Engineering Standards

> **Status:** Canonical engineering standards for MarketHubTS (practical, lightweight, enforceable). All implementation and review work must align with these rules and with confirmed product/architecture requirements.
> **Last updated:** 2026-11-16
> **Related:** [AGENTS.md](../AGENTS.md), [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md), [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md)

## 1. Purpose and scope

These standards define how MarketHubTS is built and maintained as a **clean, independent TypeScript solution** (not a migration/copy of the original Python MarketHub). They are intentionally practical: strong enough to protect correctness, reliability, and maintainability, but not enterprise-heavy.

**Product/operating context (must remain consistent):** single local owner/application instance running on the user’s PC; **LAN access is required** so other applications, devices, and multiple MCP clients can connect to the same running application; local browser-based WebUI is acceptable and a native desktop wrapper is optional (do not force either prematurely); no cloud/public internet exposure; no application-level login/authentication system; Upstox and FYERS operate independently; News, X/Twitter, and market-wide information are phased priorities (not unwanted); no order placement or automated trading. **Single-user means one local application owner, not one connected client.** LAN reachability and the single-owner model do not by themselves establish that every LAN client is trusted or authorized for every operation; safe exposure boundaries for sensitive data and operations must be defined and reviewed (without introducing an application-level login system or changing confirmed product scope).

## 2. Architecture and module isolation

- **Modular monolith, not microservices.** One application/process boundary initially, with clearly separated, independently maintainable modules/packages.
- **Ownership:** each module owns its internal logic and its data responsibilities. Expose behavior through defined interfaces/contracts; do not reach into another module’s internals.
- **Dependency direction:** keep dependencies explicit and acyclic. No circular dependencies and no uncontrolled cross-module access. Prefer a clear flow (e.g. adapters → canonical/normalization → shared services → interfaces/consumers) consistent with [ARCHITECTURE.md](ARCHITECTURE.md).
- **Provider/feature isolation:** provider-specific logic stays in adapters; a failure, disconnect, or removal of one provider/feature must not unnecessarily affect unrelated modules or the other provider.
- **State:** avoid shared mutable state and hidden dependencies. Pass required data/context explicitly; keep mutable state owned, bounded, and observable.
- **No unnecessary layers:** do not introduce abstractions, patterns, or indirection without a demonstrated need.

**Realistic limitation:** components share one process and host resources (CPU, memory, event loop, DB). Design for fault containment and graceful degradation, but do not claim absolute isolation.

## 3. Reliability and fault containment

- **Per-module/provider health and errors:** track and expose independent health/status, last error, freshness/staleness, and capability/limit restrictions where applicable.
- **Timeouts and bounded work:** all external I/O (broker APIs, feeds, network calls, file/DB operations where appropriate) must have sensible timeouts/cancellation behavior. Use bounded queues/buffers and backpressure; **no unbounded memory growth** and no blocking of unrelated features.
- **Retries/backoff:** retry only when safe and useful, with bounded attempts and backoff/jitter where appropriate; never retry in ways that amplify provider limits or duplicate side effects.
- **Graceful lifecycle:** support clean startup, shutdown, and recovery. On shutdown, stop accepting new work, flush/complete critical writes, close streams/clients, and release resources safely.
- **Data safety:** failed or incomplete catalog/data synchronization must never destroy previously valid data (transactional/safe updates). Preserve integrity across crashes/restarts.
- **Degradation:** when data/providers are unavailable, report unavailable/stale/limited states clearly; continue operating with locally available and non-broker data where possible.
- **Testing:** include partial-failure and recovery scenarios (disconnect/reconnect, limits, stale data, interrupted sync, restart) per [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md).

## 4. Code quality

- **TypeScript:** strict typing enabled and meaningful types at module boundaries. Avoid unnecessary `any`; prefer `unknown` + validation/narrowing at boundaries.
- **Boundary validation:** validate and normalize all external/untrusted data at system boundaries (provider responses/streams, MCP/HTTP inputs, config files, persisted data reads where needed) using shared schemas/contracts (e.g. Zod) as appropriate.
- **Focused code:** keep functions, modules, and files focused and reasonably sized; avoid giant files/classes and duplicated logic. Extract shared logic only when it is genuinely shared and stable.
- **Simplicity:** no speculative abstractions, no unused code, and no dead configuration paths. Prefer clear, readable implementations over cleverness.

## 5. Configuration and data

- **Centralized, validated config:** define configuration in one coherent model with schema validation and sensible defaults. No scattered magic values.
- **No hardcoded changing data:** do not hardcode changing exchange/provider data (contracts, expiries, strikes, lot/tick/quantity freezes, dynamic instrument lists). Obtain dynamic data from verified sources/catalog sync as designed.
- **Secrets:** keep credentials/tokens out of source code, logs, error messages, and ordinary APIs. Use secure local storage mechanisms once verified/implemented; never store secrets in plaintext.
- **Canonical ownership:** preserve canonical data ownership, provider attribution/provenance/timestamps/freshness, and provider independence. Raw provider-supplied market fields must never be fabricated.

## 6. UI and styling

- **Reusable components and tokens:** use shared components and design tokens (spacing, color, typography, states) for consistency; avoid one-off styling patterns.
- **No scattered styling:** avoid inline CSS and ad-hoc style values except where technically necessary and localized; prefer the project’s styling system consistently.
- **Separation of concerns:** keep UI presentation separate from business/data logic. UI consumes shared services/contracts; it must not duplicate market-data interpretation or become a second source of truth.
- **State ownership:** keep UI/client state ownership clear (local vs shared vs server-derived). Handle loading, empty, stale, error, and partial-data states explicitly.

## 7. Testing and maintenance

- **Layered, justified testing:** unit tests for pure logic/schemas/mappers; integration tests for module/service/DB/adapter boundaries; end-to-end tests where they provide real confidence. Do not add excessive test infrastructure.
- **Test-development timing:** test-first development is an option. Tests may be designed and written before or alongside implementation, and tests and implementation should evolve together within the same bounded assignment. Do not claim functionality is implemented merely because tests exist, and do not claim tests validate a feature that has not been implemented.
- **Independence and regression:** tests should be deterministic and isolated where practical; include regression coverage for fixed bugs and critical invariants.
- **Architecture boundaries:** add lightweight checks (lint rules, dependency constraints, or targeted tests) to prevent dependency violations/cycles and cross-layer leakage as the codebase grows.
- **Automated guardrails (as code is developed):** introduce module-boundary, integration, data-integrity, and failure-recovery tests progressively, with actual implementation. Do not defer all verification to the end.
- **Critical scenarios:** provider failure/recovery, data integrity (including failed sync safety), backup/restore behavior (when implemented), parity across interfaces, and performance-sensitive paths (bounded buffers, no unbounded growth).
- **Evidence:** report tests actually executed with commands/results; do not claim coverage or passing status without evidence. Honest test evidence is required.

## 8. Dependencies and technology

- **Justified and minimal:** every dependency must have a clear purpose. Prefer standard library/Bun/TypeScript capabilities and existing approved stack before adding new packages.
- **Stable and compatible:** prefer stable, maintained, compatible technologies. Use latest suitable stable versions only after compatibility verification (runtime, tooling, types, and integration).
- **No unnecessary infrastructure:** do not introduce microservices, Redis, external databases, message brokers, cloud services, or other heavy infrastructure unless evidence demonstrates they are needed for confirmed requirements.
- **Supply/maintenance awareness:** consider license, maintenance activity, security posture, and Bun/Windows compatibility before adoption; document provisional choices and verification status.

## 9. Development approach and verification discipline

- **Agreed sequence:** (1) establish essential product requirements, architecture, and engineering standards; (2) research and verify technical choices using current official documentation, supported versions, and actual compatibility information; (3) start building the real MarketHubTS application in controlled phases; (4) verify and test actual components as they are implemented; (5) integrate features progressively and verify the complete application.
- **Evidence-driven development:** technical decisions must be supported by evidence (official docs, verified compatibility, measured behavior), not assumptions. Mark unverified details explicitly.
- **Research before experiments:** research official documentation first. Do **not** create separate prototypes, throwaway projects, or an experimental development phase before building the application. When a significant technical uncertainty cannot be resolved through research, a **narrowly scoped experiment** may be used to answer it; keep it proportionate and reuse the result in the actual product wherever practical.
- **Real implementation first:** build and verify actual MarketHubTS components. Test-first development is an option (tests may be designed/written before or alongside implementation and evolve together within the same bounded assignment), but do not claim functionality is implemented merely because tests exist and do not claim tests validate a feature that has not been implemented. The first meaningful end-to-end vertical slice must become part of the real application (not a temporary discarded demonstration).
- **Incremental NSE catalogue:** start with a limited initial instrument set, but design for full intended catalogue expansion. **Never hardcode changing exchange information** (contracts, expiries, strikes, lot/tick/quantity freezes, dynamic instrument lists); use verified sources/catalog sync as designed.
- **Lean documentation:** maintain useful requirements, architecture decisions, contracts, references, and acceptance criteria. Avoid repeated documentation polishing; update docs when evidence or decisions change.

## 10. Enforcement and evolution

- **Enforceable rules:** apply these standards in design, implementation, and review (module boundaries, validation, bounded resources, secret handling, tests, dependency justification).
- **Change control:** deviations require explicit justification and, when they affect architecture/product boundaries, documented decisions/approval per [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md).
- **Living document:** update this file when standards are clarified or legitimately evolved; keep dependent docs linking here rather than duplicating the full text.