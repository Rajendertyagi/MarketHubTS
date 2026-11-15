# MCP Interface

> **Status:** Target capability and transport design (confirmed requirements + established direction). Current implementation is a minimal STDIO health tool only. Items marked **(verify)** require official MCP spec/SDK verification.
> **Last updated:** 2026-11-15
> **Related:** [ARCHITECTURE.md](ARCHITECTURE.md), [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [WEBUI_AND_CONFIGURATION.md](WEBUI_AND_CONFIGURATION.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md), [REFERENCES.md](REFERENCES.md)

## 1. Role and principles

- **MCP is a primary MarketHub interface**, not an optional extra.
- MCP exposes capabilities backed by **shared application services** and the **canonical data/catalog foundation**.
- **No independent market-data interpretation or duplicate business logic in MCP.**
- Multiple MCP clients may connect simultaneously, share the same canonical data/services, and must be isolated (one client’s subscriptions/disconnection must not corrupt another’s operation).

## 2. Current implementation (verified scaffold)

| Item | Status |
|---|---|
| App | `apps/mcp-server` |
| SDK | `@modelcontextprotocol/server` 2.4.0 (v2), Zod 4 |
| Transport | STDIO via `serveStdio` from `@modelcontextprotocol/server/stdio` |
| Tools | `markethub_health` (no inputs): fetches `${MARKETHUB_API_URL:-http://localhost:3001}/health`, validates against shared contract, returns result |
| Behavior | Reuses local API (no duplicate logic); stdout reserved for protocol; diagnostics to stderr |

**Not implemented:** Streamable HTTP, SSE event/subscription delivery, market data tools, watchlists/alerts/scanners tools, resources/prompts, multi-client HTTP serving, auth beyond local deployment model.

## 3. Transport requirements (target, verify)

| Transport | Requirement | Notes |
|---|---|---|
| Streamable HTTP | **Primary network transport** | For LAN/network access; **(verify)** exact 2026-07-28 semantics, headers, session/stateless behavior, multi-client operation |
| SSE-based event/subscription delivery | **Required under current MCP spec** | For notifications/subscriptions/events as defined by current spec; **(verify)** mechanism (e.g. spec revisions evolved around subscriptions/streaming) |
| Legacy HTTP+SSE | **Assess only if needed for existing client compatibility** | Do not confuse SSE notifications within Streamable HTTP with deprecated legacy HTTP+SSE transport; **(verify)** deprecation/compat status |
| STDIO | **Retain/document** per scaffold and compatibility requirements | Useful for local hosts/process-spawned clients |

**Verification required:** current official MCP specification (including 2026-07-28 revision where supported) and TypeScript SDK APIs/transport support before implementation claims.

## 4. AI market-data capabilities (target)

Expose comprehensive market data via shared services (all subject to availability/freshness/provider support):

- Instrument discovery and search (canonical catalog).
- Major indices.
- Live quotes and depth.
- Historical candles.
- Option chains.
- Futures data.
- OI, IV, and provider-supplied Greeks (only if provided; never fabricated).
- Market-wide information and exchange reports (VIX, breadth, sectors, FII/DII, participant-wise derivatives OI, reports/bhavcopies, calendars/status — per availability).
- Provider/source availability and freshness/provenance.
- One-time on-demand data retrieval.
- Watchlists (read/manage within permitted actions).
- Alerts (create/edit/run/delete, history/results, subscribe to applicable events — within rules).
- Scanners (create/edit/run/delete, history/results — within rules).
- Triggered events and notifications.

**Design rule:** new provider fields must not require consumers to change workflows or require a new MCP tool for every individual field (use extensible, attributed data structures).

## 5. On-demand requests (confirmed behavior)

- AI may request data for instruments not currently included in configured streaming or synchronization selections.
- MarketHub may fetch requested data from connected providers.
- **Must not silently modify operational settings** (streaming selections, historical sync settings, option-chain capture settings, etc.).
- Successfully retrieved historical candles may be cached (per caching/retention rules).
- Option-chain snapshot persistence remains governed by **WebUI capture configuration**.

## 6. AI workflow management (permitted)

AI through MCP may:
- Create, edit, run, and delete **alerts**.
- Create, edit, run, and delete **scanners**.
- Create, edit, organize, and delete **watchlists**.
- Retrieve alert and scanner history/results.
- Subscribe to applicable alert events.

**Condition model:** alerts/scanners can use canonical fields and provider-specific fields; support configurable conditions/combinations such as AND/OR, thresholds, crossings, and other supported data comparisons. **Do not invent unsupported fields or operators.**

## 7. Operational configuration boundary (AI must NOT modify)

- Broker credentials or configuration.
- Provider connection configuration.
- Streaming selections.
- Historical synchronization settings.
- Option-chain capture settings.
- Data retention.
- Provider selection preferences.
- Application startup/network configuration.

All operational configuration belongs in WebUI.

## 8. Alerts, scanners, and delivery integration

- **Alerts requiring non-streamed instruments:** save alert, mark **waiting for streaming**, explain missing configuration, **do not auto-subscribe**, activate after user enables instrument via WebUI. AI must never bypass.
- **Scanners:** may be manual/scheduled/continuous (configured via WebUI operational controls); AI may manage definitions and request executions but must not silently subscribe to additional instruments; results must identify stale/unavailable/not-streamed limitations.
- **Alert delivery (configurable, WebUI-owned):** WebUI notifications and history, desktop notifications, MCP event delivery, webhooks.

## 9. Resources and prompts (target)

- Add MCP **resources** and **prompts** where genuinely useful (e.g. catalog summaries, provider/status snapshots, report access, guided workflows) — **planned**, based on shared services.
- Must follow same permission/boundary rules and avoid exposing credentials/sensitive tokens.

## 10. Security, validation, and reliability

- Validate every input; enforce schema/permission checks.
- Never expose credentials or access tokens via MCP tools/resources/events.
- Graceful shutdown; client isolation; bounded resource usage.
- LAN HTTP exposure without app-level user login is a confirmed deployment model; protect sensitive operations/data appropriately and document risks (see [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)).

## 11. Parity requirement

MCP, REST/SSE, and WebUI must present consistent canonical instrument and data state (same shared services/foundation). Acceptance tests must verify parity (see [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md)).
