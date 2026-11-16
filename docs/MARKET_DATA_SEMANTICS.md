# Market Data Semantics

> **Status:** Aligned summary. Authoritative details: [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [ARCHITECTURE.md](ARCHITECTURE.md).
> **Last updated:** 2026-11-16

## Current state
M1/M2 implement the application foundation and canonical catalog domain foundation (contracts, identity, persistence, transactional sync primitives) with synthetic/test validation. **Live market data processing/normalization, provider ingestion, historical/option-chain pipelines, and consumer-facing market surfaces are not implemented.** No raw provider-supplied market fields are fabricated.

## Confirmed canonical rules (target)
- **Single source of truth** for instrument identity, symbol normalization, exchange/segment, quotes, depth, OHLC candles, timestamps, ordering, and freshness.
- Broker adapters normalize into canonical formats; UI/charts/MCP/REST consumers use canonical outputs only.
- No duplicate candle/market calculations across frontend components or adapters.
- Preserve provider attribution, original observation timestamps (where available), and explicit freshness/availability state.
- Preserve provider-specific fields without losing original information.
- **Never fabricate** raw provider-supplied market fields (OI, IV, option Greeks, prices, market depth, volume); report unavailable when missing.
- Technical indicators (EMA/SMA/RSI/MACD etc.) are permitted only as **separately labelled derived indicators**.

## Lifecycle semantics (confirmed)
- Live ticks/quotes/depth: in-memory only, not persisted per event; repopulated from streams after restart.
- Historical candles: retrieved on demand/user-configured sync, cached locally, preserved across disconnect/removal, gap-filled from suitable provider when available.
- Option-chain snapshots: separate persistent store per WebUI capture config; MCP on-demand does not change capture config.

## To be defined/verified from official sources
- Timestamp conventions and timezone handling per broker/feed.
- Candle aggregation/update semantics and late/out-of-order event handling.
- Depth/quote/option-chain field mappings for FYERS and Upstox.
- Freshness/staleness thresholds and reconnect gap behavior.
- Market-wide dataset definitions and source limitations.

Reference behavior from existing MarketHub and sanitized fixtures may inform expectations, but defective behavior must not be reproduced.
