# WP1 Implementation Report — Catalog Refresh Remediation

> **Post-publication reconciliation note (2026-11-25):** This report was authored against the **pre-publication** `develop` HEAD `4c018e0574b097f624ab8afecb2ecdb87e52b253` (`4c018e0`). WP1 was subsequently committed and pushed to `develop` at `50461888977d6b5dfc6ab866f5f7cf2ed7581419` (`5046188`) — 5 files, 584 insertions, 12 deletions — while `main` remained unchanged at `865d86f393a29bc1ec8d455a51d9efa82d722c48` (`865d86f`). The HEAD/status lines below are the original **pre-publication snapshot (2026-11-25)**, retained verbatim for provenance; they are not the current repository state.
>
> **Verification distinction (local agent-reported evidence, NOT CI):** the implementer's full-suite run recorded **1122 pass / 2 fail** — both environmental flakes: `tests/runtime.test.ts` (5 s listener-shutdown timeout, passed on rerun) and `tests/market/stage-f-timeout.test.ts` (Windows `EBUSY` in the untouched `tests/helpers/fs-cleanup.ts:27`). The independent auditor's clean run recorded **1124 pass / 0 fail** from the exact command `bun test` (full suite, exit 0, 9270 expect() calls, 97 files, 31.57 s). Both are local agent-reported results; GitHub reports **zero status checks / workflow runs**, so CI passing is **not** claimed.

**Repository:** `D:\Temp\MarketHubTS` · **Branch:** `develop` · **HEAD:** `4c018e0574b097f624ab8afecb2ecdb87e52b253` (pre-publication snapshot, 2026-11-25 — see reconciliation note above; WP1 subsequently published at `5046188`) · **Bun:** 1.4.5 (a7733435c) · **Date:** 2026-11-25
**Authorization (pre-publication snapshot, 2026-11-25):** WP1 ONLY (WP0/WP2/WP3/WP4 explicitly not implemented). No commit/push/stage/merge/rebase/amend performed (as of authoring; see reconciliation note above for subsequent publication).

---

## 1. Objective
Fix the dominant catalog-refresh performance defect: the identifier-supersession path issued broad-scope `findIdentifiers()` queries per instrument, and both importers used repeated `instruments.find()` linear scans. WP1 makes supersession canonical-ID-scoped via the existing indexed repository method and replaces linear scans with correctly keyed maps, preserving all semantics.

## 2. Verified current state (before coding)
- `packages/market-core/src/sync/apply.ts:415-433` called `tx.findIdentifiers({identifierType, identifierNamespace, exchangeScope, segmentScope, status:"CURRENT"})` with **no** `canonicalId` filter, then scanned rows for `cur.canonicalId === merged.canonicalId`.
- `CatalogRepositoryTx.listIdentifiersByCanonicalId(canonicalId)` **exists** at `packages/market-core/src/types.ts:124`; transaction implementation at `packages/database/src/repositories/catalog.ts:360`; index `instrument_identifier_history_canonical_idx` at `packages/database/drizzle/0001_lively_mauler.sql:134`.
- `merged.canonicalId` is **final** at the lookup point: the merge branch (`apply.ts:363-378`) pins it to `existing.canonicalId` (or the resolved incoming canonical ID) before the identifier loop.
- Linear scans: `upstox-master.ts:215` and `fyers-master.ts:229` (`instruments.find((i) => i.canonicalId === underlyingCanonicalId)`).
- `rowByFyToken` (`fyers-master.ts:118-122`) confirmed unused, but its removal is explicitly a **WP2** item (plan §3.3 / WP2-B item 6) — deliberately left untouched.
- Baseline reported by assignment: 1115 pass / 0 fail at `c26531a` (local, not CI).

**All STOP conditions checked and clear:** canonical ID final ✓; transaction interface exposes the method ✓; no query-plan measurement needed (existing index reused) ✓; no protected file required changes ✓.

