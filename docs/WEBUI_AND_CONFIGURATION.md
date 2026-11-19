# WebUI and Configuration

> **Status:** Confirmed requirements and target design. Current WebUI already includes system overview, provider status, live-data, streaming-selection, historical-candle and option-chain-snapshot panels; MCP/Activity inspection is a planned M6 addition.
> **Last updated:** 2026-11-19 (WebUI implementation reconciliation; no behavior change)
> **Related:** [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [MCP_INTERFACE.md](MCP_INTERFACE.md), [M6_PLAN.md](M6_PLAN.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md)

## 1. Role

WebUI is the **human-facing interface** and the **operational control centre** for the single local owner/application instance. A **local browser-based WebUI is acceptable**; a native desktop wrapper is optional (do not prematurely force either). **LAN access is required** so other devices can access the WebUI on the same running application (no cloud/public exposure, no app-level login).

**Guiding principle:** keep the application simple to configure. Avoid hidden fixed policies and unnecessary technical complexity. Everything relevant to normal operation should be configurable through clearly organized WebUI settings, with sensible initial defaults. Follow [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) for UI separation of concerns, reusable components/tokens, and clear state ownership.

## 2. Current implementation (verified 2026-11-19)

- `apps/web`: React 19 + Vite 8, TanStack Router/Query, Tailwind CSS, Zustand store.
- **Tabs:** Overview, Live data, History & snapshots (`apps/web/src/App.tsx`).
- **Overview:** real backend `/api/status` health/readiness with loading/error/retry states; connection info; **ProviderPanel** with Upstox/FYERS auth/streaming status and local-owner credential controls.
- **Live data:** `LivePanel` (canonical-field-only live views over the SSE client) and `SubscriptionPanel` (streaming selections with local-owner PUT guard).
- **History & snapshots:** `HistoricalPanel` (cached candles, derived coverage/gaps, unavailable periods, sync config, retention settings/cleanup) and `SnapshotPanel` (stored snapshots, capture config, manual capture).
- All panels consume the local API and shared canonical contracts; no duplicate market interpretation. No charts, watchlists, alerts/scanners, full operational settings UI, or MCP/Activity inspection yet.

## 3. Operational configuration ownership (WebUI-owned)

AI/MCP **must not** modify these; all belong in WebUI:

| Category | Configuration areas |
|---|---|
| Brokers & providers | Broker credentials and connections; provider enable/disable; provider selection preferences (advanced, optional manual preferences; no fixed priority) |
| Connectivity & runtime | Startup and background operation; LAN access and application address/network settings |
| Streaming | Streaming selections (instruments/data streams) |
| Historical data | Historical synchronization selections and schedules |
| Option-chain snapshots | Underlying, expiry, strike selection (all or ranges), capture/snapshot selection; streaming selection independent of snapshot capture |
| Retention | Data retention policies/settings (user-controlled; no invented fixed policy) |
| Alerts & scanners | Alert delivery channels/config; scanner operation/schedules and operational controls |
| UI preferences | Dashboard layout, chart preferences, table columns and sorting, watchlist layout |
| Diagnostics & maintenance | Logging and diagnostics; backup and restore |

**Rule:** provider restrictions/limits must be exposed clearly. **Never silently change user selections** because an API limit was exceeded.

## 4. WebUI functional modules (target)

| Module | Purpose (planned) |
|---|---|
| Dashboard | Overview widgets, market summary, status/health, customizable layout |
| Market data | Quotes/depth/live views for supported instruments with source/freshness/provenance |
| Watchlists | Create/organize/view watchlists; shared with MCP workflows |
| Charts | Candlestick/OHLC/volume, historical candles, multiple timeframes, technical indicators, drawing tools for stocks/indices/futures/options |
| Options | Option chains, expiries/strikes, snapshots/views (per config and availability) |
| Futures | Futures views for supported underlyings/contracts |
| Alerts | Create/manage alerts, view states/history, configure delivery |
| Scanners | Create/manage/run scanners (manual/scheduled/continuous as configured), view results/history |
| Historical data | Browse/request/sync status for cached historical data |
| Market-wide | Indices, VIX, breadth, sectors, FII/DII, participant OI, reports/bhavcopies, calendars/status (as available) |
| Settings | All operational configuration areas listed above |
| Diagnostics | Provider/system health, logs, connectivity, data freshness/availability |
| MCP / Activity **(M6 planned)** | MCP transport availability; recent tool calls with filters (operation, time, outcome); duration and sanitized error detail; incomplete/interrupted operations; on-demand retrieval attempts and outcomes; navigation to stored candles/snapshots; notification/subscription activity shown separately from data-operation success |

All modules consume **shared application services** and canonical data (no duplicate business logic).

## 5. Customization requirements

- Dashboard widgets and layout customization.
- Rearrangeable panels.
- Show/hide modules.
- Custom table columns.
- Sorting and filtering.
- Saved layouts.
- Watchlist views.
- Charts and drawing tools.
- Multiple timeframes.

Data-heavy views should use efficient rendering patterns (e.g. TanStack Table/Virtual) to remain responsive during frequent updates **(planned)**.

## 6. Charts

**Required capabilities:** candlestick charts, OHLC and volume, historical candles, multiple timeframes, technical indicators, drawing tools, stocks/indices/futures/options.

**Chart package:** Vela (`@luxalgo/vela`) is a **candidate** (installed version recorded in dependencies) but must be evaluated for actual compatibility before declared final — including React/provider API, features, multi-chart/workspace persistence, performance/memory, and licensing/attribution requirements **(verify)**.

**Data ownership:** backend/canonical services remain the source of truth for market data and candles; frontend must not independently invent candle calculations.

## 7. Alerts and scanners in WebUI

- Humans can create/manage alerts and scanners; definitions and history/results shared with MCP.
- Alert states clearly shown: waiting for streaming, active, unavailable, triggered (and reasons).
- If alert requires non-streamed instrument: UI must explain missing streaming configuration; activation occurs after user enables streaming (no auto-subscribe).
- Scanner results must surface stale/unavailable/not-streamed limitations explicitly.
- Delivery configuration (WebUI notifications/history, desktop notifications, MCP events, webhooks) managed in WebUI.

## 8. UX and safety expectations

- Simple, clear configuration flows; sensible defaults but configurable behavior.
- Explicit visibility of provider connection state, limits, restrictions, data freshness, and unavailability.
- No hidden automatic changes to user selections.
- Responsible handling of sensitive inputs (credentials/tokens): masked entry, no logging/exposure in ordinary views/APIs.
- **LAN access is required** (no app-level login) so other devices/applications can connect to the same running instance; UI should communicate local-network exposure implications clearly where relevant **(planned)**.

## 9. Current gaps (to be implemented)

Operational settings, market modules, customization persistence, charts, alerts/scanners/watchlists UI, full diagnostics, backup/restore UI, and the M6 MCP/Activity inspection section are pending per roadmap. The existing Overview/Provider, Live data and History & snapshots panels are implemented (§2).

**M6 MCP/Activity design:** a single section integrated into the existing navigation (no separate admin app) backed by a small durable `mcp_activity` SQLite table and WebUI-owned `ACTIVITY` retention class. It must show transport availability, recent calls with filters, detail with sanitized errors, incomplete operations, and links to stored data; data persistence and notification-delivery outcomes are shown separately. HTTP MCP status comes from actual API handler/readiness information; STDIO is a separate process whose current running state cannot be inferred — show only configured / activity observed / no recent activity or status unknown, never "connected" without a real signal. See [`M6_PLAN.md`](M6_PLAN.md) §9.1–§9.2.
