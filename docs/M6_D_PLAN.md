# M6-D — Modern Notifications, Subscriptions and Event Delivery

> **Status:** Implementation plan only. Awaiting separate authorization. **No M6-D source exists yet.** This document does not implement anything.
> **Last updated:** 2026-11-21 (official MCP/SDK research re-verified this date; see §2A)
> **Depends on:** M6-A (`7860c7f`: Streamable HTTP at `/mcp` + retained STDIO, shared factory); M6-B1/B2/B3 (`0d58bbb`: tools, resources, prompts, cache hints, snapshot pagination); **M6-C accepted and closed at `32b034a`** (durable activity history; acceptance record in [`M6_C_PLAN.md`](M6_C_PLAN.md) §0).
> **Governing design:** [`M6_PLAN.md`](M6_PLAN.md) §3.1 (C6/C11/C12/C17/C20/C21), §6 (subscription/event-delivery design), §6.1 (cursor/recovery guarantees), §7 (multi-client/lifecycle), §9.1 (activity outcomes), §10 (M6-D), §11–§12 (tests/acceptance); [`MCP_INTERFACE.md`](MCP_INTERFACE.md) §8.1. This document adds execution detail; it does not change that design.
> **Official references:** MCP 2026-07-28 [subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md) and [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md) specifications; TypeScript SDK [support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) and [protocol versions guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md); SDK [latest release](https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases/latest) (`v2.4.0`, 2026-10-23). Consolidated in [`REFERENCES.md`](REFERENCES.md) §8.

## 1. Objective and boundaries

Deliver the **notification/subscription half** of M6 using the installed SDK's `subscriptions/listen` over Streamable HTTP: clients open a filtered listen stream, receive only supported change notifications, then read data from existing resources/feeds (read-after-notify). One canonical event source (`MarketDataService.subscribe()`), one application-owned bridge to `handler.notify`, no new transport, no new dependency, no durable event store.

**In scope (M6-D):**
- Wire the SDK's `ServerEventBus` / `handler.notify` into the existing single `createMcpHandler` instance.
- One application-owned event bridge subscribing once to `MarketDataService.subscribe()` and publishing supported `ServerEvent` variants to `handler.notify`.
- `subscriptions/listen` behavior: ack-first with `subscriptionId`, only client-requested notification types, `resourceSubscriptions` URI filter on modern connections, multiple isolated concurrent subscriptions, graceful close on shutdown.
- Read-after-notify evidence: notifications carry no market payload; clients re-read `markethub://market/snapshot` / `markethub://events/live` by cursor.
- Notification outcomes recorded separately from data-operation outcomes in activity records (§9.1 of M6_PLAN.md) — no status flips.
- Bounded resources: `maxSubscriptions`, `keepAliveMs`, no per-tick rows, no unbounded buffers.
- Focused tests and regression for M6-A/B/C.

**Out of scope — do not start (explicit):**
- **M6-B4** conformance/parity milestone; **M6-E** broad integration/real-listener/LAN acceptance.
- The deprecated legacy HTTP+SSE transport; `resources/subscribe` on modern connections; Roots/Sampling/Logging; any custom standard notification type.
- Provider activation / Stage G, new dependencies, migrations (beyond the already-published `0006`), auth/RBAC, M6-A transport/CORS/Host-Origin changes.
- Changes to the nine B2 tools, seven B3 resources, three prompts, or M6-C activity contracts.
- Durable alert-event feeds (M7); `markethub://events/alerts` stays contract-only/unavailable.

**Fixed decisions:**
1. **One bridge, process-lifetime**, owned by `apps/api`, created after `hub.start()` and before the handler is used. Never inside `createMcpServer()` (the SDK calls the factory per request/connection plus a discovery probe).
2. **One canonical source**: `MarketDataService.subscribe()` — the authoritative change notifications. `LiveEventHub` transports changes to REST/SSE; it is not a second source.
3. **Supported notifications only**: `toolsChanged`, `promptsChanged`, `resourcesChanged`, `resourceUpdated(uri)` via `handler.notify`. No custom types.
4. **Read-after-notify**: notifications signal "something changed"; data comes from resource/feed reads. No market payload in notifications.
5. **Separate outcomes**: a data operation that succeeded stays `succeeded` even if a notification publish fails; record the notification outcome in the activity summary, never flip status.
6. **STDIO**: `serveStdio` routes list-changed calls onto active subscriptions; no second bridge. STDIO subscriptions are connection-scoped.

