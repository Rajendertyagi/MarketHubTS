# References

> **Status:** Official and primary sources reviewed for documentation baseline. External claims should be re-verified before implementation when details matter.
> **Last verified/accessed:** 2026-11-15 (web research and official documentation pages accessed via available browsing/search tools on this date).

## 1. How to use this document

- Prefer **official documentation** over third-party tutorials/examples.
- Record feature/API verification, access date, and restrictions/limitations.
- If documentation is unclear/inaccessible, mark as **not verified** rather than guessing.
- Upstox legacy feed/historical docs have changed; use current V3/official pages.

## 2. Upstox (official)

| Source | URL | What it informs | Verification notes (2026-11-15) |
|---|---|---|---|
| Developer API documentation (portal) | https://upstox.com/developer/api-documentation/ | Entry point for current APIs, auth, instruments, market data, orders (orders out of scope for product) | Accessed/reviewed via search results; use as canonical starting point |
| Market Data Feed V3 | https://upstox.com/developer/api-documentation/v3/get-market-data-feed/ | WebSocket market data feed, redirect/auth flow, protobuf-encoded feed (per docs) | Confirmed V3 feed page exists; exact modes/fields/subscription limits/entitlements require detailed verification |
| Historical Candle Data V3 | https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/ | Historical OHLC(V) candle retrieval, units/intervals/params (per docs) | V3 endpoint documented; legacy historical endpoint marked deprecated elsewhere — **use V3** |
| Expired Instruments (overview/section) | https://upstox.com/developer/api-documentation/expired-instruments/ | Expired contracts/expiries and related APIs | Section referenced in portal/announcements; verify exact capabilities/entitlements |
| Get Expired Historical Candle Data | https://upstox.com/developer/api-documentation/get-expired-historical-candle-data | Historical candles for expired instruments (per docs) | Page exists; plan/entitlement and parameter details **verify** |
| Announcements (API changes) | https://upstox.com/developer/api-documentation/announcements | Releases/changes (e.g. expired instruments APIs, websocket features, V3 updates) | Useful for change awareness; confirm current behavior in endpoint docs |

**Key cautions:** do not use discontinued legacy feed endpoints; verify subscription/rate limits, plan entitlements, field availability (OI/IV/Greeks/depth), and instrument key formats from current official docs.

## 3. FYERS (official)

| Source | URL | What it informs | Verification notes (2026-11-15) |
|---|---|---|---|
| FYERS API portal | https://myapi.fyers.in/ | Official API entry/credentials/docs portal | Referenced as official portal; detailed content/capabilities require direct verification |
| FYERS API v3 documentation | https://myapi.fyers.in/docsv3/ | API v3 endpoints, auth, market data, websockets, history, etc. | Referenced as official docs; specific endpoint/limit/field details **verify** against current pages |
| Changelog / release notes | https://fyers.in/api-docs/v3/changelog | API changes, features, limits/behavior updates | Publicly accessible changelog observed in search; use to cross-check current capabilities |

**Key cautions:** verify data socket symbol/connection limits (plan-dependent), available fields (depth/OI/IV/Greeks if any), historical/option-chain support, and Bun/SDK compatibility from official sources.

## 4. NSE (official)

| Source | URL | What it informs | Verification notes (2026-11-15) |
|---|---|---|---|
| NSE India | https://www.nseindia.com/ | Official exchange site, products, reports, market information | Access may be dynamic/restricted; verify specific datasets programmatically/officially |
| Equity derivatives contract information | https://www.nseindia.com/products-services/equity-derivatives-contract-information | Contract specs, underlyings, eligibility-related information | Official section; detailed current eligibility for all target index underlyings **verify** |
| Contract specifications | https://www.nseindia.com/static/products-services/equity-derivatives-contract-specifications | Trading cycle, expiry, lot/tick/strike scheme references (subject to updates/circulars) | Public page observed; confirm current values dynamically/officially before implementation |
| Nifty India FPI 150 F&O product page | https://www.nseindia.com/static/products-services/equity-derivatives-nifty-india-fpi | Product/contract information for Nifty India FPI 150 derivatives | Public page observed; confirms product presence — verify current eligibility/specs/circulars |
| Press release (Nifty India FPI 150 F&O introduction date) | https://nsearchives.nseindia.com/web/pressrelease/2026-01/PR_cc_01012026_20260101194417.pdf | Official NSE press release identifying introduction date of Nifty India FPI 150 index futures and options | **Verified fact (user-provided, 2026-11-15):** introduction date stated as **08 December 2025**. Direct PDF fetch timed out in this session; treat as verified per provided official source and re-verify content directly before implementation if needed. Introduction date is distinct from current eligibility and actual available contracts. |
| Circular (Nifty India FPI 150 F&O) | https://nsearchives.nseindia.com/content/circulars/FAOP75239.pdf | Circular details/specs/effective dates as stated | Public circular referenced in search results; verify latest status/circulars and current contract specs/eligibility independently (do not infer current eligibility from introduction date alone). |

**Key cautions:** do not hardcode changing contracts/expiries/strikes/lot sizes/quantity freezes; verify current index-derivative eligibility and actual available contracts (including NIFTY 50, BANK NIFTY, FINNIFTY, MIDCPNIFTY, NIFTY NEXT 50, NIFTY India FPI 150) from official/current sources. Keep introduction dates separate from current eligibility.

## 5. BSE (official)

