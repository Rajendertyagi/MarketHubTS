# Project Overview

> **Status:** Authoritative product/architecture overview (documentation baseline). Implementation is at Phase 1 scaffold only — see [PROJECT_STATUS.md](PROJECT_STATUS.md).
> **Last updated:** 2026-11-16
> **Related:** [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md)

## 1. Identity and vision

**MarketHubTS** is the **only intended future MarketHub application**: a clean, independent TypeScript solution and an **AI-first, local-first Indian stock-market data platform** focused on comprehensive **NSE and BSE F&O market information**.

The original Python MarketHub is a **reference for domain knowledge and useful requirements only**. Do not migrate, copy, or automatically reproduce its code, architecture, or accumulated complexity.

**Primary purpose:** collect, normalize, organize, maintain, and expose market data.

Humans and AI agents decide how to use the information supplied by MarketHub. MarketHub provides data and data-management capabilities; it does not make trading decisions.

## 2. What MarketHubTS is not (confirmed exclusions)

- Not an automated trading platform.
- Not an AI trading recommendation engine.
- Not a prediction engine.
- Not a sentiment-analysis product.
- Not a chat application.
- Not a broker account management application (no order placement/modification/cancellation, no positions/holdings/funds/margin, no personal broker trade history).

**Never part of the product:** order placement/modification/cancellation, automated trading, broker positions/holdings/funds/margin/personal broker trade history, AI trading recommendations/predictions/buy-sell signals, sentiment, chat, general CSV/Excel market-data export. (Watchlist import/export, where retained from existing MarketHub, is separate from general market-data export.)

**Required phased priorities (must be preserved, not treated as unwanted):** News integration; X/Twitter integration; market-wide information (as applicable/available). These are phased priorities, not scope removals.

## 3. Fundamental architecture requirement

**One canonical data and application-services foundation must serve all consumers.**

```text
Upstox ──────┐
             ├── Provider adapters
FYERS ───────┘
             │
             ▼
      Canonical market-data
      and instrument catalog
             │
             ▼
       Shared application
           services
             │
       ┌─────┴─────┐
       ▼           ▼
      MCP        REST/SSE
       │           │
       ▼           ▼
    AI agents    WebUI
```

- No independent market-data interpretation or duplicate business logic in MCP and WebUI.
- Provider-specific logic stays inside adapters.
- Consumers (MCP, REST/SSE, WebUI, alerts, scanners, charts, watchlists, etc.) use shared services and canonical data.

## 4. Consumers and interfaces

| Consumer | Interface | Role |
|---|---|---|
| AI agents | MCP (primary AI interface) | Discover/request/subscribe to market data and manage AI workflows (watchlists, alerts, scanners) within permitted boundaries |
| WebUI (human) | REST/SSE + UI | View data, customize layout/charts/tables, and own all operational configuration |
| Other local/LAN clients | REST/SSE, MCP over HTTP (planned) | Access same canonical services/data; multiple clients supported |

## 5. Deployment and operating model (confirmed)

- **Single local owner/application instance:** runs on the user’s PC (Windows-first, local-first). **Single-user means one local application owner, not one connected client.**
- **LAN access is required:** WebUI must be accessible to other devices on the user’s local network, and MCP must be accessible over LAN using HTTP (planned) so other applications, devices, and multiple MCP clients can connect to the same running application.
- **Client/UI form:** local browser-based WebUI is acceptable; a native desktop wrapper is optional. Do not prematurely force either approach.
- **No cloud hosting, no public internet exposure, no application-level user login/authentication requirement.**
- Multiple MCP clients must work normally, sharing the same canonical market data and services; one client’s subscriptions/disconnection must not corrupt another’s operation.
- Configurable startup/background behavior, graceful shutdown and recovery, clear provider and system diagnostics.
- Broker API credentials and sensitive tokens must be handled responsibly, never logged or exposed through ordinary data APIs.

## 6. Guiding principles

- **Simplicity:** keep configuration and operation simple; avoid hidden fixed policies and unnecessary technical complexity.
- **Provider independence:** Upstox and FYERS operate independently/simultaneously when configured; one provider failing must not break the other; app continues with available local/non-broker data when neither connected.
- **Truthful data:** preserve provider attribution/timestamps/freshness; never fabricate raw provider-supplied market fields (OI, IV, Greeks, prices, depth, volume). Derived technical indicators (EMA/SMA/RSI/MACD etc.) are permitted only as separately labelled derived indicators.
- **Dynamic catalog:** follow official exchange instrument/contract information; do not permanently hardcode changing contract lists, lot sizes, expiries, strike schemes, or quantity freezes.
- **User-controlled persistence:** live ticks/depth in memory; historical candles cached per policy; option-chain snapshots captured per WebUI configuration; retention user-controlled.
- **Verification over assumption:** technical claims verified against official docs where possible; unverified details explicitly marked.
- **Practical engineering standards:** follow [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) for modular-monolith boundaries, reliability/fault containment, code quality, configuration/data, UI, testing, and dependency discipline.

## 7. Related documents

- [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md) — confirmed scope and requirements
- [ARCHITECTURE.md](ARCHITECTURE.md) — system design and invariants
- [PROJECT_STATUS.md](PROJECT_STATUS.md) — current implementation state
- [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) — path from scaffold to product
- [REFERENCES.md](REFERENCES.md) — official sources and verification notes
