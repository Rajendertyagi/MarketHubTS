# MCP

> **Status:** Aligned summary. Authoritative details: [MCP_INTERFACE.md](MCP_INTERFACE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md).
> **Last updated:** 2026-11-15

## Current implementation (verified scaffold)
- App: `apps/mcp-server`
- SDK: `@modelcontextprotocol/server` 2.4.0 (v2), Zod 4
- Transport: **STDIO** via `serveStdio` from `@modelcontextprotocol/server/stdio`
- Tool: `markethub_health` (no inputs) — fetches `${MARKETHUB_API_URL:-http://localhost:3001}/health`, validates against shared contract, returns result. Reuses local API (no duplicate logic).
- STDIO rules: stdout reserved for MCP protocol messages; diagnostics to stderr.

## Target (confirmed; research verified 2026-11-19)
- MCP is a **primary interface** backed by shared application services/canonical data (no separate market calculations).
- **Latest stable official MCP protocol is a mandatory product requirement**, not merely a working HTTP endpoint (verified target `2026-07-28` / SDK `2.4.0`; re-verify at implementation start and retarget if newer stable versions exist).
- **Transports:** Streamable HTTP primary network transport, fully implemented and working at `/mcp` over localhost and configured LAN with Host/Origin security; SSE-based event/subscription delivery **inside** Streamable HTTP via `subscriptions/listen`; STDIO retained for compatibility but not a substitute. **Deprecated legacy HTTP+SSE, Roots, Sampling and Logging are not used for new features.** Mandatory conformance matrix, extension decisions and completion rule in [M6_PLAN.md](M6_PLAN.md) §3.1–§3.3.
- Multiple simultaneous clients, shared canonical data/services, client isolation.
- Comprehensive market data tools/resources/events and workflow tools (watchlists/alerts/scanners) within permission boundaries.
- **Alert-event delivery (target, verify):** durable MarketHub trigger records/history + discoverable alert-event resources/feeds; use supported MCP 2026-07-28 `subscriptions/listen` notifications (e.g. `resources/updated`, list changes as applicable) with client read-after-notify, event IDs/cursors/sequence for no-miss/reconnect recovery, independent multi-client consumption, and polling/tool fallback. Do not invent arbitrary alert-trigger notification types.
- AI may do on-demand retrieval without mutating operational settings; **cannot** modify operational configuration (credentials, connections, streaming/sync/capture, retention, preferences, startup/network).
- Strict input validation, graceful shutdown, never expose credentials/tokens.

See [MCP_INTERFACE.md](MCP_INTERFACE.md) for full capability/permission design and [REFERENCES.md](REFERENCES.md) for official MCP sources.