| Source | URL | What it informs | Verification notes (2026-11-15) |
|---|---|---|---|
| BSE India | https://www.bseindia.com/ | Official exchange site, market data, derivatives, reports | Access/content dynamic; verify specific datasets officially |
| BSE market data (bhavcopy/reports area) | https://www.bseindia.com/markets/marketinfo/bhavcopy | Bhavcopy/reports availability (as provided) | Public page observed; verify formats/availability/terms |
| Derivatives market pages (e.g. option chain/historical) | https://www.bseindia.com/markets/derivatives/derireports/derioptionchain , https://www.bseindia.com/markets/derivatives/derireports/derihistorical | Derivatives information/reporting pages | Public pages observed; confirm SENSEX F&O scope/specs and exclusions officially |

**Key cautions:** supported BSE scope is limited to SENSEX and SENSEX futures/options; explicitly exclude BANKEX derivatives, SENSEX50 derivatives, other BSE stock/unsupported derivatives (verify current official listings).

## 6. MCP (official)

| Source | URL | What it informs | Verification notes (2026-11-15) |
|---|---|---|---|
| MCP specification (2026-07-28) | https://modelcontextprotocol.io/specification/2026-07-28/ | Protocol requirements, transports, lifecycle, tools/resources/prompts, subscriptions/events | Official spec revision reviewed at portal level; exact transport/event semantics must be verified in detail before implementation |
| MCP TypeScript SDK docs (v2) | https://ts.sdk.modelcontextprotocol.io/v2/ | SDK packages/APIs, transports, migration guidance | Official docs reviewed |
| Supporting protocol revision 2026-07-28 (SDK migration) | https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 | `subscriptions/listen`, notification delivery, `createMcpHandler` notify/bus, `serveStdio` routing, client auto-listen behavior | Reviewed 2026-11-15: `subscriptions/listen` delivers `tools/prompts/resources` `list_changed` and `resources/updated` notifications on client-opened streams; `createMcpHandler` exposes `.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}` (in-process bus by default, custom `ServerEventBus` for multi-process); `serveStdio` routes pinned instance list-changed calls onto active subscriptions; `resources/subscribe` is 2025-only on 2026 connections (use `resourceSubscriptions` in listen filter). No arbitrary standard alert-trigger notification type should be invented. |
| TypeScript SDK repository | https://github.com/modelcontextprotocol/typescript-sdk | Source, examples, changelog, migration notes | Official repo; useful for implementation details and current support status |

**Key cautions:** do not confuse SSE notifications within Streamable HTTP with deprecated legacy HTTP+SSE transport. For alert/event delivery, use durable MarketHub records plus discoverable MCP resources/feeds and supported protocol notifications (e.g. `notifications/resources/updated` / list changes as applicable) with client read-after-notify, event IDs/cursors/sequence for no-miss/reconnect recovery, and polling/tool fallback. Verify exact `@modelcontextprotocol/server` v2.4.0 behavior and 2026-07-28 semantics before implementation.

## 7. Technology / dependency references (official)

| Technology | Source | Notes |
|---|---|---|
| Bun | https://bun.sh/ , https://bun.com/docs | Runtime, `bun:sqlite`, workspaces, test/build tooling; installed 1.4.4 verified locally |
| Hono | https://hono.dev/ | Web framework (API) |
| Zod | https://zod.dev/ | Schema validation/contracts |
| Drizzle ORM / Kit | https://orm.drizzle.team/ | ORM, migrations, `bun:sqlite` integration |
| React | https://react.dev/ | UI library |
| Vite | https://vite.dev/ | Frontend tooling/build |
| TanStack (Router/Query/Table/Virtual) | https://tanstack.com/ | Routing, data fetching/caching, tables, virtualization |
| Zustand | https://zustand.docs.pmnd.rs/ | UI/client state |
| Tailwind CSS | https://tailwindcss.com/ | Styling |
| shadcn/ui | https://ui.shadcn.com/ | Component patterns (generation/integration pending) |
| Vela (candidate) | https://www.npmjs.com/package/@luxalgo/vela , https://github.com/luxalgo/vela , https://velacharts.dev/ | Charting library candidate; verify compatibility/features/licensing/attribution before final adoption |

## 8. Repository-local evidence (verified 2026-11-15)

- Workspace manifests and source inspected under `D:\Temp\MarketHubTS` (apps, packages, docs, tests, configs).
- **Current Git state (stable, verified 2026-11-16):** repository `Rajendertyagi/MarketHubTS`, remote `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`), branch `main`; local HEAD and `origin/main` both `277d5e248ea972c0fea984105b86708563205a6a` (`277d5e2 Correct documentation: git state, FPI 150 date, MCP alert events, dependencies, and NSE index catalogue`), synchronized at verification time. Earlier history rewrite removed `70c4a873f36e3143d3e5d271ead752ef3409f58f` from current lineage; subsequent documentation commits were added on `main`. Working-tree status is task-specific and should be recorded in task reports (not as permanent project documentation).
- **Historical (pre-initialization):** earlier in this environment `git status` reported "not a git repository" (no `.git` history). Preserved as historical context only.
- `project-status.json`: not present locally and not tracked (verified 2026-11-15); historically observed as unrelated and removed during prior cleanup/history rewrite.
- Scaffold checks previously verified: `bun test` pass (2 tests), `bun run typecheck` pass, `bun run build` pass, API `/health` returned OK with DB check.
- Dependency evidence (verified 2026-11-15): `@modelcontextprotocol/server@2.4.0` declared/resolved and imported in `apps/mcp-server`; `@modelcontextprotocol/client` not declared in manifests, not resolved in `bun.lock`, and not imported in source.

## 9. Limitations of this reference pass

- Some official sites (exchange portals, vendor docs) are dynamic or may restrict automated access; detailed endpoint/field/limit verification must be completed during implementation using current official documentation and authorized test access.
- Search-result summaries were used to identify and partially confirm official pages; **implementation decisions must rely on the actual current official documentation content and tested behavior**, not summaries alone.
- Provider entitlements, plan-specific features, and real-time limits require account/context-specific verification.
