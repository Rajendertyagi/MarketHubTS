# Open Questions and Technical Risks

> **Status:** Tracked confirmations, established decisions, pending verifications, and risks. Do not reopen confirmed product decisions.
> **Last updated:** 2026-11-18
> **Related:** [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md), [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [REFERENCES.md](REFERENCES.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md)

## 1. Confirmed product decisions (do not reopen)

- Product identity/direction: MarketHubTS is the only intended future MarketHub application (clean, independent TypeScript solution). Original Python MarketHub is reference for domain knowledge/useful requirements only (no migration/copy/reproduction of code, architecture, or accumulated complexity). AI-first, local-first Indian stock-market data platform (NSE/BSE F&O focus) to collect/normalize/organize/maintain/expose market data.
- Exclusions: no trading/order management, no broker account management, no AI recommendations/predictions/signals, no sentiment, no chat, no general CSV/Excel market-data export (watchlist import/export separate if retained).
- Later phases required (phased priorities, not unwanted): News integration; X/Twitter integration; market-wide information (as applicable/available).
- One canonical data and application-services foundation for MCP, REST/SSE, WebUI; no duplicate market-data interpretation/business logic.
- Initial providers Upstox and FYERS, independent/simultaneous; one provider failing must not break the other; app works with either/neither (local/non-broker data).
- Automatic source selection by capability/availability/freshness/reliability/limits; optional manual preferences; no fixed provider priority.
- Never fabricate raw provider-supplied market fields (OI, IV, Greeks, prices, depth, volume); derived indicators separately labelled.
- Live ticks/depth in memory only (no per-event persistence); historical candles cached; option-chain snapshots persisted separately per WebUI capture config; retention user-controlled.
- MCP is primary AI interface; AI may manage watchlists/alerts/scanners and do on-demand retrieval but cannot modify operational configuration; alerts/scanners never auto-subscribe; waiting-for-streaming behavior required.
- WebUI is operational control centre; simple configurable settings, no hidden fixed policies, no silent selection changes due to limits.
- Deployment/operating model: single local owner/application instance on user’s PC (Windows-first, local-first). **Single-user means one local application owner, not one connected client.** **LAN access is required** (WebUI and MCP HTTP) so other applications/devices/multiple MCP clients can connect to the same running application. Local browser-based WebUI acceptable; native desktop wrapper optional (do not prematurely force either). No cloud/public exposure; no app-level user login.
- Full backup/restore must include DB and any key material/state required to recover encrypted broker credentials; restore tested on clean install.

## 2. Technical decisions already established (baseline)

- Bun + TypeScript monorepo; single long-running backend process initially.
- React + Vite WebUI; Hono API; Zod contracts; SQLite (`bun:sqlite`) + Drizzle.
- TanStack Router/Query/Table/Virtual, Zustand, Tailwind CSS, shadcn/ui (selected/integrated progressively).
- MCP TypeScript SDK (v2 packages in scaffold) with STDIO now; **latest stable official MCP protocol is a mandatory product requirement** (verified target `2026-07-28` / SDK `2.4.0`, re-verify at implementation start); Streamable HTTP primary network transport, fully implemented and working in M6. See [M6_PLAN.md](M6_PLAN.md) §3.1–§3.3.
- SSE primary for frontend realtime delivery; drop overflowing events, not subscribers; WebSocket only if justified.
- Vela as charting candidate (compatibility pending).
- Provider-specific logic in adapters; canonical catalog/identity shared and transactionally synced.

## 3. Technical details awaiting official verification

| Area | Pending verification | Why it matters |
|---|---|---|
| NSE universe/eligibility | Current official eligibility/specs and actual available contracts for NIFTY 50, BANK NIFTY, FINNIFTY, MIDCPNIFTY, NIFTY NEXT 50, NIFTY India FPI 150 (NIFTY India FPI 150 introduction date 08 December 2025 per official NSE press release is distinct from current eligibility/contracts); contract details/changes | Correct supported universe and catalog rules |
| BSE scope | Official SENSEX derivatives scope/specs; confirmation of excluded instruments | Prevent scope creep/errors |
| Upstox auth / limits | **Verified for M3:** Analytics Token (free, read-only, 1-year, no OAuth/static IP for market data), validation via `GET /v2/market/status/NSE`, Standard rate limits. Remaining: exact field availability and feed protocols (M4), expired-instruments entitlement (M5). | M3 adapter design; later data work |
| FYERS auth / limits | **Verified for M3:** V3 individual-app OAuth with non-trading app, loopback redirect, daily 6:30 AM expiry, no assumed refresh, Standard limits effective 16 Oct 2026. Remaining: exact field availability and feed protocols (M4), historical/expired entitlements (M5). **Stage C data-socket facts (verified 2026-11-17/18, see [MULTI_PROVIDER_STREAMING_ARCHITECTURE.md](MULTI_PROVIDER_STREAMING_ARCHITECTURE.md) §6 and [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md) §7A):** `autoreconnect()` is opt-in (retry count) and never called; `DataSocket.getInstance(token, logPath, false)` disables logging; the SDK object is a process-wide singleton with single-slot listeners; token rotation requires a process restart. Timestamp unit/precision (`last_traded_time` documented only as an integer — unit not stated and not to be inferred) and `cn`/`sub` confirmation schemas remain live-verification items (Stage G). | M3 adapter design; Stage C adapter; Stage G live verification |
| Upstox/FYERS SDKs on Bun | **Resolved for M3:** direct Bun `fetch` REST; no broker SDKs. **M4 Stage B scoped exception:** pinned `upstox-js-sdk@2.31.0` for Upstox market-data streaming only. **M4 Stage C scoped exception (implemented):** pinned `fyers-api-v3@2.4.1` for FYERS Data Socket streaming only; the raw wire protocol is undocumented and only the obfuscated SDK implements it, so a native Bun WebSocket is not viable from documentation alone. SDK-on-Bun compatibility is **not documented** — Node compatibility must not be assumed to imply Bun compatibility; requires a live, credentialed smoke test before committing to Bun-native execution (or a Node subprocess boundary). | Implementation simplicity and reliability; see [MULTI_PROVIDER_STREAMING_ARCHITECTURE.md](MULTI_PROVIDER_STREAMING_ARCHITECTURE.md) §6.1 |
| Market-wide sources | Official/usable sources and terms for India VIX, breadth, sectors, FII/DII, participant-wise derivatives OI, reports/bhavcopies, calendars/status | Data availability and compliance |
| MCP spec/SDK (2026-07-28) | **Research complete (2026-11-19):** mandatory server-side requirements are enumerated in [M6_PLAN.md](M6_PLAN.md) §3.1 (C1–C21); optional extensions evaluated in §3.2; modern-vs-legacy policy in §3.3. Remaining at implementation: re-verify latest stable spec/SDK, decide dual-era vs `legacy: 'reject'`, LAN Host/Origin allow-list, conformance tooling. **Deprecated legacy HTTP+SSE is not implemented.** | Correct MCP transport and interoperability |
| Vela charting | React/provider integration, required features (candles/indicators/drawings/multi-chart/workspace persistence), performance/memory, licensing/attribution, Bun/Vite fit | Chart milestone feasibility |
| Secure credential storage | **Implemented (M3, AD-021):** portable encrypted SQLite + one local key file in the app folder; no Windows/OS credential store, no plaintext. | Security, portability, owner workflow |
| Backup key material | AD-014 preserved: the folder (DB + key file) is the backup unit; a DB-only copy is not complete. M9 must design encrypted export/import and clean-install restore drills. | True full restore; no false claims |
| Stage G — FYERS terminal-error classification | The Stage C adapter's `isLimitFailure()` uses broad message matching. Before Stage G, verify actual SDK error payloads and rejection signatures; establish that genuine subscription-limit failures are classified as terminal `LIMITED`, while ordinary transient failures are not incorrectly classified as terminal. | Correct non-retryable classification; avoid both silent retries and false terminal limits |
| Stage G — FYERS depth subscription handoff | The FYERS adapter accepts `depth?: boolean` on `FyersDriverSubscription`, while the generic `DriverSubscription` exposes only `canonicalId` and `nativeIdentifier`. The Stage G integration design must resolve how depth intent reaches the FYERS adapter through the generic driver seam. Do not claim end-to-end five-level depth subscription support through the supervisor until that handoff exists and is tested. | Honest depth capability; no unsupported end-to-end claim |

## 4. Compatibility issues (known/possible)

- **Vite 8 + TypeScript 7:** latest majors; scaffold build/typecheck passed but ecosystem/plugin edge cases possible as features grow.
- **Tailwind CSS 4:** v4 configuration/tooling differs from v3; current setup works for scaffold.
- **MCP v2 SDK/package split:** differs from v1 patterns; transport APIs must match verified current docs.
- **Bun vs Node-targeted broker SDKs:** potential incompatibilities (native modules, APIs, WebSocket/protobuf tooling) — must be validated.
- **Provider protocol/format differences:** protobuf/JSON schemas, field naming, timestamps, instrument keys require careful normalization.

## 5. Provider entitlement and access limitations

- Some Upstox/FYERS features/endpoints/data modes may be plan-, account-, or entitlement-dependent (e.g. expired instruments, higher subscription/depth limits) — **(verify)**.
- Historical depth/range and option-chain field availability (OI/IV/Greeks) may vary by provider/instrument/entitlement — must be reported, never fabricated.
- Exchange/report data access may have licensing, timing, or format constraints — **(verify)**.

## 6. Performance and reliability risks

- High-frequency live feeds causing memory/CPU pressure or UI jank without bounded buffers and efficient updates.
- Unbounded queues or per-event persistence causing storage/memory growth (must be prevented by design).
- Reconnect storms, subscription limit exhaustion, or partial provider outages affecting freshness/completeness.
- Large historical/snapshot datasets impacting DB size, query performance, and backup/restore time.
- Multi-client MCP/SSE load and isolation under sustained streaming.
- Chart rendering/workspace persistence performance at scale (pending Vela validation).

## 7. Security and operational risks

- LAN exposure without app-level login: acceptable by product decision, but LAN reachability and the single-owner model do not by themselves establish that every LAN client is trusted or authorized for every operation. Safe exposure boundaries for sensitive data and operations must be defined and reviewed (without introducing an application-level login system or changing confirmed product scope); sensitive operations/data require careful handling and clear documentation.
- Credential/key management errors leading to unrecoverable secrets or leakage.
- Backups containing sensitive material if not handled securely.
- Misconfiguration of streaming/sync/capture causing unexpected load or gaps (must be visible, not silent).

## 8. Decisions requiring future product-owner approval

- Any change to confirmed product scope/exclusions (e.g. adding trading, recommendations, chat, exports, cloud exposure, auth model).
- Dependency/framework replacements or major architectural deviations from established baseline.
- Inclusion/support changes for market universe beyond confirmed NSE/BSE scope.
- Final charting library choice if Vela proves unsuitable after verification.
- Credential storage/backup approach if it materially affects user workflow or security posture.
- Any action requiring commits/pushes, destructive operations, or production/user data changes (per protocol).

## 9. Contradictions / notes discovered

- **MCP transport evolution (resolved in planning):** the latest stable official protocol is now a mandatory product requirement (verified `2026-07-28` / SDK `2.4.0`). Streamable HTTP is primary with SSE-based event/subscription delivery **inside** it; deprecated legacy HTTP+SSE is **not implemented**, and Roots/Sampling/Logging are not used for new features. Mandatory requirements, extension decisions and compatibility policy are in [M6_PLAN.md](M6_PLAN.md) §3.1–§3.3; re-verify at implementation start. (Recorded here and in [REFERENCES.md](REFERENCES.md), [MCP_INTERFACE.md](MCP_INTERFACE.md).)
- **Scaffold vs target MCP:** current scaffold uses STDIO only; target includes network transports — treated as planned progression, not contradiction.
- No other product-scope contradictions identified; existing Phase 1 docs were aligned to confirmed requirements during this documentation update.
