# Open Questions and Technical Risks

> **Status:** Tracked confirmations, established decisions, pending verifications, and risks. Do not reopen confirmed product decisions.
> **Last updated:** 2026-11-16
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
- MCP TypeScript SDK (v2 packages in scaffold) with STDIO now; Streamable HTTP primary network transport planned (verify semantics).
- SSE primary for frontend realtime delivery; drop overflowing events, not subscribers; WebSocket only if justified.
- Vela as charting candidate (compatibility pending).
- Provider-specific logic in adapters; canonical catalog/identity shared and transactionally synced.

## 3. Technical details awaiting official verification

| Area | Pending verification | Why it matters |
|---|---|---|
| NSE universe/eligibility | Current official eligibility/specs and actual available contracts for NIFTY 50, BANK NIFTY, FINNIFTY, MIDCPNIFTY, NIFTY NEXT 50, NIFTY India FPI 150 (NIFTY India FPI 150 introduction date 08 December 2025 per official NSE press release is distinct from current eligibility/contracts); contract details/changes | Correct supported universe and catalog rules |
| BSE scope | Official SENSEX derivatives scope/specs; confirmation of excluded instruments | Prevent scope creep/errors |
| Upstox APIs | Current V3 feed/historical/expired-instruments/option-chain/quotes/instruments endpoints, fields, auth/session, protobuf schemas, rate/subscription limits, plan entitlements | Adapter design, normalization, limits handling |
| FYERS APIs | Current v3 data socket/REST capabilities, symbol/connection limits, historical/option-chain/quotes fields, auth, entitlements | Adapter design, normalization, limits handling |
| Upstox/FYERS SDKs on Bun | Official SDK package names, APIs, Node dependencies, Bun compatibility | Implementation choice and reliability |
| Market-wide sources | Official/usable sources and terms for India VIX, breadth, sectors, FII/DII, participant-wise derivatives OI, reports/bhavcopies, calendars/status | Data availability and compliance |
| MCP spec/SDK (2026-07-28) | Exact Streamable HTTP behavior, SSE-based event/subscription delivery semantics, multi-client/session/stateless details, legacy HTTP+SSE compatibility needs, SDK APIs | Correct MCP transport and interoperability |
| Vela charting | React/provider integration, required features (candles/indicators/drawings/multi-chart/workspace persistence), performance/memory, licensing/attribution, Bun/Vite fit | Chart milestone feasibility |
| Secure Windows credential storage | Appropriate mechanism (e.g. OS-backed), encryption/key management, portability with backup/restore | Security and full recoverability |
| Backup key material | What key/state must accompany DB for encrypted credential recovery; safe backup format/process | True full restore |

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

- LAN exposure without app-level login: acceptable by product decision but requires clear boundaries and safe handling of sensitive operations/data.
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

- **MCP transport evolution:** product text requires Streamable HTTP primary with SSE-based event/subscription delivery and to avoid confusing with deprecated legacy HTTP+SSE; MCP spec revisions (including 2026-07-28 direction) have evolved significantly. Implementation must follow verified current official spec/SDK semantics and document any compatibility choices. (Recorded here and in [REFERENCES.md](REFERENCES.md), [MCP_INTERFACE.md](MCP_INTERFACE.md).)
- **Scaffold vs target MCP:** current scaffold uses STDIO only; target includes network transports — treated as planned progression, not contradiction.
- No other product-scope contradictions identified; existing Phase 1 docs were aligned to confirmed requirements during this documentation update.
