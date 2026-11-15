# Market Data and Catalog

> **Status:** Confirmed requirements and target design; implementation pending. Items marked **(verify)** require official-source verification.
> **Last updated:** 2026-11-15
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

**Index-derivative underlyings accepted during product discovery (names and actual exchange eligibility must be verified against current official exchange information before implementation; do not rely on older hardcoded registries):**

| Underlying (discovery name) | Verification status |
|---|---|
| NIFTY 50 | **(verify)** current NSE eligibility/contracts |
| BANK NIFTY | **(verify)** |
| FINNIFTY | **(verify)** |
| MIDCPNIFTY | **(verify)** |
| NIFTY NEXT 50 | **(verify)** |
| NIFTY India FPI 150 | **(verify current eligibility/contracts)** — Official NSE press release states introduction date of Nifty India FPI 150 index futures and options as **08 December 2025** (see [REFERENCES.md](REFERENCES.md)); introduction date is distinct from current eligibility and actual available contracts/specs, which must be verified independently from current official exchange information before implementation |

### 1.2 BSE
- SENSEX.
- SENSEX futures and options.

**Explicitly out of scope:** BANKEX derivatives, SENSEX50 derivatives, other BSE stock derivatives, other unsupported BSE derivatives. Do not broaden supported universe simply because a broker supplies additional instruments.

### 1.3 Dynamic catalog rule
- Catalog must dynamically follow official exchange instrument and contract information.
- **Do not permanently hardcode** changing contract lists, lot sizes, expiries, strike schemes, or quantity freezes.

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

### 3.1 Canonical model (target)

| Concept | Required information |
|---|---|
| Canonical instrument identity | Stable internal identifier independent of any single provider |
| Exchange and segment identity | Exchange (NSE/BSE), segment/market type as applicable |
| Underlying identity | Canonical underlying for derivatives/cash linkage |
| Provider-native identifiers and mappings | Upstox/FYERS instrument keys/codes/symbols mapped to canonical ID |
| Instrument aliases | Searchable/recognized aliases and symbols |
| Contract identity (F&O) | Instrument type (future/option), underlying, expiry, strike, option type (CE/PE) |
| Contract specifications | Lot size, tick size, quantity freeze (where applicable) — sourced dynamically **(verify)** |
| Status | Active/expired/excluded/removed; effective dates as known |
| Source and synchronization metadata | Source(s), sync time, version/state, completeness/conflict indicators |

### 3.2 Identity rules
- **Distinguish canonical identity from provider-native identifiers.** Consumers operate on canonical entities; adapters resolve mappings.
- Preserve provider-native identifiers in mappings/attribution for traceability.
- Support current and expired contracts with unambiguous identity.

### 3.3 Synchronization and evolution
- **Transactional and safe:** failed or incomplete syncs must never destroy the previous valid catalog.
- Track evolution when contracts are introduced, modified, expired, excluded, or removed.
- Reconcile differences across providers/exchange sources using verified rules; record conflicts/uncertainty rather than guessing.
- Maintain auditability of catalog changes (metadata/versioning) **(planned)**.

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

- **Implemented:** none of the canonical catalog or market-data normalization/processing.
- **Scaffold:** `packages/market-core` placeholder; `packages/contracts` contains only health/error schemas.
- **Next:** define canonical contracts/schemas and catalog model in shared packages/services per roadmap.

## 7. Verification notes

- NSE index-derivative eligibility (including NIFTY India FPI 150) and BSE SENSEX derivatives scope must be confirmed against current official exchange information before implementation. NIFTY India FPI 150 introduction date (08 December 2025, per official NSE press release) must not be treated as proof of current eligibility or currently available contracts.
- Provider field availability (OI/IV/Greeks/depth granularity), historical/expired-contract access, and market-wide dataset sources require official verification (see [REFERENCES.md](REFERENCES.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)).
