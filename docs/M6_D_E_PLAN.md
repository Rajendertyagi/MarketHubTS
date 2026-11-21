# M6-D + M6-E — Notification Bridge, Event Delivery, and Protocol Acceptance

> **Status:** Implementation plan only. Awaiting separate authorization. **No M6-D/E source exists yet.** This document does not implement anything.
> **Last updated:** 2026-11-21 (official MCP/SDK research re-verified this date; §4)
> **Repository baseline:** `Rajendertyagi/MarketHubTS`, branch `develop`, HEAD `32b034a38e9c0db134de13b9b51a9e12d1ffdee7` (verified equal to `origin/develop`).
> **Depends on:** M6-A (`7860c7f`: Streamable HTTP at `/mcp` + retained STDIO, shared factory); M6-B1/B2/B3 (`0d58bbb`: tools, resources, prompts, cache hints, snapshot pagination); **M6-C accepted and closed at `32b034a`** (acceptance record in [`M6_C_PLAN.md`](M6_C_PLAN.md) §0). M6-B4 conformance/parity remains separately tracked.
> **Governing design:** [`M6_PLAN.md`](M6_PLAN.md) §3.1 (C1–C21 matrix), §3.2 (extensions), §3.3 (modern vs legacy), §6/§6.1 (subscriptions, cursors), §7 (lifecycle), §9.1 (activity outcomes), §10–§13 (phases, tests, acceptance, gates); [`MCP_INTERFACE.md`](MCP_INTERFACE.md) §8.1; [`TESTING_AND_ACCEPTANCE.md`](TESTING_AND_ACCEPTANCE.md). This is the single execution plan for M6-D and M6-E; it narrows the governing design and does not replace it.
> **Official references:** MCP 2026-07-28 [subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md), [resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources.md), [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md); TypeScript SDK [support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md), [protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md), [v2.4.0 `createMcpHandler` source](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/server/src/server/createMcpHandler.ts), [latest release](https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases/latest) (`v2.4.0`, 2026-10-23). Consolidated in [`REFERENCES.md`](REFERENCES.md) §8.

## 1. Objective

Complete the final two M6 phases without creating a second event system or duplicating protocol behavior:

- **M6-D:** connect canonical MarketHub live-state changes to MCP `subscriptions/listen` notifications over the existing Streamable HTTP `/mcp` endpoint. Clients receive only notifications they explicitly requested, then read the relevant canonical resource/feed for data. Subscription lifecycle, acknowledgement, filtering, correlation, cancellation, concurrency limits and graceful close remain SDK-owned.
- **M6-E:** verify the composed behavior with the real official MCP client against the running Hono/Bun listener, verify modern STDIO behavior with a spawned process, prove transport/security/lifecycle behavior, and complete a repeatable second-device LAN acceptance procedure. Close the remaining applicable C1–C21 matrix without confusing in-process tests with real transport evidence.

M6-D is a notification bridge, not a new market-data pipeline. M6-E is an acceptance phase, not a reason to redesign the working M6-A/B/C implementation.

## 2. Entry conditions and scope boundaries

### 2.1 Entry conditions

1. Re-fetch `develop` and inspect actual branch/working-tree state; the baseline above is the reviewed state, not a permanent fact.
2. M6-C must remain accepted and closed at `32b034a` (already satisfied — see `M6_C_PLAN.md` §0). Do not add another activity table, alter retention schema, or modify the activity UI as a prerequisite.
3. Keep **M6-B4** separate. Its conformance/parity unit work is not silently absorbed into M6-D; M6-E may consume B4 evidence and close end-to-end gaps, but B4 remains separately tracked until explicitly closed.
4. Re-verify the latest stable MCP specification and SDK release at implementation start. Reviewed latests: `2026-07-28` / `2.4.0`; do not assume they remain current.
5. M6-D must pass its phase gate (§8.1) before M6-E begins; both must pass the combined gate (§8.3) before either is declared complete.

### 2.2 Explicit non-goals

