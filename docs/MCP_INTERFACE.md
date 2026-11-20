# MCP Interface

> **Status:** Confirmed requirements + established direction. Current implementation includes M6-A (Streamable HTTP at `/mcp` + retained STDIO, shared factory), M6-B1 (catalog-search and event-feed read seams with runtime-scoped cursors) and M6-B2 (nine tools over both transports). Resources/prompts and snapshot pagination (B3) are implemented and published on `develop` at `0d58bbb`; activity history (M6-C) is implemented and published at `fbca177`; subscriptions/notifications (M6-D) remain pending. Official MCP 2026-07-28 / SDK 2.4.0 research is complete (2026-11-19) and recorded below and in [REFERENCES.md](REFERENCES.md) §8; the governing plan is [M6_PLAN.md](M6_PLAN.md). Items still marked **(verify)** are implementation-time details, not unresolved product scope.
> **Last updated:** 2026-11-20 (current-state reconciliation; no behavior change)
> **Related:** [ARCHITECTURE.md](ARCHITECTURE.md), [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [WEBUI_AND_CONFIGURATION.md](WEBUI_AND_CONFIGURATION.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md), [REFERENCES.md](REFERENCES.md), [M6_PLAN.md](M6_PLAN.md)

## 1. Role and principles

- **MCP is a primary MarketHub interface**, not an optional extra.
- MCP exposes capabilities backed by **shared application services** and the **canonical data/catalog foundation**.
- **No independent market-data interpretation or duplicate business logic in MCP.**
- Multiple MCP clients may connect simultaneously, share the same canonical data/services, and must be isolated (one client’s subscriptions/disconnection must not corrupt another’s operation).

## 2. Current implementation (verified)

| Item | Status |
|---|---|
| Apps | `apps/api` (HTTP `/mcp`) and `apps/mcp-server` (STDIO); shared registration in `packages/mcp-core` |
| SDK | `@modelcontextprotocol/server` **2.4.0 (v2), Zod 4** — version confirmed 2026-11-19 from `bun.lock` and the installed package metadata, not assumed from the manifest |
| Transports | Streamable HTTP at `/mcp` on the existing Hono app (SDK `createMcpHandler`, Host/Origin validation, registered before SPA fallback) + retained STDIO via `serveStdio` |
| Tools (M6-B2) | Nine tools through one shared factory: `markethub_health`, `catalog_search`, `provider_status`, `market_snapshot`, `historical_candles`, `option_chain_snapshot`, `on_demand_retrieval`, `futures_chain`, `market_information` |
| Seams (M6-B1) | Bounded catalog search and event-feed read with runtime-scoped cursors and always-present `resumeCursor`; HTTP endpoints `GET /api/catalog/search` and `GET /api/market/events` |
| Behavior | HTTP uses injected services directly; STDIO is a thin local-API client; one canonical service foundation, no duplicate market logic; stdout reserved for protocol on STDIO |

**Not implemented yet:** `subscriptions/listen`/SSE notifications and event bridge (M6-D), broad conformance/parity and LAN acceptance (M6-E), watchlists/alerts/scanners tools (M7), auth beyond local deployment model. Resources/prompts/cache hints (M6-B3) and activity history/WebUI inspection (M6-C) are implemented and published on `develop`. **Streamable HTTP is a mandatory M6 deliverable (M6-A/M6-D/M6-E), not optional or deferrable** — see §3 and [M6_PLAN.md](M6_PLAN.md) §1/§10/§12.

## 3. Transport requirements (confirmed requirements + verified protocol behavior)

| Transport | Requirement | Verified behavior (official docs / installed SDK, 2026-11-19) |
|---|---|---|
| Streamable HTTP | **Primary network transport** for LAN access; **mandatory M6 deliverable — must be fully implemented and working at `/mcp` over localhost and the configured LAN interface, subject to Host/Origin security. Not optional, not deferrable; M6 cannot be declared complete without it.** | 2026-07-28 is **stateless per request** (no `initialize`/`Mcp-Session-Id`); `createMcpHandler(factory)` serves it from a web-standard `{fetch, close, notify, bus}` handler, mountable on Hono via `c.req.raw`. Default `legacy: 'stateless'` also serves 2025-era traffic from the same factory; `legacy: 'reject'` is modern-only. Host/Origin validation must be added in front of the handler. Implemented in M6-A; accepted by real-HTTP integration in M6-E. |
| SSE-based event/subscription delivery | **Required under current MCP spec** | In 2026-07-28, list_changed/resources/updated are delivered **only** on a client-opened `subscriptions/listen` stream; the server never sends unrequested notifications. Listen streams are SSE; clients then read data from resources/tools (read-after-notify). `resources/subscribe` is 2025-only; use the `resourceSubscriptions` listen filter on modern connections. |
| Legacy HTTP+SSE | **Deprecated** (12-month offramp per spec announcement); **M6 must not implement it** | Do not confuse SSE notifications within Streamable HTTP with the deprecated legacy HTTP+SSE transport. No new implementation should adopt it; M6-D delivers SSE notifications **inside** Streamable HTTP only. |
| STDIO | **Retain** per scaffold and compatibility needs | `serveStdio(factory)` is the connection-pinned entry capable of 2026-07-28 (or both eras); the current code already uses it. A hand-built `server.connect(new StdioServerTransport())` would be 2025-era only. |

**M6 acceptance rule:** Streamable HTTP and event delivery are completion gates. Unit/in-process tests using `handler.fetch` are required but **never sufficient**; M6-E requires a real Streamable HTTP MCP client connected to the running Hono/Bun server over an actual HTTP listener (localhost and the configured LAN interface), plus a documented second-device LAN verification procedure. See [M6_PLAN.md](M6_PLAN.md) §10–§12. STDIO compatibility is retained but is not a substitute for the HTTP transport.

**Verified protocol/SDK facts** (see [M6_PLAN.md](M6_PLAN.md) §3 and [REFERENCES.md](REFERENCES.md) §8): installing SDK v2 does **not** enable 2026-07-28 by default — it is an explicit opt-in via `createMcpHandler`/`serveStdio`. The installed 2.4.0 exports `createMcpHandler`, `InMemoryServerEventBus`, `ServerEventBus`, `ServerNotifier`, `resourceUpdated(uri)`, `SubscriptionFilter`, `createRequestStateCodec` and Host/Origin validators. 2026-07-28 adds header routing (`Mcp-Method`, `Mcp-Name`, `MCP-Protocol-Version`), cache hints (`ttlMs`, `cacheScope`), MRTR (`inputRequired`), and cancellation by closing the request SSE stream. Roots/Sampling/Logging are deprecated. These are verified facts, not assumptions.

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
- **On-demand option-chain capture persists a snapshot with `configId = null`** and does not read or write saved capture configuration. WebUI capture configuration governs **scheduled/manual capture only**; it does not govern on-demand capture. The resulting snapshot is visible in the WebUI Snapshot panel. This preserves M5 semantics (see [M6_PLAN.md](M6_PLAN.md) §5.2).

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

### 8.1 MCP-compatible alert-event delivery (target design, verify before implementation)

**Confirmed requirement:** alert events must be accessible to AI clients via MCP as a configurable delivery channel, without changing operational-configuration boundaries.

**Technical mechanism (established direction, pending verification):** use durable MarketHub alert-trigger records/history plus discoverable MCP resources/feeds and supported MCP 2026-07-28 notifications. Do **not** invent an arbitrary standard MCP alert-trigger notification type.

| Concern | Design |
|---|---|
| Durable records | Every alert trigger is persisted as a durable MarketHub event/record with stable event ID, sequence/cursor metadata, timestamps, alert identity, trigger payload/summary, and delivery/history state. History remains available even if real-time notification delivery fails. |
| Discoverable resource/feed | Expose alert events/history through discoverable MCP resources (and/or tools) backed by shared services, e.g. an alert-event feed resource and/or per-alert/per-scope resources with cursor/after parameters for retrieval. Exact resource URIs/shapes are implementation details to define against shared contracts. |
| Supported subscription/listen mechanism | Use MCP 2026-07-28 `subscriptions/listen` for supported protocol notifications only (e.g. `notifications/resources/updated` for subscribed/filtered resource updates and/or `resources/list_changed` as applicable). Clients receive a supported update notification, then read the resource/feed to retrieve newly available events (read-after-notify). |
| Event IDs, cursors, sequence | Event records include monotonic sequence/cursor (and stable IDs) so clients can request events after a known cursor, detect gaps/duplicates, and avoid missed events. |
| Reconnect recovery | On reconnect, clients re-open `subscriptions/listen` as needed and fetch from last known cursor/sequence via resource/tool read; durable history enables catch-up independent of notification delivery. |
| Multi-client consumption | Multiple MCP clients consume independently with their own cursors/subscriptions; one client’s disconnect, lag, or cursor position must not affect others (client isolation). |
| Polling/tool fallback | Clients that do not support required subscription/listen capability can poll/read alert-event resources or use ordinary MCP tools to retrieve history/events by cursor/time window. |

**Protocol/SDK evidence (verified 2026-11-19):** MCP 2026-07-28 spec and the official TypeScript SDK support guide confirm `subscriptions/listen` delivers `tools/prompts/resources` `list_changed` and `resources/updated` **only** on client-opened streams; `createMcpHandler` returns `.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}` over an in-process `InMemoryServerEventBus` (custom `ServerEventBus` only for multi-process deployments — not needed for this monolith); `serveStdio` routes the pinned instance's list-changed calls onto active subscriptions; `resources/subscribe` is 2025-only on 2026 connections (use `resourceSubscriptions` in the listen filter). Graceful close sends the empty result before stream close (`McpSubscription.closed` resolves `graceful` vs `remote`). No arbitrary standard alert-trigger notification type should be invented. See [M6_PLAN.md](M6_PLAN.md) §6 and [REFERENCES.md](REFERENCES.md) §8.

## 9. Resources and prompts (target)

- Add MCP **resources** and **prompts** where genuinely useful (e.g. catalog summaries, provider/status snapshots, report access, guided workflows) — **planned**, based on shared services.
- Must follow same permission/boundary rules and avoid exposing credentials/sensitive tokens.

## 10. Security, validation, and reliability

- Validate every input; enforce schema/permission checks.
- Never expose credentials or access tokens via MCP tools/resources/events.
- Graceful shutdown; client isolation; bounded resource usage.
- LAN HTTP exposure without app-level user login is a confirmed deployment model; protect sensitive operations/data appropriately and document risks (see [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)).
- **Traceability (M6 target):** important MCP operations are recorded in a small durable SQLite activity table with correlation IDs, sanitized outcomes and safe summaries; the WebUI is the main inspection surface. Data persistence and notification delivery are separate outcomes. See [M6_PLAN.md](M6_PLAN.md) §9.1–§9.2.

## 11. Parity requirement

MCP, REST/SSE, and WebUI must present consistent canonical instrument and data state (same shared services/foundation). Acceptance tests must verify parity (see [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md)).

## 12. Status separation (research reconciliation, 2026-11-19)

**Confirmed requirements (product/owner):** MCP is a primary interface; one canonical service foundation; multiple isolated clients; no AI mutation of operational config; LAN HTTP without app-level login; parity with REST/SSE/WebUI; no fabricated market data. These are unchanged by the research.

**Verified protocol/SDK behavior (official sources, not assumptions):** the latest **stable** specification is `2026-07-28` and the latest stable TypeScript SDK is `2.4.0` (verified 2026-11-19; re-verify at implementation start and retarget if newer stable versions exist). 2026-07-28 is stateless per request and explicit opt-in; `createMcpHandler` (HTTP) and `serveStdio` (STDIO) are the opt-in entries; **servers MUST implement `server/discover`**; version mismatches return `-32022`; standard headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) are required and header–body mismatch returns `-32020`; all results carry `resultType`; cache hints (`ttlMs`/`cacheScope`) are required on six cacheable operations; `subscriptions/listen` is the only notification channel with ack-first and `subscriptionId`; `resources/subscribe` is 2025-only; MRTR replaces server-initiated requests; Host/Origin validation is the application's responsibility; legacy HTTP+SSE, Roots, Sampling, Logging and Dynamic Client Registration are deprecated. Installed SDK is 2.4.0 (lockfile + package metadata). **The full mandatory server-side conformance matrix (C1–C21), optional-extension evaluation and modern-vs-legacy policy are in [M6_PLAN.md](M6_PLAN.md) §3.1–§3.3.** See also [REFERENCES.md](REFERENCES.md) §8.

