# Provider Integration

> **Status:** Confirmed requirements and target adapter design. M3 readiness research is complete: Upstox and FYERS authentication, app types and published rate limits are verified from official sources (see [REFERENCES.md](REFERENCES.md)). No live broker integration is implemented yet; M3 implementation is a separate authorized assignment. Items still unknown are marked **(verify)**.
> **Last updated:** 2026-11-16
> **Related:** [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [ARCHITECTURE.md](ARCHITECTURE.md), [REFERENCES.md](REFERENCES.md), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md)

## 1. Providers (initial)

| Provider | Role | Status |
|---|---|---|
| Upstox | Read-only market data via **Analytics Token**; streaming/historical/option-chain as supported | **Planned** — adapter scaffold only (`packages/broker-upstox`) |
| FYERS | Read-only market data via V3 **non-trading (data-only) app**; streaming/historical as supported | **Planned** — adapter scaffold only (`packages/broker-fyers`) |

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
- Bun native `fetch` for REST; no broker SDKs; no new runtime dependencies.
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
| SDK/Bun | **Resolved for M3:** direct Bun `fetch`; no broker SDKs installed. |
| Market data feed (V3) | Protobuf WebSocket feed documented; protocol/field details remain **M4** verification. |
| Historical / expired instruments | Historical Data supported by Analytics Token; expired-instruments APIs require Upstox Plus — **M5** entitlement decision. |
| Option chain / quotes / depth fields | Field availability **(verify)** before M4/M5; never fabricate missing fields. |
| Instruments/master data | File/field details **(verify)** before bulk ingestion (out of M3 scope). |

## 7. FYERS — verification status

| Area | Status |
|---|---|
| Auth / app type | **Verified:** V3 individual-app OAuth; **non-trading (data-only) app** has no static IP requirement and no order placement. See §1A. |
| Redirect URI | **Verified:** any redirect URL under developer control is permitted; loopback is acceptable if registered exactly. |
| Token expiry | **Verified:** daily 6:30 AM; no confirmed refresh endpoint — do not assume renewal. |
| Rate limits | **Verified:** official notice effective 16 Oct 2026 — Standard Data APIs 5/s, 50/min, 5,000/day; Transaction/User Info 10/s, 200/min, 100,000/day. Prime-only capabilities not assumed. |
| SDK/Bun | **Resolved for M3:** direct Bun `fetch`; no broker SDKs installed. |
| Market data / WebSocket | Data socket 100 symbols (Standard), TBT 1 symbol; protocol/fields remain **M4** verification. |
| Historical / expired F&O | Standard: daily 5 yrs, intraday 1 yr, expired F&O daily 2 yrs; broader access is Prime-only — **M5** entitlement decision. |
| Quotes/depth/option chain fields | Field availability **(verify)** before M4/M5; never fabricate missing fields. |

## 8. Security and safety

- **No order placement** during testing or in product.
- Credentials are stored via the portable encrypted store (AD-021): encrypted in SQLite with one key file in the app folder; no Windows/OS credential store, no plaintext, no logs, no ordinary data APIs.
- Privileged credential operations are loopback-only; CORS/Origin is not security; no app-level login introduced.
- Full backup/restore (AD-014) must include the key file; a database-only copy is not a complete backup. Backup/restore implementation is M9.

## 9. Current implementation status (M3, uncommitted)

- `packages/database/src/credentials.ts`: `SqliteCredentialStore` — AES-256-GCM encrypted credentials in `provider_credentials`, 32-byte key file beside the database, per-record random nonce, AAD bound to provider/name, format versioning, fail-closed on missing/corrupt key, explicit reset.
- `packages/market-core/src/provider.ts`: minimal `ProviderRegistry` with per-provider fault isolation and sanitized errors; `fetchWithTimeout`.
- `packages/broker-upstox`: Analytics Token adapter validating via `GET /v2/market/status/NSE`; no OAuth/trading endpoints.
- `packages/broker-fyers`: V3 non-trading-app OAuth adapter with random single-use state, backend `appIdHash`, loopback callback, daily 06:30 IST expiry, profile validation (PII discarded), logout on removal.
- `apps/api`: LAN-safe read-only `GET /api/providers/status`; credential-changing routes live on the same app behind one simple local-peer check (no separate management server, no CSRF framework). FYERS callback is loopback-only with single-use state validation.
- Reliability: bounded timeouts, bounded jittered retry for transient 429/5xx/network failures, atomic credential upserts, empty-replacement rejection, fail-closed key handling, and per-provider fault isolation.
- `apps/web`: minimal provider status panel; no credentials displayed.
- No broker SDKs installed; no live data flows or live authentication performed. All provider tests use mocked responses.

## 10. Open verification items

See [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md) and [REFERENCES.md](REFERENCES.md) for remaining gaps: actual account entitlements, Analytics Token generation on the account, exact provider field availability, feed protocols (M4), and historical/expired entitlements (M5).
