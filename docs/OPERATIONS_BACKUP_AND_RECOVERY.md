# Operations, Backup and Recovery

> **Status:** Confirmed operational requirements and target design; most capabilities not yet implemented.
> **Last updated:** 2026-11-16
> **Related:** [ARCHITECTURE.md](ARCHITECTURE.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [DATA_LIFECYCLE_AND_STORAGE.md](DATA_LIFECYCLE_AND_STORAGE.md), [WEBUI_AND_CONFIGURATION.md](WEBUI_AND_CONFIGURATION.md), [PROJECT_STATUS.md](PROJECT_STATUS.md)

## 1. Deployment model (confirmed)

- **Single local owner/application instance:** Windows-first, local-first, runs on the user’s PC. **Single-user means one local application owner, not one connected client.**
- **LAN access is required:** WebUI must be accessible to other devices on the user’s local network, and MCP must be accessible over LAN using HTTP (planned), so other applications, devices, and multiple MCP clients can connect to the same running application.
- **Client/UI form:** local browser-based WebUI is acceptable; a native desktop wrapper is optional (do not prematurely force either).
- **No cloud hosting. No public internet exposure. No application-level user login/authentication requirement.**
- Multiple MCP clients must work normally, sharing the same canonical data/services with client isolation.

## 2. Runtime operations

### 2.1 Startup and background behavior
- Configurable startup/background behavior via WebUI (planned).
- Application must start and operate using locally available data and non-broker sources even when no providers are connected.
- Provider connections established independently based on configuration and availability.

### 2.2 Shutdown and recovery
- **Graceful shutdown:** stop new work, complete/flush critical writes, close streams/clients, checkpoint/close DB safely, release resources.
- **Recovery:** tolerate restarts/crashes; preserve persisted catalog/data integrity; repopulate live in-memory state from provider streams after restart.
- Failed/incomplete catalog sync must never destroy previous valid catalog.

### 2.3 Diagnostics and observability
- Clear provider and system diagnostics (connection/auth/stream health, errors, limits, degradation, staleness, data availability).
- Logging and diagnostics configurable via WebUI (planned); logs must not contain credentials or sensitive tokens.
- Expose provider restrictions/limits clearly; never silently change user selections due to limits.

## 3. Security and sensitive data handling

- Broker API credentials and sensitive tokens must be handled responsibly: **never logged, never exposed through ordinary data APIs**.
- Credentials/tokens must **never be stored in plaintext**. M3 implements a portable encrypted store (AD-021): AES-256-GCM ciphertext in SQLite plus a 32-byte key file (`data/markethub.key`) beside the database. No OS credential store or native module is used. Non-secret provider settings (App ID, redirect URI, expiry metadata) are stored in the `provider_settings` SQLite table and are loaded on startup.
- LAN access is required and there is no application-level login/authentication system, but LAN reachability and the single-owner model do not by themselves establish that every LAN client is trusted or authorized for every operation. Safe exposure boundaries for sensitive data and operations must be defined and reviewed (without introducing an application-level login system or changing confirmed product scope); deployment/usage implications should be documented clearly in UI/docs (planned).
- MCP/REST interfaces must enforce input validation and avoid leaking secrets.

## 4. Backup and restore (confirmed requirements)

### 4.1 Scope
- Provide **full database backup and restore**.
- Design must account for the **complete database and any associated key material required to recover encrypted broker credentials** (and any other state required for full recovery).

### 4.2 Critical rule
- **A database-only copy must not be described as a successful full recovery** if required encryption keys or application state are missing. With M3's portable store, the backup unit is the closed data folder (database + key file). Copying both to another installation/OS preserves credentials; copying only the database does not. The accepted tradeoff is that anyone copying the whole folder can decrypt the credentials.

### 4.3 Restore validation
- Restore must be **tested on a clean installation**, not merely asserted from source code.
- Verification should confirm: application starts, configuration/state restored as designed, persisted data accessible, and encrypted broker credentials recoverable (when applicable).

### 4.4 Operational considerations (planned)
- User-initiated backup/restore from WebUI.
- Clear guidance on backup contents, storage location, and security of backup artifacts (may contain sensitive material depending on design).
- Integrity checks (e.g. SQLite integrity verification) as part of maintenance/recovery workflows.

## 5. Data integrity and maintenance

- SQLite WAL mode, foreign keys, controlled writes/transactions, prepared statements (planned), batched persistence where appropriate.
- Versioned migrations; safe application of schema changes.
- Periodic/on-demand integrity verification (planned).
- Retention/cleanup user-controlled and safely executed.

## 6. Network and access configuration

- Configurable LAN access and application address/bind settings via WebUI (planned).
- WebUI and MCP HTTP endpoints intended for local/LAN use only (no public internet exposure).
- Multi-client access supported; client isolation required.

## 7. Current implementation status

- **Implemented:** API graceful shutdown handlers (SIGINT/SIGTERM) closing DB/server; DB open with WAL/foreign_keys/NORMAL/busy_timeout and best-effort checkpoint on close; basic health diagnostics endpoint.
- **Not implemented:** configurable startup/background service behavior, LAN configuration UI, comprehensive diagnostics/logging UI, backup/restore, integrity maintenance workflows, MCP HTTP/LAN serving. **Implemented (M3, uncommitted):** portable encrypted credential storage with key file and explicit reset path.

## 8. Risks and open items

- Credential storage is implemented (portable encrypted SQLite + key file). Backup/restore implementation and clean-install restore drills remain M9; a database-only backup is explicitly insufficient.
- LAN exposure without app-level auth requires careful documentation and safe defaults.
- Restore procedures must be proven on clean installs once implemented. See [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md).