## 3. Exact files changed
| File | Change |
|---|---|
| `packages/market-core/src/sync/apply.ts` | WP1-A: supersession now uses `tx.listIdentifiersByCanonicalId(merged.canonicalId)` once per instrument and filters in memory by exact type/namespace/exchange scope/segment scope/`CURRENT` status/different normalized value. |
| `packages/market-core/src/sync/upstox-master.ts` | WP1-B: added `underlyingByCanonicalId` map built once in pass 1 (first-write-wins); replaced `instruments.find(...)` with map lookup. |
| `packages/market-core/src/sync/fyers-master.ts` | WP1-B: same map/lookup change keyed by resolved canonical ID. |
| `tests/market/catalog-refresh-wp1.test.ts` | **New** focused regression file (9 tests). |

No changes to `packages/database/**`, migrations, manifests, lockfiles, docs, MCP/WebUI/REST code, or any protected area.

## 4. Architectural decisions
- Reused the existing canonical-ID-indexed method; **no** new repository method, query parameter, index, or migration.
- Supersession filter is an exact in-memory reproduction of the old query predicates plus the old `canonicalId` check — semantics unchanged, unrelated canonicals never materialized.
- Map duplicate-key behavior: **first-write-wins**, explicitly documented in code comments as mirroring the previous `Array.find` (which returned the first matching instrument). This is proven existing behavior, not a silent later-row overwrite.
- Missing underlyings still fail closed (`report.unresolvedUnderlyings`, no derivative emitted) — unchanged.
- All work stays inside the existing single provider-snapshot transaction; reconciliation/atomicity untouched.
- No new abstraction, framework, or dependency. `rowByFyToken` left for WP2.

## 5. WP1-A / WP1-B / WP1-C implementation detail
- **WP1-A:** `canonicalHistory` fetched once per instrument via `tx.listIdentifiersByCanonicalId(merged.canonicalId)`; each derived `CURRENT` identifier supersedes only matching rows from that canonical's own history. New identifier still upserted through the same transaction. Comment records why `merged.canonicalId` is final.
- **WP1-B:** `underlyingByCanonicalId: Map<string, CanonicalInstrument>` populated in pass 1 alongside the existing `underlyingIdByInstrumentKey` / `underlyingIdByFyToken` maps; pass 2 uses `underlyingByCanonicalId.get(underlyingCanonicalId)`. Both `canonicalSymbol` and (FYERS) `instrumentCategory` resolution preserved.
- **WP1-C:** 9 deterministic tests covering every §165-177 scenario plus §7.4.1-3 assertions.

## 6. Test results (all commands actually executed)

| Command | Result |
|---|---|
| `bun test tests/market/catalog-refresh-wp1.test.ts` | **9 pass / 0 fail**, 106 expect() calls, 233 ms |
| `bun test tests/market/catalog-refresh-wp1.test.ts tests/market/catalog-refresh.test.ts` | **25 pass / 0 fail**, 171 expect() calls, 528 ms |
| `bun test` (full suite) | **1122 pass / 2 fail**, 9265 expect() calls, 1124 tests / 97 files, 48.52 s |
| `bun test tests/runtime.test.ts tests/market/stage-f-timeout.test.ts` (retry) | **22 pass / 1 fail** — `runtime.test.ts` passed on retry; Stage F still EBUSY |
| `bun test tests/market/stage-f-timeout.test.ts` (retry alone) | **20 pass / 1 fail** — different test name, same EBUSY |
| `bun run typecheck` | **PASS** — all 13 workspace packages/apps exit 0 |
| `bun run build` | **PASS** — all packages/apps exit 0; Vite web build succeeded (290 modules; only a chunk-size advisory) |
| `git diff --check` | **PASS** — exit 0 (only LF→CRLF notices, no whitespace errors) |

**Baseline comparison:** 1115 pass / 0 fail (reported baseline at `c26531a`) → 1124 total tests now = 1115 + 9 new WP1 tests. The 2 full-suite failures are **not** WP1 regressions:
1. `tests/runtime.test.ts` — 5 s listener-shutdown timeout; **passed on retry**.
2. `tests/market/stage-f-timeout.test.ts` — Windows `EBUSY` in `removeTempDir` (`tests/helpers/fs-cleanup.ts:27`, an untouched file). A **different test failed on each of three runs**, confirming pre-existing flakiness. Neither file touches catalog sync; WP1's temp dirs use a distinct `wp1-catalog-` prefix and all handles are closed in `finally`/`afterEach`.

