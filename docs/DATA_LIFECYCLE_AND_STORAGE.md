# Data Lifecycle and Storage

> **Status:** Confirmed lifecycle requirements and target storage design; implementation largely pending.
> **Last updated:** 2026-11-15
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
| Resource control | Bounded structures/queues; prevent unbounded memory growth (planned) |

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

### 6.1 Current scaffold (verified)
- `packages/database`: `openDatabase()` creates dirs, opens `bun:sqlite` DB (`MARKETHUB_DB_PATH` or `./data/markethub.sqlite`), sets `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`, returns Drizzle handle + sqlite handle + safe close (best-effort WAL checkpoint).
- `checkDatabase()` runs `SELECT 1`.
- Schema: `app_meta(key, value, updated_at)` only.
- Drizzle config (`drizzle.config.ts`, sqlite, `./drizzle` out) and migration runner (`src/migrate.ts`) scaffolded; **no generated migration files yet**.

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
