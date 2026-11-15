# Architecture Decisions

> **Status:** Record of confirmed/established decisions, rationale, constraints, and provisional items.
> **Last updated:** 2026-11-15
> **Related:** [ARCHITECTURE.md](ARCHITECTURE.md), [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)

## 1. Decision log

| ID | Decision | Status | Rationale | Constraints / notes |
|---|---|---|---|---|
| AD-001 | One canonical data and application-services foundation for all consumers (MCP, REST/SSE, WebUI) | **Confirmed** | Prevents inconsistent behavior, duplicate logic, and drift between AI and human interfaces | No independent market-data interpretation or duplicate business logic in MCP/WebUI; shared services only |
| AD-002 | Provider-specific logic isolated in adapters (Upstox, FYERS; extensible) | **Confirmed** | Provider independence, replaceability, and clean normalization boundary | Adapters handle auth, protocol, limits, reconnect, mapping; no provider logic in consumers |
| AD-003 | Both providers operate independently/simultaneously when configured; app works with either or neither (local/non-broker data) | **Confirmed** | Resilience and user choice; no hard dependency on a single broker | One disconnect must not break other; removal must not break remaining functionality |
| AD-004 | Automatic source selection by capability/availability/freshness/reliability/limits; optional manual preferences in WebUI; no fixed provider priority | **Confirmed** | Best available data without hidden bias; user override when needed | Preserve attribution/timestamps; expose restrictions clearly |
| AD-005 | Canonical fields + preserved provider-specific fields + attribution/timestamps/freshness; never fabricate raw provider-supplied market fields (OI, IV, Greeks, prices, depth, volume) | **Confirmed** | Data integrity and trust; extensibility without breaking consumers | Derived technical indicators allowed only as separately labelled derived indicators |
| AD-006 | Live ticks/quotes/depth in memory only; repopulated from streams after restart; no per-tick/per-depth-change persistence | **Confirmed** | Performance, storage efficiency, bounded writes | Must carry source/timestamp/freshness; bounded memory/queues required |
| AD-007 | Historical candles retrieved on demand and/or user-configured sync; cached locally; preserved across disconnect/removal; gap fill from suitable provider when available | **Confirmed** | Useful local history without duplicating entire broker databases | Report unavailable periods/restrictions; retention user-controlled |
| AD-008 | Option-chain snapshots persisted separately per WebUI capture config; streaming selection independent of capture; MCP on-demand does not change capture config | **Confirmed** | Predictable storage and user control; avoids hidden side effects from AI requests | No claims of pre-collection snapshots unless provider supplies them (verify) |
| AD-009 | Common instrument catalog is foundational and shared by all modules/consumers; canonical identity distinct from provider-native IDs; transactional/safe sync | **Confirmed** | Consistent instrument resolution across product; safe evolution | Dynamic follow of official exchange info; no permanent hardcoding of changing contracts/lot/expiry/strike/freeze |
| AD-010 | MCP is primary AI interface using shared services; AI may manage watchlists/alerts/scanners and do on-demand retrieval but cannot modify operational config | **Confirmed** | Powerful AI access with clear safety/control boundary | WebUI owns credentials/connections/streaming/sync/capture/retention/preferences/startup/network |
| AD-011 | Alerts/scanners never auto-subscribe; alerts needing non-streamed instruments saved as waiting with explanation | **Confirmed** | Predictable behavior and user control over streaming/resources | AI must never bypass; scanners report stale/unavailable/not-streamed limitations |
| AD-012 | WebUI is operational control centre; simple configuration, sensible defaults, no hidden fixed policies; provider restrictions exposed clearly | **Confirmed** | Usability and transparency | Never silently change user selections due to API limits |
| AD-013 | Windows-first, local-first, LAN-accessible; no cloud/public exposure; no app-level user login; multiple MCP clients supported | **Confirmed** | Target deployment and access model | Credentials/tokens still handled responsibly (never logged/exposed); secure storage required (verify mechanism) |
| AD-014 | Full backup/restore must include complete DB and any key material/state required to recover encrypted broker credentials; restore tested on clean install | **Confirmed** | Real recoverability, not false confidence | Database-only copy insufficient if keys/state missing |
| AD-015 | Bun + TypeScript monorepo; React/Vite WebUI; Hono API; Zod contracts; SQLite (`bun:sqlite`) + Drizzle; TanStack/Zustand/Tailwind/shadcn; MCP TS SDK; Vela candidate for charts | **Established (baseline/provisional mix)** | Modern, cohesive TS/Bun stack aligned with local-first single-process design | Actual installed versions documented in [DEPENDENCIES.md](DEPENDENCIES.md); Vela and some integrations pending compatibility validation; no dependency changes in this doc task |
| AD-016 | Single long-running backend process initially (API, broker connections, auth, subscriptions, canonical processing, analytics, scheduling, SSE, DB coordination) | **Established** | Simplicity and shared state/control; avoids premature microservices | Keep responsibilities modular; evolve only with demonstrated need |
| AD-017 | SSE primary for frontend realtime delivery; drop overflowing events not subscribers; WebSocket only if justified | **Established** | Simpler client model and resilience under load | Bounded buffers, cleanup, observable drop counters required (planned) |
| AD-018 | MCP transports: Streamable HTTP primary network transport, SSE-based events/subscriptions per current spec, assess legacy HTTP+SSE only for compatibility, retain/document STDIO | **Established, pending verification** | Align with current MCP direction while supporting scaffold/compat needs | Must verify 2026-07-28 spec semantics and SDK support before implementation claims |
| AD-019 | No order placement/trading/account-management, no AI recommendations/predictions/signals/sentiment/chat, no general CSV/Excel export | **Confirmed** | Clear product boundary | Watchlist import/export (if retained) is separate |
| AD-020 | News and X/Twitter integrations are required later phases | **Confirmed** | Long-term roadmap completeness | Must remain in architecture/roadmap; not implemented now |

## 2. Provisional / pending validation

| Item | Why provisional | What must be verified |
|---|---|---|
| Vela charting | Candidate selected, not proven in-product | React/provider API, features (indicators/drawings/multi-chart/workspace persistence), performance/memory, licensing/attribution, Bun/Vite compatibility |
| Upstox/FYERS SDK usage on Bun | Official APIs required; SDK runtime fit unknown | Official package names, Bun compatibility, protocol/schema details, limits/entitlements, auth/session behavior |
| Secure Windows credential storage | Required, mechanism not chosen | Appropriate Windows mechanism, encryption/key management, backup/restore of key material |
| MCP 2026-07-28 transport/event details | Spec evolved; implementation details matter | Exact Streamable HTTP/SSE subscription semantics, multi-client behavior, SDK APIs, legacy compatibility needs |
| Non-broker market-wide sources | Availability/terms vary | Official/usable sources for VIX, breadth, sectors, FII/DII, participant OI, reports/bhavcopies, calendars/status |

## 3. Superseded / avoided decisions

- **No fixed Upstox-first or FYERS-first priority** (superseded by capability/freshness/reliability/limits-based selection).
- **No permanent hardcoding** of changing exchange contracts/expiries/strikes/lot sizes/quantity freezes.
- **No microservices/external infra by default** (PostgreSQL/Redis/cloud) without demonstrated requirement.
- **No database-only backup** presented as full recovery when credential key material/state is required.
- **No legacy Upstox feed assumptions**; use current V3/official docs (verify). 
