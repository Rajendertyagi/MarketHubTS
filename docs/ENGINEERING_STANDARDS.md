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

## 3A. External integration correctness rules (learned from M3)

These rules apply to any provider/external API integration. They are the concrete lessons from the M3 correction cycle and must be checked during design and review, not discovered after publication.

- **Credential replacement is a transaction with the provider, not just a local write.** Validate a candidate credential before replacing a working one. On invalid response, network failure, timeout or uncertain validation, keep the old credential and report the failure in status. For flows with a separate secret (e.g. FYERS App Secret), store a candidate and promote it only after a successful authentication exchange.
- **HTTP success is not response success.** Validate the response body shape (status/code plus required fields) before reporting success. A malformed or unexpected HTTP 200 must produce an explicit error state, never `AUTHENTICATED`. Discard personal/sensitive payload fields after validation; persist only sanitized status and timestamps.
- **Retry only safe, idempotent operations.** Never retry a single-use authorization-code exchange. Retry bounded idempotent reads with jittered backoff. Honour `Retry-After` in both delta-seconds and HTTP-date forms; stop retrying when the header is missing, invalid, in the past, or implies an unsafe delay. Never retry in a tight loop or amplify rate-limit violations.
- **Startup must be offline-safe and state-honest.** Loading persisted configuration/credentials must not make network calls. If saved credentials/config exist, report a validation-required state (`AUTH_REQUIRED`), not `NOT_CONFIGURED`. Keep `DISABLED` and `CREDENTIALS_UNAVAILABLE` distinct. Clear the validation-required advisory after successful authentication or validation, while preserving unrelated restrictions (e.g. expiry unknown).
- **Expiry metadata is source data, never inferred.** Persist user-supplied or provider-supplied expiry timestamps. Do not calculate an expiry from the moment a token was entered, and do not overwrite a known expiry with a recalculated one. When a credential is replaced without expiry metadata, clear the previous expiry from storage, runtime config and status, and report expiry as unknown.
- **Callback/redirect configuration must match the actual listener.** Validate scheme, loopback host, port and path against the running application's listener. Reject HTTPS when the app serves HTTP and reject a port different from the configured API port. Preserve single-use state validation and never log callback query parameters containing codes.
- **Durable non-secret settings belong in SQLite, secrets in the encrypted store.** App IDs, redirect URIs and expiry metadata are settings; tokens, app secrets and API secrets are credentials. Keep the two paths separate and load settings on startup.
- **Durability tradeoffs must be explicit.** WAL + `synchronous=NORMAL` can lose the last commits on power loss without corrupting the database. This is acceptable only when the lost write is re-enterable (e.g. a credential the user still holds). Do not silently change the setting; record the justification and do not claim stronger durability than configured.

## 3B. Async lifecycle and reconciliation correctness rules (learned from M4 Stage D review)

These rules apply to any supervisor, reconciler or bounded delivery buffer. They are the concrete lessons from the Stage D independent review and must be checked during design and review, not discovered after publication.

- **Shutdown must cover in-flight starts, not only completed ones.** A driver/resource whose `start()` is still pending is a live resource. Track a pending-start state, stop it on shutdown, and stop it again if the promise resolves after stop. Guard every late callback with both an epoch and a stopped flag so it cannot mutate canonical state after shutdown.
- **Re-check optimistic generation after every async resolution step.** Reading a desired-state generation, awaiting mapping/IO, then applying it can apply stale state if a newer generation committed during the await. Re-read the committed generation after async resolution and abort if it changed; never apply stale selections to canonical state or hand them to a driver.
- **Classify failures by phase, not with one catch-all.** Validation failures before persistence are client errors; persistence failures are server errors; a post-commit reconciliation failure must not be reported as an invalid request. Expose committed generation and desired selections separately from runtime status/error so a committed write is never hidden by a later runtime failure.
- **Full payloads must respect the same memory budget as incremental events.** An initial snapshot is not exempt from per-client byte/count bounds. Account for it explicitly and, when it exceeds the bound, return a deterministic resync signal (REST retrieval) rather than queueing an unbounded payload. Keep control events coalesced and bounded.
- **Provider-native identifiers stay internal.** Public subscription/status views expose canonical IDs, state and safe reasons only. Native provider identifiers belong in mapping resolution and the driver handoff, never in externally exposed contracts.
- **Telemetry counters must be maintained where the event occurs.** A cumulative drop counter must be incremented on every drop (including for clients that later disconnect); do not derive a "total" from currently connected clients unless the metric is explicitly named and documented as such.
- **Generation ownership must remain explicit after operations settle.** Attribute callbacks to their active operation or the driver's last successfully applied generation, never to mutable desired state. Scope reconnect timers to both desired generation and driver epoch, invalidate stale timers when the desired generation changes, and prevent late timer callbacks from affecting newer timer ownership.

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
- **Option and metadata ownership:** backend and shared contracts own selectable options, capabilities and domain entities consumed by the WebUI. Derive fixed option sets from shared Zod schemas and dynamic sets from the owning registry/domain API; never maintain a second frontend list of backend-owned values. Presentation-only local choices may remain in the frontend. See [METADATA_AND_CAPABILITY_DISCOVERY.md](METADATA_AND_CAPABILITY_DISCOVERY.md) (AD-025) and the mandatory Option and Metadata Impact Assessment in [PROJECT_MANAGER_PROTOCOL.md](PROJECT_MANAGER_PROTOCOL.md) §4.1.

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