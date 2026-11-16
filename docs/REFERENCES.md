# References

> **Status:** Official and primary sources reviewed for documentation baseline. External claims should be re-verified before implementation when details matter.
> **Last verified/accessed:** 2026-11-16 (web research and official documentation pages accessed via available browsing/search tools on this date; prior 2026-11-15 notes retained where still applicable).

## 1. How to use this document

- Prefer **official documentation** over third-party tutorials/examples.
- Record feature/API verification, access date, and restrictions/limitations.
- If documentation is unclear/inaccessible, mark as **not verified** rather than guessing.
- Upstox legacy feed/historical docs have changed; use current V3/official pages.

## 2. Upstox (official)

| Source | URL | What it informs | Verification notes |
|---|---|---|---|
| Developer API documentation (portal) | https://upstox.com/developer/api-documentation/ | Entry point for current APIs, auth, instruments, market data, orders (orders out of scope for product) | Accessed/reviewed via search results; use as canonical starting point |
| Analytics Token | https://upstox.com/developer/api-documentation/analytics-token/ | Free, read-only, 1-year token; no OAuth/static IP for market-data categories; one per account; GET only | **Verified 2026-11-16:** chosen for M3. Supported categories: Charges, Margins, Market Quote, Historical Data, Option Chain, Market Information, Fundamentals, News, IPO, Websocket. User/Payments/Orders/GTT/Portfolio/MF/Trade P&L require static IP and are out of scope. |
| Exchange Status (validation endpoint) | https://upstox.com/developer/api-documentation/get-market-status | `GET /v2/market/status/NSE`, non-sensitive market-information GET | **Verified 2026-11-16:** selected for Analytics Token credential validation. User Profile is not used (User category needs static IP). |
| Rate Limits | https://upstox.com/developer/api-documentation/rate-limiting/ | Per-API/per-user limits | **Verified 2026-11-16:** Other Standard APIs 50/s, 500/min, 2000/30min; TOTP login 1/s, 10/min, 60/30min. |
| Instruments / instrument files | https://upstox.com/developer/api-documentation/instruments/ | Instrument master files/fields and identifier concepts for mapping design | **Accessed 2026-11-16:** page indicates `instrument_key` is recommended as unique identifier; `exchange_token` can be reused after expiry; files include exchange/segment, ISIN, underlying identifiers, expiry, strike, lot size, freeze quantity, tick size and other attributes depending on instrument type (exact schema/coverage/entitlements must be verified in detail before integration). Used to inform M2 mapping/provenance modeling; no Upstox integration implemented. |
| Market Data Feed V3 | https://upstox.com/developer/api-documentation/v3/get-market-data-feed/ | WebSocket market data feed, redirect/auth flow, protobuf-encoded feed (per docs) | Confirmed V3 feed page exists; exact modes/fields/subscription limits/entitlements require detailed verification |
| Historical Candle Data V3 | https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/ | Historical OHLC(V) candle retrieval, units/intervals/params (per docs) | V3 endpoint documented; legacy historical endpoint marked deprecated elsewhere — **use V3** |
| Expired Instruments (overview/section) | https://upstox.com/developer/api-documentation/expired-instruments/ | Expired contracts/expiries and related APIs | Section referenced in portal/announcements; verify exact capabilities/entitlements |
| Get Expired Historical Candle Data | https://upstox.com/developer/api-documentation/get-expired-historical-candle-data | Historical candles for expired instruments (per docs) | Page exists; plan/entitlement and parameter details **verify** |
| Announcements (API changes) | https://upstox.com/developer/api-documentation/announcements | Releases/changes (e.g. expired instruments APIs, websocket features, V3 updates) | Useful for change awareness; confirm current behavior in endpoint docs |

**Key cautions:** do not use discontinued legacy feed endpoints; verify subscription/rate limits, plan entitlements, field availability (OI/IV/Greeks/depth), and instrument key formats from current official docs. Use Upstox identifiers only as provider mappings (never canonical identity).

## 3. FYERS (official)

