# Data Lifecycle and Storage

> **Status:** Confirmed lifecycle requirements and storage design; M1/M2 persistence foundations and M4 Stage D live subscription persistence implemented. Live ticks remain in memory only; historical/option-chain data lifecycles remain pending.
> **Last updated:** 2026-11-17
> **Related:** [ARCHITECTURE.md](ARCHITECTURE.md), [MARKET_DATA_AND_CATALOG.md](MARKET_DATA_AND_CATALOG.md), [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md), [WEBUI_AND_CONFIGURATION.md](WEBUI_AND_CONFIGURATION.md), [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md)

## 1. Storage principles (confirmed)

- **Local-first, single-user:** SQLite via `bun:sqlite` + Drizzle (no external DB services without demonstrated requirement).
- **Appropriate persistence by data type:** live streaming state is not the same as historical cache or snapshot archive.
- **User-controlled retention:** configured through WebUI; no invented permanently fixed retention policy.
- **Integrity and safety:** versioned migrations, WAL, controlled writes/transactions, prepared statements (planned), batched persistence, safe shutdown/recovery, backup/restore, integrity verification.
- **No secrets in plaintext:** broker credentials/sensitive tokens never stored in plaintext; full recovery must include required key material/state.

## 2. Live data lifecycle

| Aspect | Requirement |
|---|---|
| Scope | Live ticks, quotes, and market-depth updates |
| Storage | **In memory** for display and consumption |
| Persistence | **Do not permanently store every incoming tick or every market-depth change** |
| Restart behavior | Live state repopulated from connected provider streams after restart |
| Metadata | Must carry source/provider, timestamp (original observation where available), and freshness/availability state |
| Resource control | Bounded structures/queues; prevent unbounded memory growth. **Implemented (M4-D):** `LiveEventHub` bounds replay history and per-client queues by event count and approximate bytes; overflow drops data events (with counters and one coalesced `snapshot-required`) rather than subscribers. |
| Desired subscriptions | **Implemented (M4-D):** `streaming_subscriptions` persists canonical instrument selections with enabled/disabled state; a durable generation in `app_meta` (`streaming_subscriptions_generation`) advances transactionally with each full replacement, including empty replacements. |

## 3. Historical data lifecycle

| Aspect | Requirement |
|---|---|
| Sources | Historical APIs offered by connected brokers |
| Retrieval | On demand when requested; support user-configured historical synchronization |
| Local cache | Cache successfully retrieved historical candles locally |
| Durability | Preserve historical data when brokers disconnect or are removed |
| Gap handling | Retrieve missing historical periods from another suitable provider when available |
| Unavailability | Clearly report unavailable periods and provider restrictions |
| Scope control | Do not duplicate entire broker historical databases without a demonstrated requirement |
| Retention | User-controlled via WebUI |

## 4. Option-chain snapshot lifecycle

| Aspect | Requirement |
|---|---|
| Storage strategy | **Separate persistent storage** (distinct from live in-memory state and generic candle cache) |
| Capture trigger/config | Captured locally according to **WebUI configuration** |
| Configuration dimensions | Underlying, expiry, all available strikes or selected strike ranges, capture/snapshot selection |
| Streaming independence | Streaming selection independent of snapshot capture |
| Historical availability | Do not claim access to snapshots from before local collection began unless a provider actually supplies that historical information **(verify)** |
| MCP on-demand behavior | MCP one-time option-chain requests **must not change** saved snapshot-capture configuration |

## 5. Catalog and configuration persistence (target)

| Data | Persistence intent |
|---|---|
| Common instrument catalog & mappings | Persisted with sync metadata/versioning; transactional safe updates (never destroy previous valid catalog on failed/incomplete sync) |
| Watchlists | Persisted; shared across WebUI/MCP |
| Alert definitions & trigger history | Persisted; shared across WebUI/MCP; states/history retained per design |
| Scanner definitions & results/history | Persisted; shared across WebUI/MCP |
| Operational configuration | Persisted (WebUI-owned): providers/connections, streaming, historical sync, snapshot capture, retention, preferences, startup/LAN/network, delivery, UI layouts/preferences as applicable |
| Diagnostics/log metadata | As needed for troubleshooting; avoid sensitive data/credentials in logs |

## 6. Database design and operations (target)

### 6.1 Current implementation (verified)
- `packages/database`: `openDatabase()` creates dirs, opens `bun:sqlite` DB (`MARKETHUB_DB_PATH` or `./data/markethub.sqlite`), sets `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`, returns Drizzle handle + sqlite handle + safe close (best-effort WAL checkpoint). `checkDatabase()` runs `SELECT 1`.
- **Migrations (versioned, additive):** `0000_tan_la_nuit.sql` (`app_meta`), `0001_lively_mauler.sql` (catalog foundation), `0002_round_baron_strucker.sql`, `0003_sad_edwin_jarvis.sql` (provider settings), and `0004_flat_spitfire.sql` (`streaming_subscriptions`). Drizzle config (`drizzle.config.ts`, sqlite, `./drizzle` out) and migration runner (`src/migrate.ts`) implemented. Each migration has its SQL file, journal entry and generated snapshot.
- **Catalog schema (M2):** `canonical_instruments`, `derivative_contracts`, `provider_instrument_mappings`, `instrument_aliases`, `instrument_identifier_history`, `catalog_sync_runs` with PK/FK/unique/index constraints and JSON fields for extensible/provider-specific metadata/provenance.
- **Live subscription schema (M4-D):** `streaming_subscriptions` (canonical ID PK, enabled flag, timestamps) plus the durable generation key in `app_meta`. `SqliteSubscriptionRepository.replace()` deletes and reinserts rows and increments the generation in one serialized `BEGIN IMMEDIATE` transaction; no provider SDK/network work occurs inside it.
- **Repository/transactions (M2):** `SqliteCatalogRepository` provides lookups and transactional catalog writes used by `CatalogSyncService`; failed/conflicting syncs roll back catalog changes (no partial catalog writes). Failed-run audit persistence is best-effort outside rolled-back catalog transactions when supported.
- **Not yet implemented:** domain schemas/storage for candles, option-chain snapshots, watchlists, alerts/scanners/history, operational config persistence beyond foundation, backup/restore, integrity maintenance workflows.

### 6.2 Planned capabilities
- Versioned migrations committed and applied appropriately.
- Domain schemas for catalog, mappings, candles, snapshots, watchlists, alerts/scanners/history, config, etc.
- Controlled write paths and transaction ownership; batched market-data persistence where appropriate.
- Prepared statements and query/index tuning based on measured needs.
- Safe shutdown (flush/checkpoint/close) and crash recovery behavior.
- Integrity verification (e.g. `PRAGMA integrity_check`) and maintenance procedures.
- Backup and restore workflows (see [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md)).

## 7. Retention and cleanup

- Retention settings are **user-configurable in WebUI** for applicable persisted data (historical cache, snapshots, histories/results/logs as designed).
- Cleanup must be safe, transparent, and respect dependencies (e.g. do not break references/history unintentionally).
- No hidden fixed retention policy.

## 8. Data not to persist

- Every incoming live tick.
- Every market-depth change event.
- Broker credentials/sensitive tokens in plaintext.
- Fabricated/raw-unavailable market fields represented as real values.

## 9. Backup/restore considerations (summary)

- Full backup must cover the complete database and any associated key material/state required to recover encrypted broker credentials.
- Database-only copy is **not** full recovery if required keys/state are missing.
- Restore must be tested on a clean installation. Details: [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md).
