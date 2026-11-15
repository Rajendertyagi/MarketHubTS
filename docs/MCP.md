# MCP

> **Status:** Aligned summary. Authoritative details: [MCP_INTERFACE.md](MCP_INTERFACE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md).
> **Last updated:** 2026-11-15

## Current implementation (verified scaffold)
- App: `apps/mcp-server`
- SDK: `@modelcontextprotocol/server` 2.4.0 (v2), Zod 4
- Transport: **STDIO** via `serveStdio` from `@modelcontextprotocol/server/stdio`
- Tool: `markethub_health` (no inputs) — fetches `${MARKETHUB_API_URL:-http://localhost:3001}/health`, validates against shared contract, returns result. Reuses local API (no duplicate logic).
- STDIO rules: stdout reserved for MCP protocol messages; diagnostics to stderr.

## Target (confirmed/planned, verify transport semantics)
- MCP is a **primary interface** backed by shared application services/canonical data (no separate market calculations).
- **Transports:** Streamable HTTP primary network transport; SSE-based event/subscription delivery per current MCP spec; assess legacy HTTP+SSE only for compatibility; retain/document STDIO. **(verify 2026-07-28 spec/SDK details)**
- Multiple simultaneous clients, shared canonical data/services, client isolation.
- Comprehensive market data tools/resources/events and workflow tools (watchlists/alerts/scanners) within permission boundaries.
- AI may do on-demand retrieval without mutating operational settings; **cannot** modify operational configuration (credentials, connections, streaming/sync/capture, retention, preferences, startup/network).
- Strict input validation, graceful shutdown, never expose credentials/tokens.

See [MCP_INTERFACE.md](MCP_INTERFACE.md) for full capability/permission design and [REFERENCES.md](REFERENCES.md) for official MCP sources.