| Source | URL | What it informs | Verification notes |
|---|---|---|---|
| FYERS API portal | https://myapi.fyers.in/ | Official API entry/credentials/docs portal | Referenced as official portal; detailed content/capabilities require direct verification |
| Authentication Flow (individual app) | https://fyers.in/api-docs/v3/api/authentication/individual-app/authentication-flow/ | V3 OAuth flow, state validation, `appIdHash`, daily 6:30 AM expiry | **Verified 2026-11-16:** random state must be verified on return; `appIdHash` = SHA-256 of `app_id:app_secret`; `Authorization: app_id:access_token`; invalid token errors -8/-15/-16/-17. |
| Generate Auth Code | https://fyers.in/api-docs/v3/api/authentication/individual-app/generate-auth-code/ | `GET /api/v3/generate-authcode` parameters | **Verified 2026-11-16:** `client_id`, `redirect_uri` (must match app creation), `response_type=code`, random `state`. |
| Validate Auth Code | https://fyers.in/api-docs/v3/api/authentication/individual-app/validate-auth-code/ | `POST /api/v3/validate-authcode` token exchange | **Verified 2026-11-16:** JSON `grant_type`, `appIdHash`, `code`; response includes `access_token` (and example `refresh_token`, but no refresh endpoint confirmed — do not assume renewal). |
| Create an App / Individual App | https://fyers.in/api-docs/v3/getting-started/create-an-app/individual-app/ | Trading vs non-trading app, redirect URI rules | **Verified 2026-11-16:** non-trading (data-only) app has no static IP requirement and no order placement; any redirect URL under developer control is permitted and must match registration. M3 uses a non-trading app. |
| Rate-limit notice (16 Oct 2026) | https://fyers.in/notice-board/changes-to-fyers-api-rate-limits-and-usage | Official Standard vs Prime limits | **Verified 2026-11-16:** Standard Data APIs 5/s, 50/min, 5,000/day; Transaction/User Info 10/s, 200/min, 100,000/day. Prime-only: expired F&O/historical Greeks, 1,000-symbol quotes, 5,000 data-socket symbols, 15 TBT. |
| FYERS API v3 documentation | https://myapi.fyers.in/docsv3/ | API v3 endpoints, auth, market data, websockets, history, etc. | Referenced as official docs; specific endpoint/limit/field details **verify** against current pages |
| Symbol Master JSON | https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-json/ | Symbol master fields/formats for mapping design | **Recorded 2026-11-16 (per task research inputs; direct extraction not fully completed in this session):** relevant fields include `fyToken`, `isin`, `exSymbol`, `symTicker`, `exToken`, `underSym`, `underFyTok`, `exInstType`, `minLotSize`, `tickSize`, `expiryDate`, `strikePrice`, `optType`, `qtyFreeze`, `tradeStatus`. Validate against current symbol master before integration. |
| Symbol Master File | https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-file/ | Symbol master file access/details | **Recorded 2026-11-16:** verify current format/availability/fields before integration. |
| Changelog / release notes | https://fyers.in/api-docs/v3/changelog | API changes, features, limits/behavior updates | Publicly accessible changelog observed in search; use to cross-check current capabilities |

**Key cautions:** verify data socket symbol/connection limits (plan-dependent), available fields (depth/OI/IV/Greeks if any), historical/option-chain support, and Bun/SDK compatibility from official sources. Use FYERS identifiers only as provider mappings (never canonical identity).

## 4. NSE (official)