## 2. Verified baseline (re-checked against source at `32b034a`; original check at `5154ec9`)

| Fact | Evidence |
|---|---|
| One `createMcpHandler` instance created in composition; factory is pure | `apps/api/src/index.ts:125-129`; `packages/mcp-core/src/factory.ts:13-34` |
| Handler exposes `fetch`/`close`/`notify`/`bus`; no public health state | installed SDK `createMcpHandler-*.d.mts:336-360` |
| `ServerEvent` variants: `tools_list_changed`, `prompts_list_changed`, `resources_list_changed`, `resource_updated{uri}` | installed SDK `createMcpHandler-*.d.mts:115-127` |
| `ServerNotifier` = `toolsChanged()/promptsChanged()/resourcesChanged()/resourceUpdated(uri)` | installed SDK `createMcpHandler-*.d.mts:180-189` |
| `SubscriptionFilter` fields: `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions` | installed core `schemas-*.mjs:523-528` |
| Client `listen(filter, options?)` → `McpSubscription` with `honoredFilter`, `close()`, `closed: 'local'|'graceful'|'remote'` | installed client `client-*.d.mts:490-515,997` |
| `createMcpHandler` options: `bus?`, `maxSubscriptions?` (default 1024), `keepAliveMs?` (default 15000), `maxRequestBodySize?` | installed SDK `createMcpHandler-*.d.mts:294-324` |
| `MarketDataService.subscribe(listener)` is the canonical change source | `packages/market-core/src/live/service.ts:36-37` |
| `LiveEventHub` subscribes to the same source; bounded replay + `readAfter` | `packages/realtime/src/hub.ts:201-209,310` |
| `LiveChangeEvent` canonical type | `packages/contracts/src/live.ts:201` |
| Activity records have `summaryJson` for separate notification outcomes | `packages/contracts/src/mcp-activity.ts`; `packages/mcp-core/src/activity.ts` |
| Shutdown closes handler before server/DB | `apps/api/src/index.ts:168-177` |
| `markethub://events/live` resource exists with runtime-scoped cursor | `packages/mcp-core/src/resources.ts` |

## 2A. Official API research (fetched 2026-11-21)

These are the authoritative behaviors M6-D must build against. Links are to official specification/SDK pages; version/date recorded where available.

| Official source | Verified behavior relevant to M6-D |
|---|---|
| [Spec — Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md) (2026-07-28) | `subscriptions/listen` request filter is `params.notifications` with `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions: string[]`. Server **MUST NOT** send unrequested types. First message **MUST** be `notifications/subscriptions/acknowledged` with `io.modelcontextprotocol/subscriptionId` in `_meta` and the honored `notifications` subset; no notification before it. Every notification carries that subscription ID. Multiple concurrent subscriptions are demultiplexed by the listen request's JSON-RPC ID. Client cancels by closing the SSE stream (HTTP) or `notifications/cancelled` (stdio); server-initiated close **SHOULD** send a successful `subscriptions/listen` result first. On stdio the client **MUST** re-send `subscriptions/listen` after reconnect — the server holds no subscription state across reconnections. |
| [SDK — support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) (v2.4.0) | `createMcpHandler` returns `.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}` typed publish sugar over an in-process bus; supply a `ServerEventBus` for multi-process (not needed here). `serveStdio` routes the pinned instance's existing `send*ListChanged()` calls onto active subscriptions automatically — **no second bridge on STDIO**. `ClientOptions.listChanged` auto-opens a listen stream whose filter is the intersection of configured sub-options and server-advertised capabilities; `client.listen(filter)` opens one explicitly. Graceful close resolves `McpSubscription.closed === 'graceful'`; abrupt close `'remote'`. Modern cancellation closes the request SSE stream instead of POSTing `notifications/cancelled`. |
| [SDK — protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md) (v2.4.0) | `legacy` era = 2024-10-07…2025-11-25 (`initialize`); `modern` era = 2026-07-28 (per-request `_meta`). `createMcpHandler`/`serveStdio` serve both unless `legacy: 'reject'`. Change notifications are unsolicited on legacy, `subscriptions/listen`-only on modern. Deprecation (sampling/roots/logging) is separate from era. |
| [SDK — latest release](https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases/latest) | `v2.4.0` is still the latest stable release (published 2026-10-23); no newer stable SDK or protocol revision — target remains `2026-07-28` / SDK `2.4.0`. |

