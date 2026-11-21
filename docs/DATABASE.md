# Database

> **Status:** Aligned summary. Authoritative details: [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md), [ARCHITECTURE.md](ARCHITECTURE.md).
> **Last updated:** 2026-11-15

## Stack (confirmed baseline)
- SQLite via Bun native `bun:sqlite`
- Drizzle ORM + Drizzle Kit
- Local single-user storage (no external DB services without demonstrated requirement)

## Current implementation (verified scaffold)
- `packages/database` `openDatabase()`:
  - creates parent directory if needed,
  - opens/creates SQLite file (`MARKETHUB_DB_PATH` or `./data/markethub.sqlite`),
  - enables `WAL`, `foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`,
  - returns Drizzle instance + raw sqlite handle + safe close (best-effort `wal_checkpoint(TRUNCATE)`).
- `checkDatabase()` performs `SELECT 1` for health reporting.
- Schema scaffold: `app_meta` table (`src/schema.ts`).
- Drizzle config: `drizzle.config.ts` (sqlite dialect, `./drizzle` migrations output).
- Migration runner: `src/migrate.ts` (applies migrations from `./drizzle`).
- **Versioned migrations `0000`–`0006`** exist in `packages/database/drizzle/` (foundation, catalog, provider settings, streaming subscriptions, M5 historical/snapshot tables, M6-C `mcp_activity`).

## Target responsibilities (planned)
- Versioned migrations; domain schemas for catalog/mappings, historical candles, option-chain snapshots, watchlists, alerts/scanners/history, configuration/state.
- Controlled writes/transaction ownership, batched persistence, prepared statements.
- Safe shutdown/recovery and integrity verification (`PRAGMA integrity_check`).
- Backup/restore including any key material/state required to recover encrypted broker credentials (DB-only copy is not full recovery if keys/state missing).
- **Do not persist** every raw tick or every market-depth change.
- **Never store** broker credentials/access tokens in plaintext.

See [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md) for lifecycle rules and [OPERATIONS_BACKUP_AND_RECOVERY.md](OPERATIONS_BACKUP_AND_RECOVERY.md) for recovery requirements.
