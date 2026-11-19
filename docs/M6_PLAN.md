# M6 — MCP Market-Data and Event Interface Plan

> **Status:** Research complete; execution-ready plan awaiting separate implementation authorization. No M6 source, transport, dependency or MCP market tool has been implemented. This document is a plan only.
> **Last updated:** 2026-11-19
> **Related:** [MCP_INTERFACE.md](MCP_INTERFACE.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) (M6), [PROJECT_STATUS.md](PROJECT_STATUS.md), [STAGE_5_PLAN.md](STAGE_5_PLAN.md) §15, [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [REFERENCES.md](REFERENCES.md) §8

## 1. Objective and scope

Give AI clients first-class MCP access to the **existing canonical market-data foundation** with correct 2026-07-28 transport behavior, read-only market capabilities, supported subscription/event delivery, multi-client isolation and strict permission boundaries. MCP, REST/SSE and WebUI must remain consumers of one shared service layer — no duplicate market-data interpretation.

**In scope:** transport/server lifecycle (Streamable HTTP on the existing Hono app + STDIO compatibility), read-only tools/resources/prompts over shared services, `subscriptions/listen` event delivery with read-after-notify, multi-client behavior, parity/security/conformance acceptance.

**Out of scope:** M6 source implementation (this is a plan), provider activation (M5 Phase 4B / Stage G), live provider auth/network/sockets, watchlist/alert/scanner workflow services (M7), new dependencies, new database migrations, production-driver unlock, MCP mutation of operational configuration.

**M6 must work while M5 Phase 4B remains gated.** It operates on cached/stored data and honest empty/unavailable states; it is not a reason to connect providers.

## 2. Verified current MCP implementation and repository baseline

| Item | Verified fact (from code/manifests/lockfile, 2026-11-19) |
|---|---|
| App | `apps/mcp-server`, single source file `src/index.ts` |
| Declared dependency | `@modelcontextprotocol/server` **2.4.0** in `apps/mcp-server/package.json`; `zod` 4.6.7; `@markethub/contracts` workspace |
| **Installed version** | **2.4.0 confirmed** — `bun.lock` resolves `@modelcontextprotocol/server@2.4.0` and `@modelcontextprotocol/core@2.4.0`; installed package at `node_modules/.bun/@modelcontextprotocol+server@2.4.0/.../server/package.json` reports `2.4.0`. Not assumed from the manifest alone. |
| Current transport | `serveStdio(() => new McpServer(...))` from `@modelcontextprotocol/server/stdio` |
| Current tool | `markethub_health` (no inputs): fetches `${MARKETHUB_API_URL}/health`, validates with `healthStatusSchema`, returns text + structured content; stdout reserved for protocol, diagnostics to stderr |
| HTTP app | Hono + Bun in `apps/api`; `createApp(deps)` registers provider, M5 historical/snapshot and market routes; M5 services composed with **empty provider collections** (`apps/api/src/app.ts`) |
| Shared services available | `MarketDataService`, `LiveEventHub` (`packages/realtime`), `HistoricalCandleService`, `OptionChainSnapshotService`, `CatalogSyncService`, repositories, `ProviderRegistry` (`packages/market-core`, `packages/database`) |
| Shared contracts available | `liveSnapshotSchema`/`LiveSnapshot`, `providerStatusMapSchema`, `subscriptionStateViewSchema`, historical/snapshot schemas, `market-dates` IST helpers (`packages/contracts`) |
| Existing boundary | `isLocalPeer` guards mutating HTTP routes; WebUI owns operational config; no app-level login |
| Not present | No MCP HTTP transport, no market tools/resources/prompts, no event bus wiring, no `@modelcontextprotocol/node` dependency, no `tests/mcp/` suite |

## 3. Official protocol/SDK research findings (source URLs)

Access date **2026-11-19** for all sources below.

| Source | URL | Facts established |
|---|---|---|
| MCP 2026-07-28 specification | https://modelcontextprotocol.io/specification/2026-07-28 | Authoritative revision; stateless self-contained requests, per-request capability negotiation, `server/discover` optional, JSON-RPC 2.0, resources/tools/prompts, extensions opt-in, security principles (user consent, data privacy, tool safety) |
| Official spec announcement | https://blog.modelcontextprotocol.io/posts/2026-07-28/ | No handshake/session (`initialize`/`Mcp-Session-Id` retired); header routing (`Mcp-Method`, `Mcp-Name`); MRTR replaces server→client requests; cacheable list results (`ttlMs`, `cacheScope`); auth hardening; Tasks extension; Roots/Sampling/Logging and legacy HTTP+SSE deprecated with 12-month window; Tier-1 SDKs support the revision |
| TypeScript SDK support guide | https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md | **Nothing in v2 puts 2026-07-28 on the wire by default** — explicit opt-in required. `createMcpHandler` serves 2026-07-28 per request (default `legacy: 'stateless'` also serves 2025; `legacy: 'reject'` modern-only). `serveStdio(factory)` is connection-pinned and serves 2026-07-28 or both eras. `subscriptions/listen` is the only channel for list_changed/resources/updated; `.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}`; `ServerEventBus`/`InMemoryServerEventBus`; `resources/subscribe` is 2025-only (use `resourceSubscriptions` listen filter). Cancellation closes the request SSE stream. `requestState` replaces session state (opaque/untrusted; seal with `createRequestStateCodec`). Origin/Host validation must be added in front of the handler. |
| TypeScript SDK releases | https://github.com/modelcontextprotocol/typescript-sdk/releases | 2.4.0 is the latest release (23 Oct); `@modelcontextprotocol/server@2.4.0`, `core@2.4.0`, `node@2.1.2`; 2.4.0 notes include `ServerEvent` optional params for listen-router forwarding, `createMcpHandler` `Allow: POST` on 405, modern-revision binding fix for per-request transports |
| Installed SDK source (local) | `node_modules/.bun/@modelcontextprotocol+server@2.4.0/.../dist/` | `FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28"`, `MODERN_WIRE_REVISION = "2026-07-28"`; core `LATEST_PROTOCOL_VERSION = "2025-11-25"`, `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"`, `SUPPORTED_PROTOCOL_VERSIONS = [2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07]`; `SUPPORTED_MODERN_PROTOCOL_VERSIONS = ["2026-07-28"]`. Exports include `createMcpHandler`, `McpServer`, `InMemoryServerEventBus`, `ServerEventBus`, `ServerNotifier`, `WebStandardStreamableHTTPServerTransport`, `PerRequestHTTPServerTransport`, `SubscriptionFilter`, `resourceUpdated` notifier, `hostHeaderValidationResponse`/`originValidationResponse`, `createRequestStateCodec`. |

### Confirmed behavior vs assumptions rejected

- **Rejected:** "installing SDK v2 automatically enables 2026-07-28." The support guide states the opposite; a hand-built `McpServer` keeps speaking 2025-era. Opt-in via `createMcpHandler` (HTTP) or `serveStdio` (stdio) is required.
- **Rejected:** "the installed version might be 2.4.0 by assumption." Confirmed from lockfile and installed package metadata.
- **Rejected:** "core's `LATEST_PROTOCOL_VERSION` being 2025-11-25 means 2026-07-28 is unsupported." The server package defines a separate modern revision constant (`2026-07-28`) and the handler serves it; the core constant is the legacy-era latest.
- **Rejected:** "server may push unrequested notifications." In 2026-07-28, list_changed/resources/updated are delivered only on a client-opened `subscriptions/listen` stream.
- **Rejected:** "MCP subscriptions are the app's REST/SSE live transport." They are distinct: MCP listen streams carry protocol notifications; clients then read data from resources/tools. The app's `/api/market/stream` SSE is unrelated.
- **Rejected:** "invent a standard MCP alert-trigger notification." Use supported notifications + durable records + read-after-notify (consistent with `MCP_INTERFACE.md` §8.1).

## 4. Transport architecture and recommended integration

**Recommendation: keep the modular monolith.** Mount MCP HTTP on the existing Hono app; no separate service/process, no new runtime dependency.

- **HTTP (primary LAN transport):** in `apps/api`, register a single route (e.g. `POST/GET/DELETE /mcp`) that delegates to `createMcpHandler(createMcpServer).fetch(c.req.raw)`. The handler is web-standard and explicitly supports Hono's `c.req.raw`. It serves 2026-07-28 per request; default `legacy: 'stateless'` keeps 2025-era clients working through the same factory. Choose `legacy: 'reject'` only if a strict modern-only endpoint is required — default to dual-era for compatibility.
- **Validation in front:** the SDK entry is deliberately validation-free. Add `hostHeaderValidationResponse`/`originValidationResponse` (with `localhostAllowedHostnames`/`localhostAllowedOrigins`) before `handler.fetch`, and respect the existing `isLocalPeer`/LAN policy for sensitive operations.
- **STDIO (retain):** keep `serveStdio(() => createMcpServer())`. It is already the correct connection-pinned entry capable of 2026-07-28; no change is needed merely to preserve compatibility. Era selection depends on the client's opening exchange. Do not switch to a hand-built `server.connect(new StdioServerTransport())`, which would be 2025-era only.
- **One factory, both transports:** `createMcpServer()` registers the same tools/resources/prompts for HTTP and STDIO so the eras cannot drift.
- **Lifecycle:** call `handler.close()` on API shutdown to abort in-flight modern exchanges and close per-request instances; STDIO handle cleanup on process exit. Bounded resources: `maxSubscriptions` (SDK default 1024), `keepAliveMs` (default 15000), `maxRequestBodySize` (default 4 MiB) — configure explicitly rather than relying on defaults where operationally relevant.
- **Multi-client/stateless:** 2026-07-28 has no `Mcp-Session-Id`; each request is self-describing. Client-specific state belongs in `requestState` (sealed) or in the client's own listen stream — never in a global mutable map. No Redis/broker needed for a single-process monolith; `InMemoryServerEventBus` is sufficient.

## 5. Tool, resource and prompt inventory

Group related capabilities; do not create one tool per field. All read-only over shared services; all report availability/freshness/provenance honestly.

**Tools (read-only + on-demand retrieval):**
- `markethub_health` — retain (existing).
- `catalog_search` — canonical instrument discovery/search over catalog repositories (canonical IDs only; provider-native IDs stay internal).
- `provider_status` — composed auth/runtime/capability status from `ProviderRegistry` + live service; restrictions and `UNVERIFIED` capabilities surfaced, never fabricated.
- `market_snapshot` — canonical live snapshot from `MarketDataService` (quotes/depth via agreed canonical fields; no `value.native`).
- `historical_candles` — cached candles + derived coverage/gaps from `HistoricalCandleService`; on-demand fetch only via the service's explicit request (never mutates sync config).
- `option_chain_snapshot` — stored snapshots from `OptionChainSnapshotService`; on-demand capture returns data without changing capture config.
- `futures_chain` / `market_information` — only where a shared service exists; otherwise report unavailable (do not fabricate).
- `on_demand_retrieval` — grouped request for data not currently selected; success may cache candles per existing rules; never changes operational config.

**Resources (discoverable, cursor-based):**
- `markethub://catalog/instruments` (filterable), `markethub://market/snapshot`, `markethub://historical/{canonicalId}/{interval}` with `from`/`to`, `markethub://snapshots/{configId?}` with cursor, `markethub://events/live` and `markethub://events/alerts` (feeds with stable event IDs/cursors). Resource URIs are implementation details to finalize against shared contracts; keep them stable and documented.

**Prompts (guided workflows, no hidden actions):**
- `explain_market_snapshot`, `interpret_coverage_gaps`, `how_to_capture_snapshot` — read-only guidance that calls the tools above; no operational changes.

**Boundary with M7:** M6 provides the **event-delivery foundation** (listen streams, supported notifications, discoverable feeds with cursors, read-after-notify) and read-only data access. Alert/scanner/watchlist definition, evaluation, trigger history and delivery-channel management are **M7** services; M6 does not implement them or invent alert-trigger notification types.

## 6. Subscription and event-delivery design

- Use `subscriptions/listen` exactly as documented: the client opens a stream with a `SubscriptionFilter`; the server never sends unrequested notifications.
- Supported notifications only: `notifications/tools/list_changed`, `notifications/prompts/list_changed`, `notifications/resources/list_changed`, `notifications/resources/updated`. Publish through `handler.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}` backed by `InMemoryServerEventBus` (single process). No custom standard notification types.
- For resource URI subscriptions on 2026 connections, clients use the `resourceSubscriptions` field of the listen filter; `resources/subscribe` is 2025-only and must not be relied on for modern clients.
- **Read-after-notify:** a notification signals "something changed"; the client then reads the relevant resource/feed (by cursor) to retrieve data. This matches `MCP_INTERFACE.md` §8.1 and avoids putting market payloads in notifications.
- **Event feeds:** expose live events (from `LiveEventHub`) and any future alert events as discoverable resources with monotonic cursors/event IDs, enabling gap/duplicate detection and reconnect catch-up. Durable alert records are an M7 dependency; M6 defines the feed contract only.
- **Graceful close:** on `handler.close()`/shutdown the listen stream receives the empty result before closing (`McpSubscription.closed` resolves `graceful`); an abrupt close resolves `remote` and clients re-listen. Reconnect = re-open listen + fetch from last cursor.
- **Cancellation:** on 2026 Streamable HTTP, client abort closes the request SSE stream; no `notifications/cancelled` POST. Honor `AbortSignal` in tool handlers and bound all work.

## 7. Multi-client and lifecycle behavior

- Stateless per-request handling means multiple clients share the same factory and services without session coupling; no cross-client mutable state.
- Each client owns its listen stream, filter and cursor; one client's disconnect/lag must not affect others. `maxSubscriptions` bounds concurrent listen streams.
- `requestState` (if used for multi-round flows) is opaque and untrusted: seal with `createRequestStateCodec({ key, ttlSeconds, bind })` and verify via `ServerOptions.requestState.verify`; never store secrets or operational config in it.
- Startup is offline-safe: constructing the MCP server must not make provider calls. Shutdown closes the HTTP handler and STDIO handle, aborts in-flight work and releases listeners.
- Bounded resources: request body size, subscription count, keepalive, tool result sizes and feed page sizes all explicit; no unbounded buffers.

## 8. Permission and security boundaries

- **MCP must not modify:** broker credentials/config, provider connections, streaming selections, historical sync config, snapshot capture config, retention, provider preferences, startup/network settings. All M6 tools are read-only or on-demand retrieval through services that already enforce config immutability.
- Reuse `isLocalPeer` and the WebUI-owned config boundary; do not add an app-level login system. LAN exposure without login is a confirmed deployment model — document risks and validate Host/Origin headers in front of the HTTP handler.
- Validate every MCP input with shared Zod contracts; use tool annotations honestly; treat tool descriptions as untrusted per the spec's security guidance.
- Never expose tokens/credentials in tools, resources, events, errors or logs; reuse `sanitizeError`. Provider-native identifiers stay internal.
- Multiple simultaneous clients are expected; isolate subscriptions and cursors per client. No automatic operational changes by AI.

## 9. Existing services and contracts to reuse

| Need | Reuse (verified module) |
|---|---|
| Live quotes/depth/snapshot | `MarketDataService.getSnapshot()`, `liveSnapshotSchema` (`packages/market-core`, `packages/contracts`) |
| Live event feed/cursor | `LiveEventHub.openStream()`, `parseCursor`, `OutboundEvent` (`packages/realtime`) |
| Historical candles/coverage | `HistoricalCandleService.getCached/getCoverageStatus/fetchOnDemand` (`packages/market-core`) |
| Option-chain snapshots | `OptionChainSnapshotService.listSnapshots/captureOnDemand` (`packages/market-core`) |
| Catalog discovery | `SqliteCatalogRepository` + `CatalogSyncService` (`packages/database`, `packages/market-core`) |
| Provider status/capabilities | `ProviderRegistry.getStatuses()`, `providerStatusMapSchema`, live connection status composition (`apps/api/src/provider-routes.ts`) |
| Subscriptions view | `subscriptionStateViewSchema` (`packages/contracts`) |
| Dates/intervals | `market-dates` IST helpers, `candleIntervalSchema`, `intervalClass` (`packages/contracts`) |
| HTTP app/lifecycle | `createApp(deps)`, `isLocalPeer`, logger (`apps/api`) |

No new service layer: MCP is a thin adapter over these.

## 10. Implementation phases and dependencies

- **M6-A — Transport and server lifecycle.** Add `createMcpServer()` factory; mount `createMcpHandler` on Hono `/mcp` with Host/Origin validation; retain `serveStdio(factory)`; wire `handler.close()` into shutdown; explicit opt-in/era tests. Depends on: existing app lifecycle. No provider dependency.
- **M6-B — Read-only tools and resources.** Implement the tool/resource/prompt inventory over shared services; on-demand retrieval with config immutability; honest unavailable states. Depends on: M6-A, M2/M4/M5 services (already present).
- **M6-C — Subscription/listen and event delivery.** Wire `ServerEventBus`/`notify`, listen filters, resource URIs, cursor-based feeds, read-after-notify, graceful close/reconnect. Depends on: M6-B, `LiveEventHub`; alert feeds are contract-only until M7.
- **M6-D — Parity, multi-client, security and conformance acceptance.** Cross-interface parity, multi-client isolation, permission-boundary tests, 2026/2025-era conformance, bounded-resource and shutdown tests. Depends on: M6-A–C.

Ordering may be adjusted if SDK behavior or repository architecture proves a dependency wrong; record the reason before changing it.

## 11. Deterministic test allocation

New `tests/mcp/` suite (mirrors source areas; no live network):
- `transport.test.ts` — `createMcpHandler` via `handler.fetch` in-process (StreamableHTTPClientTransport with a fake URL), era opt-in, 2025 stateless fallback, Host/Origin rejection, `close()` behavior, STDIO factory shape.
- `tools.test.ts` — each read-only tool over fake/shared services; input validation; honest unavailable/empty states; on-demand config immutability.
- `resources.test.ts` — resource URIs, cursor pagination, provenance/freshness fields, read-after-notify payloads.
- `subscriptions.test.ts` — listen filter, supported notifications only, `resourceUpdated(uri)`, graceful vs remote close, reconnect from cursor, multi-client isolation, `maxSubscriptions` bound.
- `parity.test.ts` — MCP vs REST/SSE vs WebUI canonical state from the same services.
- `security.test.ts` — no operational config mutation, no credential leakage, `isLocalPeer`/LAN boundary, bounded inputs, cancellation/timeout.

All tests use fakes/mocked fetch/temp DBs; no live provider, socket or network.

## 12. Acceptance criteria

- 2026-07-28 is explicitly opted in via `createMcpHandler`/`serveStdio`; default behavior and 2025 compatibility are tested, not assumed.
- One factory backs HTTP and STDIO; no duplicate market logic; MCP consumes shared services only.
- Tool/resource inventory is grouped, discoverable, read-only, and reports availability/freshness/provenance honestly; no fabricated fields.
- On-demand retrieval never mutates operational config; permission boundary tests pass.
- `subscriptions/listen` delivers only supported notifications; clients read data from resources/feeds; no custom standard notification types; graceful close/reconnect and multi-client isolation pass.
- Parity with REST/SSE/WebUI over the same canonical state; bounded resources and clean shutdown verified.
- Focused + full suite, typecheck, build, `git diff --check` pass locally; independent diff review before any merge. Results reported as local, not CI.

## 13. Risks, unresolved questions and explicit gates

- **Stage G gate:** M6 must not activate providers; live data availability remains unestablished. MCP surfaces honest empty/unavailable states until Phase 4B is separately authorized.
- **M7 dependency:** durable alert-trigger records/feeds are M7; M6 defines the event-delivery contract but cannot deliver real alert history until M7 exists.
- **SDK/spec evolution:** 2026-07-28 deprecates Roots/Sampling/Logging and legacy HTTP+SSE (12-month window); avoid building on deprecated surfaces. Re-verify against current docs before implementation.
- **Unresolved:** exact resource URI shapes and cursor encoding; whether to offer `legacy: 'reject'` for a strict endpoint (default to dual-era); Host/Origin allow-list policy for LAN clients; `requestState` key management if multi-round flows are added; conformance-test tooling selection. These are implementation-time decisions grounded in the cited official docs, not product-scope questions.
- **No new dependencies** without separate justification; `@modelcontextprotocol/node` is only needed for Node framework adapters, not for Hono/Bun web-standard mounting.

## 14. Non-goals

- M6 source implementation, transport code or dependency upgrades (this document is a plan).
- Provider activation, live auth/network/sockets, Stage G verification, production-driver unlock.
- Watchlist/alert/scanner workflow services (M7) or MCP mutation of operational config.
- New database migrations, microservices, Redis/brokers, or a second frontend/API architecture.
- Inventing standard MCP notification types or duplicating market-data calculations in MCP.