**Reconciliation with the existing design:** the plan's "ack-first with `subscriptionId`" (§1, §4, §8) is confirmed and now names the exact ack notification (`notifications/subscriptions/acknowledged`) and `_meta` key. The "no `resources/subscribe` on modern" decision is confirmed: use the `resourceSubscriptions` listen filter. The "one bridge, no second STDIO bridge" decision is confirmed by `serveStdio`'s automatic `send*ListChanged()` routing. The "graceful close" decision is confirmed by the `McpSubscription.closed` semantics. **New obligation:** on STDIO reconnect the client must re-open `subscriptions/listen` (server holds no state) — add this to the reconnect test in §7. No capability in this plan depends on an unverified API assumption.

## 3. Event bridge design

### 3.1 Ownership and lifecycle
- Create the bridge in `apps/api/src/index.ts` **after** `hub.start()` and alongside the handler. It is a small module (e.g. `apps/api/src/mcp-event-bridge.ts`) exporting `createMcpEventBridge(notifier, source)` → `{ start(): void; stop(): void }`.
- `start()` calls `source.subscribe((event) => { ... })` **once** and stores the unsubscribe function. `stop()` calls it. Idempotent start/stop.
- The bridge maps each canonical `LiveChangeEvent` to a supported `ServerEvent` and calls `handler.notify.*`. It never publishes market payloads — only the change signal (and URI for `resourceUpdated`).
- Mapping (normative — **live resources only**):
  - The only canonical change source is `MarketDataService.subscribe()`, whose `LiveChangeEvent` variants are `item-updated`, `item-removed` and `provider-connection-changed` (`packages/contracts/src/live.ts:178-201`). All of these affect the live snapshot.
  - Any of those variants → `notifier.resourceUpdated("markethub://market/snapshot")`. This is the single URI the bridge emits; clients re-read that resource (read-after-notify).
  - `markethub://events/live` is a bounded replay feed read by cursor, not a subscribed resource in M6-D; the bridge does **not** emit `resourceUpdated` for it. Clients poll/read it by `resumeCursor` after a notification.
  - **Historical/snapshot `resourceUpdated` is explicitly deferred** (not emitted in M6-D): historical candle caching and option-chain snapshot persistence live in `HistoricalCandleService` / `OptionChainSnapshotService`, outside `MarketDataService`. Adding hooks there would create a second change source and break the one-canonical-source invariant. The governing plan's mention of historical URIs as `resources/updated` targets (§5.3) is a future capability; M6-D does not claim it. No implementer guess is required — the bridge emits exactly one URI.
  - Capability/resource set change → `notifier.resourcesChanged()` (and `toolsChanged()`/`promptsChanged()` only if the registered set actually changes — in M6-D the static set does not change at runtime, so these are available but not emitted by the bridge).
  - Control events (`snapshot-required`, `refresh`) from the hub are **not** MCP notifications; they remain REST/SSE concerns. The bridge subscribes to `MarketDataService`, not the hub's outbound stream.
- Errors in the bridge listener are reported through the existing logger and never throw into SDK dispatch. One listener for the process lifetime; no per-request listeners.

### 3.2 Notification outcome separation
- A notification publish failure is diagnostic-only: log via `logger.warn("mcp_notification_publish_failed", ...)`; never flip a data operation's activity status.
- Where a data operation's activity record is updated after a notification attempt, record `notification: "failed"` in the safe summary (bounded, sanitized) — never change `status` from `succeeded` to `failed`.
- Notifications emitted from **background canonical changes** (not tied to an MCP data-operation callback) have no activity record to annotate: emit a bounded diagnostic log only (`logger.warn`), with **no** activity row and **no** status mutation. Activity records remain one-per-executed-callback (M6-C contract).
- No per-notification activity rows.

