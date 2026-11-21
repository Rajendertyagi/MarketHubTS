# M6-E — Protocol Conformance, Real-HTTP Integration and Compatibility Acceptance

> **Status:** Implementation plan only. Awaiting separate authorization. **No M6-E source exists yet.** This document does not implement anything.
> **Last updated:** 2026-11-21 (official MCP/SDK research re-verified this date; see §2A)
> **Depends on:** M6-A (`7860c7f`), M6-B1/B2/B3 (`0d58bbb`), **M6-C accepted and closed at `32b034a`** (acceptance record in [`M6_C_PLAN.md`](M6_C_PLAN.md) §0), M6-D (planned in [`M6_D_PLAN.md`](M6_D_PLAN.md)), and M6-B4 conformance/parity (pending).
> **Governing design:** [`M6_PLAN.md`](M6_PLAN.md) §3.1 (C1–C21 conformance matrix), §3.2 (extensions), §3.3 (modern vs legacy policy), §11 (test strategy: classes a/b/c), §12 (acceptance), §13 (gates); [`TESTING_AND_ACCEPTANCE.md`](TESTING_AND_ACCEPTANCE.md). This document adds execution detail; it does not change that design.
> **Official references:** MCP 2026-07-28 [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md) and [subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md) specifications; TypeScript SDK [support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md), [protocol versions guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md) and [latest release](https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases/latest) (`v2.4.0`, 2026-10-23). Consolidated in [`REFERENCES.md`](REFERENCES.md) §8.

## 1. Objective and boundaries

Prove M6 is complete against the **latest stable official MCP protocol** using a **real Streamable HTTP MCP client over an actual HTTP listener** — not just in-process `handler.fetch`. Verify every applicable mandatory requirement C1–C21 with a named test, both transports, simultaneous clients, error/cancellation/reconnect/shutdown, and a documented second-device LAN procedure. No new product features, no provider activation.

**In scope (M6-E):**
- `conformance.test.ts` — one named assertion per applicable C1–C21 row (class a, in-process).
- `http-integration.test.ts` — real Hono/Bun listener + real pinned `2026-07-28` Streamable HTTP client: discovery, tool execution, resource access, `subscriptions/listen` read-after-notify, simultaneous clients/subscriptions with isolation, error/cancellation/reconnect/shutdown, Host/Origin accept+reject, localhost and configured LAN interface (class c).
- `stdio-modern.test.ts` — spawn the real STDIO server, modern-pinned client: `server/discover`, per-request `_meta`, tool/resource access, `subscriptions/listen` on STDIO.
- `legacy-compat.test.ts` — **only if dual-era retained**: 2025-era clients work through `legacy: 'stateless'` / `serveStdio`, and no legacy behavior leaks into modern requests. If `legacy: 'reject'` is chosen, assert legacy openings are refused instead.
- `parity.test.ts` — MCP vs REST/SSE vs WebUI canonical state; both transports reach the same capabilities where the local API exposes them, with honest unavailable reporting otherwise.
- `security.test.ts` — no operational config mutation, no credential leakage, `isLocalPeer`/LAN boundary, bounded inputs, cancellation/timeout.
- A **documented, repeatable second-device LAN verification procedure** with expected results and failure evidence (manual artifact, not a mocked test).
- Re-verify the latest stable spec/SDK at implementation start; retarget §3.1 if a newer stable version exists.

**Out of scope — do not start (explicit):**
- New product features, tools, resources, prompts, or activity behavior; changes to B2/B3/C/D contracts.
- Provider activation / Stage G, live provider data, new dependencies, migrations, auth/RBAC, transport redesign.
- Treating an in-process `handler.fetch` test as satisfying Streamable HTTP acceptance (it does not).

**Fixed decisions:**
1. **Class (b) M6-A smoke test stays** as the transport exit gate; class (c) extends it, never replaces it.
2. **Real listener required**: `Bun.serve` on an actual port, real `StreamableHTTPClientTransport`, client pinned to `2026-07-28`.
3. **No CI claim**: results are local unless a real CI run exists; report as such.
4. **Full-suite baseline**: compare against the documented two `EBUSY` temp-dir cleanup failures; report exact failure list.

## 2. Verified baseline (re-checked against source at `32b034a`; original check at `5154ec9`)

