# M6-E — C1–C21 evidence map

> **Status:** Acceptance evidence assembled by M6-E. Ownership is **not** transferred: M6-A/B own their rows, M6-B4 owns its conformance/parity rows and closeout, M6-D owns C17. M6-E assembles evidence and adds real-listener assertions; it does **not** claim M6-B4 acceptance before B4 closeout.
> **Baseline:** M6-C accepted at `32b034a`; M6-D implemented at the commit recorded in the implementation report. Target protocol `2026-07-28`, SDK `2.4.0`.
> **Governing matrix:** [`M6_PLAN.md`](M6_PLAN.md) §3.1 (C1–C21).

## Ownership and evidence

| # | Requirement (short) | Owner | Evidence (test / location) | Status |
|---|---|---|---|---|
| C1 | JSON-RPC 2.0, IDs, notifications | M6-A/B | `tests/mcp/http-integration.test.ts` (real listener), `tests/mcp/transport.test.ts` | evidenced |
| C2 | `resultType: "complete"` on results | M6-A/B | `tests/mcp/http-integration.test.ts` (SDK emits; discover/tool results) | evidenced |
| C3 | Error codes `-32602/-32601/-32020/-32021/-32022`; no `-32002/-32042` | M6-A/B | `tests/mcp/http-integration.test.ts` (Host/Origin 403, unknown method), `tests/mcp/transport.test.ts` | evidenced |
| C4 | Per-request `_meta` required; missing → `-32602`+400 | M6-A | `tests/mcp/transport.test.ts`, SDK-enforced | evidenced |
| C5 | No undeclared client capabilities; `-32021` | M6-A/B | SDK capability gating; `tests/mcp/transport.test.ts` | evidenced |
| C6 | `serverInfo` in `_meta`; `subscriptionId` on listen notifications | M6-A/D | `tests/mcp/subscriptions.test.ts` (subscriptionId), `tests/mcp/stdio-modern.test.ts` (discover body) | evidenced |
| C7 | Version negotiation; `server/discover` MUST exist | M6-A | `tests/mcp/http-integration.test.ts`, `tests/mcp/stdio-modern.test.ts` | evidenced |
| C8 | Single Streamable HTTP POST endpoint | M6-A | `tests/mcp/http-smoke.test.ts`, `tests/mcp/http-integration.test.ts` | evidenced |
| C9 | Standard headers required + mismatch → `-32020` | M6-A | `tests/mcp/http-smoke.test.ts` (CORS preflight), `tests/mcp/http-integration.test.ts` | evidenced |
| C10 | Origin/Host validation; unknown method → 404/`-32601` | M6-A | `tests/mcp/http-integration.test.ts` (403 bad Host), `tests/mcp/http-smoke.test.ts` | evidenced |
| C11 | SSE response rules, keepalive, no `Last-Event-ID` | M6-A/D | `tests/mcp/subscriptions.test.ts` (listen stream), `tests/mcp/http-integration.test.ts` | evidenced |
| C12 | Cancellation via SSE close; stdio `notifications/cancelled` | M6-A/D | `tests/mcp/subscriptions.test.ts` (sub.close), `tests/mcp/stdio-modern.test.ts` | evidenced |
| C13 | Tools/resources/prompts standard operations | M6-B | `tests/mcp/tools.test.ts`, `tests/mcp/resources.test.ts`, `tests/mcp/http-integration.test.ts` | evidenced |
| C14 | Opaque pagination cursors | M6-B | `tests/mcp/tools.test.ts`, `tests/mcp/resources.test.ts`, `tests/mcp/feed-sync.test.ts` | evidenced |
| C15 | Cache hints on six cacheable operations | M6-A/B | `tests/mcp/cache-hints.test.ts` | evidenced |
| C16 | MRTR `input_required` — **not used in M6** | M6-B | N/A documented in `M6_PLAN.md` §3.1; no server-initiated requests | N/A (documented) |
| C17 | `subscriptions/listen`: filter, ack-first, ID, isolation, graceful close | **M6-D** | `tests/mcp/subscriptions.test.ts`, `tests/mcp/http-integration.test.ts` | evidenced |
| C18 | Capability negotiation & extensions (none advertised) | M6-A/B | `tests/mcp/subscriptions.test.ts` (discover capabilities) | evidenced |
| C19 | JSON Schema 2020-12; no remote `$ref` | M6-B | `tests/mcp/tools.test.ts`, `tests/mcp/security.test.ts` | evidenced |
| C20 | Security: Origin/Host, no login, no credential leakage | M6-A/B/D | `tests/mcp/http-integration.test.ts`, `tests/mcp/security.test.ts` | evidenced |
| C21 | Deprecated features not used for new functionality | M6-A/B/D | `tests/mcp/legacy-compat.test.ts` (modern path uses discover, not `resources/subscribe`) | evidenced |

## Ownership notes

- **M6-B4 rows** (conformance/parity unit work) remain owned by B4. M6-E assembled the real-listener evidence above but does **not** claim B4 acceptance; B4 closeout is a separate gate.
- No row is marked accepted solely because an in-process `handler.fetch` test passed where the master plan requires an actual listener — `tests/mcp/http-integration.test.ts` uses a real `Bun.serve` listener and a pinned official client.
- SHOULD deviations: none identified in this evidence set. Any future deviation must be recorded here with reason and owner.