### 3.3 Handler configuration
- Pass an explicit `bus` (default `InMemoryServerEventBus` is acceptable for this single-process monolith) and explicit `maxSubscriptions` / `keepAliveMs` from validated config where operationally relevant. No new dependency.
- `handler.close()` on shutdown already aborts in-flight exchanges and closes listen streams gracefully (empty result before stream close).
- **Full shutdown order (normative)** — extend the current sequence in `apps/api/src/index.ts:160-181`: `coordinator.stop() → hub.stop() → bridge.stop() → handler.close() → server.stop(true) → db.close()`. Quiesce event producers (coordinator, hub) before stopping the bridge so no new events are published during teardown; stop the bridge before `handler.close()` so no publish races with listen-stream teardown. `bridge.stop()` is idempotent and completes before `handler.close()` is awaited.

## 4. `subscriptions/listen` behavior (SDK-owned)

- The SDK owns ack-first delivery, `subscriptionId` stamping, per-stream filtering, and teardown. M6-D must **not** reimplement these. The first stream message is `notifications/subscriptions/acknowledged` carrying `io.modelcontextprotocol/subscriptionId` in `_meta` and the honored `notifications` subset; no notification may precede it (§2A).
- Clients request a `SubscriptionFilter` (wire field `params.notifications`); the server honors only the supported fields and must not send unrequested notification types. `honoredFilter` on the client reflects what was agreed; clients SHOULD compare it with what they requested and degrade gracefully.
- `resourceSubscriptions` carries resource URIs for `resourceUpdated` filtering; `resources/subscribe` is 2025-only and must not be used on modern connections.
- Multiple concurrent subscriptions are isolated: one client's filter/close does not affect another. `maxSubscriptions` bounds the count.
- Graceful close on `handler.close()` → client `closed` resolves `'graceful'`; abrupt disconnect → `'remote'` and clients re-listen. Reconnect = re-open listen + re-read feed by `resumeCursor`. **On STDIO the client MUST re-send `subscriptions/listen` after a connection re-establish — the server holds no subscription state across reconnections (§2A).**
- Cancellation: on modern Streamable HTTP, client abort closes the request SSE stream (no `notifications/cancelled` POST); on STDIO, cancellation uses `notifications/cancelled` referencing the listen request ID (§2A). Both are SDK-owned.

## 5. Read-after-notify contract

- Notifications carry **no market payload** — only the change signal (and URI). Clients re-read:
  - `markethub://market/snapshot` for live quote/depth changes.
  - `markethub://events/live?after=<resumeCursor>&limit=<n>` for incremental live events (runtime-scoped cursor; `snapshot-required` on expiry/restart).
  - Stored-data resources (`markethub://snapshots/...`, `markethub://historical/...`) for historical/snapshot changes.
- Resource descriptions already state cursor kinds (B3); no change needed.
- No new endpoint for notification delivery — `subscriptions/listen` is served by the existing `/mcp` handler.

## 6. File scope

**New:** `apps/api/src/mcp-event-bridge.ts`, `tests/mcp/subscriptions.test.ts`, `tests/mcp/notification-outcomes.test.ts`.
**Modified:** `apps/api/src/index.ts` (create/start/stop bridge; explicit handler options), `apps/api/src/app.ts` (if handler options need config injection), `packages/mcp-core/src/factory.ts` (only if registration must expose list-changed hooks — prefer no change), relevant docs (`MCP_INTERFACE.md` §8.1 status, `PROJECT_STATUS.md`, `M6_PLAN.md` status lines).
**No dependency changes. No migration. No new endpoint.**

## 7. Required focused tests

- **Bridge:** subscribes once to `MarketDataService`; maps each canonical change to the correct `handler.notify.*` call; no market payload in published events; listener errors are logged and non-fatal; start/stop idempotent; stop before handler close.
- **SDK semantics (in-process, pinned `2026-07-28`):** ack-first with `subscriptionId`; only requested notification types arrive; `resourceSubscriptions` URI filter works; multiple concurrent subscriptions isolated; `maxSubscriptions` bound; graceful close resolves `'graceful'`; abrupt close resolves `'remote'`; no `resources/subscribe` on modern; no deprecated methods.
- **Read-after-notify:** a notification is followed by a resource read returning current data; `events/live` `resumeCursor` advances; `snapshot-required` is explicit on expiry/restart.
- **Outcome separation:** a data operation that persists successfully stays `succeeded` when notification publish fails; failure recorded in safe summary only; no per-notification activity rows.
- **Regression:** M6-A transport/security/lifecycle, B2 tools, B3 resources/prompts/cache hints, C activity all green.