| Source | URL | What it informs | Verification notes |
|---|---|---|---|
| NSE India | https://www.nseindia.com/ | Official exchange site, products, reports, market information | Access may be dynamic/restricted; verify specific datasets programmatically/officially |
| Equity derivatives contract specifications | https://www.nseindia.com/products-services/equity-derivatives-contract-specifications | Current contract specifications/cycles/expiry framework and listed index underlyings | **Verified 2026-11-16 (current NSE publication):** page updated **11 August 2026** lists six index underlyings for equity derivatives. Describes three consecutive monthly futures for the six index underlyings, NIFTY 50 options with weekly expiries in addition to monthly/longer-dated cycles, other five index options with monthly cycles, individual-security futures/options with three-month trading cycle, and Tuesday expiry for listed indices/individual securities (previous trading day if Tuesday is a trading holiday). **Rules/spec framework only; actual listed contracts/expiry dates/strikes/lot sizes must come from authoritative contract data.** |
| Equity derivatives products | https://www.nseindia.com/products-services/equity-derivatives-products | Current NSE equity-derivatives product/index information | **Verified 2026-11-16 (current NSE publication):** page updated **12 August 2026** lists six major derivative indices, supporting the six-underlying scope in current NSE publications. |
| NIFTY India FPI 150 F&O product page | https://www.nseindia.com/products-services/equity-derivatives-nifty-india-fpi | Product/contract information for NIFTY India FPI 150 derivatives | **Verified 2026-11-16 (current NSE publication):** explicitly documents **FUTIDX** and **OPTIDX** products for NIFTY India FPI 150. Confirms product presence in current NSE publications; actual available contracts/specs remain authoritative-source-driven. |
| List of underlyings | https://www.nseindia.com/products-services/equity-derivatives-list-underlyings-information | Current eligible underlyings/membership information | NSE stock F&O eligibility is dynamic (periodic evaluation; list can change). Capture source-backed membership with as-of/effective information; do not hardcode. Detailed current stock membership **verify** from authoritative source before integration. |
| Selection criteria | https://www.nseindia.com/products-services/equity-derivatives-selection-criteria | Eligibility/selection criteria for derivatives | Criteria based on changing market/liquidity/position-limit and other measures; presence in broad cash-index catalogue does not automatically imply derivatives eligibility. **Verify** current criteria/details as needed. |
| Equity derivatives contract information | https://www.nseindia.com/products-services/equity-derivatives-contract-information | Contract specs, underlyings, eligibility-related information | Official section; use for current contract/eligibility verification as needed. |
| Individual securities F&O | https://www.nseindia.com/static/products-services/equity-derivatives-individual-securities | Stock futures/options security descriptor, trading cycle, settlement, strike scheme, contract size | **Verified 2026-11-16 (current NSE publication):** security descriptor is market type `N`, instrument `FUTSTK`/`OPTSTK`, underlying symbol, expiry date, and for options option type `CE`/`PE` plus strike. Options are European style and physically settled; futures/options have a three-month cycle; stock-option strike step is based on underlying volatility and reviewed quarterly. Contract value at introduction not less than Rs 5 lakh. Current lot size/quantity freeze come from `NSE_FO_contract_ddmmyyyy.csv.gz` / `fo_mktlots.csv`. |
| NIFTY 50 F&O | http://www.nseindia.com/products-services/equity-derivatives-nifty50 | Index futures/options security descriptor, cycles, contract size | **Verified 2026-11-16 (current NSE publication):** `FUTIDX`/`OPTIDX`, underlying NIFTY 50, expiry, `CE`/`PE` and strike; CE = Call European, PE = Put European. Index options have 4 weekly + 3 monthly + 3 quarterly + 8 half-yearly expiries (at least 5-year tenure). Contract value at introduction not less than Rs 15 lakh. |
| F&O contract / lot-size files | https://nseindia.com/all-reports-derivatives , https://www.nseindia.com/products-services/equity-derivatives-contract-information | Authoritative current lot size, quantity freeze, tick size, strike scheme | **Verified 2026-11-16:** NSE disseminates `NSE_FO_contract_ddmmyyyy.csv.gz` (contract file) and `fo_mktlots.csv` (permitted lot size). SEBI reviews lot size every six months; NSE reviews index/stock futures tick size monthly. These files — not hardcoded values — are the source for M3+ contract specs. |
| F&O consolidated circular (28 Apr 2026) | https://www.nseindia.com/ (circular section; NSE/FAOP consolidated circular) | Expiry-day/holiday rules, order types, price steps | **Recorded 2026-11-16 (via reproduced circular text; direct PDF fetch not performed):** if the expiry day is a trading holiday, expiry moves to the previous trading day (never forward); options price step Rs 0.05. Verify the current circular directly before implementation. |
| Press release (NIFTY India FPI 150 F&O introduction date) | https://nsearchives.nseindia.com/web/pressrelease/2026-01/PR_cc_01012026_20260101194417.pdf | Official NSE press release identifying introduction date of NIFTY India FPI 150 index futures and options | **Verified fact (user-provided, 2026-11-15):** introduction date stated as **08 December 2025**. Direct PDF fetch timed out in this session; treat as verified per provided official source and re-verify content directly before implementation if needed. Introduction date is distinct from current eligibility and actual available contracts. |
| Circular (NIFTY India FPI 150 F&O) | https://nsearchives.nseindia.com/content/circulars/FAOP75239.pdf | Circular details/specs/effective dates as stated | Public circular referenced in search results; verify latest status/circulars and current contract specs/eligibility independently. |
| SEBI Annual Report 2025–26 (observation-date context) | https://www.sebi.gov.in/ (annual report publication; specific report section as applicable) | Regulatory annual reporting context for eligible indices | **Recorded 2026-11-16 (per task input):** states five eligible NSE indices as of **31 March 2026** (observation date). Reconciled with later NSE publications (Aug 2026) listing/documenting six index underlyings including NIFTY India FPI 150; different observation dates. Do not treat as contradiction without date context. |

