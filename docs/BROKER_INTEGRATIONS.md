# Broker Integrations

> **Status:** Aligned summary. Authoritative details: [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [REFERENCES.md](REFERENCES.md).
> **Last updated:** 2026-11-17

## Scope (confirmed)
- Initial providers: **Upstox** and **FYERS**. Both must operate independently and simultaneously when configured.
- App must continue working with either provider alone, or with neither (using locally available/non-broker data).
- Provider-specific logic stays inside adapters; additional providers must not require MCP/WebUI contract changes.

## Current implementation (M3 + M4 Stages A/B/D, published)
- `packages/broker-upstox`: Analytics Token REST validation adapter and Upstox V3 SDK streaming adapter (`upstox-js-sdk@2.31.0`, pinned) for market-data streaming only.
- `packages/broker-fyers`: V3 non-trading-app OAuth adapter with loopback callback. Data Socket streaming (Stage C) is studied but on hold.
- Encrypted SQLite credential store with portable key file; independent provider registry; loopback-only privileged management API; LAN-safe read-only status.
- M4 Stage D adds canonical live normalization/freshness/source selection, bounded in-memory state, subscription persistence, a realtime hub, REST/SSE market endpoints and a supervisor. Production uses a locked/disabled driver: no real SDK construction, socket or provider connection is attempted. No live authentication or real market data flows.

## Target adapter responsibilities
- Authentication and token lifecycle (secure storage, no plaintext).
- REST requests and market-data connections (protocols/encoding per official docs).
- Subscriptions/unsubscriptions, reconnect/backoff, rate/subscription limits.
- Health/error/limit reporting and normalization into canonical models with attribution/timestamps/freshness.
- Preserve provider-specific fields; never fabricate raw provider-supplied market fields.

## M3 readiness (verified 2026-11-16)
- Upstox: **Analytics Token** (free, read-only, 1-year, no OAuth/static IP for market data); validate with `GET /v2/market/status/NSE`. No daily OAuth or trading APIs in M3.
- FYERS: V3 individual-app OAuth using a **non-trading (data-only) app** (no static IP, no order placement); loopback callback matching the registered redirect URI; daily 6:30 AM expiry; no assumed refresh.
- HTTP: Bun native `fetch` for auth/REST; the pinned Upstox SDK is used only for market-data streaming (M4-B).
- Credentials: portable encrypted SQLite + local key file (AD-021); no Windows/OS credential store, no plaintext.
- Limits: no hardcoded caps; FYERS Standard limits as of 16 Oct 2026; report actual capability/restrictions.
- Full source list and details: [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [REFERENCES.md](REFERENCES.md).

## Still to verify
- Actual account entitlements and Analytics Token generation on the account.
- Exact provider field availability and feed protocols (M4/M5).
- Backup/restore design with key material (M9).

## Safety
- Do not place orders during testing.
- Never log or expose credentials/tokens via ordinary APIs.

See [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md) for full checklists and [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md) for tracked gaps.