| Fact | Evidence |
|---|---|
| Governing conformance matrix C1–C21 with phase owners and test IDs | `docs/M6_PLAN.md` §3.1:74-96 |
| Test strategy classes a/b/c and completion rule | `docs/M6_PLAN.md` §11:505-524 |
| M6-A real HTTP smoke test exists (class b) | `tests/mcp/http-smoke.test.ts` |
| STDIO modern test exists (real spawned process, pinned `2026-07-28`; the pin-mode connect exercises `server/discover` as its probe, and the test asserts `markethub_health`) | `tests/mcp/stdio-modern.test.ts:20-59` |
| Modern-pinned client pattern | `tests/mcp/*.test.ts` (`versionNegotiation: { mode: { pin: "2026-07-28" } }`) |
| Host/Origin validation in front of handler | `apps/api/src/mcp-routes.ts:17-63` |
| Handler created once, closed before server/DB | `apps/api/src/index.ts:125-129,168-177` |
| `createApp` supports config overrides for LAN host/port | `apps/api/src/app.ts` `AppDependencies` |
| STDIO entry uses shared factory with retained handle | `apps/mcp-server/src/index.ts` |
| Activity records with sanitized summaries | `packages/contracts/src/mcp-activity.ts`; `packages/mcp-core/src/activity.ts` |
| Latest stable target `2026-07-28` / SDK `2.4.0` (re-verify at start) | `docs/M6_PLAN.md` §3, `docs/REFERENCES.md` §8 |

## 2A. Official API research (fetched 2026-11-21)

Authoritative behaviors M6-E must assert against. Links are to official specification/SDK pages; version/date recorded where available.