**Key cautions:** do not hardcode changing contracts/expiries/strikes/lot sizes/quantity freezes or stock F&O membership; verify current index-derivative eligibility and actual available contracts from official/current sources. Keep introduction dates and observation dates separate from current eligibility/actual contracts. Actual expiry dates must come from authoritative contract data (not weekday calculation).

## 5. BSE (official)

| Source | URL | What it informs | Verification notes |
|---|---|---|---|
| BSE India | https://www.bseindia.com/ | Official exchange site, market data, derivatives, reports | Access/content dynamic; verify specific datasets officially |
| Notice 20250623-59 (expiry day revision) | https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page=20250623-59 | Revised BSE index and stock derivative expiry days | **Recorded 2026-11-16 (per task research inputs; direct verification pending):** revised expiry days to Thursday for contracts expiring after 1 Sep 2025; SENSEX weekly contracts move to Thursday and monthly/long-dated index contracts follow last-Thursday schedule. Use current exchange contract master for actual expiry dates (do not calculate). |
| BSE market data (bhavcopy/reports area) | https://www.bseindia.com/markets/marketinfo/bhavcopy | Bhavcopy/reports availability (as provided) | Public page observed; verify formats/availability/terms |
| Derivatives market pages (e.g. option chain/historical) | https://www.bseindia.com/markets/derivatives/derireports/derioptionchain , https://www.bseindia.com/markets/derivatives/derireports/derihistorical | Derivatives information/reporting pages | Public pages observed; confirm SENSEX F&O scope/specs and exclusions officially |

**Key cautions:** MarketHubTS BSE derivative product scope is limited to SENSEX and SENSEX futures/options (deliberate scope restriction). Do not represent BANKEX, SENSEX50 or BSE single-stock derivatives as non-existent; they are outside current supported product scope. Verify current official listings/specs. Actual expiry dates must come from authoritative contract data.

## 6. SEBI (official)

| Source | URL | What it informs | Verification notes |
|---|---|---|---|
| Final Settlement Day / Expiry Day for equity derivatives contracts (26 May 2025) | https://www.sebi.gov.in/legal/circulars/may-2025/final-settlement-day-expiry-day-for-equity-derivatives-contracts_94189.html , https://www.sebi.gov.in/sebi_data/attachdocs/may-2025/1748266377271.pdf | Regulatory framework for equity-derivative expiry days/tenor | **Verified 2026-11-16 (circular text SEBI/HO/MRD/MRD-TPD-1/P/CIR/2025/76):** clause 3.1 — all equity-derivative expiries of an exchange uniformly limited to Tuesday or Thursday; 3.2 — one weekly benchmark index-options contract per exchange on its chosen day; 3.3 — all other equity derivatives (benchmark index futures, non-benchmark index F&O, single-stock F&O) have minimum one-month tenor and expire in the last week of the month on the chosen day; 3.4 — exchanges need prior SEBI approval to change their settlement day. Effective for contracts expiring on or after 1 Sep 2025. NSE chose Tuesday, BSE Thursday. These are rules, not substitutes for actual listed-contract records. |
| Exchange-traded derivatives framework (SEBI, May 2026) | https://www.sebi.gov.in/sebi_data/commondocs/may-2026/Annexure-%20B_p.pdf | Contract size, lot size, tenor, quotation rules | **Verified 2026-11-16 (via reproduced annexure text; direct PDF fetch not performed):** index derivative contract value not less than Rs 15 lakh at introduction with lot size reviewed every six months; stock derivative contract value not less than Rs 5 lakh; equity derivatives quoted in rupees; index futures/options and stock F&O maximum maturity 12 months, with Nifty/SENSEX index options up to 5 years. Verify the current annexure directly before implementation. |

