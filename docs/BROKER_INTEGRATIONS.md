# Broker Integrations

> **Status:** Aligned summary. Authoritative details: [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [REFERENCES.md](REFERENCES.md).
> **Last updated:** 2026-11-15

## Scope (confirmed)
- Initial providers: **Upstox** and **FYERS**. Both must operate independently and simultaneously when configured.
- App must continue working with either provider alone, or with neither (using locally available/non-broker data).
- Provider-specific logic stays inside adapters; additional providers must not require MCP/WebUI contract changes.

## Current implementation
- `packages/broker-fyers` and `packages/broker-upstox`: **placeholder scaffolds only** (no auth, connections, subscriptions, or normalization).

## Target adapter responsibilities
- Authentication and token lifecycle (secure storage, no plaintext).
- REST requests and market-data connections (protocols/encoding per official docs).
- Subscriptions/unsubscriptions, reconnect/backoff, rate/subscription limits.
- Health/error/limit reporting and normalization into canonical models with attribution/timestamps/freshness.
- Preserve provider-specific fields; never fabricate raw provider-supplied market fields.

## Verification required before implementation
- Official Upstox (current V3) and FYERS API capabilities, fields, limits, entitlements, auth/session behavior.
- Official SDK package names and **Bun compatibility** (not verified/installed).
- Secure Windows credential storage mechanism and backup/key-material implications.
- Use current official docs; do not rely on discontinued Upstox legacy endpoints.

## Safety
- Do not place orders during testing.
- Never log or expose credentials/tokens via ordinary APIs.

See [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md) for full checklists and [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md) for tracked gaps.
