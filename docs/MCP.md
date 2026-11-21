# MCP

> **Status:** Aligned summary. Authoritative details: [MCP_INTERFACE.md](MCP_INTERFACE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md).
> **Last updated:** 2026-11-20

## Current implementation (verified)
- Apps: `apps/api` (HTTP `/mcp`) and `apps/mcp-server` (STDIO); shared registration in `packages/mcp-core`
- SDK: `@modelcontextprotocol/server` 2.4.0 (v2), Zod 4
- Transports: **Streamable HTTP** at `/mcp` on the existing Hono app (SDK `createMcpHandler`, Host/Origin validation, before SPA fallback) + retained **STDIO** via `serveStdio`
- Tools (M6-B2): nine tools through one shared factory — `markethub_health`, `catalog_search`, `provider_status`, `market_snapshot`, `historical_candles`, `option_chain_snapshot`, `on_demand_retrieval`, `futures_chain`, `market_information`
- Seams (M6-B1): bounded catalog search and event-feed read with runtime-scoped cursors and always-present `resumeCursor`; endpoints `GET /api/catalog/search` and `GET /api/market/events`
- Behavior: HTTP uses injected services directly; STDIO is a thin local-API client; one canonical foundation, no duplicate market logic; STDIO stdout reserved for protocol, diagnostics to stderr
- Implemented (B3): resources/prompts, cache hints, snapshot pagination — published at `0d58bbb`
- Accepted: activity history (M6-C, closed at `32b034a`)
- Pending: subscriptions/notifications (M6-D), broad conformance/LAN acceptance (M6-E)

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