- No provider activation, authentication, live sockets or Stage G unlock. Tests use synthetic/injected state or the existing honest empty/unavailable provider state.
- No M7 alert-trigger records, alert feed persistence, scanner/watchlist workflows, or fabricated `markethub://events/alerts` data.
- No custom MCP JSON-RPC router, custom SSE implementation, separate legacy HTTP+SSE transport, custom resumability protocol, or hand-written subscription-ID handling.
- No Redis, broker, external pub/sub, database migration, activity schema change, new runtime service, or new third-party dependency.
- No new app login/RBAC layer; preserve the Host/Origin and local-owner/LAN boundary.
- No unrelated UI, REST/SSE, subscription coordinator or WebUI refactor.
- No promise of active live notification delivery over STDIO in M6 (see §5.6).

## 3. Verified repository baseline (re-checked at `32b034a`)

| Fact | Evidence |
|---|---|
| One `createMcpHandler` instance in composition; factory is pure | `apps/api/src/index.ts:125-132`; `packages/mcp-core/src/factory.ts:13-34` |
| Handler exposes `fetch`/`close`/`notify`/`bus`; no public health state | installed SDK `createMcpHandler-*.d.mts:336-360` |
| `ServerEvent` variants: `tools_list_changed`, `prompts_list_changed`, `resources_list_changed`, `resource_updated{uri}` | installed SDK `createMcpHandler-*.d.mts:115-127` |
| `ServerNotifier` = `toolsChanged()/promptsChanged()/resourcesChanged()/resourceUpdated(uri)` | installed SDK `createMcpHandler-*.d.mts:180-189` |
| `SubscriptionFilter` fields: `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions` | installed core `schemas-*.mjs:523-528` |
| Client `listen(filter, options?)` → `McpSubscription` with `honoredFilter`, `close()`, `closed: 'local'|'graceful'|'remote'` | installed client `client-*.d.mts:490-515,997` |
| Handler options: `bus?`, `maxSubscriptions?` (default 1024), `keepAliveMs?` (default 15000), `maxRequestBodySize?` (default 4 MiB), `onerror?`, `legacy?`, `responseMode?` | installed SDK `createMcpHandler-*.d.mts:294-324`; v2.4.0 source §4 |
| `MarketDataService.subscribe(listener)` is the canonical change source; `LiveStateStore` emits detached, revisioned `LiveChangeEvent` values and isolates listener exceptions | `packages/market-core/src/live/service.ts:36-37`; `packages/market-core/src/live/store.ts:75,107,117` |
| `LiveChangeEvent` variants: `item-updated`, `item-removed`, `provider-connection-changed` | `packages/contracts/src/live.ts:178-201` |
| `LiveEventHub` subscribes to the same source; bounded replay + `readAfter` with runtime-scoped `resumeCursor` / `snapshot-required` | `packages/realtime/src/hub.ts:201-209,310` |
| `markethub://events/live` resource exists with runtime-scoped cursor | `packages/mcp-core/src/resources.ts:196` |
| Activity records have `summaryJson` for separate notification outcomes | `packages/contracts/src/mcp-activity.ts`; `packages/mcp-core/src/activity.ts` |
| Shutdown order: coordinator → hub → handler → server → DB | `apps/api/src/index.ts:163-181` |
| `tests/mcp/http-smoke.test.ts` (real listener, class b) and `tests/mcp/stdio-modern.test.ts:20-59` (real spawned process) exist | repository |
| No dedicated `subscriptions.test.ts`, `http-integration.test.ts`, `conformance.test.ts`, `legacy-compat.test.ts`, or LAN evidence record | repository |

`GET /api/market/stream` is the application SSE transport, **not** the MCP `subscriptions/listen` channel. Live feed history is in-memory and bounded; a cursor from a previous process is not resumable.

## 4. Official protocol and SDK facts (fetched 2026-11-21)

