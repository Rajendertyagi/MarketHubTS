# Product Requirements

> **Status:** Confirmed product requirements and boundaries (authoritative). Items marked **(verify)** require official-source verification before implementation.
> **Last updated:** 2026-11-16
> **Related:** [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [MCP_INTERFACE.md](MCP_INTERFACE.md), [WEBUI_AND_CONFIGURATION.md](WEBUI_AND_CONFIGURATION.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md)

## 1. Product identity

- **Name:** MarketHubTS
- **Type:** AI-first, local-first Indian stock-market data platform focused on comprehensive NSE and BSE F&O market information.
- **Product direction:** MarketHubTS is the **only intended future MarketHub application** — a clean, independent TypeScript solution. The original Python MarketHub is a **reference for domain knowledge and useful requirements only**; do not migrate, copy, or automatically reproduce its code, architecture, or accumulated complexity.
- **Primary purpose:** collect, normalize, organize, maintain, and expose market data.
- **Users/consumers:** humans (WebUI) and AI agents/applications (MCP, REST/SSE). They decide how to use supplied information. **Single-user means one local application owner, not one connected client.**

## 2. Confirmed exclusions (never part of the product)

- Order placement, modification, or cancellation.
- Automated trading.
- Broker positions, holdings, funds/margin, personal broker trade history.
- AI trading recommendations, predictions, or buy/sell signals.
- Sentiment analysis.
- Chat.
- General CSV/Excel market-data export.
- **Separate note:** watchlist import/export, where retained from existing MarketHub, is separate from general market-data export.

## 3. Required later-phase features (must be preserved in architecture/roadmap)

- News integration.
- X/Twitter integration.
- Market-wide information (as applicable/available).

These are **phased priorities, not unwanted features**, and must not be forgotten or removed from long-term architecture/roadmap.

## 4. Confirmed market coverage

### 4.1 NSE
- Major NSE indices via a discoverable, catalogue-based approach (cash/index market data exposure; distinct from approved index F&O underlyings — see [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md) for catalogue architecture, official-category organization, and configuration/availability rules; exact enabled/core set requires product confirmation).
- NSE F&O stocks.
- NSE cash-market instruments for supported F&O stocks.
- Futures and options for supported stock underlyings.
- Futures and options for currently eligible NSE index-derivative underlyings (approved six below).
- Current and expired contracts.
- All relevant expiries and available strikes.

**Six NSE index F&O underlyings accepted during product discovery (names/actual exchange eligibility and currently available contracts must be verified against current official exchange information before implementation; do not rely on older hardcoded registries):**
1. NIFTY 50
2. BANK NIFTY
3. FINNIFTY
4. MIDCPNIFTY
5. NIFTY NEXT 50
6. NIFTY India FPI 150

### 4.2 BSE
- SENSEX.
- SENSEX futures and options.

**Explicitly out of scope (BSE):** BANKEX derivatives, SENSEX50 derivatives, other BSE stock derivatives, other unsupported BSE derivatives. Do not broaden supported universe simply because a broker supplies additional instruments.

### 4.3 Catalog dynamics
- Catalog must dynamically follow official exchange instrument and contract information.
- Do not permanently hardcode changing contract lists, lot sizes, expiries, strike schemes, or quantity freezes.

### 4.4 Market-wide information (retain where applicable)
- India VIX.
- Major indices.
- Advance/decline and market breadth.
- Sector indices and sector data.
- FII/DII information.
- Participant-wise derivatives OI.
- Relevant exchange reports and bhavcopies.
- Exchange trading calendars and market status.

Document source and availability limitations for each dataset (see [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [REFERENCES.md](REFERENCES.md)).

## 5. Provider and data architecture requirements

### 5.1 Initial providers
- Upstox and FYERS. Both must operate independently and simultaneously whenever configured.

### 5.2 Required provider behavior
| Upstox | FYERS | Expected behavior |
|---|---|---|
| Connected | Connected | Both operate |
| Connected | Disconnected | MarketHub continues working (Upstox) |
| Disconnected | Connected | MarketHub continues working (FYERS) |
| Disconnected | Disconnected | MarketHub still starts and operates using locally available data and non-broker sources |

- One provider disconnects: the other continues.
- A provider is removed: remaining functionality is unaffected.
- Additional providers can be introduced later without changing MCP or WebUI contracts.
- Provider-specific logic must stay inside adapters.

### 5.3 Automatic source selection (default)
- Selection must consider actual provider capabilities, data availability, freshness, reliability, and applicable subscription/account limits.
- Optional manual provider preferences may be introduced as an advanced WebUI setting.
- No fixed Upstox-first or FYERS-first dependency.
- Preserve provider attribution and timestamps.

### 5.4 Data normalization and truthfulness
Provide: (1) stable canonical fields shared across providers; (2) additional provider-specific fields preserved without losing original information; (3) source/provider attribution; (4) original provider observation timestamps where available; (5) explicit data freshness and availability state.

- New provider fields must not require consumers to change workflows or require a new MCP tool for every individual field.
- Raw values must not be fabricated.
- **Must not calculate missing provider-supplied market fields:** OI, IV, option Greeks, prices, market depth, volume. If unavailable, report unavailable.
- **Permitted:** technical chart indicators (EMA, SMA, RSI, MACD, etc.) as separately labelled derived indicators — not confused with provider-supplied raw data.

## 6. Data lifecycle requirements

### 6.1 Live data
- Live ticks, quotes, and market-depth updates remain in memory for display and consumption.
- Do not permanently store every incoming tick or every market-depth change.
- Live state is repopulated from connected provider streams after restart.
- Live data must carry source, timestamp, and freshness information.

### 6.2 Historical data
- Use historical APIs offered by connected brokers.
- Retrieve historical data when requested; support user-configured historical synchronization.
- Cache successfully retrieved historical candles locally.
- Preserve historical data when brokers disconnect or are removed.
- Retrieve missing historical periods from another suitable provider when available.
- Clearly report unavailable periods and provider restrictions.
- Do not duplicate entire broker historical databases without a demonstrated requirement.

### 6.3 Option-chain snapshots
- Separate persistent storage strategy; captured locally according to WebUI configuration.
- Configuration must support: underlying, expiry, all available strikes or selected strike ranges, capture/snapshot selection, streaming selection independently of snapshot capture.
- Do not claim access to snapshots from before local collection began unless a provider actually supplies that historical information.
- MCP one-time option-chain requests must not change saved snapshot-capture configuration.

### 6.4 Retention
- Users control retention settings through WebUI. Do not invent a permanently fixed retention policy.

## 7. Common instrument catalog (foundational)

Shared by Dashboard, Market data, Watchlists, Charts, Options, Futures, Alerts, Scanners, Historical data, REST, and MCP.

Must document/support: canonical instrument identity; exchange and segment identity; underlying identity; provider-native identifiers and mappings; instrument aliases; futures/options contract identity; expiry; strike; option type; lot size; tick size; quantity freeze (where applicable); active/expired contract status; source and synchronization metadata.

- Distinguish canonical identity from provider-native identifiers.
- Catalog synchronization must be transactional and safe: failed/incomplete syncs must never destroy the previous valid catalog.
- Explain evolution when contracts are introduced, modified, expired, excluded, or removed.

## 8. MCP and AI requirements (summary)

- MCP is a primary interface. Expose comprehensive market data and AI workflow management via shared backend services (no separate market calculations in MCP).
- **Transports (planned/verify):** Streamable HTTP primary network transport; SSE-based event/subscription delivery under current MCP spec; assess legacy HTTP+SSE only if required for compatibility; retain/document STDIO per scaffold/compatibility needs. Multiple simultaneous clients; shared canonical data/services; client isolation.
- **AI may:** discover/search instruments, access quotes/depth/candles/option chains/futures/OI/IV/Greeks/market-wide data/reports/freshness, one-time on-demand retrieval, manage watchlists/alerts/scanners and retrieve history/results, subscribe to applicable alert events.
- **On-demand:** may fetch data for instruments not in configured streaming/sync selections without silently modifying operational settings; historical candles may be cached; option-chain snapshot persistence remains governed by WebUI capture config.
- **AI must NOT modify operational config:** broker credentials/config, provider connections, streaming selections, historical sync settings, option-chain capture settings, data retention, provider selection preferences, application startup/network configuration.
- **Alert delivery (configurable):** WebUI notifications/history, desktop notifications, MCP event delivery, webhooks.

Details: [MCP_INTERFACE.md](MCP_INTERFACE.md).

## 9. Alerts and scanners

- Distinct services with shared condition-definition infrastructure where appropriate.
- **Alerts:** AI (MCP) and humans (WebUI) create/manage; shared definitions and trigger history; canonical and provider-specific fields; configurable conditions/combinations (AND/OR, thresholds, crossings, supported comparisons) — do not invent unsupported fields/operators; clear waiting/active/unavailable/triggered states.
  - **Crucial:** if alert requires instrument not enabled for streaming — save alert, mark waiting for streaming, explain missing config, do not auto-subscribe, activate after user enables via WebUI. AI must never bypass.
- **Scanners:** manual, scheduled, and continuous evaluation from incoming live data (all configurable). AI may create/manage definitions and request executions via MCP; WebUI controls operational schedules and streaming selections. Never silently subscribe to additional instruments. Identify stale/unavailable/not-streamed limitations explicitly in results.

## 10. WebUI and operational configuration

- WebUI is human-facing interface and **operational control centre**. Keep simple to configure; avoid hidden fixed policies/unnecessary complexity.
- **Configurable areas:** broker credentials/connections, provider enable/disable, startup/background, LAN access/app address, streaming selections, historical sync selections/schedules, option-chain snapshot config (underlying/expiry/strikes/capture/streaming), retention, provider preferences, alert delivery, scanner operation, dashboard layout, chart preferences, table columns/sorting, watchlist layout, logging/diagnostics, backup/restore. Sensible defaults, configurable behavior.
- Provider restrictions exposed clearly; never silently change user selections because an API limit was exceeded.
- **Customization:** dashboard widgets/layout, rearrangeable panels, show/hide modules, custom table columns, sorting/filtering, saved layouts, watchlist views, charts/drawing tools, multiple timeframes.
- **Charts (required):** candlestick, OHLC and volume, historical candles, multiple timeframes, technical indicators, drawing tools, stocks/indices/futures/options. Chart package (Vela candidate) must be evaluated for actual compatibility before declared final.

## 11. Deployment and operations

- **Single local owner/application instance:** Windows-first, local-first, runs on the user’s PC. **Single-user means one local application owner, not one connected client.**
- **LAN access is required:** WebUI must be accessible to other devices on the user’s LAN, and MCP must be accessible over LAN using HTTP, so other applications, devices, and multiple MCP clients can connect to the same running application.
- **Client/UI form:** local browser-based WebUI is acceptable; a native desktop wrapper is optional. Do not prematurely force either approach.
- No cloud hosting, no public internet exposure, no application-level user login/auth requirement.
- Multiple MCP clients work normally; configurable startup/background; graceful shutdown/recovery; clear provider/system diagnostics.
- Broker API credentials/sensitive tokens handled responsibly, never logged or exposed through ordinary data APIs.
- **Full backup and restore:** account for complete database and any associated key material required to recover encrypted broker credentials; database-only copy is not full recovery if keys/state missing; restore must be tested on clean installation.
- **Engineering standards:** implementation must follow [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) (modular monolith, fault containment, validation, bounded resources, testing, dependency discipline).

## 12. Current implementation status

Phase 1 scaffold only (health API, web shell, MCP health tool, DB/contracts scaffolding). No market-data, broker, catalog, realtime, alerts/scanners, charts, or operational config implemented. See [PROJECT_STATUS.md](PROJECT_STATUS.md).
