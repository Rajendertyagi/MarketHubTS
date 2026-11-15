# Provider Integration

> **Status:** Confirmed requirements and target adapter design; no live broker integration implemented. All provider API/SDK details marked **(verify)** until confirmed against official documentation and tested compatibility.
> **Last updated:** 2026-11-15
> **Related:** [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [REFERENCES.md](REFERENCES.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)

## 1. Providers (initial)

| Provider | Role | Status |
|---|---|---|
| Upstox | Market data/auth/streaming/historical (as supported) | **Planned** — adapter scaffold only (`packages/broker-upstox`) |
| FYERS | Market data/auth/streaming/historical (as supported) | **Planned** — adapter scaffold only (`packages/broker-fyers`) |

Both must operate **independently and simultaneously** whenever configured. Additional providers may be introduced later without changing MCP or WebUI contracts.

## 2. Required provider behavior (confirmed)

| Upstox | FYERS | Expected result |
|---|---|---|
| Connected | Connected | Both operate |
| Connected | Disconnected | MarketHub continues working (Upstox) |
| Disconnected | Connected | MarketHub continues working (FYERS) |
| Disconnected | Disconnected | MarketHub still starts and operates using locally available data and non-broker sources |

- One provider disconnects: the other continues.
- A provider is removed: remaining functionality is unaffected.
- Provider-specific logic must stay inside adapters.

## 3. Adapter responsibilities (target)

Each adapter must handle (as applicable and supported):
- **Authentication & token lifecycle:** login/session/token acquisition, refresh/expiry handling, secure storage integration (no plaintext), clear auth state.
- **REST requests:** instrument/master data, quotes, historical candles, option chain/contract info, expired instruments (if supported) — **(verify per provider)**.
- **Market-data connections:** WebSocket/feed connections, encoding/decoding (e.g. protobuf/JSON as applicable) — **(verify)**.
- **Subscriptions/unsubscriptions:** manage instrument subscriptions within provider limits; reflect actual subscription state.
- **Reconnection:** resilient reconnect/backoff, resubscription, state recovery signals.
- **Rate and subscription limits:** respect and expose limits/capacity; never silently change user selections because a limit was exceeded.
- **Health and error reporting:** connection/auth/stream/data health, errors, degradation, staleness indicators.
- **Data normalization:** map provider-native data/IDs/timestamps to canonical models while preserving provider-specific fields and attribution.

## 4. Automatic source selection

- **Default:** automatic selection considering actual provider capabilities, data availability, freshness, reliability, and applicable subscription/account limits.
- **Optional:** manual provider preferences as advanced WebUI setting.
- **No fixed Upstox-first or FYERS-first dependency.**
- Preserve provider attribution and timestamps; expose why/which source is used and when unavailable.

## 5. Provider independence and failure handling

- Adapters run independently; failures isolated (no cascading corruption).
- Disconnect/reconnect does not affect other provider or other clients.
- Catalog/data operations must tolerate partial provider availability; failed/incomplete catalog sync must never destroy previous valid catalog.
- When neither provider connected, app remains operational with locally available data and non-broker sources.

## 6. Upstox — verification checklist (official docs required)

> **Use current V3/official documentation; do not base decisions on discontinued/legacy endpoints.**

| Area | What to verify | Notes |
|---|---|---|
| Official docs & APIs | Current developer portal, endpoint specs, auth flows, terms/entitlements | https://upstox.com/developer/api-documentation/ (and specific pages in [REFERENCES.md](REFERENCES.md)) |
| Market data feed (V3) | WebSocket/feed protocol, encoding (protobuf), modes, fields, subscription model/limits, redirect/auth behavior | V3 feed docs indicate websocket/redirect and protobuf-based feeds **(verify details/limits)** |
| Historical candles (V3) | Intervals/units, date ranges, instrument key format, availability/retention, rate limits | V3 historical endpoint exists; legacy historical endpoint marked deprecated in docs **(verify)** |
| Expired instruments | Expiries/contracts discovery, expired historical candle access, instrument key formats, plan/entitlement requirements | Expired instruments APIs announced/documented (some features noted as plan-specific) **(verify)** |
| Option chain / quotes / depth | Available fields (OI, IV, Greeks if provided), depth levels, snapshot/stream behavior | **(verify)**; never fabricate missing fields |
| Instruments/master data | Instrument files/keys, segments, contract metadata, update cadence | **(verify)** |
| Limits & entitlements | Connection/subscription/rate limits, plan tiers, account requirements | **(verify)**; expose clearly in UI |
| SDK/Bun compatibility | Official SDK packages (if any), Node-specific dependencies, Bun runtime compatibility | Not verified/installed |

## 7. FYERS — verification checklist (official docs required)

| Area | What to verify | Notes |
|---|---|---|
| Official docs & APIs | Current API v3 docs, auth (OAuth/token), endpoints, terms/entitlements | https://myapi.fyers.in/ , https://myapi.fyers.in/docsv3/ **(verify access/content)** |
| Market data / WebSocket | Data socket capabilities, symbol subscription limits (plan-dependent), message types/fields, depth/TBT availability, reconnect behavior | Public sources suggest plan-based symbol limits and data socket updates **(verify officially)** |
| Historical data | Candle/history APIs, intervals, ranges, limits | **(verify)** |
| Quotes/depth/option chain | Available fields (OI/IV/Greeks if provided), depth levels, option chain support | **(verify)** |
| Instruments/master data | Symbol formats, contract/master data, updates | **(verify)** |
| Limits & entitlements | Rate limits, symbol/connection limits, plan requirements | **(verify)** |
| SDK/Bun compatibility | Official SDK packages, Bun runtime compatibility | Not verified/installed |

## 8. Security and safety

- **No order placement** during testing or in product.
- Broker credentials and sensitive tokens handled responsibly: secure local storage (Windows mechanism **verify**), never stored in plaintext, never logged, never exposed through ordinary data APIs.
- Full backup/restore must account for key material/state required to recover encrypted credentials (see [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md)).

## 9. Current implementation status

- `packages/broker-upstox` and `packages/broker-fyers`: placeholder scaffolds only (no auth, no connections, no normalization).
- No provider SDKs installed; no live data flows.

## 10. Open verification items

See [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md) and [REFERENCES.md](REFERENCES.md) for tracked verification gaps (capabilities, limits, entitlements, SDK/Bun fit, exact field availability).