## 7. Deterministic assertion evidence (timing-independent)
- **Repository-boundary spy** (`spyOnTx`) wraps `transaction` and counts `findIdentifiers` / `listIdentifiersByCanonicalId` calls on the real tx object.
- **Fixed code:** `findIdentifiers = 0`, `findIdentifiersQueries = []`, `listIdentifiersByCanonicalId > 0`, and `listedCanonicalIds.every(id => id === target.canonicalId) === true` in all three supersession tests.
- **Negative control:** temporarily reverted only the supersession block to the old broad-query code (backup hash `534E9239…`); the same tests then reported `findIdentifiers = 2` and **3 tests failed** at the `expect(spy.findIdentifiers).toBe(0)` assertions. The fixed file was restored from backup and its hash re-verified identical (`534E9239…`). This proves the assertions detect the defect rather than passing because the fixture is small.
- **Importer equivalence:** a temporary fingerprint script captured full sorted instrument/mapping/report output before and after the refactor; output was **byte-for-byte identical**. The script was deleted. The compact relationship/spec fingerprint is now asserted in two permanent tests.
- **No new repository method/index/migration:** proven by `git status` — no `packages/database/**` or migration file changed.

## 8. Git status before / after
**Before:** `## develop...origin/develop`; 9 modified docs (plan + 8 others), 4 untracked user docs. HEAD `4c018e0`.
**After:** same branch/HEAD; the same 9 modified docs and 4 untracked docs **preserved exactly**; plus 3 modified WP1 source files and 1 new untracked WP1 test file. No staging, commit, or history change.

## 9. Complete / incomplete / unverified
- **Complete:** WP1-A, WP1-B, WP1-C; all targeted tests, typecheck, build, whitespace check.
- **Incomplete:** none within WP1 scope.
- **Unverified / noted:** (a) full suite has 2 flaky failures unrelated to WP1 (evidence above); (b) no live provider verification (out of scope, production drivers locked); (c) no `EXPLAIN` query-plan measurement — not required because the existing canonical-ID index was reused and no new query/index was introduced; (d) `rowByFyToken` removal deferred to WP2 by design.

## 10. Option and Metadata Impact Assessment (§4.1 — all 18 answered)
1. **New selectable options/capabilities/entities/config fields?** None — internal ingestion fix.
2. **Source of truth owner?** Existing market-core sync/import + catalog repository; no new owner.
3. **Classification?** Internal algorithm change — not an enum/capability/domain option/user setting.
4. **Consumer access?** No new consumer; existing catalog APIs unchanged.
5. **Existing API/schema/registry/repository provides it?** Yes — `listIdentifiersByCanonicalId` + existing index `instrument_identifier_history_canonical_idx`.
6. **New discovery/read API necessary?** No — direct existing repository method.
7. **UI update on new values?** N/A — no UI values introduced.
8. **Cache invalidation/refresh?** None — no caching in WP1.
9. **Sensitive metadata exposed?** No — no logs of raw payloads/tokens; spy counters record only method names and canonical IDs in tests.
10. **Tests proving frontend/backend consistency?** N/A — no frontend change; existing tests preserved and pass.
11. **Shared contract impact?** None.
12. **Provider/runtime registration impact?** None — fixed `UPSTOX`/`FYERS` identity preserved.
13. **MCP tool/resource/prompt impact?** None.
14. **REST/SSE/WebUI consumer impact?** None — behavior unchanged.
15. **Domain-data discovery impact?** None — bounded APIs unchanged.
16. **Configuration persistence impact?** None — no user settings touched.
17. **Forward compatibility?** Existing import path unchanged; new source rows still flow through.
18. **Dependency direction?** No new module; changes stay in market-core sync layer; acyclic.
