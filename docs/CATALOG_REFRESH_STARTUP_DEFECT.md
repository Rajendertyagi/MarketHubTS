# Catalog Refresh Startup Defect (OPEN)

> **Status:** **OPEN — needs fix.** Newly discovered runtime defect recorded 2026-11-25. This is a **separate, post-closeout defect** and does **not** change any M6 acceptance status: **M6 remains accepted and closed.** No fix has been applied.
> **Last updated:** 2026-11-25
> **Related:** [PROJECT_STATUS.md](PROJECT_STATUS.md) (§9 note), [OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md](OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md) (§10 entry), [METADATA_DISCOVERY_PHASE_4_PLAN.md](METADATA_DISCOVERY_PHASE_4_PLAN.md) (WP4A local master import), [M6_D_E_PLAN.md](M6_D_E_PLAN.md) (M6 acceptance records)

## Reconciliation note (2026-11-27) — defect RESOLVED by the G0 child-process architecture

> **Scope:** documentation-only reconciliation. The historical defect record below (title, OPEN status, symptom, evidence, proven/not-proven, impact, constraints and proposals) is **preserved unchanged** as evidence of the 2026-11-25 investigation. This note records the later resolution without rewriting that record. All verification figures below are **local, agent-reported — NOT CI** (GitHub reported zero status checks).

- **Status: RESOLVED — G0 ACCEPTED (2026-11-27).** The startup busy-loop / unbounded-memory defect recorded below is resolved by the completed G0 child-process architecture (packages **G0-A through G0-E**, each independently audited **KEEP**). The technical lead gave the final **KEEP** on the complete G0 implementation after independent review of all published commits (range **`2c22402..08cf605`** on `develop`). The canonical design and implementation record is [`G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md`](G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md).
- **Resolution mechanism:** each provider refresh run now executes in its own `Bun.spawn` child process with its own SQLite connection to the **same** WAL database file. The API process keeps serving reads from its own WAL connection and never runs the long synchronous apply, so `/health`, `/ready` and `/api/status` remain responsive during download, parse and apply. A two-phase write permit grants `OWNED` only across the child's atomic transaction; interactive writes during that window fail fast with HTTP 503 `CATALOG_WRITE_BUSY` instead of sleeping inside SQLite's `busy_timeout`. A monotonic parent-controlled ownership generation is checked by the child **inside** its `BEGIN IMMEDIATE` before any catalog write (generation fencing), and fail-closed recovery verifies persisted run state before any retry. The single atomic provider snapshot transaction and fail-closed reconciliation are preserved unchanged.
- **Verification (local, not CI):** full suite **1253 pass / 0 fail**; `bun run typecheck`, `bun run build` and `git diff --check` clean. GitHub reported zero status checks / workflow runs; these are **local agent-reported evidence — NOT CI**, and no CI pass is claimed. The previously accepted **G0 STOP finding** (a real SQLite apply blocked the API event loop; the earlier G0 test used a stubbed apply gate) is resolved by real-listener / real-child / real-transaction evidence. No live provider connection or live REST verification was performed.
- **Git state:** the G0 implementation is **published on `develop`** across commits `2c22402` (implementation), `539c4a7` (six integration fixes), `a6264b1` (unobserved-exit fix) and `08cf605` (shutdown-token fix) — commit range **`2c22402..08cf605`**; `develop` HEAD is `08cf60567b8d19e8932bc784d1dd38a3b917bedf`. This documentation update performed no commit, push, merge, rebase, amend or stage.
- **Gates unchanged:** Stage G, M5 Phase 4B, M7, Phase 3 and production provider activation remain locked; no live provider data was retrieved.

## 1. Symptom

The WebUI fails to load properly. The Vite dev server on port 5173 serves the HTML fine (HTTP 200), but the API on port 3001 accepts TCP connections and **never responds** to `/health`, `/ready`, or `/api/status`. The API process enters a **busy loop**: approximately one full CPU core continuously, with memory growing to **3.7 GB in about 4 minutes**. It never recovers — in a 60-second observation the process consumed 69 s of CPU, reached 2.3 GB, and still returned no response.

The original dev servers exited during the memory pressure. Restarting `bun run dev` restores the WebUI briefly, but the API hangs again on every start.

## 2. Evidence (all local, 2026-11-25, Bun 1.4.5, Windows)

| # | Observation | Result |
|---|---|---|
| 1 | Fresh API process on port 3101 | Logged `starting`, `database_ready`, `listening`, then spun (1.6 GB in 8 s); `/health` timed out; raw TCP accepted the connection but returned no data. |
| 2 | Minimal `Bun.serve` with a trivial fetch handler | Clean — 0.046 s CPU, 56 MB. Rules out the Bun HTTP server itself as the cause. |
| 3 | Step-by-step startup diagnostic | All composition steps completed cleanly (0.42 s CPU, 103 MB) through `Bun.serve`; the spin began only afterward. |
| 4 | Instrumented fetch handler | **Zero** `app.fetch` calls — the spin is not request-driven. |
| 5 | Bisection: config + DB + serve | Clean. |
| 6 | Bisection: adding providers / service / hub / MCP handler / app individually | Each clean. |
| 7 | Full composition with `catalogRefresh` | Spins. |
| 8 | Passing `catalogRefresh: undefined` to `createApp` | API healthy — `/health` 200, 0.42 s CPU, ~99 MB. |
| 9 | Isolated Upstox fetch + gzip decompress + `JSON.parse` | Completed fine — 0.25 s CPU, 276 MB. The single download is not the defect. |
| 10 | Disabling `catalogRefresh` in `createApp` | API healthy — `/health` 200, 0.42 s CPU, ~99 MB. |