| Official source | Verified behavior used by this plan |
|---|---|
| [Spec — Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md) | `subscriptions/listen` filter is `params.notifications` with `toolsListChanged`/`promptsListChanged`/`resourcesListChanged`/`resourceSubscriptions: string[]`. Server **MUST NOT** send unrequested types. First message **MUST** be `notifications/subscriptions/acknowledged` with `io.modelcontextprotocol/subscriptionId` in `_meta` and the honored subset; no notification before it. Every notification carries that ID; multiple concurrent subscriptions demultiplex by listen request ID. Client cancels by closing the SSE stream (HTTP) or `notifications/cancelled` (stdio); server-initiated close **SHOULD** send a successful `subscriptions/listen` result first. On stdio the client **MUST** re-send `subscriptions/listen` after reconnect — the server holds no subscription state across reconnections. |
| [Spec — Resources](https://modelcontextprotocol.io/specification/2026-07-28/server/resources.md) | `resources.subscribe` capability enables resource-specific update notifications via the `resourceSubscriptions` listen filter; `resources.listChanged` is independent and only for a changing resource inventory. `notifications/resources/updated` is a change signal; the client re-reads the URI. |
| [Spec — Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md) | Servers **MUST** implement `server/discover`. Response carries `supportedVersions`, `capabilities`, optional `instructions`, `ttlMs`/`cacheScope`, and identity at `_meta['io.modelcontextprotocol/serverInfo']` (not in the body). `serverInfo` is self-reported; MarketHubTS **MUST NOT** use it to drive behavior or security decisions. |
| [SDK — support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) | `createMcpHandler` returns `.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}` over an in-process bus (supply `ServerEventBus` for multi-process — not needed here). `serveStdio` routes the pinned instance's `send*ListChanged()` onto active subscriptions automatically. `ClientOptions.listChanged` auto-opens a listen stream intersected with advertised capabilities; `client.listen(filter)` opens explicitly. Graceful close resolves `McpSubscription.closed === 'graceful'`, abrupt `'remote'`. Modern cancellation closes the request SSE stream. Standard headers `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` required on modern request POSTs (mismatch → `-32020`); cache hints default `ttlMs: 0`/`cacheScope: 'private'`; `clientInfo` is a SHOULD. |
| [SDK — protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md) | `legacy` era = 2024-10-07…2025-11-25 (`initialize`); `modern` = 2026-07-28 (per-request `_meta`). `createMcpHandler`/`serveStdio` serve both unless `legacy: 'reject'`. Change notifications are unsolicited on legacy, listen-only on modern. Deprecation is separate from era. |
| [SDK v2.4.0 `createMcpHandler` source](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/server/src/server/createMcpHandler.ts) | `McpRequestContext` carries `era` and `requestInfo`. For `subscriptions/listen` the factory **is** constructed to read `server.getCapabilities()`; the acknowledged filter reflects what the instance can actually deliver. `handler.close()` calls `listenRouter.closeAll()` and closes in-flight exchanges. `onerror` is reporting-only. |
| [SDK — latest release](https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases/latest) | `v2.4.0` is still the latest stable release (published 2026-10-23); no newer stable SDK or protocol revision — target remains `2026-07-28` / SDK `2.4.0`. |

**Reconciliation:** the SDK reads capabilities from the per-request instance for listen, so capability advertisement is the precise control point for the honored filter (§5.3). The "ack-first with `subscriptionId`" decision is confirmed and now names the exact ack notification and `_meta` key. "No `resources/subscribe` on modern" is confirmed: use the `resourceSubscriptions` listen filter. "One bridge, no second STDIO bridge" is confirmed by `serveStdio`'s automatic `send*ListChanged()` routing. No capability in this plan depends on an unverified API assumption.

## 5. M6-D — Modern MCP notification bridge and event delivery

### 5.1 Architecture

```text
MarketDataService.subscribe()
        | LiveChangeEvent (revisioned canonical change)
        v
apps/api MCP notification bridge (one process-wide listener)
        | handler.notify.resourceUpdated("markethub://market/snapshot")
        v
createMcpHandler-owned ServerEventBus
        | SDK-owned filter + subscriptionId + SSE delivery
        v
HTTP clients with matching subscriptions/listen streams
        +--> resources/read: markethub://market/snapshot
        +--> resources/read: markethub://events/live?after=<resumeCursor>&limit=N
```

Responsibilities: `MarketDataService` is the canonical change source; `LiveEventHub` remains the bounded feed/replay source for REST/SSE and the existing `events/live` resource, not a second MCP notification source; `apps/api` owns one bridge subscription per process; `createMcpHandler` owns all HTTP listen streams; `packages/mcp-core` registers shared resources/tools/prompts and owns no background publisher. No new bus, queue, worker, table or broker.

### 5.2 Notification mapping

**M6-D notification topic:** `markethub://market/snapshot` (one stable URI). Every `LiveChangeEvent` variant changes or invalidates the canonical snapshot, so the bridge publishes exactly one `resources/updated` signal for that URI. Notifications carry only the URI and SDK metadata — no market payload, credentials or provider-native identifiers, and no custom notification methods.

After notification the client: (1) re-reads `markethub://market/snapshot`; (2) when it needs incremental events, reads `markethub://events/live{?after,limit}` with its saved `resumeCursor`; (3) on `snapshot-required` (expired cursor, previous runtime, future cursor, lost history) fetches a fresh snapshot and starts a new feed position. `events/live` is a parameterized template — do not publish cursor-specific template URLs as a fixed resource. The stable snapshot URI is the topic; the feed is the catch-up mechanism.

### 5.3 Capability advertisement (normative)

- Advertise `resources.subscribe: true` **only** for the modern HTTP handler where the API bridge is active. Derive it from `ctx.era === 'modern'` and `ctx.requestInfo` in the factory; the SDK reads `server.getCapabilities()` for the listen ack, so this is the exact control point.
- Do **not** advertise `resources.listChanged`, `tools.listChanged` or `prompts.listChanged`: those inventories are static in M6.
- Do **not** advertise `resources.subscribe` on STDIO (no live event relay — §5.6) or on the 2025 stateless HTTP fallback. The SDK still handles `subscriptions/listen`; the ack must omit unsupported filters rather than falsely claim them.
- Confirm with `server/discover` tests for modern HTTP, legacy HTTP, modern STDIO and legacy STDIO as applicable.

### 5.4 Bridge lifecycle, bounds and errors

Implement a small independently testable helper, preferably `apps/api/src/mcp-notification-bridge.ts`:

- Input: canonical `MarketDataService`, the handler's typed `resourceUpdated(uri)` notifier, and a best-effort error callback/logger.
- `start()` calls `service.subscribe()` **exactly once**; `stop()` returns an idempotent unsubscribe that does not mutate canonical state or hub history.
- On any valid live change: call `notify.resourceUpdated(MARKET_SNAPSHOT_URI)`.
- On publisher/diagnostic failure: catch, emit a bounded diagnostic (`mcp_notification_publish_failed`) and return normally. No bridge error may escape into `LiveStateStore` or affect canonical mutation.
- Never subscribe from each `createMcpServer()` factory invocation or per HTTP request/subscription stream.

Configure existing handler options deliberately: `maxSubscriptions`, `keepAliveMs`, `maxRequestBodySize`, `onerror`. Reuse existing config conventions; do not add a settings framework. The SDK owns the actual bounds and protocol errors.

**Notification storms:** one notification per canonical event initially; measure with tests before introducing coalescing. Do not add a timer/debounce subsystem speculatively.

**Shutdown order:** stop accepting new app work / stop the desired-subscription coordinator (DB still open) → `await mcpHandler.close()` so active listen streams receive the SDK's graceful completion → unsubscribe the bridge → stop `LiveEventHub` and its clients → stop the Bun HTTP listener → close/checkpoint SQLite. Essential invariant: **close the handler before detaching the bridge source or closing the HTTP server/DB, and never let the handler outlive SQLite.** A slightly different coordinator position is acceptable if this invariant holds; document and test the chosen sequence.

### 5.5 Activity and notification outcome separation

- A failed notification publish is not a failed market-data update and must never roll back or relabel canonical state.
- No per-tick/per-notification rows in `mcp_activity`; M6-C uses one row per MCP operation.
- Keep bridge diagnostics separate from MCP operation status using the existing logger and a distinct event name. Where an activity summary already has a relevant notification result, do not overwrite a successful data result with a notification failure.
- No migration or activity schema change in M6-D.

### 5.6 STDIO decision and parity boundary

The governing scope puts the M6-D bridge on Streamable HTTP. The SDK also supports `subscriptions/listen` on STDIO and exposes `sendResourceUpdated({ uri })` on a connected server, but the STDIO process is only a local-API client with no canonical live-event source/relay. Adding active STDIO delivery would require a new API SSE relay and connection-lifecycle ownership — not in scope.

Therefore: M6-E tests modern `subscriptions/listen` **control-plane** behavior on a real STDIO process (ack ordering, actually honored — possibly empty — filter, cancellation, correlation, clean shutdown). STDIO must not advertise `resources.subscribe` or claim live updates until a relay exists. Active MarketDataService → MCP delivery acceptance is **HTTP only**. If the product requires active STDIO notifications in M6, that is an explicit scope decision requiring a bounded relay, lifecycle/cleanup, reconnection semantics and tests before implementation — do not smuggle it into the HTTP bridge.

### 5.7 M6-D implementation sequence

1. Add the bridge helper and unit tests for mapping, idempotent unsubscribe, failure isolation and one-listener ownership.
2. Wire it once in `apps/api/src/index.ts` after handler and source are available; retain the unsubscribe for shutdown.
3. Configure bounded handler options and `onerror`.
4. Set `resources.subscribe` only for modern HTTP-created servers; keep list-changed bits unset.
5. Preserve existing resources and cursor/feed contracts; do not redesign `LiveEventHub`.
6. Add focused subscription tests (§7.1).
7. Review startup/shutdown ordering and Stage G constraints before marking D complete.

## 6. M6-E — End-to-end conformance and transport acceptance

M6-E proves the composed system, not merely a handler object. It consumes M6-D and M6-B4 evidence; it must not substitute mocked transports for actual listeners.

### 6.1 Real HTTP integration

Add `tests/mcp/http-integration.test.ts`, extending the `http-smoke.test.ts` pattern:

- Start the actual Hono app with `Bun.serve()` on a real local port, temporary SQLite DB, synthetic canonical `MarketDataService` events, no live providers.
- Connect ≥2 official `Client` instances via `StreamableHTTPClientTransport` pinned to `2026-07-28`.
- Verify `server/discover` returns the modern revision and advertises `resources.subscribe` for HTTP.
- Open `client.listen({ resourceSubscriptions: ["markethub://market/snapshot"] })`; confirm ack is first, `honoredFilter` includes only supported/advertised requests, and notifications correlate to the correct subscription ID.
- Cause a synthetic canonical change; verify subscribed clients receive `notifications/resources/updated` and unsubscribed clients receive nothing.
- Verify read-after-notify: read the snapshot and assert its revision/state reflects the event; use `events/live` with a saved `resumeCursor` and assert the incremental event.
- Verify multiple concurrent subscriptions are isolated (distinct filters/IDs); closing one must not suppress another.
- Verify reconnect: close a listen stream, make another change, open a new stream, reuse the saved feed cursor. Do not expect MCP SSE `Last-Event-ID` replay; the feed cursor is the recovery mechanism.
- Verify expired/invalid/previous-runtime cursor returns `snapshot-required`, never a successful empty page.
- Verify malformed modern envelopes/headers, unsupported methods, invalid and allowed Host/Origin, and CORS preflight including modern required headers. Retain the smoke test's negative Host check.
- Verify client abort/cancellation and server-initiated shutdown; an active listen stream closes with the graceful completion result on deliberate `handler.close()`.
- Verify bridge/publisher errors are diagnostics only and do not turn successful mutations/reads into failures.
- Use bounded timeouts and deterministic `finally` cleanup of clients, handler, server and DB. No external providers, market sessions or credentials.

### 6.2 Modern STDIO process

Extend `tests/mcp/stdio-modern.test.ts` rather than building another harness:

- Spawn the actual `apps/mcp-server/src/index.ts` with `StdioClientTransport` and a test local API server; pin to `2026-07-28`.
- Verify `server/discover` response body (`supportedVersions`, `capabilities`, `_meta['io.modelcontextprotocol/serverInfo']`), tool listing/call, resource reads and prompt retrieval.
- Verify `subscriptions/listen` is handled by the SDK; because there is no event relay, confirm the ack does **not** claim `resourceSubscriptions` are honored. Verify cancellation and clean process shutdown with no leaked child.
- Assert stdout carries only protocol messages; diagnostics on stderr. Preserve the thin local-API architecture (no SQLite, no `MarketDataService` in the STDIO app).

### 6.3 Legacy compatibility

The current composition uses the default dual-era posture (`createMcpHandler` legacy stateless fallback; `serveStdio` legacy serving by default). Unless a separate decision changes it, add `tests/mcp/legacy-compat.test.ts` to prove: a 2025-era HTTP client uses the stateless path; a 2025-era STDIO client uses the legacy opening path; modern pinned clients use `server/discover`/`_meta` and the 2026 listen mechanism; and legacy compatibility causes no unsolicited notifications or deprecated `resources/subscribe` on the modern path. If dual-era support is intentionally removed, document it, set `legacy: 'reject'` deliberately and test the rejection — do not let posture change accidentally.

### 6.4 LAN acceptance procedure

Automated loopback tests do not prove a second device can reach the configured LAN interface. Add a repeatable manual procedure, preferably `docs/M6_E_LAN_ACCEPTANCE.md`, and execute it on a second device on the same private LAN. Record: API machine LAN IPv4, bind host, port, `MARKETHUB_LAN` state, client device/interface and MCP config, test date; that the API is bound to the intended interface and reachable at `/mcp`; a modern-pinned client completing discovery, tool/resource listing, snapshot read, a subscription to `markethub://market/snapshot`, a notification after a controlled synthetic change, and a read-after-notify with cursor resume or explicit recovery; a valid configured LAN Host/Origin accepted and an unapproved one rejected (403) without loosening SDK validation; that the endpoint is not publicly exposed; expected vs actual results, timestamps and redacted evidence. If a physical second-device run is impossible, record **not tested** — do not claim LAN acceptance from localhost or a mocked request.

### 6.5 Matrix traceability

Use the governing `docs/M6_PLAN.md` §3.1 C1–C21 matrix. Maintain a test-to-requirement table giving each applicable MUST one explicit named assertion. M6-D owns C17 and its tests; M6-A/B and M6-B4 own their rows; M6-E verifies every applicable row is present in the complete evidence set and adds actual-listener/real-client assertions unit tests cannot prove. No row is accepted because an in-process `handler.fetch` test passed when the master plan requires an actual listener. Document any SHOULD deviation with reason and owner. Do not reimplement the protocol manually to satisfy a row.

## 7. Test plan

### 7.1 M6-D focused tests

| Test | Scope |
|---|---|
| New `tests/mcp/subscriptions.test.ts` | SDK handler + real client in-process: ack-first, honored filter, subscription ID, exact URI filtering, no unrequested notification, two clients/two subscriptions isolated, cancellation, graceful handler close, max subscriptions, no false list-changed capability |
| New `tests/mcp/notification-bridge.test.ts` (or focused API bridge test) | one `MarketDataService.subscribe()` listener; all `LiveChangeEvent` variants map to the stable URI; repeated start/stop safe; notifier failure contained and reported; canonical mutation still succeeds |
| Existing `tests/market/notifications.test.ts`, `tests/mcp/event-feed.test.ts` | retain as source-level guarantees; extend only for missing cases |

These prove logic but do **not** replace M6-E's real HTTP listener test.

### 7.2 M6-E integration and acceptance tests

| Test/artifact | Required evidence |
|---|---|
| `tests/mcp/http-smoke.test.ts` | Keep as M6-A smoke; do not relabel as full M6-E acceptance |
| New `tests/mcp/http-integration.test.ts` | Real listener, pinned real client, subscription/update/read-after-notify, concurrent clients, cancellation/reconnect, Host/Origin, shutdown |
| Extended `tests/mcp/stdio-modern.test.ts` | Spawned process, modern discovery/capability/resource/tool access, listen ack/filter behavior, cancellation, clean teardown |
| New `tests/mcp/legacy-compat.test.ts` (unless legacy explicitly rejected) | 2025 HTTP + STDIO compatibility, no modern/legacy leakage |
| `tests/mcp/conformance.test.ts` or explicit evidence map | Named assertion per C1–C21; reuse existing passing locations where mapping is unambiguous; do not duplicate merely to match a filename |
| `docs/M6_E_LAN_ACCEPTANCE.md` | Executed second-device procedure and evidence, or explicitly recorded not-tested blocker |

### 7.3 Commands and quality gates

```bash
bun test tests/mcp/subscriptions.test.ts tests/mcp/notification-bridge.test.ts
bun test tests/mcp/http-smoke.test.ts tests/mcp/http-integration.test.ts tests/mcp/stdio-modern.test.ts
bun test tests/mcp/legacy-compat.test.ts
bun run typecheck
bun run build
bun test
git diff --check
```

Adjust focused names to actual files. Report local results separately from CI evidence. Run the full suite only after focused D/E tests are deterministic and no child process or SSE stream is leaked.

## 8. Phase gates and acceptance criteria

### 8.1 M6-D definition of done

- [ ] One process-wide bridge subscribes to `MarketDataService`, not `LiveEventHub` or the per-request factory.
- [ ] A modern HTTP client subscribes to the stable snapshot URI and receives the correct `resources/updated` notification after canonical changes.
- [ ] Ack-first, exact filter semantics, subscription ID, concurrent subscriptions, cancellation, graceful close and bounded subscription behavior are proven.
- [ ] The client reads the updated snapshot and uses the existing live feed cursor for incremental replay/recovery.
- [ ] Notification delivery failures cannot change data-operation outcomes or corrupt canonical state.
- [ ] Capability advertisement matches §5.3 across modern HTTP, legacy HTTP, modern STDIO and legacy STDIO.
- [ ] No custom protocol/SSE implementation, migration, dependency, provider activation or unsupported capability advertisement.
- [ ] Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; full suite shows no new failures vs the accepted M6-C baseline; independent diff review completed.

### 8.2 M6-E definition of done

- [ ] C1–C21 evidence matrix complete across M6-A/B/B4/D/E owners.
- [ ] A real pinned client passes the full HTTP integration suite against the running Hono/Bun listener, not just in-process `handler.fetch`.
- [ ] Modern STDIO process tests pass, including honest listen-filter/capability behavior; legacy paths tested if retained.
- [ ] Host/Origin, CORS, error/cancellation, reconnect/read-after-notify, multi-client isolation, graceful shutdown and bounded-resource behavior pass.
- [ ] Second-device LAN procedure executed and evidence recorded; "not tested" blocks claiming LAN acceptance.
- [ ] Full tests, typecheck, build and diff checks pass; independent review finds no scope creep or regression.
- [ ] M6-C closure and M6-B4 closeout reconciled; M6 remains separate from Stage G and M7.

### 8.3 Combined M6-D + M6-E integration gate

Individually passing phases must not leave incompatible interfaces. Before either phase is declared complete:

- A real pinned client over an actual listener opens `subscriptions/listen`, receives a supported notification after a canonical change, re-reads `markethub://market/snapshot` and `markethub://events/live` by cursor, and observes graceful close on shutdown — using the **same** bridge and handler M6-D wired.
- The same client set verifies discovery, tools, resources and prompts over both transports with no duplicate market logic and no deprecated methods.
- STDIO and HTTP expose the same notification control-plane semantics; STDIO re-listen after reconnect is verified; no false capability advertisement on STDIO.
- No interface introduced by M6-D is left untested by M6-E, and no M6-E assertion depends on behavior M6-D did not implement.
- Evidence is assembled in one report referencing both phase gates; a gap in either blocks the combined gate and any M6-complete claim.

Implementation or passing tests alone do **not** mark a phase complete — the independent review gate is required. **M6 may be declared complete only when M6-B4, M6-D and M6-E are all accepted.**

## 9. Risks, mitigations and rollback

| Risk/decision | Handling |
|---|---|
| SDK capability mismatch | Advertise `resources.subscribe` only where a working source/publisher exists; assert `server/discover` separately per transport/era (§5.3) |
| Event source duplication | Bridge from `MarketDataService.subscribe()` exactly once; `LiveEventHub` stays feed/replay consumer |
| Resource URI mismatch | Publish only the exact stable URI `markethub://market/snapshot`; SDK resource filtering is exact |
| Notification storms | One notification per canonical event initially; measure before coalescing; no speculative debounce |
| Feed cursor invalid after restart | Return existing explicit `snapshot-required`; no durable event store |
| Shutdown ordering | Gracefully close handler, detach bridge, then stop hub/server and close DB; preserve §5.4 invariant |
| Notification errors | Diagnostic-only; never poison data outcome or create per-tick activity rows |
| STDIO live notification parity | Not in M6-D HTTP scope; re-scope explicitly before adding an API SSE relay |
| LAN test unavailable | Mark not tested; do not equate localhost with LAN acceptance |
| Protocol/SDK advances | Re-verify official latest stable versions at start; update the conformance map before coding |
| B4/M6-C concurrent work | M6-C is already accepted; keep B4 separately tracked; do not overwrite either |

**Rollback:** the bridge is additive and isolated in one new module plus composition/shutdown edits; disable by not starting it (no schema/data change). M6-E adds tests and documentation only. Revert the added files/edits if a defect appears; no migration to roll back.

## 10. File-level change map (expected, not a rigid checklist)

| Area | Expected change | Guardrail |
|---|---|---|
| `apps/api/src/mcp-notification-bridge.ts` (new, recommended) | Small source-to-notifier adapter with isolated errors and unsubscribe | No DB, timer, queue or new event system |
| `apps/api/src/index.ts` | Instantiate handler with explicit bounded options; attach one bridge; retain unsubscribe; correct shutdown order | No per-request subscription or duplicate handler |
| `packages/mcp-core/src/factory.ts` | Conditionally advertise `resources.subscribe` for modern HTTP only | No list-changed claims; no background work |
| `tests/mcp/subscriptions.test.ts` (new) | Focused listen/notification protocol tests | Official SDK client/router, no hand-written wire server |
| Bridge test under `tests/mcp/` or `tests/api/` | Event mapping/failure isolation | Synthetic in-memory service only |
| `tests/mcp/http-integration.test.ts` (new) | Real listener + real MCP client integration | Temporary DB, fake canonical changes, no provider network |
| `tests/mcp/stdio-modern.test.ts` | Extend current child-process acceptance | STDIO remains HTTP API client, no DB |
| `tests/mcp/legacy-compat.test.ts` (new if dual-era) | Legacy HTTP/STDIO compatibility | Do not change posture by accident |
| `tests/mcp/conformance.test.ts` or evidence map | Trace C1–C21 assertions | M6-B4 remains separately tracked |
| `docs/M6_E_LAN_ACCEPTANCE.md` (new) | Second-device procedure and run evidence | Do not claim LAN tested without execution |

## 11. Implementation order

1. **Baseline/entry review:** confirm current `develop`, M6-C closure, M6-B4 status, dependencies and official versions.
2. **D contract test first:** write tests against official SDK listen behavior with an in-memory `MarketDataService` and real SDK client; lock the stable URI and filter behavior before wiring production startup.
3. **D bridge helper:** implement the one-listener mapping, catch/report failures, unsubscribe lifecycle.
4. **D composition/capabilities:** wire the process-wide bridge, advertise `resources.subscribe` only on modern HTTP, configure bounded options, adjust shutdown ordering.
5. **D closeout:** focused suite, review changed files, no activity schema/migration/provider changes; pass §8.1.
6. **E real HTTP integration:** real-listener suite, two clients, reconnect/cancellation/graceful close with synthetic state.
7. **E STDIO/legacy:** extend the real STDIO process test; add legacy compatibility only if dual-era posture remains.
8. **E matrix and LAN:** map every mandatory C1–C21 item to evidence; perform the second-device procedure and save results.
9. **Final independent review:** focused + full tests, typecheck/build/diff-check; verify no M6-C changes were overwritten and no Stage G/M7 scope pulled in; pass §8.2 and §8.3.
10. **Documentation closeout:** update master plan/status pages only after implementation is merged and verified; this plan itself does not update them.

## 12. Reporting format

Report: exact HEAD/status before and after; files changed; bridge mapping and capability-advertisement evidence; SDK subscription evidence (ack/filter/isolation/close); read-after-notify and cursor recovery evidence; outcome-separation evidence; C1–C21 coverage table with test names; real-HTTP and STDIO evidence; legacy posture; LAN procedure location and results; commands and actual results; full-suite failures vs the accepted M6-C baseline; acceptance checklists for §8.1, §8.2 and §8.3; remaining issues. Do not claim M6-B4/D/E or M6 complete without the independent review gate. No commit/push without separate authorization.
