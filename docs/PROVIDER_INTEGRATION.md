# Provider Integration

> **Status:** Confirmed requirements and adapter design. M1–M3, M4 Stages A/B and **M4 Stages D and E are published on `develop` and accepted** (Stage D final commit `f51e7db`; Stage E commits `ea0cae0`, `00e6830`, `a8f4eef` plus final closeout fixes). **M4 Stage C (FYERS Data Socket adapter) is implemented on `develop`** — adapter-only; the production driver remains locked. Authentication, app types and published rate limits for both providers are verified from official sources (see [REFERENCES.md](REFERENCES.md)). No live provider connection or real-account authentication has been performed; all provider tests use mocks/fake drivers. Items still unknown are marked **(verify)**.
> **Last updated:** 2026-11-18
> **Related:** [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [REFERENCES.md](REFERENCES.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)

## 1. Providers (initial)

| Provider | Role | Status |
|---|---|---|
| Upstox | Read-only market data via **Analytics Token**; streaming/historical/option-chain as supported | **Implemented:** auth adapter (M3) + V3 market-data streaming via official `upstox-js-sdk@2.31.0` (M4 Stage B). Historical/option-chain remain future milestones. |
| FYERS | Read-only market data via V3 **non-trading (data-only) app**; streaming/historical as supported | **Implemented:** auth adapter (M3) + Data Socket streaming adapter (M4 Stage C, official `fyers-api-v3@2.4.1` pinned). Production driver remains locked; historical remains future. |

Both must operate **independently and simultaneously** whenever configured. Additional providers may be introduced later without changing MCP or WebUI contracts.

## 1A. Verified M3 authentication decisions (owner-directed, 2026-11-16)

These decisions govern M3 implementation. Full source list in [REFERENCES.md](REFERENCES.md).

**Upstox — Analytics Token**
- Free, read-only, 1-year validity, generated in Developer Apps → Analytics tab; no OAuth redirect, no daily re-auth, no static IP for market-data categories.
- Only one token per account; generating a new one revokes the previous. UI must explain manual regeneration/revocation.
- Supported categories include Market Quote, Historical Data, Option Chain, Market Information, Fundamentals, News, IPO, Websocket. GET only; no trading/account APIs.
- **Validation endpoint:** `GET https://api.upstox.com/v2/market/status/NSE` (Exchange Status, Market Information category, non-sensitive, `Authorization: Bearer <token>`). Do **not** use User Profile — the User category requires a static IP.
- Standard daily OAuth and expired-instruments APIs (Upstox Plus) are out of M3 scope.

**FYERS — V3 individual app (non-trading / data-only)**
- A **non-trading app** grants data and user-info APIs with no order placement, no static IP requirement, and multiple apps allowed. This matches the product boundary; the trading app's static-IP mandate is avoided.
- Flow: random `state` generated and verified on callback; `appIdHash = SHA-256(app_id:app_secret)` computed on the backend; single-use auth code exchanged at `POST /api/v3/validate-authcode`; `Authorization: app_id:access_token` on later calls.
- Access tokens expire **daily at 6:30 AM**. The response may include a `refresh_token`, but no refresh endpoint was confirmed — do not assume renewal; re-authenticate.
- Profile endpoint is used **only** to validate credentials; returned personal account data is never persisted or exposed.
- Logout/revoke the token when the user explicitly removes the provider.
- Callback: loopback-only listener on a configurable port; the exact URI must match the app's registered redirect URI. FYERS permits any redirect URL under the developer's control. No public callback collector. State is random, short-lived, single-use, invalidated on completion/failure; callback query parameters are never logged.
- Design for **Standard** limits (Data APIs 5/s, 50/min, 5,000/day; Transaction/User Info 10/s, 200/min, 100,000/day as of 16 Oct 2026). Prime-only capabilities (expired F&O, historical Greeks, 1,000-symbol quotes, 5,000 data-socket symbols, 15 TBT) are not assumed.

**Shared M3 decisions**
- Bun native `fetch` for REST; no broker SDKs; no new runtime dependencies. **M4 Stage B exception:** Upstox market-data streaming uses the official `upstox-js-sdk@2.31.0` (pinned) — a deliberate, scoped reversal of the no-SDK decision for that one provider's feed only (see §6). **M4 Stage C exception:** FYERS Data Socket streaming uses the official `fyers-api-v3@2.4.1` (pinned) — a second scoped reversal for that one provider's feed only (see §7A). FYERS REST/auth still uses native `fetch`; the SDK is confined to the streaming adapter.
- Credentials stored via a portable encrypted store (see AD-021): encrypted in SQLite with one key file in the app folder; no Windows/OS credential store, no plaintext fallback.
- No hardcoded plan limits; report actual capability and restrictions; unknown entitlements stay unknown.
- Privileged credential operations are loopback-only; CORS/Origin is not security; no app-level login introduced.

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

## 6. Upstox — verification status

| Area | Status |
|---|---|
| Auth / Analytics Token | **Verified:** free, read-only, 1-year, no OAuth, no static IP for market-data categories; one per account; GET only. See §1A. |
| Validation endpoint | **Verified:** `GET /v2/market/status/NSE` (Exchange Status, Market Information). User Profile is excluded (static IP required). |
| Rate limits | **Verified:** Other Standard APIs 50/s, 500/min, 2000/30min. |
| SDK/Bun | **M3:** direct Bun `fetch`, no broker SDKs. **M4 Stage B (scoped exception):** official `upstox-js-sdk@2.31.0` (pinned) is used for **market-data streaming only**; no order/trading operation is introduced. This deliberately reverses the earlier no-broker-SDK decision for Upstox streaming. |
| Market data feed (V3) | Protobuf WebSocket feed; **M4 Stage B** uses the official SDK instead of the removed custom decoder/proto. SDK declares 9 direct dependencies (measured install: 124 packages, 1 blocked transitive `protobufjs` postinstall). Version-specific workarounds (independently verified 2026-11-17 from the exact `upstox-js-sdk@2.31.0` source): call `autoReconnect(false)` before connect (SDK defaults it on); never use SDK `changeMode()` (it sends `sub` instead of `change_mode`) — use unsubscribe+subscribe; handle Buffer/Uint8Array/string message payloads; wait for SDK protobuf readiness before subscribing. MarketHubTS retains ownership of subscriptions, normalization, freshness and reconnection. Verified limits: 2 connections/user (5 Plus); LTPC 5000/2000, Greeks 3000/2000, Full 2000/1500, Full D30 50/1500 (Plus-only). IV is a separate field, not inside `OptionGreeks`. LTPC is documented as containing **only LTP and close price (CP)** — not a full quote; Full/Full D30 add five/30 market levels, OHLC, `atp`, `vtt`, OI/IV and Greeks. `cp` is the **previous session close** (same canonical meaning as FYERS `prev_close_price`). Field-level capability matrix: [MULTI_PROVIDER_STREAMING_ARCHITECTURE.md](MULTI_PROVIDER_STREAMING_ARCHITECTURE.md) §5, §7.1. |
| Historical / expired instruments | Historical Data supported by Analytics Token; expired-instruments APIs require Upstox Plus — **M5** entitlement decision. |
| Option chain / quotes / depth fields | Streaming quote, depth, OHLC, Greeks and CAS fields are mapped and tested against the SDK's protobuf schema (M4 Stage B). Actual account-level delivery remains unverified because no live connection has been performed. Option-chain functionality remains a future milestone; never fabricate missing fields. |
| Instruments/master data | File/field details **(verify)** before bulk ingestion (out of M3 scope). |

## 7. FYERS — verification status

| Area | Status |
|---|---|
| Auth / app type | **Verified:** V3 individual-app OAuth; **non-trading (data-only) app** has no static IP requirement and no order placement. See §1A. |
| Redirect URI | **Verified:** any redirect URL under developer control is permitted; loopback is acceptable if registered exactly. |
| Token expiry | **Verified:** daily 6:30 AM; no confirmed refresh endpoint — do not assume renewal. |
| Rate limits | **Verified:** official notice effective 16 Oct 2026 — Standard Data APIs 5/s, 50/min, 5,000/day; Transaction/User Info 10/s, 200/min, 100,000/day. Prime-only capabilities not assumed. |
| SDK/Bun | **M3:** direct Bun `fetch` for REST/auth. **M4 Stage C (scoped exception):** official `fyers-api-v3@2.4.1` (pinned) is used for **Data Socket streaming only**; no order/trading operation is introduced. See §7A. |
| Market data / WebSocket | Data socket 100 symbols (Standard), 5,000 (Prime), per user across all connections; TBT 1/15. Protocol/fields studied in the Stage C preflight; implementation on hold. **Verified 2026-11-17:** price (`sf`) and five-level depth (`dp`) are separate messages/subscriptions; `sf` carries LTP, day OHLC, `prev_close_price`, `vol_traded_today`, `avg_trade_price`, `ch`/`chp`, last-traded fields and L1 bid/ask; index (`if`) explicitly has **no volume or bid/ask**; OI/IV/Greeks are **not** in the Data Socket (REST `include_oi`/`include_greeks` only). `last_traded_time` is documented only as an integer — its unit/precision is **not** stated and must not be inferred from the type (bounded live-validation item). Raw wire protocol is undocumented and only the obfuscated `fyers-api-v3` SDK implements it — a native Bun WebSocket is not viable from documentation alone. Field-level capability matrix and merge/timestamp rules: [MULTI_PROVIDER_STREAMING_ARCHITECTURE.md](MULTI_PROVIDER_STREAMING_ARCHITECTURE.md) §6, §7.1, §9, §12. |
| Historical / expired F&O | Standard: daily 5 yrs, intraday 1 yr, expired F&O daily 2 yrs; broader access is Prime-only — **M5** entitlement decision. |
| Quotes/depth/option chain fields | Field availability **(verify)** before M4/M5; never fabricate missing fields. |

## 7A. M4 Stage C — FYERS Data Socket adapter (decision record)

Stage C adds `packages/broker-fyers/src/stream.ts`: a thin, adapter-only wrapper around the official `fyers-api-v3@2.4.1` SDK. It is **structurally compatible** with the supervisor's `StreamingDriver` seam but defines its own interfaces inside `broker-fyers` and imports nothing from `apps/api`. Production wiring and activation remain locked; no live socket, authentication or network call is performed.

**Why the SDK (scoped no-SDK exception).** The raw HSM wire protocol is undocumented and only the obfuscated SDK implements it; a native Bun WebSocket reimplementation would be neither lean nor durable. The exception is confined to this one provider's market-data feed, mirroring the Stage B Upstox exception.

**Verified SDK facts (tarball inspection + runtime probes, 2026-11-18).**
- `DataSocket.getInstance(token, logPath, false)` — the third argument disables logging; the token is never logged.
- `autoreconnect()` is **opt-in** and its argument is a retry count (`autoreconnect(false)` would *enable* it). The wrapper never calls it; the supervisor owns retry with a fresh adapter instance.
- The SDK object is a **process-wide singleton**: `getInstance()` returns the same object after `close()` and even with a different token; there is no reset method. The fresh-instance guarantee applies to the **adapter wrapper**, not the SDK object. The adapter calls `close()` on retirement so the shared socket is released before the next instance connects; only one adapter instance may be active at a time.
- `on(event, cb)` is **single-slot** (no `removeListener`/`off`); a second registration overwrites the first, and `close()` does not detach. Every new adapter instance therefore re-registers all four events (`connect`/`message`/`error`/`close`); a generation guard makes any callback firing before re-registration inert. No listener accumulation is possible.
- **Token rotation requires a process restart.** A fresh wrapper cannot guarantee fresh authentication because the singleton does not re-apply credentials. FYERS tokens expire daily at 06:30 IST with no confirmed refresh endpoint; restart (or a process boundary) is a Stage G operational concern, not solvable in-process here.

**Component mapping and protection.** `sf` → quote (LTP, previous close, OHLC, volume, average trade price, change/percent, last-traded fields) plus L1 best bid/ask depth; `dp` → five-level depth only; `if` (index) → reduced quote with no volume or bid/ask. OI/IV/Greeks are absent from the Data Socket and are reported unsupported, never fabricated. `last_traded_time`/`exch_feed_time` units are undocumented: values are stored verbatim with unit `UNKNOWN`, untrusted, and receipt ordering is used until live verification (Stage G). The adapter tracks five-level depth per symbol: once `dp` depth is emitted, later `sf` L1 depth for that symbol is suppressed while quote fields continue. Reset is surgical — protection is cleared only for symbols removed from the subscription set or on full retirement; retained symbols keep it.

**Limits.** No hardcoded symbol cap and no silent truncation: the desired set is submitted as-is. Connection-preventing over-limit rejections are classified as `LIMITED` with a reason (via connection state and capability report), the shared desired state is left unchanged, and entitlements remain `UNKNOWN` until verified.

## 8. Security and safety

- **No order placement** during testing or in product.
- Credentials are stored via the portable encrypted store (AD-021): encrypted in SQLite with one key file in the app folder; no Windows/OS credential store, no plaintext, no logs, no ordinary data APIs.
- Privileged credential operations are loopback-only; CORS/Origin is not security; no app-level login introduced.
- Full backup/restore (AD-014) must include the key file; a database-only copy is not a complete backup. Backup/restore implementation is M9.

## 9. Current implementation status (M1–M3 + M4 Stage B, published on `develop`)

- `packages/database/src/credentials.ts`: `SqliteCredentialStore` — AES-256-GCM encrypted credentials in `provider_credentials`, 32-byte key file beside the database, per-record random nonce, AAD bound to provider/name, format versioning, fail-closed on missing/corrupt key, explicit reset.
- `packages/market-core/src/provider.ts`: minimal `ProviderRegistry` with per-provider fault isolation and sanitized errors; `fetchWithTimeout`.
- `packages/broker-upstox`: Analytics Token adapter validating via `GET /v2/market/status/NSE`; no OAuth/trading endpoints. **M4 Stage B:** V3 market-data streaming via official `upstox-js-sdk@2.31.0` (pinned) — SDK used for market-data streaming only; MarketHubTS retains subscription ownership, normalization, freshness and reconnection.
- **M4 Stage D locked boundary:** the real Upstox streaming SDK driver is not instantiated in production. The supervisor consumes a provider-agnostic driver seam; production composition uses `LockedUpstoxDriver`, which fails safely on any start/update attempt and never constructs the SDK, opens a socket or schedules retries. Only deterministic fake drivers are used in tests. Real driver construction and connection behavior require a separately authorized, independently reviewed Stage G change.
- `packages/broker-fyers`: V3 non-trading-app OAuth adapter with random single-use state, backend `appIdHash`, loopback callback, daily 06:30 IST expiry, profile validation (PII discarded), logout on removal. **M4 Stage C:** Data Socket streaming adapter (`src/stream.ts`) with its own structurally compatible driver interfaces, generation guards, all-four-event re-registration, adapter-side depth protection and canonical component updates; production driver remains locked.
- `apps/api`: LAN-safe read-only `GET /api/providers/status`; credential-changing routes live on the same app behind one simple local-peer check (no separate management server, no CSRF framework). FYERS callback is loopback-only with single-use state validation.
- Reliability: bounded timeouts, bounded jittered retry for idempotent REST reads (429 respects `Retry-After`; no delay information means no retry), **no retry of the single-use FYERS code exchange**, atomic credential upserts, empty-replacement rejection, fail-closed key handling, and per-provider fault isolation.
- Durable non-secret settings: `provider_settings` table stores FYERS App ID/redirect URI and Upstox/FYERS expiry metadata; loaded on startup. Secrets remain only in the encrypted `CredentialStore`.
- Credential replacement: Upstox candidate tokens are validated before replacing a working token (old token preserved on any failure); FYERS App Secret is stored as a candidate and promoted only after a successful authentication exchange.
- Response validation: HTTP 200 alone is insufficient — Upstox Market Status and FYERS token/profile response shapes are validated; malformed responses produce ERROR status. FYERS profile PII is discarded.
- FYERS redirect URI must be loopback and point to `/api/provider/fyers/callback`; mismatched or non-loopback URIs are rejected.
- WebUI provider panel has functional controls for token/config/secret entry, auth start, validate and remove; status diagnostics remain.
- `apps/web`: minimal provider status panel; no credentials displayed.
- Broker SDKs: official `upstox-js-sdk@2.31.0` (M4 Stage B) and `fyers-api-v3@2.4.1` (M4 Stage C) are installed for market-data streaming only (scoped exceptions); neither is used for orders/trading. No live provider connection or real-account authentication has been performed; all provider tests use mocked responses.

## 10. Open verification items

See [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md) and [REFERENCES.md](REFERENCES.md) for remaining gaps: actual account entitlements, Analytics Token generation on the account, exact provider field availability, FYERS Data Socket field delivery and timestamp units (adapter implemented in Stage C; live verification is a Stage G gate), SDK execution under Bun (Stage G smoke test), token rotation via process restart, and historical/expired entitlements (M5).