| Official source | Verified behavior relevant to M6-E |
|---|---|
| [Spec — Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md) (2026-07-28) | Servers **MUST** implement `server/discover`. Response carries `supportedVersions`, `capabilities`, optional `instructions`, `ttlMs`/`cacheScope`, and server identity at `_meta['io.modelcontextprotocol/serverInfo']` — **not** in the body. `serverInfo` is self-reported, for display/logging/debugging only, and clients **MUST NOT** use it to drive behavior or security decisions (MarketHubTS adopts this stricter internal rule; the spec's baseline wording is "SHOULD NOT"). Clients MAY call it; on stdio it is the backward-compatibility probe. |
| [Spec — Subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md) (2026-07-28) | `subscriptions/listen` ack-first with `notifications/subscriptions/acknowledged` and `io.modelcontextprotocol/subscriptionId` in `_meta`; honored `notifications` subset; only requested types; multiple concurrent subscriptions; graceful close via successful `subscriptions/listen` result; stdio re-listen required after reconnect. |
| [SDK — support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md) (v2.4.0) | `clientInfo` is a SHOULD (optional); `DiscoverResult` has no `serverInfo` member — read via `client.getServerVersion()` or the `_meta` key. Standard headers `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` required on every modern request POST; mismatch → HTTP 400 with `-32020`. Error codes: `-32020` header mismatch, `-32021` missing required client capability (after dispatch → HTTP 400), `-32022` unsupported protocol version. Cache hints default `ttlMs: 0`/`cacheScope: 'private'` on cacheable results. Modern cancellation closes the request SSE stream; legacy/stdio use `notifications/cancelled`. In-process testing drives `createMcpHandler.fetch` with a fake URL; stdio-era coverage requires a spawned process. |
| [SDK — protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md) (v2.4.0) | `versionNegotiation`: absent/`legacy` = 2025 `initialize`; `auto` = probe with `server/discover` then fall back; `{pin:'2026-07-28'}` = modern only, no fallback. On stdio the `auto` probe uses a short-lived sibling process. Auth statuses (401/403) and 5xx are never era evidence. `getProtocolEra()` reports the landed era. Deprecation is separate from era. |
| [SDK — latest release](https://api.github.com/repos/modelcontextprotocol/typescript-sdk/releases/latest) | `v2.4.0` is still the latest stable release (published 2026-10-23); no newer stable SDK or protocol revision — target remains `2026-07-28` / SDK `2.4.0`. |

**Reconciliation with the existing plan:** the C6/C11/C12 "serverInfo in `_meta`" expectation is confirmed and must be asserted at `_meta['io.modelcontextprotocol/serverInfo']`, not in the `DiscoverResult` body. The C1/C7–C10 header checks now name the three required standard headers and the `-32020` mismatch code. The C17 listen assertions now name the exact ack notification and subscription-ID key. The per-request `_meta` observer in §4.2 should assert `clientInfo` as a SHOULD (present from this SDK, but not a MUST). No acceptance assertion depends on an unverified API assumption.

## 3. Conformance matrix coverage (C1–C21)

One named test per applicable row. Owners from §3.1; M6-E owns the **evidence aggregation** and any gaps, not reimplementation.

| Row | Evidence source | M6-E action |
|---|---|---|
| C1–C5, C7–C10, C18–C21 | `conformance.test.ts`, `http-integration.test.ts`, `security.test.ts` | Assert JSON-RPC IDs, `resultType`, error codes (`-32020`/`-32021`/`-32022`, no `-32002`/`-32042`), `_meta` rejection, `server/discover`, the three standard headers (`MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name`) and their mismatch → `-32020`, Host/Origin, no extensions, no deprecated methods (§2A) |
| C6, C11, C12, C17, C20 | `conformance.test.ts`, `subscriptions.test.ts`, `http-integration.test.ts` | Assert `serverInfo` at `_meta['io.modelcontextprotocol/serverInfo']` (not in the body), `subscriptionId` in `_meta`, SSE shape, modern cancellation via SSE close, listen ack/filter/isolation/graceful-close semantics, security (§2A) |
| C13–C16, C19 | `tools.test.ts`, `resources.test.ts`, `cache-hints.test.ts`, `conformance.test.ts` | Assert standard operations, deterministic order, opaque cursors, cache hints, no MRTR, JSON Schema |
| C14 | `snapshot-page*.test.ts`, `catalog-search.test.ts`, `event-feed.test.ts` | Assert keyset cursors across catalog/feed/activity |

Any row whose implementation is missing is a **blocker for M6 completion**, not something to paper over with a weaker assertion.

## 4. Real-HTTP integration test design

### 4.1 `http-integration.test.ts`
- Start the **actual** Hono/Bun app via `Bun.serve({ hostname, port: 0, fetch: app.fetch })` with a temp DB and empty provider collections.
- Connect a real `StreamableHTTPClientTransport` pinned to `2026-07-28`.
- Verify: `server/discover`; `markethub_health`; all nine tools callable; resources readable (including snapshot pagination); prompts gettable; `subscriptions/listen` delivers a supported notification after a canonical change and a subsequent resource read returns current data (read-after-notify).
- **Simultaneous clients**: open ≥2 clients and ≥2 subscriptions with different filters; assert isolation (one client's close/filter does not affect the other).
- **Error/cancellation/reconnect/shutdown**: invalid Host/Origin → 403; unknown method → `-32601`; abort a request stream; reconnect a listen stream from last `resumeCursor`; `handler.close()` → clients observe graceful close; clean server/DB shutdown.
- **LAN interface**: repeat discovery + one tool/resource read against the configured LAN address (from `buildMcpAllowlists` / config), with Host/Origin validation enforced. If no private LAN interface exists in the test environment, assert the allowlist logic and document the manual procedure as the LAN evidence.

### 4.2 `stdio-modern.test.ts` (incremental — already a real-process test)
- **Baseline:** the test already spawns the real STDIO server (`StdioClientTransport` with `command: process.execPath`, `args: ["apps/mcp-server/src/index.ts"]`), uses a modern-pinned client (whose connect exercises `server/discover` as the pin-mode probe), and asserts `markethub_health` (`tests/mcp/stdio-modern.test.ts:20-59`). It does **not** currently assert the discover response body. No conversion from in-process is needed.
- **Incremental additions required:** (a) per-request `_meta` evidence, (b) broader tool/resource access beyond `markethub_health`, (c) `subscriptions/listen` coverage on STDIO, and (d) an explicit `server/discover` response assertion (`supportedVersions`, `capabilities`, `_meta['io.modelcontextprotocol/serverInfo']`) so C6/C11/C12 are evidenced on STDIO rather than only implied by the probe.
- **Per-request `_meta` verification method (normative):** wrap the STDIO transport's message sink with a test-only observer that captures the raw outbound JSON-RPC frames and asserts each request carries `_meta["io.modelcontextprotocol/protocolVersion"] === "2026-07-28"` and a `clientCapabilities` object. This is an observable transport-boundary assertion, not a guess about SDK internals; the observer is test-only and does not alter production code.
- Assert stdout carries only protocol messages; diagnostics on stderr.

### 4.3 `legacy-compat.test.ts` (conditional)
- Determine the chosen posture from config/composition (`legacy: 'stateless'` default vs `legacy: 'reject'`).
- If dual-era retained: 2025-era client works; assert no legacy leakage into modern requests (no sessions, no `initialize`, no unsolicited notifications, no `resources/subscribe`).
- If `legacy: 'reject'`: assert legacy openings are refused with the unsupported-version error.

### 4.4 Second-device LAN procedure (documented artifact)
- Add `docs/LAN_VERIFICATION.md` (or a section in `TESTING_AND_ACCEPTANCE.md`): prerequisites, steps to connect a real MCP client from a second device to the configured LAN interface, expected results for discovery/tool/resource/event delivery, Host/Origin accept+reject evidence, and a results template. Mark it as a manual procedure, not a mocked test.

## 5. Parity, security and activity evidence

- `parity.test.ts`: same canonical instrument/data state via MCP, REST/SSE and WebUI; both transports reach the same capabilities where the local API exposes them (§4.1.3 of M6_PLAN.md); capabilities unavailable over STDIO are asserted as unavailable, not omitted.
- `security.test.ts`: no operational config mutation via MCP; no credentials/tokens in `_meta`, activity, errors or logs; LAN reads allowed, management loopback-only; bounded inputs; cancellation/timeout.
- Activity durability: records survive restart; `started`/`interrupted` rows detectable; data success distinct from notification failure; sanitized summaries; `ACTIVITY` retention fail-closed.

## 6. File scope

**New:** `tests/mcp/conformance.test.ts`, `tests/mcp/http-integration.test.ts`, `tests/mcp/parity.test.ts`, `tests/mcp/security.test.ts`, `tests/mcp/legacy-compat.test.ts`, `docs/LAN_VERIFICATION.md` (or a documented section in `TESTING_AND_ACCEPTANCE.md`).
**Modified:** `tests/mcp/stdio-modern.test.ts` (incremental: per-request `_meta` observer, broader tool/resource access, `subscriptions/listen` — the test is already real-process), relevant status docs (`M6_PLAN.md`, `PROJECT_STATUS.md`, `AGENTS.md`, `TESTING_AND_ACCEPTANCE.md`) only where implementation status changes.
**No dependency changes. No source changes expected** — M6-E is acceptance evidence; any implementation gap found is reported as a blocker for separate authorization, not silently fixed here.

## 7. Required tests and verification commands

- `bun test tests/mcp/conformance.test.ts` — C1–C21 named assertions.
- `bun test tests/mcp/http-integration.test.ts` — real listener, real client, all scenarios in §4.1.
- `bun test tests/mcp/stdio-modern.test.ts` — real STDIO process, modern-pinned.
- `bun test tests/mcp/legacy-compat.test.ts` — conditional posture.
- `bun test tests/mcp/parity.test.ts`, `tests/mcp/security.test.ts`.
- `bun run typecheck`, `bun run build`, `bun test`, `git diff --check`.
- Full-suite failures compared with the documented two `EBUSY` baseline failures; exact failure list reported.

## 8. Acceptance criteria

- Every applicable C1–C21 row has a named passing test; no unsupported extension advertised; no deprecated feature used for new functionality.
- Real Streamable HTTP client over an actual listener passes discovery, tools, resources, prompts, subscriptions/read-after-notify, simultaneous clients, error/cancellation/reconnect/shutdown, Host/Origin accept+reject, localhost and LAN interface.
- STDIO modern-protocol verification passes against the real process; legacy posture verified conditionally.
- Parity, security and activity durability evidence complete.
- Documented second-device LAN procedure published with expected results and failure evidence.
- Focused + full suite, typecheck, build, `git diff --check` pass locally; independent diff review before merge.
- **M6 may be declared complete only when this phase passes** — not before. B4 and D must also be complete.

## 8A. Sequencing and milestones

1. **Re-verify currency** — confirm the latest stable spec/SDK at implementation start (§2A); retarget §3.1 if a newer stable revision exists, with explicit approval before changing the target.
2. **Conformance suite (class a)** — `conformance.test.ts` with one named assertion per applicable C1–C21 row; in-process `handler.fetch` only, explicitly not Streamable HTTP acceptance.
3. **Real-HTTP integration (class c)** — `http-integration.test.ts` on an actual `Bun.serve` listener with a real pinned client; discovery, tools, resources, prompts, subscriptions/read-after-notify, simultaneous clients, error/cancellation/reconnect/shutdown, Host/Origin accept+reject, localhost and LAN interface.
4. **STDIO modern** — incremental additions to the already-real-process `stdio-modern.test.ts` (§4.2): per-request `_meta` observer, broader tool/resource access, `subscriptions/listen`.
5. **Conditional legacy posture** — `legacy-compat.test.ts` per the chosen `legacy` option; assert no legacy leakage into modern requests.
6. **Parity, security, activity durability** — `parity.test.ts`, `security.test.ts`, and restart/sanitization evidence for M6-C records.
7. **LAN procedure** — publish the documented second-device procedure with expected results and a results template (§4.4).
8. **Combined gate** — assemble evidence for the M6-E phase gate (§8B) and the M6-D+E final integration gate (§8D); independent diff review before any completion claim.

## 8B. Phase gate — definition of done for M6-E

M6-E is complete only when **all** of the following are evidenced:

- [ ] Every applicable C1–C21 row has a named passing test; no unsupported extension advertised; no deprecated feature used for new functionality.
- [ ] A real Streamable HTTP client pinned to `2026-07-28`, over an actual listener, passes discovery, tools, resources, prompts, `subscriptions/listen` read-after-notify, simultaneous clients/subscriptions with isolation, error/cancellation/reconnect/shutdown, Host/Origin accept+reject, and localhost + configured LAN interface. In-process `handler.fetch` tests are explicitly not counted as this evidence.
- [ ] STDIO modern verification passes against the real spawned process, including per-request `_meta`, broader tool/resource access and `subscriptions/listen`; legacy posture verified conditionally with no leakage into modern requests.
- [ ] Parity, security and activity-durability evidence complete; no credential leakage; no operational config mutation; bounded inputs; clean shutdown with no leaked listeners/processes.
- [ ] Documented second-device LAN procedure published with expected results and failure evidence.
- [ ] Focused + full suite, `bun run typecheck`, `bun run build`, `git diff --check` pass locally; full-suite failures compared with the accepted M6-C baseline and any new failure reported separately; independent diff review completed.
- [ ] No new product feature, provider activation/Stage G, dependency, migration, auth/RBAC or transport redesign; no change to the accepted M6-C implementation.

Implementation or passing tests alone do **not** mark the phase complete — the independent review gate is required. **M6 may be declared complete only when M6-B4, M6-D and M6-E are all accepted.**

## 8C. Risks, mitigations and rollback

| Risk | Mitigation |
|---|---|
| In-process test mistaken for real-HTTP acceptance | Class (b) smoke test retained as exit gate; class (c) requires a real listener and real client; §8B states this explicitly. |
| Target revision superseded mid-phase | Re-verify at implementation start; retarget §3.1 only with approval; record the new version in `REFERENCES.md` §8. |
| Flaky temp-dir cleanup obscures results | Compare exact failure list with the accepted baseline; report new failures separately; do not mask a real failure as a flake without isolation evidence. |
| LAN test environment lacks a private interface | Assert allowlist logic and publish the manual second-device procedure as the LAN evidence; do not claim LAN acceptance from a mocked test. |
| Acceptance finds an implementation gap | Report as a blocker for separate authorization; do not silently fix in this phase. |
| Rollback | M6-E adds tests and documentation only; no source/schema change expected. Revert the added test files and doc edits if needed; no migration to roll back. |

## 8D. Final integration gate (M6-D + M6-E together)

M6-E shares one mandatory combined gate with M6-D, defined normatively in [`M6_D_PLAN.md`](M6_D_PLAN.md) §8E: a real pinned client over an actual listener must exercise the **same** bridge/handler that M6-D wired, verify read-after-notify and graceful close, and confirm both transports expose equivalent notification semantics with STDIO re-listen after reconnect. No interface introduced by M6-D may remain untested by M6-E, and no M6-E assertion may depend on behavior M6-D did not implement. Evidence is assembled in one report referencing both phase gates; a gap in either phase blocks the combined gate and any M6-complete claim.

## 9. Failure cases and security boundaries

- No live provider calls; empty/unavailable states are honest.
- No credentials/tokens in `_meta`, activity, errors or logs; reuse `sanitizeSensitiveText`.
- Bounded test resources: temp DBs, ephemeral ports, clean shutdown; no leaked listeners/processes.
- LAN verification respects Host/Origin security; no auth framework added.

## 10. Non-goals and separate authorization boundaries

- No new product features, provider activation/Stage G, dependencies, migrations, auth/RBAC, or transport redesign.
- **Dependency:** M6-C must remain accepted and closed at `32b034a`; M6-D must be implemented and pass its phase gate ([`M6_D_PLAN.md`](M6_D_PLAN.md) §8C) before M6-E starts, because M6-E's subscription/read-after-notify assertions exercise the M6-D bridge. M6-B4 conformance/parity must also be accepted. M6-E owns all real-listener, real-client, LAN and conformance evidence; it does not reimplement M6-D functionality. The shared final gate (§8D) is required before M6 or either phase can be declared complete.
- Implementation gaps found during acceptance are reported as blockers for separate authorization, not fixed in this phase.
- No commit/push without separate authorization.

## 11. Reporting format

Report: exact HEAD/status before/after; files changed; C1–C21 coverage table with test names; real-HTTP integration evidence (listener, client pin, scenarios); STDIO modern evidence; legacy posture evidence; parity/security/activity evidence; LAN procedure location; commands and actual results; full-suite failures vs baseline; acceptance checklist; remaining issues. Do not claim M6 complete unless all gates pass. No commit/push without separate authorization.