**Implementation decisions (recommended, not yet implemented):** mount `createMcpHandler` on the existing Hono app at `/mcp` with `handler.fetch(c.req.raw)`; one `createMcpServer(ctx, services)` factory with an `McpServices` seam (HTTP direct services, STDIO local-API client); default `legacy: 'stateless'` for dual-era compatibility; `InMemoryServerEventBus` (single process); read-after-notify with cursor-based resources; one small additive `mcp_activity` table for durable traceability with WebUI inspection; no new third-party dependencies. Full rationale in [M6_PLAN.md](M6_PLAN.md) §4–§9.2.

**Optional extensions (M6 decisions):** Tasks and Skills over MCP are **deferred**; MCP Apps and authorization extensions are **not needed**; no extension capability is advertised or claimed in M6. See [M6_PLAN.md](M6_PLAN.md) §3.2.

**Completion rule:** M6 is not complete until the latest stable protocol's mandatory requirements are verified, Streamable HTTP works over localhost and the configured LAN interface, and the conformance tests pass. Modern `2026-07-28` support is mandatory; older compatibility is retained only where justified and tested (§3.3). No deprecated feature is used for new functionality.

**Unresolved implementation-time questions (not product scope):** exact resource URI shapes/cursor encoding; whether to offer a strict `legacy: 'reject'` endpoint; LAN Host/Origin allow-list policy; `requestState` key management if multi-round flows are added; conformance-test tooling. Durable alert-event feeds depend on M7. None of these block the plan; they are resolved during authorized implementation against the cited official docs.
