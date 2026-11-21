# M6-E — C1–C21 evidence map

> **Status:** Acceptance evidence assembled by M6-E. Ownership is **not** transferred: M6-A/B own their rows, M6-B4 owns its conformance/parity rows and closeout, M6-D owns C17. M6-E assembles evidence and adds real-listener assertions; it does **not** claim M6-B4 acceptance before B4 closeout.
> **Baseline:** M6-C accepted at `32b034a`; M6-D implemented at the commit recorded in the implementation report. Target protocol `2026-07-28`, SDK `2.4.0`.
> **Governing matrix:** [`M6_PLAN.md`](M6_PLAN.md) §3.1 (C1–C21).

## Ownership and evidence

| # | Requirement (short) | Owner | Evidence (named test / location) | Status |
|---|---|---|---|---|
| C1 | JSON-RPC 2.0, IDs, notifications | M6-A/B | `http-integration.test.ts` › "discovery, tools, resources, prompts, subscriptions and read-after-notify over a real listener" | evidenced |
| C2 | `resultType: "complete"` on results | M6-A/B | SDK-emitted; exercised by the same real-listener test (discover/tool results). Not asserted as a raw wire field. | SDK-enforced (not raw-asserted) |
| C3 | Error codes `-32602/-32601/-32020/-32021/-32022`; no `-32002/-32042` | M6-A/B | `http-integration.test.ts` › "malformed modern headers and unsupported methods are rejected" (400/404); individual codes not asserted. | partial (codes not individually asserted) |
| C4 | Per-request `_meta` required; missing → `-32602`+400 | M6-A | SDK-enforced; no named assertion in the current suite. | SDK-enforced (not asserted) |
| C5 | No undeclared client capabilities; `-32021` | M6-A/B | SDK capability gating; no named assertion in the current suite. | SDK-enforced (not asserted) |
| C6 | `serverInfo` in `_meta`; `subscriptionId` on listen notifications | M6-A/D | `subscriptions.test.ts` › "listen ack is first, honors only the requested URI, and notifications carry subscriptionId" (subscriptionId asserted). `serverInfo` `_meta` not asserted. | partial (subscriptionId only) |
| C7 | Version negotiation; `server/discover` MUST exist | M6-A | `http-integration.test.ts` › real-listener test; `stdio-modern.test.ts` › "modern STDIO: discover body…" | evidenced |
| C8 | Single Streamable HTTP POST endpoint | M6-A | `http-smoke.test.ts` › "pinned 2026-07-28 client discovers and calls markethub_health over /mcp" | evidenced |
| C9 | Standard headers required + mismatch → `-32020` | M6-A | `http-integration.test.ts` › "malformed modern headers and unsupported methods are rejected" (missing headers → 400); exact `-32020` code not asserted. | partial (rejection asserted, code not) |
| C10 | Origin/Host validation; unknown method → 404/`-32601` | M6-A | `http-integration.test.ts` › "Host/Origin validation and CORS preflight on the real listener" (403 bad Host) | evidenced (Host/Origin); method code not asserted |
| C11 | SSE response rules, keepalive, no `Last-Event-ID` | M6-A/D | SDK-owned; listen stream exercised in `subscriptions.test.ts` but keepalive/`Last-Event-ID` not asserted. | SDK-enforced (not asserted) |
| C12 | Cancellation via SSE close; stdio `notifications/cancelled` | M6-A/D | `subscriptions.test.ts` › "handler.close() completes an active listen stream gracefully" and "handler.close() aborts an in-flight request"; stdio cancellation not asserted. | partial (HTTP asserted, stdio not) |
| C13 | Tools/resources/prompts standard operations | M6-B | `http-integration.test.ts` › real-listener test (tools/resources/prompts); `tools.test.ts`, `resources.test.ts` | evidenced |
| C14 | Opaque pagination cursors | M6-B | `feed-sync.test.ts` › "pagination beyond 100 events via nextCursor"; `tools.test.ts`, `resources.test.ts` | evidenced |
| C15 | Cache hints on six cacheable operations | M6-A/B | `cache-hints.test.ts` | evidenced |
| C16 | MRTR `input_required` — **not used in M6** | M6-B | N/A documented in `M6_PLAN.md` §3.1; no server-initiated requests | N/A (documented) |
| C17 | `subscriptions/listen`: filter, ack-first, ID, isolation, graceful close | **M6-D** | `subscriptions.test.ts` › "listen ack is first…", "unsubscribed clients receive no notification; two subscriptions are isolated", "handler.close() completes an active listen stream gracefully"; `http-integration.test.ts` › "two concurrent subscriptions with distinct filters are isolated" | evidenced |
| C18 | Capability negotiation & extensions (none advertised) | M6-A/B | `subscriptions.test.ts` › "server/discover advertises explicit capabilities…" | evidenced |
| C19 | JSON Schema 2020-12; no remote `$ref` | M6-B | `tools.test.ts`, `security.test.ts` | evidenced |
| C20 | Security: Origin/Host, no login, no credential leakage | M6-A/B/D | `http-integration.test.ts` › "Host/Origin validation and CORS preflight…"; `security.test.ts` | evidenced |
| C21 | Deprecated features not used for new functionality | M6-A/B/D | `legacy-compat.test.ts` › "modern pinned client on the same handler uses discover, not initialize" | evidenced |

## Ownership notes

- **M6-B4 rows** (conformance/parity unit work) remain owned by B4. M6-E assembled the real-listener evidence above but does **not** claim B4 acceptance; B4 closeout is a separate gate.
- No row is marked accepted solely because an in-process `handler.fetch` test passed where the master plan requires an actual listener — `tests/mcp/http-integration.test.ts` uses a real `Bun.serve` listener and a pinned official client.
- Rows marked **SDK-enforced (not asserted)** or **partial** are honest gaps: the behavior is implemented by the pinned SDK 2.4.0 but not covered by a named assertion in the current suite. They are **not** claimed as independently verified. Closing them requires adding the named wire assertions (owner: M6-A/B for C2/C3/C4/C5/C9/C11, M6-A/D for C6 serverInfo/C12 stdio) — a separate, bounded task.
- **LAN acceptance is NOT TESTED** (no second device available) — see [`M6_E_LAN_ACCEPTANCE.md`](M6_E_LAN_ACCEPTANCE.md). Per §8.2 this blocks M6-E acceptance regardless of the matrix rows above.
- SHOULD deviations: none identified in this evidence set. Any future deviation must be recorded here with reason and owner.