All figures above are **local, agent-reported observations**, not CI evidence. No production code was changed during diagnosis; all temporary scripts and databases were created outside the repo or removed.

## 3. Trigger and code locations (confirmed)

- `createApp()` calls `deps.catalogRefresh?.startIfNeeded()` at **`apps/api/src/app.ts:191`**.
- `CatalogMasterRefresh.startIfNeeded()` at **`packages/market-core/src/sync/refresh.ts:62-66`** fires an immediate `refreshProvider()` for each provider in `PROVIDERS = ["UPSTOX", "FYERS"]` (`refresh.ts:9,65`).
- `refreshProvider()` → `doRefresh()` → `download()` fetches live public master files:
  - Upstox `complete.json.gz` — `UPSTOX_MASTER_URL` in `packages/market-core/src/sync/upstox-master.ts:14` (`https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz`), reported ~3.8 MB gzipped / ~64 MB decompressed / 136,571 rows.
  - Four FYERS symbol-master files — `FYERS_MASTER_URLS` in `packages/market-core/src/sync/fyers-master.ts:15-20` (`NSE_FO`, `BSE_FO`, `NSE_CM`, `BSE_CM`), reported ~90 MB each.
- Constants: `FETCH_TIMEOUT_MS = 20_000` (`refresh.ts:8`), `DEFAULT_REFRESH_INTERVAL_MS = 30 min` (`refresh.ts:11`).
- Evidence items 8 and 10 (healthy API when `catalogRefresh` is disabled/undefined) identify the startup refresh as the **trigger**.

## 4. What is proven vs. not proven

**Proven (local evidence):**
- The hang is reproducible on a fresh API process and is not request-driven (zero `app.fetch` calls).
- The Bun HTTP server, config, DB, and each composition step added individually are clean.
- The spin appears only with the full composition including `catalogRefresh`, and disappears when `catalogRefresh` is disabled or passed as `undefined`.
- A single Upstox fetch + decompress + parse completes fine in isolation.

**Not proven — do not claim otherwise:**
- The **precise internal mechanism** of the spin is **not isolated**. It is not established whether the cause is concurrent multi-provider downloads, the FYERS files specifically, an interaction with the running server, or something else.
- The defect is attributed to the **combination** of the startup refresh with the running application, not to any single download step.
- No root-cause fix has been identified or validated; the items in §7 are untested proposals only.

## 5. Impact

- **WebUI unusable** — the API never serves `/health`, `/ready`, or `/api/status`, so the WebUI cannot load its data.
- **API unresponsive** — TCP connections are accepted but no HTTP response is ever returned.
- **Unbounded memory growth** — up to 3.7 GB in ~4 minutes with no recovery, risking process termination and host memory pressure.
- **Every start affected** — restarting `bun run dev` restores the WebUI only briefly before the API hangs again.

## 6. Constraints (must be respected when this is eventually fixed)

- **Do not change M6 acceptance status** — M6 remains accepted and closed; this is a separate post-closeout defect.
- **Do not unlock Stage G, M5 Phase 4B, or M7** — all remain locked; this defect does not authorize any live provider connection or activation.
- **No live provider activation** — any fix must not introduce live provider calls, credentials, sockets, or production driver activation.
- Preserve the locked production boundary, the local-catalogue/no-full-exchange-claim scope, and all existing acceptance records.
- This document is **documentation only**; it does not authorize any source, test, manifest, lockfile, DB, dependency, or config change.

## 7. Candidate fix directions to investigate (PROPOSALS — NOT AUTHORIZED CHANGES)

The following are **ideas for future investigation only**. None has been implemented, tested, or approved; do not treat any as an authorized fix.

1. **Make the startup refresh opt-in or delayed** — avoid firing immediate multi-provider downloads during `createApp()`; defer to an explicit trigger or a delayed timer so startup is not blocked.
2. **Use local cached master files** — rely on the already-imported local catalogue / cached master data instead of live downloads at startup, preserving the no-credentials/no-live-calls boundary.
3. **Isolate the Bun 1.4.5 interaction** — reproduce the spin in a minimal harness to determine whether it is a Bun-specific concurrency/gzip/fetch interaction, then bound or serialize the work accordingly.

Any actual fix requires its own authorization, implementation, deterministic tests, and independent review before it can be applied.

## 8. Explicit statement

**No production code was changed and no fix has been applied.** This record was produced by documentation-only work in the working tree. All diagnosis was performed with temporary scripts/databases outside the repo or removed afterward. No commit, push, merge, or history rewrite was performed, and no M6 acceptance status was changed.
