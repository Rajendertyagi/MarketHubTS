# Market Data and Catalog

> **Status:** Confirmed requirements and target design; **M2 canonical catalog foundation implemented and corrected in application** (contracts, identity, persistence, transactional sync primitives) with synthetic/test validation. Real provider ingestion, live/historical/option-chain data, and search/UI exposure are not implemented. Items marked **(verify)** require official-source verification.
> **Last updated:** 2026-11-16
> **Related:** [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [REFERENCES.md](REFERENCES.md)

## 1. Supported universe (confirmed)

### 1.1 NSE
- Major NSE indices (cash/index market data exposure; see §1.1.1 — distinct from index F&O underlyings).
- NSE F&O stocks.
- NSE cash-market instruments for supported F&O stocks.
- Futures and options for supported stock underlyings.
- Futures and options for currently eligible NSE index-derivative underlyings (see §1.1.2).
- Current and expired contracts.
- All relevant expiries and available strikes.

#### 1.1.1 Major NSE cash indices vs NSE index F&O underlyings (clarification)

| Category | Meaning | Scope status |
|---|---|---|
| **NSE cash-index catalogue** | Index definitions/values/market data MarketHub should be able to expose as indices (quotes/candles/market-wide context as available), based on official NSE index definitions and configured/available sources. This is broader than derivatives eligibility. | **Confirmed requirement (catalogue-based):** do not hardcode a small fixed list and do not treat the six F&O underlyings as the complete cash-index catalogue. Exact enabled/default/core set requires product confirmation and verified source mapping. |
| **NSE index F&O underlyings** | Index underlyings eligible for NSE futures/options contracts that MarketHub must support for derivatives data (current/expired contracts, expiries, strikes as applicable). | **Approved scope (six underlyings):** see §1.1.2. Keep separate from the broader cash-index catalogue. Do not expand or reduce without evidence and authorization. |

**Recommended catalogue architecture (target, evidence-oriented):**
- **Discoverable catalogue:** maintain a discoverable catalogue of official NSE index definitions (not a hardcoded handful). NSE Indices manages a large index universe (reported as 440+ indices across families; **verify current official count/scope**), so the catalogue must scale without assuming every index is streamed or stored.
- **Organization:** organize indices by official categories/families where supported (e.g. broad-market, sectoral, thematic/strategy, and other official categories as defined by NSE; **verify current taxonomy**).
- **Configuration:** streaming and historical synchronization must be individually configurable per index (or defined index groups) through WebUI operational settings; no automatic subscription/sync for hundreds of indices by default.
- **Availability:** show/expose only data actually available from configured and capable sources; report unavailable/unsupported/stale states clearly (no fabrication).
- **Separation of concerns:** the six approved index F&O underlyings (§1.1.2) are a distinct derivatives scope and must remain separate from the broader cash-index catalogue, even when the same index appears in both contexts.

**Important:** inclusion in the cash-index catalogue does **not** imply F&O eligibility; F&O support is limited to currently eligible contracts for the approved underlyings in §1.1.2 and verified BSE scope. **India VIX** remains tracked separately under market-wide information (§2), not as an index F&O underlying in this product scope.

#### 1.1.2 NSE index F&O underlyings (approved)

**Supported NSE index-derivative underlyings (MarketHubTS scope):** NIFTY 50, NIFTY BANK, NIFTY FINANCIAL SERVICES (FINNIFTY), NIFTY MIDCAP SELECT (MIDCPNIFTY), NIFTY NEXT 50, NIFTY INDIA FPI 150.

| Underlying | Verification status (current NSE specifications) |
|---|---|
| NIFTY 50 | **Verified (current NSE specs):** listed as an index underlying in current NSE equity-derivatives contract specifications/products publications (see [REFERENCES.md](REFERENCES.md)). Actual listed contracts/expiries/strikes/specs remain authoritative-source-driven. |
| NIFTY BANK | **Verified (current NSE specs):** listed in current NSE equity-derivatives contract specifications/products publications. Actual contracts/specs authoritative-source-driven. |
| NIFTY FINANCIAL SERVICES (FINNIFTY) | **Verified (current NSE specs):** listed in current NSE equity-derivatives contract specifications/products publications. Actual contracts/specs authoritative-source-driven. |
| NIFTY MIDCAP SELECT (MIDCPNIFTY) | **Verified (current NSE specs):** listed in current NSE equity-derivatives contract specifications/products publications. Actual contracts/specs authoritative-source-driven. |
| NIFTY NEXT 50 | **Verified (current NSE specs):** listed in current NSE equity-derivatives contract specifications/products publications. Actual contracts/specs authoritative-source-driven. |
| NIFTY INDIA FPI 150 | **Verified (current NSE specs):** listed in current NSE equity-derivatives contract specifications/products publications; NSE NIFTY India FPI 150 page documents FUTIDX and OPTIDX products. Introduction date (08 Dec 2025, official NSE press release) is distinct from current eligibility and actual available contracts/specs, which remain authoritative-source-driven. |

**Observation-date reconciliation:** SEBI Annual Report 2025–26 states five eligible NSE indices as of **31 March 2026** (observation date). Later NSE publications (contract specifications updated 11 Aug 2026; products page updated 12 Aug 2026; NIFTY India FPI 150 product page) list/document six index underlyings including NIFTY India FPI 150. These are different observation dates; MarketHubTS documents the six underlyings as verified from current NSE specifications/publications while preserving source/as-of context and not fabricating live contracts. Exchange eligibility remains distinct from MarketHubTS product scope and from actual available contracts.
### 1.2 BSE
- SENSEX.
- SENSEX futures and options.

**Explicitly out of scope:** BANKEX derivatives, SENSEX50 derivatives, other BSE stock derivatives, other unsupported BSE derivatives. Do not broaden supported universe simply because a broker supplies additional instruments.

### 1.3 Dynamic catalog rule
- Catalog must dynamically follow official exchange instrument and contract information.
- **Do not permanently hardcode** changing contract lists, lot sizes, expiries, strike schemes, or quantity freezes.

### 1.4 F&O domain primer (verified 2026-11-16; see [REFERENCES.md](REFERENCES.md) §7)

This primer grounds the catalog model in how Indian equity F&O actually works. It is descriptive only — no concrete contract values are asserted here.

| Concept | What it means for the catalog |
|---|---|
| **Security descriptor** | NSE identifies a contract by market type `N`, instrument type (`FUTIDX`/`OPTIDX`/`FUTSTK`/`OPTSTK`), underlying, expiry date, and for options `CE`/`PE` plus strike. This is the real-world basis of the M2 derivative identity tuple (exchange + segment + class + underlying canonical ID + expiry + normalized strike + option type). |
| **CE / PE and settlement** | `CE` = Call European, `PE` = Put European; Indian options are European style. Index F&O is cash-settled; stock F&O is physically settled (an ITM stock option at expiry becomes a delivery obligation). Lifecycle status must be authoritative source data, not inferred. |
| **Expiry framework** | Since the SEBI circular of 26 May 2025 (effective 1 Sep 2025), each exchange has one expiry weekday — NSE Tuesday, BSE Thursday — with one weekly benchmark index option (Nifty 50 / Sensex); all other equity derivatives have at least one-month tenor and expire in the last week of the month. NSE moves a holiday expiry to the previous trading day. **Expiry dates must be read from contract data, never computed from weekday rules.** |
| **Dynamic specs** | Index strike intervals depend on underlying price; stock-option strike schemes depend on volatility and are reviewed quarterly. Tick size: index futures 0.05/0.10/0.20 by index level, stock futures inherit the cash-market tick, all options 0.05. Lot size and quantity freeze come from NSE contract/lot-size files and are reviewed periodically. These are source-attributed, time-aware fields — never hardcoded. |
| **Option chain** | CE on the left, PE on the right, strikes in the middle; per-strike OI, change in OI, volume, IV, LTP, net change, bid/ask quantity and price. These are live market fields for future realtime/snapshot layers, **not** catalog fields. |
| **Moneyness** | ITM/ATM/OTM is derived from spot vs strike (CE ITM when strike < spot; PE ITM when strike > spot). It is a derived view, not a stored contract attribute. |
| **Out of scope** | SPAN/exposure margins, MWPL ban periods and position limits are broker/account/risk concerns and are excluded from MarketHubTS. |

## 2. Market-wide information (retain where applicable)

| Dataset | Intent | Source/availability notes |
|---|---|---|
| India VIX | Market volatility index | **(verify)** official/broker source, fields, update frequency |
| Major indices | Index values/changes | **(verify)** NSE/BSE/broker availability |
| Advance/decline and market breadth | Market-wide breadth | **(verify)** source and calculation basis if derived from official data (do not fabricate) |
| Sector indices and sector data | Sector-level information | **(verify)** |
| FII/DII information | Institutional flow data | **(verify)** official report/source, timeliness/lag |
| Participant-wise derivatives OI | Participant OI data | **(verify)** exchange report availability/format |
| Relevant exchange reports and bhavcopies | End-of-day/reference reports | **(verify)** NSE/BSE report endpoints/files, licensing/terms |
| Exchange trading calendars and market status | Trading days/holidays/session status | **(verify)** official calendar/status sources |

Limitations must be documented per dataset; unavailable data reported explicitly.

## 3. Common instrument catalog (foundational)

The catalog is shared by: Dashboard, Market data, Watchlists, Charts, Options, Futures, Alerts, Scanners, Historical data, REST, and MCP.

### 3.1 Canonical model (implemented foundation / target)

| Concept | Required information |
|---|---|
| Canonical instrument identity | Stable internal `canonicalId` independent of any single provider; normalized versioned `identityKey` for uniqueness/stability |
| Exchange and segment identity | Exchange (NSE/BSE), segment/market type as applicable; exchange-specific tradable listings remain distinguishable |
| Underlying identity | Canonical underlying for derivatives/cash linkage (derivatives reference underlying canonical ID) |
| Provider-native identifiers and mappings | Upstox/FYERS native identifiers mapped to canonical ID with status/validity/provenance and preserved source metadata (unstable tokens like Upstox `exchange_token` / FYERS `exToken` are not canonical identity) |
| Instrument aliases | Searchable/recognized aliases with normalized value, type, source, and normalized scope (global or exchange/segment context); ambiguity returned, not guessed |
| Contract identity (F&O) | Instrument class (stock/index future/option), underlying canonical ID, exact expiry date, strike and option type (CE/PE) for options |
| Contract specifications | Lot size, tick size, quantity freeze where provided — source-attributed/time-aware; never fabricated |
| Status | Trading/lifecycle status and contract lifecycle status; explicit authoritative lifecycle updates only |
| Source and synchronization metadata | Source/provider, observed/received/synced times, version/scope/completeness/conflicts, provenance |

### 3.2 Identity rules (implemented, M2 corrected)

- **Canonical instrument meaning:** represents an exchange-specific tradable listing/contract in the catalog context. Exchange-specific listings remain distinguishable (e.g. same ISIN on NSE and BSE are distinct canonical instruments).
- **Cash equity identity (priority):** `v1|EXCHANGE|SEGMENT|EQUITY|ISIN:<normalized>` when valid ISIN is available; else `SECID:<exchangeSecurityId>`; else `STABLE:<stableIdentifier>`; else `SYMBOL:<normalized symbol>` fallback only when no stronger stable identifier exists. Symbol/display-name changes do not change identity when the stable identifier basis remains the same.
- **Index identity:** `v1|EXCHANGE|SEGMENT|INDEX|CODE:<exchangeSecurityId|stableIdentifier|normalized index code>`. Provider tokens are not canonical index identity. Cash-index catalogue membership, exchange F&O eligibility, MarketHubTS product scope, and actual listed contracts are separate concepts.
- **Derivative identity:** `v1|EXCHANGE|SEGMENT|<STOCK_FUTURE|STOCK_OPTION|INDEX_FUTURE|INDEX_OPTION>|<underlyingCanonicalId>|<YYYY-MM-DD>` for futures, plus `|<normalized strike>|<CE|PE>` for options. Identity is based on contract-defining fields (not trading symbols/provider IDs/display names/lot/tick/freeze updates). Strike normalization is deterministic.
- **Stability/migration:** identity is versioned (`identityVersion`, currently v1). Existing canonical IDs/identity keys are preserved across sync/metadata updates; identity-critical fields are preserved on merge when omitted by incomplete input. M2 migration is unshipped in repo state and was corrected/regenerated as `0001_lively_mauler.sql` (M1 migration unchanged). Identifier history and structured derivative-contract storage are included in the corrected M2 schema.

### 3.3 Provider mappings and aliases (implemented)

- **Mappings:** unique per `(provider, nativeIdentifier)` and linked to canonical instruments. Upstox `instrument_key` / FYERS `fyToken` (and other native identifiers) map independently; Upstox `exchange_token` and FYERS `exToken` may be stored as non-canonical metadata/tokens but never as canonical identity. Provider-native symbols are not assumed interchangeable. Conflicting remaps are reported, not silently overwritten.
- **Aliases:** stored with original alias, normalized alias, type, source, optional exchange/segment, and non-null normalized scope keys (`exchangeScope`, `segmentScope`, `*` for global). Unique per `(canonicalId, aliasNormalized, aliasType, source, exchangeScope, segmentScope)` to prevent duplicates in the same scope while allowing the same alias to point to multiple canonical instruments (ambiguity). Resolution is normalized and can be narrowed by context; ambiguous matches are returned, not silently selected.

### 3.4 Synchronization and evolution (implemented)

- **Transactional and safe:** validated batches applied in DB transactions; invalid/conflicting batches do not leave partial catalog writes; failed/incomplete sync preserves previous valid catalog.
- **Batch semantics:** source-independent `COMPLETE`/`PARTIAL`/`INCREMENTAL` batches with scope/source/version/observed metadata. Partial/incremental batches do not remove absent instruments; a source does not remove another source’s mappings; no destructive replacement.
- **Conflict handling:** duplicate identity in batch, unknown canonical references, and ambiguous provider remaps reported as conflicts (error conflicts fail/rollback). Sync runs record status/counts/conflicts/timestamps for diagnostics/auditability (failed-run persistence best-effort outside rolled-back catalog transaction).
- **Lifecycle:** explicit authoritative lifecycle/status changes applied only from batch input; absence from a provider file does not automatically imply delisted/expired. Full-snapshot reconciliation must be explicitly scoped (future adapter responsibility).
## 4. Data normalization and provenance

### 4.1 Normalization layers
1. **Stable canonical fields** shared across providers (common schema for quotes, depth, candles, contracts, etc.).
2. **Provider-specific fields** preserved without losing original information (extensible payload/attributes).
3. **Source/provider attribution** for every observation/record.
4. **Original provider observation timestamps** where available, plus system receive/cache timestamps as applicable.
5. **Explicit freshness and availability state** (fresh/stale/unavailable/unsupported/limited, etc. — exact states to be defined).

### 4.2 Truthfulness rules (confirmed)
- Raw values must not be fabricated.
- **Never calculate missing provider-supplied market fields:** OI, IV, option Greeks, prices, market depth, volume. If unavailable, report unavailable.
- **Derived technical indicators** (EMA, SMA, RSI, MACD, etc.) are permitted only as **separately labelled derived indicators**, never confused with provider-supplied raw data.
- New provider fields must not require consumers to change workflows or require a new MCP tool for every individual field (design for extensible attributed data).

## 5. Instrument/data domains (target coverage)

| Domain | Examples / notes |
|---|---|
| Instruments & search | Discovery, search, aliases, contract lookup across supported universe |
| Quotes & depth | LTP/quotes, bid/ask, market depth (as provided), freshness/source |
| Historical candles | OHLCV/timeframes as supported by providers; cached locally |
| Option chains | Strikes/expiries, CE/PE data, OI/IV/Greeks only if provider-supplied |
| Futures | Futures contracts/quotes/data for supported underlyings |
| Market-wide | Indices, VIX, breadth, sectors, FII/DII, participant OI, reports/bhavcopies, calendars/status (availability varies) |

## 6. Current implementation status

- **Implemented (M2 corrected, in application):**
  - `packages/contracts/src/market.ts`: Zod-validated canonical schemas/types for exchange/segment/classification, instruments (equity/index/stock future/stock option/index future/index option), derivative specs, separated cash-index membership / exchange derivative eligibility / MarketHubTS product scope metadata, provider mappings, aliases (normalized + scoped), provenance/freshness/availability concepts, and sync scope/batch/result/conflicts.
  - `packages/market-core`: versioned normalized identity-key computation (ISIN/exchange security/stable identifier priority for equities, stable index codes, derivative identity by underlying canonical ID + exact contract fields with deterministic strike normalization), repository/transaction ports, and `CatalogSyncService` for source-independent transactional batch apply with conflict reporting and safe failure behavior.
  - `packages/database`: corrected unshipped additive migration `0001_lively_mauler.sql` and `SqliteCatalogRepository` persisting `canonical_instruments`, `derivative_contracts` (one-to-one structured core derivative fields), `provider_instrument_mappings`, `instrument_aliases`, `instrument_identifier_history`, and `catalog_sync_runs` (PK/FK/unique/index constraints; non-null normalized alias/identifier scope keys; JSON fields for extensible/provider-specific metadata and separated eligibility/scope concepts).
  - Automated tests (`tests/market/catalog.test.ts`) verify corrected M2 scenarios on isolated temporary databases, including clean install and M1→M2 upgrade preserving `app_meta`.
- **Not implemented:** real provider adapters/API/SDK integration, bulk exchange catalog downloads, production data seeding, live/historical/option-chain normalization pipelines, instrument search, market-data REST/SSE/MCP surfaces, and UI market modules.
- **Scope separation (implemented/modeling):** cash-index catalogue membership, exchange F&O eligibility, MarketHubTS product scope, and actual available contracts are distinct concepts. NSE cash-index catalogue remains separate from NSE index F&O eligibility; NSE stock F&O membership is dynamic/source-driven (not hardcoded). MarketHubTS BSE derivative scope is restricted to SENSEX and SENSEX F&O (a product-scope restriction, not a claim about BSE’s broader universe). Actual listed contracts/expiry dates/specs must come from authoritative contract data (not generated from weekday rules).
- **Verification status:** current exchange eligibility, actual listed contracts/specs, and provider-native identifier/master details remain **(verify)** before provider integration. No real provider/exchange data loaded.

## 7. Verification notes

- NSE index-derivative eligibility (including NIFTY India FPI 150) and BSE SENSEX derivatives scope must be confirmed against current official exchange information before implementation. NIFTY India FPI 150 introduction date (08 December 2025, per official NSE press release) must not be treated as proof of current eligibility or currently available contracts.
- Provider field availability (OI/IV/Greeks/depth granularity), historical/expired-contract access, and market-wide dataset sources require official verification (see [REFERENCES.md](REFERENCES.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)).