## 7. Indian equity F&O domain mechanics (verified 2026-11-16)

These facts were studied to ground the catalog model. Official sources above are authoritative; the explanatory sources below are secondary and used only to confirm widely agreed mechanics, never for provider/exchange data values.

| Topic | Verified fact | Source class |
|---|---|---|
| Security descriptor | NSE identifies an F&O contract by market type `N`, instrument type (`FUTIDX`/`OPTIDX`/`FUTSTK`/`OPTSTK`), underlying symbol, expiry date (`DD-MMM-YYYY`), and for options `CE`/`PE` plus strike. This matches the M2 derivative identity tuple (exchange + segment + class + underlying canonical ID + expiry + strike + option type). | Official (NSE contract specifications / individual securities / NIFTY 50 pages) |
| CE / PE | `CE` = Call European, `PE` = Put European. Indian index and stock options are European style. Index F&O is cash-settled; stock F&O is physically settled (an ITM stock option at expiry becomes a share-delivery obligation). | Official (NSE pages) + explanatory (Zerodha Varsity, IndMoney, TredexView) |
| Expiry framework | SEBI 26 May 2025 circular: one expiry weekday per exchange (NSE Tuesday, BSE Thursday from 1 Sep 2025); one weekly benchmark index option per exchange (Nifty 50 / Sensex); all other equity derivatives minimum one-month tenor, last week of month. NSE moves a holiday expiry to the previous trading day. **Read expiry from contract data, never compute from weekday rules.** | Official (SEBI circular, NSE/BSE communications) |
| Dynamic specs | Index strike intervals depend on underlying price; stock-option strike schemes depend on volatility and are reviewed quarterly. Index futures tick size 0.05/0.10/0.20 by index level; stock futures inherit cash-market tick; all options 0.05. Lot size and quantity freeze are source-driven (`NSE_FO_contract_ddmmyyyy.csv.gz`, `fo_mktlots.csv`), reviewed periodically. **Never hardcode.** | Official (NSE contract specifications, F&O consolidated circular, SEBI framework) |
| Option chain | CE on left, PE on right, strikes in the middle. Per-strike columns: OI, change in OI, volume, IV, LTP, net change, bid/ask quantity and price. These are live market fields for future realtime/snapshot layers, **not** catalog fields. | Explanatory (IndMoney, ClearStrike, TredexView, Zerodha Varsity) |
| Moneyness | ITM/ATM/OTM is derived from spot vs strike (CE ITM when strike < spot; PE ITM when strike > spot). It is a derived view, not a stored contract attribute. | Explanatory (Zerodha Varsity, Groww, BeInOptions) |
| Margins / position limits | SPAN is a portfolio scenario engine; exposure margin is a flat notional cushion; MWPL ban period above 95% open interest, releasing below 80%. These are broker/account/risk concerns and are **explicitly out of MarketHubTS scope** (no account/margin/position tracking). | Official (NSE margining pages) + explanatory (OpenAlgo, Zerodha support) |

**Key caution:** the explanatory sources confirm mechanics only. All concrete values (eligibility, listed contracts, expiries, strikes, lot/tick/freeze, provider fields) must still come from current official exchange/provider sources before M3+ implementation.

## 8. MCP (official)