## 8. Acceptance criteria

- `subscriptions/listen` delivers only supported, client-requested notifications with ack-first `subscriptionId` and graceful close (C17).
- One canonical event source; one process-lifetime bridge; no per-request listeners; no duplicate market logic.
- Read-after-notify verified: notifications carry no payload; clients re-read resources/feeds by cursor.
- Notification failures never flip data-operation status; recorded separately in safe summaries.
- Multiple concurrent subscriptions isolated; `maxSubscriptions` and keepalive explicit; no unbounded buffers.
- No legacy HTTP+SSE, `resources/subscribe`, custom notification types, providers/Stage G, new deps, migrations, or B4/E work.
- Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; full suite shows no new failures vs baseline; independent diff review before merge.

## 8A. Sequencing and milestones

Implementation order (each milestone independently verifiable; no milestone is "done" until its tests pass):

1. **Handler wiring** — pass an explicit `bus` and bounded `maxSubscriptions`/`keepAliveMs` to the single `createMcpHandler`; confirm no behavior change to existing tools/resources/prompts.
2. **Event bridge module** — `apps/api/src/mcp-event-bridge.ts` with idempotent `start()`/`stop()` and the single-URI mapping from §3.1; unit-test the mapping and listener-error containment before wiring it into composition.
3. **Composition and shutdown** — create/start the bridge after `hub.start()`; insert `bridge.stop()` into the §3.3 shutdown order; verify no publish after teardown begins.
4. **Subscription semantics tests** — in-process, pinned `2026-07-28`: ack-first, honored filter, `resourceSubscriptions` URI filter, isolation, `maxSubscriptions`, graceful/remote close, no deprecated methods.
5. **Read-after-notify tests** — notification followed by resource/feed read; `resumeCursor` advance; `snapshot-required` on expiry/restart; STDIO re-listen after reconnect.
6. **Outcome-separation tests** — notification publish failure leaves data-operation status `succeeded`; no per-notification activity rows.
7. **Regression and review** — M6-A/B1/B2/B3/C suites green; full diff review; acceptance evidence assembled for the M6-D gate (§8C) and the combined gate (§8E).

## 8B. Error handling, retries, timeouts and cancellation

- **Bridge listener errors** are contained: log via the existing logger and never throw into SDK dispatch. A failed `handler.notify.*` publish is diagnostic-only (§3.2) and never flips a data-operation status.
- **No new retry loop for notifications.** The canonical service already owns change production; the bridge is a thin signal forwarder. A dropped notification is recovered by the client's read-after-notify (re-read by cursor), not by bridge retries — this avoids duplicate signals and a second change source.
- **Timeouts/bounds** are SDK-owned for listen streams (`keepAliveMs`, `maxSubscriptions`); M6-D sets them explicitly and does not add its own timers. Feed reads use the existing bounded page limits.
- **Cancellation** follows §2A/§4: modern HTTP closes the request SSE stream; STDIO uses `notifications/cancelled`. Client abort must not leave a bridge listener or activity row behind.
- **Reconnect** is client-driven: re-open `subscriptions/listen` (mandatory on STDIO) and re-read the feed from the last `resumeCursor`; `snapshot-required` is handled explicitly. No server-side subscription persistence is introduced.

## 8C. Phase gate — definition of done for M6-D

M6-D is complete only when **all** of the following are evidenced:

