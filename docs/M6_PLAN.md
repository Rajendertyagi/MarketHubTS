# M6 — MCP Market-Data and Event Interface Plan

> **Status:** Research complete; execution-ready plan awaiting separate implementation authorization. No M6 source, transport, dependency or MCP market tool has been implemented. This document is a plan only.
> **Last updated:** 2026-11-19
> **Related:** [MCP_INTERFACE.md](MCP_INTERFACE.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) (M6), [PROJECT_STATUS.md](PROJECT_STATUS.md), [STAGE_5_PLAN.md](STAGE_5_PLAN.md) §15, [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [REFERENCES.md](REFERENCES.md) §8

## 1. Objective and scope

Give AI clients first-class MCP access to the **existing canonical market-data foundation** with correct 2026-07-28 transport behavior, side-effect-free reads plus explicitly annotated on-demand retrieval/capture, supported subscription/event delivery, multi-client isolation and strict permission boundaries. MCP, REST/SSE and WebUI must remain consumers of one shared service layer — no duplicate market-data interpretation.

**In scope:** transport/server lifecycle (Streamable HTTP on the existing Hono app + STDIO compatibility), tools/resources/prompts over shared services (mostly reads; on-demand retrieval/capture annotated per §5.2), `subscriptions/listen` event delivery with read-after-notify, multi-client behavior, parity/security/conformance acceptance.

**Out of scope:** M6 source implementation (this is a plan), provider activation (M5 Phase 4B / Stage G), live provider auth/network/sockets, watchlist/alert/scanner workflow services (M7), new third-party dependencies (the thin shared workspace package in §4.1 reuses the existing SDK version), production-driver unlock, MCP mutation of operational configuration. **Database migrations are out of scope except for one narrow exception:** a single additive SQLite migration for the `mcp_activity` table is permitted within M6-C (§9.1, §13). That exception does not authorize any other schema change; further migrations require separate justification. The activity table remains a design — no migration or schema is created in this documentation task.

**M6 must work while M5 Phase 4B remains gated.** It operates on cached/stored data and honest empty/unavailable states; it is not a reason to connect providers.

## 2. Verified current MCP implementation and repository baseline

| Item | Verified fact (from code/manifests/lockfile, 2026-11-19) |
|---|---|
| App | `apps/mcp-server`, single source file `src/index.ts` |
| Declared dependency | `@modelcontextprotocol/server` **2.4.0** in `apps/mcp-server/package.json`; `zod` 4.6.7; `@markethub/contracts` workspace |
| **Installed version** | **2.4.0 confirmed** — `bun.lock` resolves `@modelcontextprotocol/server@2.4.0` and `@modelcontextprotocol/core@2.4.0`; installed package at `node_modules/.bun/@modelcontextprotocol+server@2.4.0/.../server/package.json` reports `2.4.0`. Not assumed from the manifest alone. |
| Current transport | `serveStdio(() => new McpServer(...))` from `@modelcontextprotocol/server/stdio` |
| Current tool | `markethub_health` (no inputs): fetches `${MARKETHUB_API_URL}/health`, validates with `healthStatusSchema`, returns text + structured content; stdout reserved for protocol, diagnostics to stderr |
| STDIO service path | **Already a thin local-API client** — STDIO does not instantiate a market-data service or open the application DB. M6 generalizes this pattern; it must not create a second application or database state. |
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
| Installed SDK source (local) | `node_modules/.bun/@modelcontextprotocol+server@2.4.0/.../dist/` and `@modelcontextprotocol+core@2.4.0/.../dist/` | **Server** dist (`src-*.mjs`, verified): `FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28"`, `MODERN_WIRE_REVISION = "2026-07-28"`, `SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION]` (i.e. `["2026-07-28"]`). **Core** dist (`internal.d.mts`, `schemas-*.mjs`, verified): `LATEST_PROTOCOL_VERSION = "2025-11-25"`, `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"`, `SUPPORTED_PROTOCOL_VERSIONS = [2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07]`. Note the modern constants are **server**-package, not core; core's constants are the legacy-era set. Available in the installed 2.4.0 dist (exported from `index.d.mts` or defined in server dist modules): `createMcpHandler`, `McpServer`, `InMemoryServerEventBus`, `ServerEventBus`, `ServerNotifier` (with `resourceUpdated(uri)`), `WebStandardStreamableHTTPServerTransport`, `PerRequestHTTPServerTransport` (class in `createMcpHandler-*.d.mts`), `SubscriptionFilter` (type in `mcp-*.d.mts`), `hostHeaderValidationResponse`/`originValidationResponse`, `createRequestStateCodec`. |

### Confirmed behavior vs assumptions rejected

- **Rejected:** "installing SDK v2 automatically enables 2026-07-28." The support guide states the opposite; a hand-built `McpServer` keeps speaking 2025-era. Opt-in via `createMcpHandler` (HTTP) or `serveStdio` (stdio) is required.
- **Rejected:** "the installed version might be 2.4.0 by assumption." Confirmed from lockfile and installed package metadata.
- **Rejected:** "core's `LATEST_PROTOCOL_VERSION` being 2025-11-25 means 2026-07-28 is unsupported." The server package defines a separate modern revision constant (`2026-07-28`) and the handler serves it; the core constant is the legacy-era latest.
- **Rejected:** "server may push unrequested notifications." In 2026-07-28, list_changed/resources/updated are delivered only on a client-opened `subscriptions/listen` stream.
- **Rejected:** "MCP subscriptions are the app's REST/SSE live transport." They are distinct: MCP listen streams carry protocol notifications; clients then read data from resources/tools. The app's `/api/market/stream` SSE is unrelated.
- **Rejected:** "invent a standard MCP alert-trigger notification." Use supported notifications + durable records + read-after-notify (consistent with `MCP_INTERFACE.md` §8.1).

## 4. Transport architecture and recommended integration

**Recommendation: keep the modular monolith.** Mount MCP HTTP on the existing Hono app; no separate service/process, no new third-party runtime dependency (the existing `@modelcontextprotocol/server` 2.4.0 is reused).

### 4.1 Shared factory ownership and workspace boundary (Finding A)

**Problem:** `apps/mcp-server` owns the STDIO entry and declares `@modelcontextprotocol/server` 2.4.0; `apps/api` owns the Hono HTTP app but does not declare the SDK. Both transports must register identical tools/resources/prompts. Neither app may import the other, and registration must not be duplicated.

**Selected ownership:** introduce one thin shared workspace package, **`packages/mcp-core`**, that owns `createMcpServer()` and all tool/resource/prompt registration. Dependency direction is strictly one-way:

```
packages/mcp-core  ->  @markethub/contracts, @markethub/market-core (service types),
                       @modelcontextprotocol/server@2.4.0, zod
apps/mcp-server    ->  packages/mcp-core  (serveStdio((ctx) => createMcpServer(ctx, stdioServices)))
apps/api           ->  packages/mcp-core  (createMcpHandler((ctx) => createMcpServer(ctx, httpServices)))
```

`packages/mcp-core` must not import `apps/api` or `apps/mcp-server`. The SDK dependency is declared in `packages/mcp-core` at the **existing 2.4.0 version**; `apps/mcp-server` retains its existing declaration for `serveStdio` (same version, deduped by Bun workspaces). No version change or new third-party dependency is introduced.

**Why an existing boundary cannot support this:** `packages/contracts` is schema/type-only with no runtime dependencies; `packages/market-core` is the canonical domain/service layer and adding an MCP SDK dependency there would invert the consumer→domain dependency direction; `packages/database` is persistence-only; `packages/shared` is a generic utility package with no service dependencies. Placing `createMcpServer()` in either app and importing it from the other violates the explicit "no app imports another app" constraint. A new thin package is therefore the smallest valid boundary that both apps can depend on without duplication or inversion.

**Factory contract:** `createMcpServer(ctx: McpRequestContext, services: McpServices)` is a pure registration function — it constructs an `McpServer`, registers the tool/resource/prompt set against the supplied `services`, and returns it. It must not create background subscriptions, timers, listeners or process-level event consumers (see §4.2). The SDK calls it once per HTTP request (and once per STDIO connection plus a discarded `server/discover` probe), so any side effect in the factory would be multiplied per request.

#### 4.1.1 Canonical service path for both transports (Finding A)

Both transports must reach the **same canonical capabilities** without duplicating market interpretation or application state. Introduce a small `McpServices` interface — the seam through which shared registration calls application capabilities. It is a thin adapter boundary, not a plugin framework.

```
                    packages/mcp-core
              createMcpServer(ctx, services)
              registerTools/Resources/Prompts(services)
                          |
              +-----------+-----------+
              |                       |
      McpServicesHttp          McpServicesStdio
      (apps/api)               (apps/mcp-server)
      direct injected          thin local-API client
      services/repos           fetch -> existing /api routes
              |                       |
      +-------+-------+               |
      | canonical services            |
      MarketDataService, LiveEventHub,|
      HistoricalCandleService,        |
      OptionChainSnapshotService,     |
      CatalogRepository, ProviderRegistry
      (packages/market-core, database)|
              |                       |
              +-----------+-----------+
                          |
                  one local application instance
                  (single SQLite DB, single canonical state)
```

- **HTTP implementation (`McpServicesHttp`):** lives in `apps/api`, backed by the existing injected services and repositories (`createApp(deps)`). No separate application state; it uses the same instances as REST/SSE/WebUI.
- **STDIO implementation (`McpServicesStdio`):** lives in `apps/mcp-server`, backed by a thin client to the existing local API (`MARKETHUB_API_URL`, default `http://localhost:3001`) — the same pattern the current `markethub_health` tool already uses. It must **not** instantiate a second `MarketDataService`, open the application SQLite DB, or manage provider state. Where the local API does not yet expose a capability, the STDIO tool reports it unavailable rather than reimplementing it locally.
- **Shared registration:** one implementation of tool/resource/prompt registration in `packages/mcp-core`, parameterised by `McpServices`. Both transports register identical capabilities; response shapes use the same canonical contracts. Capabilities are available wherever the underlying API provides them; STDIO honestly reports gaps.
- **Error handling:** both implementations map failures to the same canonical error/availability semantics; STDIO wraps HTTP status/transport errors, HTTP wraps service errors. No credential or raw argument leakage in either path.
- **Offline behavior:** constructing either implementation makes no provider calls. With M5 Phase 4B gated, on-demand tools return honest empty/unavailable results from the shared services.

**Why this interface is justified:** without it, shared registration would either import one app into the other (forbidden) or duplicate the tool set per transport. `McpServices` is the smallest seam that lets one registration implementation serve both transports while keeping dependency direction acyclic. It is not a general-purpose plugin system.

#### 4.1.2 Normative `McpServices` contract (design)

Shared registration calls only the operations below. Each returns canonical contract types where one exists, or a uniform `McpResult<T> = { ok: true; value: T } | { ok: false; error: { category: "validation" | "unavailable" | "provider" | "internal"; message: string } }` with sanitized messages (no credentials/raw arguments). `unavailable` is used for capabilities the local API does not expose or that are gated (e.g. M5 Phase 4B); it is never fabricated into data.

| Operation | Purpose | Canonical basis / reuse |
|---|---|---|
| `getHealth()` | API/database health | `healthStatusSchema` (`packages/contracts`) |
| `getProviderStatus()` | Composed auth/runtime/capability status | `providerStatusMapSchema` + `ProviderRegistry.getStatuses()` |
| `searchCatalog({ text, limit, afterCanonicalId? })` | Bounded instrument discovery (§5.1); returns a bounded page + `nextCursor` aligned with §5.1/§5.3 | `CatalogRepository.searchInstruments` extension; canonical IDs only |
| `getLiveSnapshot()` | Canonical live snapshot | `MarketDataService.getSnapshot()` / `liveSnapshotSchema` |
| `getCachedCandles(req)` / `getCoverage(req)` | Cached reads + derived coverage | `HistoricalCandleService.getCached/getCoverageStatus` |
| `fetchHistorical(req)` | On-demand retrieval (may cache candles) | `HistoricalCandleService.fetchOnDemand` |
| `listSnapshots(filter)` / `getSnapshot(id)` | Stored snapshot reads | `OptionChainSnapshotService.listSnapshots/getSnapshot` |
| `captureSnapshot(req)` | On-demand capture (persists `configId = null`) | `OptionChainSnapshotService.captureOnDemand` |
| `readEventFeed({ after, limit })` | Bounded in-memory replay read (§6.1); returns `{ events, nextCursor, snapshotRequired? }` | `LiveEventHub` bounded history read seam |
| `startActivity(rec)` / `completeActivity(rec)` | Durable activity recording (§9.1.1), best-effort/non-fatal | `McpActivityRepository` via API |

`McpServicesHttp` implements these with direct in-process service/repository calls; `McpServicesStdio` implements them as thin local-API calls. Both use the same result/error shape so shared registration is transport-agnostic. Activity hooks are best-effort: a failure there never changes a data operation's outcome.

#### 4.1.3 STDIO parity surface — capability-to-endpoint matrix (design)

`McpServicesStdio` can only reach capabilities the local API exposes. Verified against `apps/api/src/app.ts` route registration (2026-11-19):

| Capability | Local API today | M6 STDIO plan |
|---|---|---|
| Health | `GET /health` | Available now |
| Provider status | `GET /api/providers/status` | Available now |
| Live snapshot | `GET /api/market/snapshot` | Available now |
| Historical cached/coverage | `GET /api/historical/candles`, `/coverage` | Available now |
| Historical on-demand | `POST /api/historical/fetch` (loopback-guarded) | Available via local loopback; LAN MCP uses direct services (§8.1) |
| Snapshot list/get | `GET /api/snapshots`, `/api/snapshots/:id` | Available now |
| Snapshot on-demand capture | `POST /api/snapshots/capture` (loopback-guarded) | Available via local loopback |
| Activity start/complete | none | **Add** `POST /api/mcp/activity/start` and `/complete` (§9.1.1) |
| Activity list/detail (WebUI) | none | **Add** `GET /api/mcp/activity` (list), `GET /api/mcp/activity/:id` (by record id) and `GET /api/mcp/activity/by-operation/:operationId` (by correlation id) (§9.1.1) |
| Catalog search | none (repository-level only) | **Add** bounded catalog search endpoint (§5.1) if catalog_search is in M6 scope; otherwise report unavailable over STDIO |
| Event feed read | none (SSE stream only) | **Add** bounded feed-read endpoint (§6.1) or report unavailable over STDIO in M6 |
| Futures / market-information | none | Unavailable in M6 (no shared service); report honestly |

Parity acceptance is therefore qualified: **both transports expose the same capabilities where the local API provides them**; capabilities requiring new endpoints are either added in M6 phases or reported unavailable over STDIO, never silently reimplemented locally. The endpoint additions above are part of the M6 design, not existing implementation.

**Per-capability decision rule (normative, for M6-B):** for `catalog_search` and `events/live` feed read, the implementer must record **one** of two outcomes per capability in the acceptance evidence: (a) the HTTP endpoint above is added in M6-B and both transports expose the capability, or (b) the capability is marked `unavailable` over STDIO with the deferral recorded. HTTP direct-service support alone does **not** satisfy STDIO parity. The default is (a) — add the endpoints — unless a documented reason prevents it. This decision is asserted by the parity tests (§11/§12): a capability in state (b) must be tested as `unavailable`, not silently omitted.

**Normative contracts for the two new parity endpoints (design):**
- `GET /api/catalog/search` — query `text` (non-empty), `limit` (default 25, max 100), optional `cursor` (keyset on `canonical_id`); response `{ instruments: CanonicalInstrument[], nextCursor: string | null }` with deterministic `canonical_id ASC` ordering. Read-only under the existing LAN access model; no `isLocalPeer` requirement. Reuses the §5.1 repository extension.
- `GET /api/market/events` — query `after` (opaque cursor), `limit` (bounded); response `{ events: OutboundEvent[], nextCursor: string | null, snapshotRequired?: { reason: string } }` from the §6.1 `readAfter(cursor, limit)` seam. Explicit `snapshot-required` on expired/invalid/future cursor or empty history after restart; never a fabricated empty success. Read-only under the existing LAN access model. If these endpoints are not added in M6, `McpServicesStdio` reports catalog search and event feed reads as `unavailable` rather than inventing a local implementation.

- **HTTP (primary LAN transport):** in `apps/api`, register a single route (e.g. `POST/GET/DELETE /mcp`) that delegates to `createMcpHandler((ctx) => createMcpServer(ctx, httpServices)).fetch(c.req.raw)`, where `httpServices` is the application-backed `McpServicesHttp` built from the existing injected services/repositories. The handler is web-standard and explicitly supports Hono's `c.req.raw`. It serves 2026-07-28 per request; default `legacy: 'stateless'` keeps 2025-era clients working through the same factory. Choose `legacy: 'reject'` only if a strict modern-only endpoint is required — default to dual-era for compatibility.
- **Route registration order:** register the `/mcp` route **before** the production static/SPA catch-all in `apps/api/src/app.ts`. The existing `app.get("*")` fallback returns `index.html` for GETs not starting with `/api`, `/health` or `/ready`; `/mcp` must be added to that bypass list (or registered ahead of the fallback) so `GET /mcp` and all handler-required methods reach the MCP handler rather than the SPA. Handle every method the SDK entry needs (POST/GET/DELETE, plus OPTIONS preflight where applicable) at `/mcp`; do not let static or SPA handlers intercept them.
- **Validation in front:** the SDK entry is deliberately validation-free. Add `hostHeaderValidationResponse`/`originValidationResponse` (with `localhostAllowedHostnames`/`localhostAllowedOrigins`) before `handler.fetch`, and respect the existing `isLocalPeer`/LAN policy for sensitive operations.
- **STDIO (retain):** keep `serveStdio((ctx) => createMcpServer(ctx, stdioServices))`, where `stdioServices` is the thin local-API-backed `McpServicesStdio`. It is already the correct connection-pinned entry capable of 2026-07-28; no change is needed merely to preserve compatibility. Era selection depends on the client's opening exchange. Do not switch to a hand-built `server.connect(new StdioServerTransport())`, which would be 2025-era only.
- **One factory, both transports:** `createMcpServer(ctx, services)` registers the same tools/resources/prompts for HTTP and STDIO so the eras cannot drift; only the `McpServices` implementation differs. Neither transport creates a second application or independent database. Tool registration is never duplicated per transport.
- **Lifecycle:** call `handler.close()` on API shutdown to abort in-flight modern exchanges and close per-request instances. For STDIO, retain the `serveStdio` handle (the current `apps/mcp-server/src/index.ts` discards it) and call its `close()` on process shutdown signals and relevant stdin end/close paths; do not leave the handle unreferenced. Bounded resources: `maxSubscriptions` (SDK default 1024), `keepAliveMs` (default 15000), `maxRequestBodySize` (default 4 MiB) — configure explicitly rather than relying on defaults where operationally relevant.
- **Multi-client/stateless:** 2026-07-28 has no `Mcp-Session-Id`; each request is self-describing. Client-specific state belongs in `requestState` (sealed) or in the client's own listen stream — never in a global mutable map. No Redis/broker needed for a single-process monolith; `InMemoryServerEventBus` is sufficient.

### 4.2 HTTP event bridge ownership and lifecycle (Finding B)

**Verified SDK behavior (installed 2.4.0 source + official support guide, accessed 2026-11-19):**
- `McpServerFactory = (ctx: McpRequestContext) => McpServer | Server | Promise<...>`. `createMcpHandler` calls the factory **once per HTTP request**; `serveStdio` calls it **once per connection plus once for a discarded `server/discover` probe**. The factory therefore must be side-effect-free with respect to background work.
- The `ServerEventBus` is owned by **`createMcpHandler`**, not by factory-created server instances. Each open `subscriptions/listen` stream registers a listener via `bus.subscribe()`; `handler.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}` publishes via `bus.publish()`. The SDK owns ack-first delivery, filtering, subscription-id stamping and teardown. `InMemoryServerEventBus` delivers synchronously to the live listener set; a throwing listener does not stop delivery to others, and an optional `onerror` callback reports listener errors.
- `handler.close()` is idempotent: it closes all listen streams via `listenRouter.closeAll()` (which writes the empty complete result before stream close — graceful teardown), closes/aborts other in-flight per-request server instances, clears its maps, and calls `onclose`. The public `McpHttpHandler.close()` type describes aborting in-flight modern exchanges; the graceful listen-stream completion is confirmed in the installed implementation (`dist/listenRouter-Bartj63y.mjs`), not only the type. It does **not** own application-level subscriptions.

**Selected ownership:** the **application-wide event bridge is owned by `apps/api`**, created once at startup alongside `LiveEventHub` — never inside `createMcpServer()`. Its single canonical subscription source is **`MarketDataService.subscribe()`** (the authoritative change notifications); `LiveEventHub` is the transport of those changes to REST/SSE clients, not a second source. The bridge maps each canonical change to `handler.notify.resourcesChanged()` / `resourceUpdated(uri)` for the affected resource (§5.3). It is the only component that translates application events into MCP-supported notifications; the factory only registers capabilities.

**Sharing safety:** the handler's notifier/bus is handler-level state and is safe to share across all request-created server instances — those instances never touch the bus. The bridge publishes through the single `handler.notify` facade; no per-request listener is created. `InMemoryServerEventBus` is sufficient for this single-process monolith; a custom `ServerEventBus` would only be needed for multi-process deployments, which are out of scope.

**Lifecycle and cleanup:**
- **Init:** after `hub.start()` in `apps/api/src/index.ts`, create the MCP handler and bridge, then subscribe the bridge once. The bridge must not make provider calls at startup (offline-safe).
- **Shutdown:** in the existing `shutdown()` function, use this order: (1) `await mcpHandler.close()` — closes MCP listen streams gracefully (empty result before stream close) and aborts in-flight exchanges; (2) unsubscribe the bridge listener; (3) `hub.stop()`; (4) `server.stop(true)`; (5) `db.close()`. `handler.close()` is idempotent, so repeated shutdown calls are safe.
- **Errors:** bridge listener errors are reported through the SDK bus `onerror` callback and the existing logger; they never throw into SDK dispatch or stop delivery to other listeners. With the default handler-created `InMemoryServerEventBus`, `onerror` is wired through the handler's `onerror` option; a custom `ServerEventBus` must wire its own error reporting. No duplicate event processing: one bridge subscription, one publish path. No unbounded listeners: the bridge owns one listener for the process lifetime; per-stream listeners are owned and torn down by the SDK listen router.

## 5. Tool, resource and prompt inventory

Group related capabilities; do not create one tool per field. All capabilities go through shared services and report availability/freshness/provenance honestly. Most are side-effect-free reads; on-demand retrieval and snapshot capture have bounded persistence side effects and are annotated accordingly (§5.2).

**Tools (reads + on-demand retrieval/capture):**
- `markethub_health` — retain (existing).
- `catalog_search` — canonical instrument discovery/search over catalog repositories (canonical IDs only; provider-native IDs stay internal).
- `provider_status` — composed auth/runtime/capability status from `ProviderRegistry` + live service; restrictions and `UNVERIFIED` capabilities surfaced, never fabricated.
- `market_snapshot` — canonical live snapshot from `MarketDataService` (quotes/depth via agreed canonical fields; no `value.native`).
- `historical_candles` — cached candles + derived coverage/gaps from `HistoricalCandleService`; on-demand fetch only via the service's explicit request (never mutates sync config).
- `option_chain_snapshot` — stored snapshots from `OptionChainSnapshotService`; on-demand capture returns data without changing capture config.
- `futures_chain` / `market_information` — **unavailable in M6** (no shared service exists in the current repository); report unavailable honestly, do not fabricate. They may be added later without changing MCP contracts.
- `on_demand_retrieval` — grouped request for data not currently selected; success may cache candles per existing rules; never changes operational config.

#### 5.1 Bounded `catalog_search` (Finding D)

**Verified repository behavior (2026-11-19):** `CatalogRepository` (`packages/market-core/src/types.ts`) exposes `listInstruments()` (unbounded, no `ORDER BY`/`LIMIT` in `SqliteCatalogRepository`), `findAlias()` and `findIdentifiers()` (exact-match filters). There is **no general paginated catalog-search method**; do not claim one exists.

**Required contract for `catalog_search`:**
- **Non-empty query required:** reject empty/whitespace-only `query` with a validation error; no unfiltered search.
- **Bounded page size:** default 25, maximum 100; values above the maximum are rejected or clamped with an explicit response field (decide at implementation time, document in the tool description).
- **Deterministic ordering:** order by `canonical_id` ascending (stable tie-break) so pages are reproducible.
- **Pagination/cursor semantics:** keyset cursor on the last returned `canonical_id` (opaque to clients), with `nextCursor` returned when more results exist. Avoid offset pagination over a changing catalog.
- **No accidental full-catalog reads:** the `markethub://catalog/instruments` resource must also require a query filter and a page bound; an unfiltered listing resource is not exposed.

**Smallest repository-level extension needed:** add one method to `CatalogRepository` and `SqliteCatalogRepository`, e.g. `searchInstruments(query: { text: string; limit: number; afterCanonicalId?: string }): Promise<CanonicalInstrument[]>`. Implement with a bounded `LIKE` filter over canonical symbol/display name/identity key, `ORDER BY canonical_id ASC`, `LIMIT ?`, and a `canonical_id > afterCanonicalId` keyset predicate. This is a repository interface + implementation extension only — no new service layer, no new table or migration **for catalog search**. It is **not implemented in this task**.

**Parameter translation (normative):** the external tool/resource `query` maps to service/repo `text`; the external opaque `cursor` / `nextCursor` is the last returned `canonical_id` and maps to/from service/repo `afterCanonicalId` (decode on input, encode on output). `limit` is identical across all layers. This keeps the tool/resource contract (§5.3), the `McpServices.searchCatalog` seam (§4.1.2), the HTTP endpoint (§4.1.3) and the repository extension consistent.

#### 5.2 Data side effects and tool annotations (Finding F)

**Verified repository behavior (2026-11-19):**
- `HistoricalCandleService.fetchOnDemand()` calls `upsertCandles()` — successfully retrieved candles are **cached** (a write to the candle cache, not to operational config).
- `OptionChainSnapshotService.captureOnDemand()` calls `putSnapshot()` with `configId = null` — it **persists a snapshot** (a write to the snapshot store, not to `option_chain_capture_configs`).
- Neither operation reads or writes saved sync/capture configuration; on-demand immutability is preserved.

**Four categories must be distinguished in tool descriptions and annotations:**

| Category | Examples | Side effect | Annotation guidance |
|---|---|---|---|
| 1. Side-effect-free reads | `getCached`, `getCoverageStatus`, `listSnapshots`, `getSnapshot`, live `getSnapshot()`, catalog lookups, provider status | None | `readOnlyHint: true` |
| 2. On-demand historical retrieval | `fetchOnDemand` via `historical_candles` / `on_demand_retrieval` | May cache retrieved candles | **Not strictly read-only** — `readOnlyHint: false` (or omit); description must state "may cache retrieved candles" |
| 3. On-demand snapshot capture | `captureOnDemand` via `option_chain_snapshot` | Persists a snapshot with `configId = null` | **Not read-only** — `readOnlyHint: false`; description must state "persists a snapshot with no capture config" |
| 4. Operational configuration changes | credentials, connections, streaming/sync/capture config, retention, provider prefs, network settings | Forbidden for MCP | No tool exposes these |

**Verified annotation fields (installed 2.4.0 `ToolAnnotationsSchema`):** `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (all optional). Use them honestly: category 1 may set `readOnlyHint: true`; categories 2 and 3 must not claim read-only. `destructiveHint`/`idempotentHint` are set per actual behavior (e.g. snapshot persistence is additive, not destructive).

**WebUI-owned capture configuration reconciliation:** on-demand capture does **not** read or write `option_chain_capture_configs`; it stores the snapshot with `configId = null`. WebUI capture configuration governs scheduled/manual capture only. This preserves existing M5 semantics — M6 must not silently change M5 behavior to make on-demand capture "read-only" or to attach it to a saved config. The earlier MCP_INTERFACE statement that "option-chain snapshot persistence remains governed by WebUI capture configuration" is corrected in this task: it is true for scheduled/manual capture, but on-demand capture persists a snapshot with no config and is still visible in the WebUI Snapshot panel.

**LAN queries:** legitimate private-LAN MCP clients may perform side-effect-free reads and on-demand retrieval/capture through the shared services. Do not block them merely because the operation is not configuration management (§8.1). Only operational configuration writes remain local-owner-only.

**WebUI visibility of results:** candles cached by on-demand retrieval and snapshots persisted by on-demand capture appear in the existing History & snapshots tab through the canonical stores; the MCP Activity section (§9.2) links to them via `data_result_ref`. The owner can inspect what was stored without SQL.

**Resources (discoverable, cursor-based):**
- `markethub://catalog/instruments` (filterable), `markethub://market/snapshot`, `markethub://historical/{canonicalId}/{interval}` with `from`/`to`, `markethub://snapshots/{configId?}` with cursor, `markethub://events/live` and `markethub://events/alerts` (feeds with stable event IDs/cursors). Resource URIs are implementation details to finalize against shared contracts; keep them stable and documented.

**Prompts (guided workflows, no hidden actions):**
- `explain_market_snapshot`, `interpret_coverage_gaps`, `how_to_capture_snapshot` — read-only guidance that calls the tools above; no operational changes.

**Boundary with M7:** M6 provides the **event-delivery foundation** (listen streams, supported notifications, discoverable feeds with cursors, read-after-notify) and read/on-demand data access (§5.2). Alert/scanner/watchlist definition, evaluation, trigger history and delivery-channel management are **M7** services; M6 does not implement them or invent alert-trigger notification types.

#### 5.3 Normative capability inventory (design)

Shared registration implements exactly this set. Inputs/outputs reuse existing contracts where available; `McpResult` is defined in §4.1.2. All tools report `unavailable` honestly when the underlying service/API lacks the capability (M5 Phase 4B gated, no futures/market-information service).

| Capability | Kind | Input | Output | Side-effect class (§5.2) | Availability |
|---|---|---|---|---|---|
| `markethub_health` | tool | none | `healthStatusSchema` | read | existing |
| `catalog_search` | tool | non-empty `query`, bounded `limit`, optional keyset `cursor` | canonical instruments + `nextCursor` | read | needs bounded search extension (§5.1) |
| `provider_status` | tool | none | `providerStatusMapSchema` composition | read | existing |
| `market_snapshot` | tool | optional canonical ID filter | `liveSnapshotSchema` (canonical fields only) | read | existing |
| `historical_candles` | tool | `canonicalId`, `interval`, `from`/`to`, `mode: cached\|coverage\|onDemand` | candles + gaps / coverage status | read for cached/coverage; persistence for onDemand | existing services |
| `option_chain_snapshot` | tool | `configId?`, `snapshotId?`, `mode: list\|get\|capture`, capture request fields | snapshot envelope(s) | read for list/get; persistence for capture | existing services |
| `on_demand_retrieval` | tool | grouped request (instrument, data kind, range) | dispatch result referencing the specific tool outcome | persistence (delegates to historical/capture) | existing services; never mutates config |
| `futures_chain`, `market_information` | tool | — | — | — | **unavailable in M6** (no shared service); report honestly |
| `markethub://catalog/instruments` | resource template | `?query=&limit=&cursor=` | bounded instrument page | read | needs search extension |
| `markethub://market/snapshot` | resource | none | `liveSnapshotSchema` | read | existing |
| `markethub://historical/{canonicalId}/{interval}` | resource template | `?from=&to=` | candles + coverage | read | existing |
| `markethub://snapshots/{configId?}` | resource template | `?cursor=` | snapshot page | read | existing |
| `markethub://events/live` | resource | `?after=<cursor>` | bounded replay page or `snapshot-required` (§6.1) | read | in-memory only |
| `markethub://events/alerts` | resource | — | — | — | **unavailable/contract-only in M6** (M7 dependency) |
| `explain_market_snapshot`, `interpret_coverage_gaps`, `how_to_capture_snapshot` | prompt | guided args | text guidance calling tools above | read | existing |

Event→notification mapping: canonical live changes map to `resources/updated` for the affected resource URI (e.g. `markethub://market/snapshot`, `markethub://historical/{id}/{interval}`) and `resources/list_changed` when the available resource set changes; clients then re-read the resource (read-after-notify). No custom notification types.

## 6. Subscription and event-delivery design

- Use `subscriptions/listen` exactly as documented: the client opens a stream with a `SubscriptionFilter`; the server never sends unrequested notifications.
- Supported notifications only: `notifications/tools/list_changed`, `notifications/prompts/list_changed`, `notifications/resources/list_changed`, `notifications/resources/updated`. Publish through `handler.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}` backed by `InMemoryServerEventBus` (single process). No custom standard notification types.
- For resource URI subscriptions on 2026 connections, clients use the `resourceSubscriptions` field of the listen filter; `resources/subscribe` is 2025-only and must not be relied on for modern clients.
- **Read-after-notify:** a notification signals "something changed"; the client then reads the relevant resource/feed (by cursor) to retrieve data. This matches `MCP_INTERFACE.md` §8.1 and avoids putting market payloads in notifications.
- **Event feeds:** expose live events (from `LiveEventHub`) and any future alert events as discoverable resources with monotonic cursors/event IDs, enabling gap/duplicate detection and reconnect catch-up. Durable alert records are an M7 dependency; M6 defines the feed contract only.
- **Graceful close:** on `handler.close()`/shutdown the listen stream receives the empty result before closing (`McpSubscription.closed` resolves `graceful`); an abrupt close resolves `remote` and clients re-listen. Reconnect = re-open listen + fetch from last cursor.
- **Cancellation:** on 2026 Streamable HTTP, client abort closes the request SSE stream; no `notifications/cancelled` POST. Honor `AbortSignal` in tool handlers and bound all work.

### 6.1 Cursor and recovery guarantees (Finding C)

**Verified repository behavior (2026-11-19):**
- `LiveStateStore` starts `revisionValue = 0` (`packages/market-core/src/live/store.ts`); revisions are in-memory and monotonic only for the life of that store instance.
- `LiveEventHub` keeps a **bounded in-memory replay history** (`replayMaxEvents`/`replayMaxBytes`) and per-client bounded queues (`packages/realtime/src/hub.ts`, `types.ts`). `openStream()` replays events with revision > cursor only when the cursor is within retained history; invalid, expired and future cursors return `snapshot-required` with a reason (`invalid-last-event-id`, `expired-cursor`, `future-cursor`, `snapshot-exceeds-client-budget`). Client queue overflow also yields `snapshot-required`.
- `LiveEventHub.stop()` clears replay history and closes all clients (`hub.ts`). A restarted process constructs a fresh store and hub with empty history and revision 0.

**Four distinct cases — do not conflate them:**

1. **In-process replay (same running process):** a disconnected client that reconnects with a still-retained cursor receives missed events from `LiveEventHub`'s bounded in-memory history. This is best-effort and bounded; overflow or eviction forces a fresh snapshot.
2. **Recovery after a disconnected client:** re-open the stream with the last known cursor. If the hub reports `snapshot-required` (expired/invalid/future cursor or budget overflow), the client must fetch a fresh canonical snapshot via REST or an MCP resource/tool before resuming. No silent gap filling.
3. **Recovery after application restart:** **no durable live-event replay is promised.** Replay history is in-memory and cleared on `stop()`; a new process starts at revision 0 with empty history. Old cursors must be treated as invalid/future; clients fetch a fresh snapshot. M6 does **not** add a durable event store or database migration to strengthen this wording.
4. **Durable historical / alert-event retrieval:** this is separate from live replay. Historical candles and option-chain snapshots are persisted by M5 and can be read with their own cursors/ranges. Alert-event feeds with durable records are an **M7** dependency; M6 defines the feed contract only and must not claim durable alert history exists.

**Honest cursor semantics for MCP resources:** live-event feed resources expose the in-memory hub cursor with explicit `snapshot-required` recovery; historical/snapshot resources use their own stored-data cursors. Resource descriptions must state which kind of cursor they use and that live cursors do not survive restart.

**Feed read mechanism (design):** `LiveEventHub` currently exposes a stream-session API (`openStream`) and bounded in-memory history, not a stateless read-after-cursor method. M6 adds a narrow bounded history-read seam (e.g. `readAfter(cursor, limit)`) used only by the MCP feed resource handler: it returns events with revision > cursor from retained history, or an explicit `snapshot-required` (expired/invalid/future cursor, empty history after restart) or empty page. It must not create a client session or consume the SSE stream. Page size is bounded; the response envelope carries `events`, `nextCursor` and optional `snapshotRequired` reason. **Envelope cases (normative):** a normal page (including "no new events") returns `{ events: [...], nextCursor: string | null }` with **no** `snapshotRequired` field; a `snapshot-required` outcome returns `{ events: [], nextCursor: null, snapshotRequired: { reason } }` — never an empty success that could be mistaken for "no new events". `markethub://events/alerts` is **unavailable/contract-only in M6** (durable alert records are M7); the resource handler reports unavailable rather than returning empty data that could be mistaken for "no alerts".

## 7. Multi-client and lifecycle behavior

- Stateless per-request handling means multiple clients share the same factory and services without session coupling; no cross-client mutable state.
- Each client owns its listen stream, filter and cursor; one client's disconnect/lag must not affect others. `maxSubscriptions` bounds concurrent listen streams.
- `requestState` (if used for multi-round flows) is opaque and untrusted: seal with `createRequestStateCodec({ key, ttlSeconds, bind })` and verify via `ServerOptions.requestState.verify`; never store secrets or operational config in it.
- Startup is offline-safe: constructing the MCP server must not make provider calls. Shutdown closes the HTTP handler and STDIO handle, aborts in-flight work and releases listeners.
- Bounded resources: request body size, subscription count, keepalive, tool result sizes and feed page sizes all explicit; no unbounded buffers.

## 8. Permission and security boundaries

- **MCP must not modify:** broker credentials/config, provider connections, streaming selections, historical sync config, snapshot capture config, retention, provider preferences, startup/network settings. All M6 tools are side-effect-free reads or on-demand retrieval/capture with bounded persistence (§5.2) through services that already enforce config immutability.
- Reuse `isLocalPeer` and the WebUI-owned config boundary; do not add an app-level login system. LAN exposure without login is a confirmed deployment model — document risks and validate Host/Origin headers in front of the HTTP handler.
- Validate every MCP input with shared Zod contracts; use tool annotations honestly; treat tool descriptions as untrusted per the spec's security guidance.
- Never expose tokens/credentials in tools, resources, events, errors or logs; reuse `sanitizeError`. Provider-native identifiers stay internal.
- Multiple simultaneous clients are expected; isolate subscriptions and cursors per client. No automatic operational changes by AI.

### 8.1 LAN access vs local-owner management (Finding E)

**Verified repository behavior (2026-11-19):** `isLocalPeer()` (`apps/api/src/lib/net.ts`) is a **loopback-only** check — it accepts `127.0.0.0/8`, `::1` and `localhost`, and returns false for private LAN addresses. It guards credential and operational-management routes in `apps/api/src/provider-routes.ts` and `apps/api/src/market-routes.ts` (PUT subscriptions). `isPrivateLanIpv4()` exists separately and recognises `10/8`, `172.16/12`, `192.168/16`. Product requirements explicitly make private LAN clients legitimate MCP clients.

**Correct separation:**
- **Host/Origin validation** protects the MCP HTTP handler against DNS rebinding and invalid-origin requests. Use the SDK's `hostHeaderValidationResponse(req, allowedHostnames)` and `originValidationResponse(req, allowedOriginHostnames)` (verified signatures in installed 2.4.0). The convenience helpers `localhostAllowedHostnames()` / `localhostAllowedOrigins()` are **localhost-only** and therefore insufficient for LAN clients — build the allowlist from validated config (`config.host`, configured LAN host/IP, and the API/Web origins) at startup.
- **Existing loopback-only management controls remain intact.** MCP tools must not call credential/config management routes or bypass `isLocalPeer`; MCP capabilities are side-effect-free reads plus on-demand retrieval/capture through shared services (§5.2), never management operations.
- **Do not apply `isLocalPeer()` to all read-only MCP requests** — that would incorrectly reject legitimate private LAN MCP clients. Apply it only where the existing application already requires local-owner management.
- **HTTP MCP on-demand operations use direct in-process service calls**, not the loopback-guarded REST routes (`POST /api/historical/fetch`, `POST /api/snapshots/capture`). Those REST guards remain unchanged and are **not** the MCP enforcement point; MCP's boundary is the read-only/on-demand-vs-config-management distinction above. STDIO calls localhost and would pass `isLocalPeer`, but it likewise uses the dedicated activity/API endpoints, not a proxy of management routes. Implementers must not route MCP HTTP through the guarded REST endpoints, or LAN clients would be wrongly blocked.
- **Do not weaken credential/configuration protection**, and do not introduce application login/authentication or a new security framework. LAN exposure without app-level login remains the confirmed deployment model; document the risk.

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

## 9.1 Durable MCP activity history and traceability (Finding B)

**Problem:** `apps/api/src/lib/logger.ts` emits structured JSON to stdout only. It is useful for diagnostics but is not persistent, queryable history. An operation's outcome is lost when the process restarts or a client disconnects. The owner needs durable, inspectable activity records without terminal/SQL access.

**Persistence decision (preferred order evaluated):**
1. **Reuse existing table?** No. `catalog_sync_runs` is catalog-sync-specific (source/completeness/counts/conflicts); `app_meta` is a settings KV store; the console logger is ephemeral; M5 tables hold market data, not operations. None genuinely fits MCP tool activity without polluting its semantics.
2. **One small additive SQLite table + repository.** This is the recommended, simplest correct option. It reuses the existing SQLite/Drizzle foundation, migration conventions, repository pattern and WebUI-owned retention. **One additive migration is therefore genuinely needed** — the original M6 "no migrations" restriction is revised for this single table (see §13). No event store, audit framework, telemetry platform or new dependency.

**Proposed record structure (`mcp_activity` table, conceptual):**
| Field | Purpose |
|---|---|
| `id` (PK) | Stable operation/record ID |
| `operation_id` | Correlation ID shared by start and completion records |
| `tool_name` | Tool/resource/prompt identifier |
| `transport` | `HTTP` or `STDIO` |
| `started_at`, `finished_at` | Timestamps; `finished_at` null while in progress |
| `duration_ms` | Derived on completion |
| `client_name`, `client_version` | From request envelope where available; nullable |
| `status` | `started` / `succeeded` / `failed` / `interrupted` |
| `error_category` | Sanitized category (e.g. `validation`, `unavailable`, `provider`, `internal`); nullable |
| `error_message` | Sanitized useful message; nullable |
| `summary_json` | Safe operation summary: canonical instrument ID, interval, provider attempts, snapshot ID, record counts — **no credentials, tokens, raw arguments or full market payloads** |
| `data_result_ref` | Optional reference to the resulting stored record (e.g. snapshot ID / canonical ID + range) for WebUI navigation |

**Lifecycle and correlation (normative default):** one row per operation with a **unique `operation_id`**. Start inserts the row with `status = "started"`; complete updates the same row to a terminal status (`succeeded`/`failed`/`interrupted`) with `finishedAt`/`durationMs`. Duplicate start with the same `operation_id` is idempotent (no second row); a complete for an unknown `operation_id` is rejected. Timestamps are monotonic (`finishedAt >= startedAt`). On shutdown, in-progress rows may be marked `interrupted`; rows left `started` across a restart are detectable as incomplete. Deviations (e.g. append-only start/finish rows) require explicit rationale in implementation.

**Bounds and indexes (normative default):** `summary_json`, `error_message` and `error_category` are size-bounded and sanitized server-side; oversized values are truncated or rejected, never stored raw. Indexes on `operation_id` (unique), `started_at`, `status`, `tool_name` and `transport` support the WebUI filters/pagination (§9.1.1) and the retention cutoff scan. No full market payloads, credentials, tokens or unrestricted arguments are stored.

**Separate outcomes — critical:** a successful data operation that persists candles/snapshots must remain `succeeded` even if a subsequent notification publish fails. Notification delivery is a distinct outcome: record it in `summary_json` (e.g. `notification: "failed"`) or a separate optional field, never by flipping the data operation's status. Notification failures must not make persisted data appear failed.

**Ownership:** an `McpActivityRepository` in `packages/database` owns writes/reads; the shared registration in `packages/mcp-core` records through `McpServices`. The API process owns the SQLite database and the repository. HTTP MCP uses the existing in-process repository through its application services. STDIO **never opens the database or imports the repository** — it sends activity start/completion through the local API. Bounded writes: one record per operation, no per-tick/per-notification rows.

#### 9.1.1 Proposed STDIO activity API contract (design only)

Two minimal internal endpoints on the existing Hono app, following current conventions (`isLocalPeer` guard, Zod `safeParse`, `apiErrorSchema` with `error`/`message`, 400/403 responses):

- **Start operation — `POST /api/mcp/activity/start`**
  - Request: generated `operationId` (client-generated correlation ID), `toolName`, `transport: "STDIO"`, optional `clientName`/`clientVersion`, `startedAt` (ISO), `summaryJson` (sanitized safe summary).
  - Response: persisted activity record `id` and the echoed `operationId`.
  - Validation: non-empty `operationId`/`toolName`, valid timestamp, summary size bound; reject unknown fields or oversized payloads.
- **Complete operation — `POST /api/mcp/activity/complete`**
  - Request: matching `operationId`, terminal `status` (`succeeded` | `failed` | `interrupted`), `finishedAt` (ISO), optional `errorCategory`/`errorMessage` (sanitized), optional `dataResultRef` (safe result reference).
  - Response: the updated activity record `id` and final `status`.
  - Validation: `operationId` must match an existing started record; status must be a terminal value; error fields sanitized server-side.
- **List/query (WebUI read) — `GET /api/mcp/activity`**
  - Query: bounded `limit` (default 25, max 100), keyset `cursor` (opaque, on `started_at`+`id`), optional filters `toolName`, `transport` (`HTTP`/`STDIO`), `status`, `from`/`to` (ISO timestamps). Deterministic order `started_at DESC, id DESC`.
  - Response: `{ records: McpActivityView[], nextCursor: string | null }`. `McpActivityView` exposes only safe fields (id, operationId, toolName, transport, timestamps, duration, status, client name/version, sanitized error category/message, safe summary, `dataResultRef`) — never raw arguments, tokens or full payloads.
  - Access: read-only under the existing LAN access model (no `isLocalPeer` requirement for reads); no new auth framework.
- **Detail (WebUI read) — two canonical forms, both on dedicated paths (no dual-mode collection path):**
  - `GET /api/mcp/activity/:id` — lookup by persisted record `id`.
  - `GET /api/mcp/activity/by-operation/:operationId` — lookup by correlation `operationId` (unique per §9.1).
  - Response: both detail forms return a **single `McpActivityView`** (404 if absent) using the safe-field allow-list. The collection path `GET /api/mcp/activity` is **always** the paginated `{ records, nextCursor }` list envelope and never accepts an `operationId` selector; there is no response-shape switching on a single path. Register the static `/by-operation` segment before the `/:id` route so it is not captured as a record id.
  - `dataResultRef` maps to existing views: a snapshot ID opens the Snapshot panel record; a canonical ID + interval/range opens the Historical panel range. The WebUI performs this navigation client-side; the API returns only the reference, not joined market payloads.

**Boundary and ownership:** the API process owns the DB and `McpActivityRepository`; STDIO uses these endpoints only. Use the existing loopback-only local-owner boundary (`isLocalPeer`) for these write endpoints, as with other local management writes. The WebUI reads activity through the normal application API under the existing LAN read model (read-only, no new auth). Never store access tokens, broker credentials, unrestricted raw arguments or complete market-data payloads. No OAuth, API-key infrastructure, new auth framework or generic audit platform.

**Failure behavior (explicit):**
- A temporary failure to record activity must **not** corrupt a successfully completed market-data operation. STDIO treats activity-write failure as a logged diagnostic, not a data-operation failure.
- A successful data persistence result remains `succeeded` even if activity finalization or notification delivery fails; those are separate outcomes recorded in the activity record, not status flips.
- A missing completion record remains detectable as `started`/incomplete after a restart; the WebUI highlights it.
- No stronger durability guarantee is claimed than the implementation can provide: activity writes are best-effort at the STDIO boundary, with the API repository providing the actual persistence once a write is accepted.

**Retention:** activity retention is configurable through the existing WebUI-owned `app_meta` retention settings. Extend `retentionSettingsSchema.classes` with an optional `ACTIVITY: { maxAgeDays: z.number().int().positive() }` alongside `CANDLE`/`SNAPSHOT`. Existing stored values without `ACTIVITY` remain valid (optional field) and simply have no activity cleanup until the owner configures it; malformed/invalid values still fail closed. Reuse `AppSettings` validated-read and the existing fail-closed cleanup pattern: missing/malformed/invalid settings disable cleanup and delete nothing. Add a bounded, batched `cleanupActivities(cutoffMs, batchLimit)` repository method invoked from the same cleanup path as candles/snapshots (extend `applyRetentionCleanup` to include an `activitiesDeleted` count), with an index on `started_at` for the cutoff scan. No hidden deletion policy; no silent discard of useful records. The WebUI retention panel gains an activity max-age field using the same validated save flow.

## 9.2 WebUI activity inspection and management (Finding C)

**Verified current WebUI (2026-11-19):** `apps/web/src/App.tsx` already has three tabs — Overview, Live data, History & snapshots — with `ProviderPanel`, `LivePanel`, `SubscriptionPanel`, `HistoricalPanel` and `SnapshotPanel`. It is **not** a minimal health shell. `docs/WEBUI_AND_CONFIGURATION.md` is stale on this point and is corrected in this task.

**Target addition — one "MCP / Activity" section integrated into the existing navigation** (no separate admin app or dashboard framework):
- **Transport availability — distinct, honest states per transport:**
  - **HTTP MCP** (runs in the API process): `Not implemented` (current state until M6-A), then `Configured`, `Available`, or `Unavailable/error`. Once implemented, derive these from actual API handler/readiness information — never from package installation alone.
  - **STDIO MCP** (separate process): `Not configured`, `Configured`, `Activity observed`, or `No recent activity / status unknown`. The WebUI cannot reliably infer that a separate STDIO process is currently running; durable activity records may provide evidence of *observed past activity*, but historical activity is **not** proof the process is currently running. Do not claim "connected" or "running" without an actual signal.
  - No heartbeat service, polling solely to simulate STDIO connection status, background monitoring process, or new infrastructure component. HTTP readiness and STDIO process status are not interchangeable.
- **Recent tool calls:** a bounded, paginated list from `mcp_activity` with tool name, transport, timestamp, duration, status and client name/version.
- **Filters:** by operation/tool, time window and outcome (`succeeded`/`failed`/`interrupted`/`started`).
- **Detail view:** correlation/operation ID, sanitized error category and message, safe summary, and whether the data was stored even if notification delivery failed.
- **Incomplete operations:** highlight `started`/`interrupted` records so the owner can see operations that never completed (e.g. after a restart).
- **Navigation to stored data:** links from an activity record to the corresponding historical candles or snapshot in the existing History & snapshots tab (via `data_result_ref`).
- **Notification/subscription activity:** where useful, show recent listen-stream/notification outcomes as a distinct sub-view; never conflate notification failure with data-operation failure.

**UX expectations:** clear loading/empty/error/partial states and plain-language explanations, not raw logs as the only interface. Reuse existing components/tokens and the established panel pattern. The WebUI is the main inspection surface; no terminal or SQL required for ordinary operation.

## 10. Implementation phases and dependencies

- **M6-A — Transport and server lifecycle.** Add `createMcpServer(ctx, services)` factory and the `McpServices` seam (§4.1.1); mount `createMcpHandler` on Hono `/mcp` with Host/Origin validation; retain `serveStdio(factory)` with the local-API `McpServicesStdio`; wire `handler.close()` into shutdown; explicit opt-in/era tests. Depends on: existing app lifecycle. No provider dependency.
- **M6-B — Tools and resources over shared services.** Implement the normative capability inventory (§5.3) over the `McpServices` contract (§4.1.2); add the local-API endpoints needed for STDIO parity per the matrix (§4.1.3) — bounded catalog search (§5.1) and bounded feed read (§6.1) — or report those capabilities unavailable over STDIO; on-demand retrieval/capture with accurate side-effect annotations (§5.2) and config immutability; register `/mcp` before the SPA catch-all (§4). Depends on: M6-A, M2/M4/M5 services (already present).
- **M6-C — Durable activity history and WebUI inspection.** Add the single additive `mcp_activity` table + repository + `ACTIVITY` retention class (§9.1); add the STDIO write endpoints and WebUI read endpoints (§9.1.1); record start/completion/correlation through `McpServices`; add the WebUI MCP/Activity section with filters, detail view and navigation to stored data (§9.2). Depends on: M6-A/B. This is the smallest correct way to make operations durable and inspectable.
- **M6-D — Subscription/listen and event delivery.** Wire `ServerEventBus`/`notify`, listen filters, resource URIs, cursor-based feeds, read-after-notify, graceful close/reconnect; record notification outcomes separately from data outcomes (§9.1). Depends on: M6-B/C, `LiveEventHub`; alert feeds are contract-only until M7.
- **M6-E — Parity, multi-client, security and conformance acceptance.** Cross-interface parity, multi-client isolation, permission-boundary tests, 2026/2025-era conformance, bounded-resource, activity-durability and shutdown tests. Depends on: M6-A–D.

Ordering may be adjusted if SDK behavior or repository architecture proves a dependency wrong; record the reason before changing it.

## 11. Deterministic test allocation

New `tests/mcp/` suite (mirrors source areas; no live network):
- `transport.test.ts` — `createMcpHandler` via `handler.fetch` in-process (StreamableHTTPClientTransport with a fake URL), era opt-in, 2025 stateless fallback, Host/Origin rejection, `close()` behavior, STDIO factory shape.
- `tools.test.ts` — each tool over fake/shared services (including on-demand retrieval/capture side effects); input validation; bounded catalog search limits/ordering/cursor; honest unavailable/empty states; on-demand config immutability; annotation accuracy.
- `resources.test.ts` — resource URIs, cursor pagination, provenance/freshness fields, read-after-notify payloads.
- `subscriptions.test.ts` — listen filter, supported notifications only, `resourceUpdated(uri)`, graceful vs remote close, reconnect from cursor, multi-client isolation, `maxSubscriptions` bound.
- `parity.test.ts` — MCP vs REST/SSE vs WebUI canonical state from the same services; **both transports** (HTTP direct services and STDIO local-API client) reach the same capabilities with identical response semantics **where the local API exposes them** (§4.1.3); capabilities reported unavailable over STDIO are asserted as such, not silently omitted.
- `security.test.ts` — no operational config mutation, no credential leakage, `isLocalPeer`/LAN boundary (LAN reads allowed, management still loopback-only), bounded inputs, cancellation/timeout.
- `activity.test.ts` — durable activity records: start/completion correlation, status transitions (`started`/`succeeded`/`failed`/`interrupted`), sanitized error category/message, safe summary with no secrets or full payloads, restart recovery of incomplete operations, **data success preserved when notification delivery fails**, `ACTIVITY` retention fail-closed and bounded cleanup, WebUI query/filter/navigation reads.

All tests use fakes/mocked fetch/temp DBs; no live provider, socket or network.

## 12. Acceptance criteria

- 2026-07-28 is explicitly opted in via `createMcpHandler`/`serveStdio`; default behavior and 2025 compatibility are tested, not assumed.
- One factory backs HTTP and STDIO through the concrete `McpServices` contract (§4.1.2); no duplicate market logic; MCP consumes shared services only; parity holds where the local API exposes a capability (§4.1.3), with honest unavailable reporting otherwise.
- Tool/resource inventory is grouped, discoverable, correctly annotated for side effects (§5.2), and reports availability/freshness/provenance honestly; no fabricated fields.
- On-demand retrieval never mutates operational config; permission boundary tests pass.
- `subscriptions/listen` delivers only supported notifications; clients read data from resources/feeds; no custom standard notification types; graceful close/reconnect and multi-client isolation pass.
- Parity with REST/SSE/WebUI over the same canonical state; **both transports** reach the same capabilities without a second application or DB state; bounded resources and clean shutdown verified.
- Durable activity records survive restart; outcomes and failures are traceable with sanitized summaries and no secrets/full payloads; data success is distinct from notification-delivery failure; incomplete operations are identifiable.
- WebUI MCP/Activity section exposes transport availability, recent calls, filters, detail, incomplete operations and navigation to stored data; WebUI documentation matches the real panels.
- On-demand persistence semantics are accurately described (cached candles / `configId = null` snapshot); LAN read queries are not blocked; operational config remains WebUI-owned and local-owner-only.
- Focused + full suite, typecheck, build, `git diff --check` pass locally; independent diff review before any merge. Results reported as local, not CI.

## 13. Risks, unresolved questions and explicit gates

- **Stage G gate:** M6 must not activate providers; live data availability remains unestablished. MCP surfaces honest empty/unavailable states until Phase 4B is separately authorized.
- **M7 dependency:** durable alert-trigger records/feeds are M7; M6 defines the event-delivery contract but cannot deliver real alert history until M7 exists.
- **SDK/spec evolution:** 2026-07-28 deprecates Roots/Sampling/Logging and legacy HTTP+SSE (12-month window); avoid building on deprecated surfaces. Re-verify against current docs before implementation.
- **Unresolved:** exact resource URI shapes and cursor encoding; whether to offer `legacy: 'reject'` for a strict endpoint (default to dual-era); Host/Origin allow-list policy for LAN clients; `requestState` key management if multi-round flows are added; conformance-test tooling selection. These are implementation-time decisions grounded in the cited official docs, not product-scope questions.
- **No new third-party dependencies** without separate justification; `@modelcontextprotocol/node` is only needed for Node framework adapters, not for Hono/Bun web-standard mounting. The thin `packages/mcp-core` workspace package in §4.1 is a **recommendation for authorized M6-A implementation**, not something created by this documentation task; it reuses the existing SDK 2.4.0 and requires separate implementation authorization.
- **Migration decision (revised):** the original M6 plan excluded database migrations. Durable, inspectable activity history (§9.1) cannot be delivered by the ephemeral console logger or by misusing catalog-sync/app_meta tables, so **one small additive SQLite migration for `mcp_activity` is the simplest correct solution** and is now proposed, not excluded. It reuses the existing Drizzle migration/repository/retention conventions; no event store, audit framework or new dependency. This is a design recommendation only — no migration is created in this documentation task.

## 14. Non-goals

- M6 source implementation, transport code or dependency upgrades (this document is a plan).
- Provider activation, live auth/network/sockets, Stage G verification, production-driver unlock.
- Watchlist/alert/scanner workflow services (M7) or MCP mutation of operational config.
- Microservices, Redis/brokers, event stores, audit/telemetry platforms, or a second frontend/API architecture. (One small additive `mcp_activity` migration is proposed in §9.1/§13 as the minimal durable-history mechanism; it is not implemented here.)
- Inventing standard MCP notification types or duplicating market-data calculations in MCP.