| Source | URL | What it informs | Verification notes (2026-11-15) |
|---|---|---|---|
| MCP specification (2026-07-28) | https://modelcontextprotocol.io/specification/2026-07-28/ | Protocol requirements, transports, lifecycle, tools/resources/prompts, subscriptions/events | Official spec revision reviewed at portal level; exact transport/event semantics must be verified in detail before implementation |
| MCP TypeScript SDK docs (v2) | https://ts.sdk.modelcontextprotocol.io/v2/ | SDK packages/APIs, transports, migration guidance | Official docs reviewed |
| Supporting protocol revision 2026-07-28 (SDK migration) | https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28 | `subscriptions/listen`, notification delivery, `createMcpHandler` notify/bus, `serveStdio` routing, client auto-listen behavior | Reviewed 2026-11-15: `subscriptions/listen` delivers `tools/prompts/resources` `list_changed` and `resources/updated` notifications on client-opened streams; `createMcpHandler` exposes `.notify.{toolsChanged,promptsChanged,resourcesChanged,resourceUpdated(uri)}` (in-process bus by default, custom `ServerEventBus` for multi-process); `serveStdio` routes pinned instance list-changed calls onto active subscriptions; `resources/subscribe` is 2025-only on 2026 connections (use `resourceSubscriptions` in listen filter). No arbitrary standard alert-trigger notification type should be invented. |
| TypeScript SDK repository | https://github.com/modelcontextprotocol/typescript-sdk | Source, examples, changelog, migration notes | Official repo; useful for implementation details and current support status |

**Key cautions:** do not confuse SSE notifications within Streamable HTTP with deprecated legacy HTTP+SSE transport. For alert/event delivery, use durable MarketHub records plus discoverable MCP resources/feeds and supported protocol notifications (e.g. `notifications/resources/updated` / list changes as applicable) with client read-after-notify, event IDs/cursors/sequence for no-miss/reconnect recovery, and polling/tool fallback. Verify exact `@modelcontextprotocol/server` v2.4.0 behavior and 2026-07-28 semantics before implementation.

## 9. Technology / dependency references (official)

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

## 10. Repository-local evidence (verified 2026-11-15/16)

- Workspace manifests and source inspected under `D:\Temp\MarketHubTS` (apps, packages, docs, tests, configs).
- **Git state (task-specific):** repository `Rajendertyagi/MarketHubTS`, remote `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`), permanent branches `main`/`develop`. Published `develop`/`origin/develop` baseline is `484c0a6add7bfde04b294c523a453f3bff4b5b1f` (M2 corrective commit); M2 initial publication `fa40420`. `main`/`origin/main` remain `277d5e248ea972c0fea984105b86708563205a6a`. Working tree clean at M3 readiness verification. Record exact branch/HEAD/remote sync/working-tree status in task reports.
- **Historical (pre-initialization):** earlier in this environment `git status` reported "not a git repository" (no `.git` history). Preserved as historical context only.
- `project-status.json`: not present locally and not tracked (verified 2026-11-15); historically observed as unrelated and removed earlier.
- **Verification (2026-11-16):** `bun run typecheck` pass, `bun test` pass (120 tests, 457 expect() calls, 15 files), `bun run build` pass — agent-reported local verification, not CI evidence. M2 catalog and M3 provider tests use isolated temporary databases and mocked provider responses; no real provider data loaded or live authentication performed.
- Dependency evidence (verified 2026-11-15): `@modelcontextprotocol/server@2.4.0` declared/resolved and imported in `apps/mcp-server`; `@modelcontextprotocol/client` not declared in manifests, not resolved in `bun.lock`, and not imported in source.

## 11. Limitations of this reference pass

- Some official sites (exchange portals, vendor docs) are dynamic or may restrict automated access; detailed endpoint/field/limit verification must be completed during implementation using current official documentation and authorized test access.
- Search-result summaries were used to identify and partially confirm official pages; **implementation decisions must rely on the actual current official documentation content and tested behavior**, not summaries alone.
- Provider entitlements, plan-specific features, and real-time limits require account/context-specific verification.