- [ ] One process-lifetime bridge from `MarketDataService.subscribe()` to `handler.notify`, emitting exactly `markethub://market/snapshot`; no per-request listeners, no second source, no market payload in notifications.
- [ ] `subscriptions/listen` verified in-process (pinned `2026-07-28`): ack-first `notifications/subscriptions/acknowledged` with `subscriptionId`, honored-filter subset, only requested types, `resourceSubscriptions` URI filter, multiple isolated subscriptions, `maxSubscriptions` bound, graceful `'graceful'` / abrupt `'remote'` close, no `resources/subscribe` or deprecated methods.
- [ ] Read-after-notify verified: notification → resource/feed read by cursor; `resumeCursor` advances; `snapshot-required` explicit on expiry/restart; STDIO re-listen after reconnect.
- [ ] Notification failures are diagnostic-only; data-operation status unchanged; no per-notification activity rows.
- [ ] Shutdown order `coordinator → hub → bridge → handler → server → db` verified; no publish after teardown begins.
- [ ] Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; full suite shows no new failures vs the accepted M6-C baseline; independent diff review completed.
- [ ] No M6-B4/E/Stage G work, no new dependency/migration/endpoint, no change to M6-C accepted implementation.

Implementation or passing tests alone do **not** mark the phase complete — the independent review gate is required.

## 8D. Risks, mitigations and rollback

| Risk | Mitigation |
|---|---|
| Bridge becomes a second change source | Subscribe only to `MarketDataService`; never to hub outbound or historical/snapshot services; single URI emitted (§3.1). |
| Notification publish failure corrupts data-operation outcome | Diagnostic-only logging; status computed before completion; no status flips (§3.2). |
| Teardown race publishes to a closing stream | `bridge.stop()` before `handler.close()` in the normative shutdown order (§3.3). |
| STDIO duplicate bridge or missed re-listen | `serveStdio` routes `send*ListChanged()` automatically (§2A); no second bridge; reconnect test asserts re-listen. |
| Unbounded subscriptions/buffers | Explicit `maxSubscriptions`/`keepAliveMs`; no per-tick rows; bounded feed pages. |
| Rollback | Bridge is additive and isolated in one new module plus composition/shutdown edits; disable by not starting the bridge (no schema/data change). Revert the composition edits if a defect appears; no migration to roll back. |

## 8E. Final integration gate (M6-D + M6-E together)

Individually passing phases must not leave incompatible interfaces. Before M6-D or M6-E can be declared complete, the combined work must pass one end-to-end gate:

- A real pinned `2026-07-28` client over an actual listener opens `subscriptions/listen`, receives a supported notification after a canonical change, re-reads `markethub://market/snapshot` and `markethub://events/live` by cursor, and observes graceful close on shutdown — using the **same** bridge and handler that M6-D wired.
- The same client set verifies discovery, tools, resources and prompts over both transports with no duplicate market logic and no deprecated methods.
- STDIO and HTTP expose the same notification semantics; STDIO re-listen after reconnect is verified.
- No interface introduced by M6-D is left untested by M6-E, and no M6-E acceptance assertion depends on behavior M6-D did not implement.
- Evidence is assembled in one report referencing both phase gates; a gap in either phase blocks the combined gate.

## 9. Failure cases and security boundaries

- No credentials/tokens/market payloads in notifications or activity summaries; reuse `sanitizeSensitiveText`.
- LAN reads and listen streams follow the existing Host/Origin + LAN-read model; no new auth framework.
- Bounded subscriptions, bounded feed pages, bounded summaries; no per-tick rows.
- Shutdown order: bridge.stop() → handler.close() → server.stop() → db.close().

## 10. Non-goals and separate authorization boundaries

- B4 conformance/parity, M6-E integration/LAN, Stage G/provider activation — all excluded.
- **Dependency:** M6-C must remain accepted and closed at `32b034a` before M6-D starts; M6-D must pass its own phase gate (§8C) before M6-E begins. M6-E owns all real-listener, real-client, LAN and conformance evidence; M6-D owns only the bridge and in-process subscription semantics. The shared final gate (§8E) is required before either phase can be declared complete.
- No commit/push without separate authorization.

## 11. Reporting format

Report: exact HEAD/status before/after; files changed; bridge mapping evidence; SDK subscription evidence (ack/filter/isolation/close); read-after-notify evidence; outcome-separation evidence; test commands and actual results; full-suite failures vs baseline; acceptance checklist; remaining issues. Do not claim M6-B4/E or M6 complete. No commit/push without separate authorization.
