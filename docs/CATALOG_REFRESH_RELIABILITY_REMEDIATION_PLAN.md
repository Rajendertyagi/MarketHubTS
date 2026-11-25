# Catalog Refresh Reliability and Performance Remediation Plan

> **Status:** Proposed — **PLAN AUDIT ONLY**. No implementation is authorized by this document.
>
> **Product:** MarketHubTS  
> **Reference repository:** `Rajendertyagi/MarketHubTS`  
> **Reference branch/snapshot:** `develop` at `c26531afe7213e2c9326cfcbf21a6bcbd6bbd630` (the last snapshot independently inspected while preparing this plan; the auditor must verify the current branch head before accepting it).  
> **Prepared:** 2026-11-25  
> **Revised in place:** 2026-11-25 (audit corrections A–G; see §16). Official Upstox and FYERS documentation re-fetched 2026-11-25 (§6.4, §9). This remains a plan-audit artifact only — no implementation is authorized.  
> **Repository location:** now published at `docs/CATALOG_REFRESH_RELIABILITY_REMEDIATION_PLAN.md` on `develop`.

---

## 1. Purpose and decision requested

The catalog master refresh currently has a serious reliability/performance defect: the refresh path can consume excessive CPU and memory and has lifecycle gaps around startup and shutdown. The API must remain available while public provider masters are downloaded, parsed, normalized and applied.

This plan consolidates the reported investigation and the subsequent source-level review into one controlled remediation programme. It deliberately separates:

1. A confirmed database-query scope defect in identifier supersession.
2. Repeated linear searches in provider import builders.
3. Excessive full-file buffering and duplicated representations of provider masters.
4. Refresh cancellation, startup ordering and shutdown coordination.
5. Regression tests, realistic benchmarks and operational evidence.

**Decision requested from the plan auditor:** determine whether this plan is technically correct, complete, compatible with the current repository and official provider/runtime documentation, and sufficiently bounded to become the basis for later implementation assignments.

**No code is to be written during this audit.** A KEEP result means the plan is suitable for separate owner approval; it does not authorize implementation. After the audit, the plan must be reviewed and explicitly accepted before any implementation assignment is issued.

## 2. Executive recommendation

Proceed in controlled work packages, in this order:

- **WP0 — Reconfirm the baseline and establish reproducible measurements.** Verify current code, runtime versions, provider payloads, existing tests and the actual performance symptoms.
- **WP1 — Fix identifier supersession lookup and importer lookup complexity.** This is the highest-priority correctness/performance fix. Reuse the existing canonical-ID repository query instead of adding another generic query or database index without evidence.
- **WP2 — Redesign provider-master ingestion to bound memory.** Remove unnecessary full-file copies and process provider files with bounded memory/backpressure. Preserve source completeness and the atomic snapshot boundary.
- **WP3 — Make refresh lifecycle explicit and cancellable.** Start refresh only after the API listener is available; cancel and await active work before closing the database.
- **WP4 — Validate end-to-end behavior and publish evidence.** Run realistic full-refresh tests, failure-matrix tests, performance measurements and an independent diff review.

WP1 should be delivered and measured before WP2 is broadened. WP2 and WP3 can be developed after WP1, but must be independently testable. Do not introduce worker-thread/process isolation merely as a first response; consider it only if measurements show that bounded streaming and efficient indexing still leave unacceptable event-loop delay.

## 3. Verified repository findings and evidence boundaries

The following findings were confirmed by source-level review of the `develop` snapshot identified above. The plan auditor must re-check them against the actual checkout before accepting this document.

### 3.1 Identifier supersession query is broader than the required canonical instrument

In `packages/market-core/src/sync/apply.ts`, the identifier-application path derives identifiers for a merged canonical instrument. For a `CURRENT` identifier, it calls `tx.findIdentifiers()` using identifier type, namespace, exchange scope, segment scope and status, but does not pass either:

- `canonicalId`, or
- `identifierNormalized`.

It then iterates the returned rows and only acts on rows whose `canonicalId` equals the canonical instrument currently being applied and whose normalized identifier differs from the incoming identifier.

The query therefore retrieves current identifiers for the whole matching type/namespace/exchange/segment scope, even though the caller only needs history belonging to one canonical instrument. The repository row mapper also parses provenance JSON while materializing returned rows. With a large F&O symbol population, this can turn an otherwise small per-instrument operation into repeated broad reads and JSON parsing.

**Important existing capability:** `CatalogRepositoryTx.listIdentifiersByCanonicalId(canonicalId)` already exists, is implemented in the transaction repository and has a canonical-ID index (`instrument_identifier_history_canonical_idx`). The likely simplest correction is to use this existing method and filter its returned history to the same identifier type, namespace, exchange scope, segment scope and `CURRENT` status required by the current supersession behavior.

Do not add a new repository method, query parameter, schema index or migration unless the audit proves the existing method cannot preserve the required behavior or has unacceptable query plans. Verify the exact current method signature, index, transaction implementation and canonical-ID resolution timing before finalizing the implementation design.

### 3.2 Provider import builders repeat linear searches

The Upstox and FYERS importer paths contain derivative-to-underlying lookups using `instruments.find(...)` from within loops. This can produce repeated linear scans as derivative and underlying counts grow. The intended design should build the required keyed lookup maps once, using the correct stable key and duplicate-handling semantics, then perform constant-time lookups during derivative construction.

Do not assume a key is unique without checking the actual provider schema and current importer behavior. The auditor must identify the correct key for each provider and explain how missing, duplicate or conflicting rows are handled.

### 3.3 Provider file handling creates avoidable full-size representations

The current Upstox path reads a full response into an `ArrayBuffer`, decompresses it into a complete text representation, parses the complete JSON array, and computes a hash by re-encoding the text. Several large representations can therefore coexist during refresh.

The current FYERS path fetches multiple segment files together, parses them into full object graphs, creates additional tagged/wrapper collections, and computes a hash from `JSON.stringify(files)`, creating another large serialized representation. A `rowByFyToken` map was also reported as unused and should be re-verified before any removal.

A memory-safe design must avoid holding multiple full representations of the same source data at once. It must also preserve the ability to resolve derivative underlyings, validate completeness, and apply a provider snapshot atomically.

### 3.4 Refresh lifecycle gaps

The refresh service exposes a stop path that clears scheduling state but does not currently provide a complete guarantee that in-flight fetch, parsing, import and database work has been cancelled or awaited. Startup-failure cleanup and graceful shutdown must be checked to ensure the refresher is stopped and drained before database resources are closed.

The existing `startIfNeeded()` call occurs during app creation before the `Bun.serve()` call. Because the refresh work is asynchronous/fire-and-forget, this ordering alone does **not** prove that the HTTP listener is blocked while a download is running. The confirmed design requirement is stronger and simpler: the listener must be created successfully first, then refresh may be scheduled without blocking server readiness. Separately, parsing/import/database work must be measured for event-loop impact.

### 3.5 Important claims that are not yet independently established

A prior OpenCode investigation report stated that:

- a full refresh could take more than 15 minutes in a problematic Upstox apply path;
- FYERS processing peaked around 979.5 MB RSS in one run;
- the source download/parse portion took approximately five seconds;
- the local Bun version was 1.4.5 while the project target was reported as 1.4.4.

These are **reported measurements, not independently reproduced facts**. They must not be repeated as proven baselines until WP0 captures exact commands, runtime version, machine, source-file sizes, row counts, timings and RSS. A benchmark must distinguish download, decompression, parsing, normalization/import construction, database apply, reconciliation and total wall-clock time.

## 4. Goals

1. A refresh must not prevent the API from becoming available or serving normal requests.
2. Identifier supersession must inspect only identifiers belonging to the canonical instrument being updated, while preserving current supersession semantics.
3. Importer lookup complexity must not grow quadratically because of repeated array scans.
4. Provider-master ingestion must use bounded memory and bounded concurrency; it must not create multiple avoidable full-file copies.
5. The catalogue must never be partially reconciled from an incomplete, malformed, truncated or failed provider source.
6. A provider refresh failure must remain isolated to that provider and must not corrupt another provider's last-known-good snapshot.
7. Shutdown must stop scheduling, abort cancellable I/O, prevent new work and await active refresh/transaction work before closing the database.
8. The final behavior must be supported by realistic data tests, failure tests and measured performance evidence.
9. The supported MarketHubTS instrument universe and provider contracts must remain unchanged unless a separate product/architecture approval explicitly changes them.

## 5. Non-goals and protected invariants

This remediation is not authorization to:

- Expand supported product scope, including adding futures or new exchange/segment coverage not already approved.
- Change the NSE cash-index catalogue requirements, the six approved NSE index F&O underlyings, or the BSE SENSEX-only derivative boundary.
- Introduce broker credentials or make public master refresh depend on an authenticated instrument-search API.
- Replace public master files with an unverified or incomplete API.
- Add a generic configuration framework, a new frontend options list, or new WebUI selectors.
- Change the fixed `UPSTOX` / `FYERS` provider identity contract without a separate documented architecture decision.
- Split one provider snapshot into separately committed partial batches if that weakens the existing atomicity guarantee.
- Relax completeness validation, source freshness rules, failure isolation, or fail-closed reconciliation.
- Add a database migration/index by default when an existing indexed query already meets the requirement.
- Upgrade/downgrade Bun, replace dependencies, introduce a new streaming parser dependency, or use experimental Worker APIs without a demonstrated need, official-version compatibility evidence and separate approval.
- Commit, push, merge, rebase, amend, force-push or perform destructive Git operations.

**Protected invariant:** a provider snapshot is validated and applied within the existing atomic transaction boundary. Reconciliation must run only after the complete source has been fetched, parsed, validated and imported successfully. Failed or incomplete sources must not cause stale records to be removed.

## 6. Proposed work packages

### WP0 — Repository re-audit and reproducible baseline

**Purpose:** remove uncertainty before implementation and establish metrics that later work can be compared against.

Tasks:

1. Inspect `git status`, branch, HEAD and all pre-existing changes before doing anything. Preserve every unrelated user change. Do not clean, reset, stash, checkout over or otherwise disturb user work.
2. Re-read `docs/PROJECT_MANAGER_PROTOCOL.md`, `docs/ENGINEERING_STANDARDS.md`, `docs/TESTING_AND_ACCEPTANCE.md`, architecture decisions and current catalog/metadata requirements.
3. Re-open the exact implementation paths listed in §8, confirm line-level behavior and identify any changes since the reference snapshot.
4. Inspect package manifests, lockfile and CI/runtime configuration to determine the project's actual supported Bun version. Record the exact runtime used for every benchmark; do not silently change it.
5. Capture representative current Upstox and FYERS source files from the official public source, or use a clearly identified, legally retained fixture already in the repository. Record source URL, retrieval date/time, compressed/uncompressed bytes, row counts by segment and a content hash. Never add credentials or sensitive data to fixtures.
6. Run the existing catalog refresh tests and the narrowest reproducible refresh/benchmark command. Record actual command, exit code, Bun version, machine/OS, source URL + hash, compressed/uncompressed bytes, row counts, elapsed time, RSS and event-loop delay. Classify every number using §7.1: **verified baseline** only if reproduced with this full environment capture; otherwise **reported but unreproduced**. If the 15-minute or approximately 1 GB reports cannot be reproduced, record them as unverified rather than forcing a synthetic equivalent. Do not adopt any absolute numeric pass/fail budget in this plan; WP0 may only propose candidate targets with the derivation basis required by §7.3, subject to owner acceptance.
7. Establish stage-level timing instrumentation or a benchmark harness that does not alter production semantics. Keep diagnostics free of credentials and full raw market payloads.

**WP0 output:** a baseline report, exact current call graph, a list of verified versus unverified findings, and any plan corrections required before WP1.

**Gate:** do not proceed to implementation if the core query behavior, repository API, atomicity boundary or provider source payload assumptions differ materially from this plan. Return the differences for plan revision first.

### WP1 — Canonical-scoped identifier supersession and indexed importer lookups

**Priority:** P0 / first implementation work package.

#### WP1-A: Fix identifier supersession lookup

1. In the transactional apply path, use the existing `tx.listIdentifiersByCanonicalId(merged.canonicalId)` (or the exact equivalent confirmed by the auditor) to retrieve only identifier history belonging to the canonical instrument currently being applied.
2. Filter that result to the exact current identifier type, namespace, exchange scope, segment scope and `CURRENT` status required by the existing supersession logic.
3. Preserve the existing rule: when a new current identifier for the same canonical instrument/scope replaces a different normalized identifier, the prior current identifier is superseded using the existing status/provenance/timestamp semantics; unrelated canonical instruments must never be touched.
4. Continue to upsert the newly derived identifier through the existing transaction.
5. Keep this work inside the existing single provider snapshot transaction. Do not move reconciliation or provider-run state updates outside that transaction.
6. Prefer the existing canonical-ID index. Do not add an index or migration unless a query-plan measurement proves the existing method is inadequate.

The implementation must verify whether `merged.canonicalId` is final after resolution at the point of lookup. If it is not, the plan must be revised to use the resolved canonical ID before querying. Do not guess.

#### WP1-B: Replace repeated `Array.find` scans in importers

1. Identify every repeated `instruments.find(...)` or equivalent linear search inside Upstox and FYERS derivative-import loops.
2. Build provider-specific maps once per import using the exact provider identifier that links a derivative to its underlying.
3. Define duplicate-key behavior explicitly: reject conflicting duplicates, apply an existing deterministic precedence rule, or preserve the current behavior where that behavior is proven intentional. Never silently let a later row overwrite a conflicting earlier row without evidence.
4. Handle missing underlyings explicitly and preserve current validation/fail-closed semantics.
5. Remove unused intermediate structures only after confirming they have no consumers, side effects or test/debug purpose.

#### WP1-C: Regression tests

Required scenarios:

- A canonical instrument with an old current SYMBOL identifier and a new normalized SYMBOL value correctly supersedes only its own old identifier.
- Many unrelated canonical instruments share the same provider/exchange/segment/SYMBOL scope; processing one instrument must not materialize or mutate identifiers belonging to the others.
- Existing identifiers of another namespace, exchange scope, segment scope, identifier type or status remain unchanged.
- Identifier history remains intact; no unrelated identifier is deleted.
- Missing or duplicate underlying mapping follows the documented behavior and does not create a malformed derivative.
- Upstox and FYERS imports preserve the same canonical instruments, relationships and specifications as before for the same source fixtures.
- Existing transaction rollback, invalid-import and no-reconciliation-on-failure tests continue to pass.

The test proving the broad query is gone must assert query/result scope or instrument the repository boundary so it cannot pass merely because the test dataset is small. Avoid brittle wall-clock assertions as the only proof. Required deterministic assertions (§7.4.1–7.4.3): (a) the supersession path issues **zero** broad-scope `findIdentifiers()` calls — asserted via a repository-boundary spy/counter or SQL-capture assertion, with a fixture containing many unrelated canonical instruments sharing the same type/namespace/exchange/segment/SYMBOL scope; (b) every identifier row materialized during the apply belongs to the canonical ID under test; (c) no new repository method, index or migration is added. These criteria are independent of timing and dataset size.

**WP1 acceptance:** correctness is unchanged for valid imports; unrelated canonical identifiers are excluded from the supersession lookup; the lookup uses the existing canonical-ID access path; importer relationship resolution no longer performs repeated full-array scans; existing atomic snapshot behavior is preserved; the deterministic assertions above pass regardless of wall-clock timing.

### WP2 — Bounded provider-master ingestion and memory reduction

**Priority:** P1, after WP1 baseline comparison.

#### WP2-A: Upstox ingestion

1. Re-evaluate the supported public master sources in current official Upstox documentation. Compare `complete.json.gz` with available separate NSE/BSE BOD files for coverage, schema, update timing, compression, availability and compatibility with the MarketHubTS scope.
2. Use separate exchange files only if the auditor verifies that they contain every required instrument/underlying for the currently supported catalogue and that their combined semantics match the existing complete-source import. Do not trade completeness for a smaller download.
3. Design a bounded streaming pipeline: stream the response, decompress incrementally, parse records incrementally with a maintained and version-compatible parser, validate records, and feed the importer in bounded chunks or an equivalent bounded structure.
4. Apply backpressure. Define maximum in-flight bytes/records and a clear failure path for malformed input, unexpected content type, truncated gzip, oversized payload and cancellation.
5. Avoid keeping the full compressed `ArrayBuffer`, full decompressed string and full parsed array alive together.
6. Hash incrementally only if the selected runtime/API supports it and the hash semantics are preserved. If the current hash represents decompressed text, do not silently switch to compressed-byte hashing. Document and test any intentional hash-semantic change before implementation.
7. Conditional requests/caching are **deferred** (§6.2) and are not part of WP2; retain the existing unconditional-download behavior. Do not assume HTTP `ETag`, `Last-Modified` or conditional GET support. If a 304 is observed unexpectedly, treat it as a failure unless a valid previously accepted cached body and matching validator metadata exist for that exact source URL/segment (only applicable if a separately authorized caching follow-up exists; otherwise treat any unexpected 304 as a failure) — a 304 must never be success when cached content is absent, corrupt or unvalidated. Any future caching implementation must satisfy the full §6.2 contract.

#### WP2-B: FYERS ingestion

1. Verify the current official FYERS Symbol Master format and the actual segment files required for the existing NSE/BSE import scope. The plan assumes there is no official symbol-filtered endpoint; the auditor must confirm this with current official documentation.
2. Do not parse and retain all required segment files concurrently as full object graphs unless a measured, documented reason proves that is the only safe option.
3. Evaluate a bounded two-pass/staged approach: first derive the required derivative/underlying token set from the relevant FO sources; then stream the relevant CM sources and retain only cash-underlying records required by that set; finally resolve and import the staged derivative records once all required mappings are available.
4. Verify that this ordering is compatible with the provider's actual `underFyTok`/`fyToken` relationship and with current importer semantics. Do not assume field meanings or uniqueness from names alone.
5. If the two-pass design requires temporary files, define secure temp-directory handling, restrictive permissions, maximum disk use, unique names, crash cleanup, cancellation cleanup and protection against path traversal. Temporary files must not contain credentials; they must be treated as untrusted source data.
6. Remove redundant wrapper arrays/maps only after proving they are unnecessary. The reported `rowByFyToken` map must be checked at current HEAD before removal.
7. Hash incrementally without building a second full-file JSON string. Preserve or explicitly migrate the existing source-hash contract; never silently change whether hashes represent source bytes, parsed content or concatenated segment data.
8. Process sources sequentially or with a strict bounded concurrency limit. The limit must be justified by peak memory and elapsed-time measurements, not an arbitrary `Promise.all` expansion.

#### WP2-C: Shared safety requirements

- The parser must be compatible with the actual supported Bun version and dependency policy.
- The parser must detect malformed, truncated and incomplete input and must not emit a successful import from a partial stream.
- Input byte limits, row-count sanity limits and parser error handling must fail closed and be configurable only where an existing owning backend configuration model already exists; do not add a new generic configuration surface for this task.
- Backpressure and cancellation must propagate from the refresh lifecycle into fetch, decompression, parsing and staging.
- A complete provider snapshot must still be built and validated before the one atomic database apply/reconciliation boundary.
- Keep the current per-provider isolation: an Upstox failure must not block a valid FYERS refresh and vice versa, subject to the existing scheduler/single-flight rules.
- Do not add a new dependency without comparing existing dependencies, runtime-native capabilities, supported-version constraints, maintenance status and bundle/runtime impact. Any dependency addition requires explicit justification and approval.

**WP2 acceptance:** memory measurements show a reproducible reduction against the WP0 baseline under the same fixture, runtime and environment, with the measurement procedure in §7.5; no absolute numeric threshold is adopted until WP0 establishes a defensible baseline; no pair of avoidable full-size source representations coexist; the complete supported catalogue is preserved; malformed/truncated/cancelled sources fail safely; import output matches the baseline fixture semantically; snapshot atomicity and provider isolation remain intact.

### WP3 — Refresh lifecycle, server readiness and shutdown safety

#### WP3-A: Exact lifecycle and shutdown contract

The lifecycle is an explicit state machine: `RUNNING → STOPPING → STOPPED`. Shutdown must satisfy **all** of the following, in order. Each numbered item is a separate testable obligation.

1. **Enter stopping state.** Transition to `STOPPING` atomically and observably; the state is exposed for tests/diagnostics. All subsequent steps run from this state.
2. **Prevent new scheduled refreshes.** The single-flight/scheduling guard rejects any new refresh start once `STOPPING` is entered; no new refresh may be created after this point.
3. **Clear future timers.** Cancel every pending interval/timeout handle so no future timer can fire a refresh. Verify no timer remains registered after `STOPPED`.
4. **Abort active network/stream operations.** Signal each active refresh's `AbortController` and propagate cancellation through fetch, decompression, parsing and staging. Cancellation is distinct from provider failure (see item 10).
5. **Clean up temporary staging files.** Remove all staging artifacts on success, failure, cancellation and crash paths, with bounded disk use and deterministic paths (§WP2-B item 5). No staging file may outlive its refresh.
6. **Refresh not yet in a DB transaction.** Abandon it safely: no catalog writes, no reconciliation, no provider-run "success" record. Cancellation here must not touch the database.
7. **Refresh whose atomic DB transaction has already started.** Let that transaction reach its **existing** commit-or-rollback boundary. Do **not** abandon it mid-transaction, do not force-close the database, and do not introduce a partial commit. The existing atomic commit/rollback boundary is preserved exactly (§5 protected invariant, §6.1 row E).
8. **Await the active refresh task.** `stopAndWait` (or an equivalently explicit lifecycle method) resolves only after every active refresh task has settled (completed, failed or cancelled). Do not silently change a public `stop` contract without checking consumers; add the explicit method if `stop` cannot express this guarantee.
9. **Close the database only after all refresh work and transactions have settled.** Database closure is the final step, after items 1–8. No refresh task or transaction may still be able to use the database at closure time.
10. **Startup failure and repeated/idempotent shutdown.** If API startup fails after partial initialization, run the same drain sequence (items 1–9) before closing resources. Repeated `stop`/`stopAndWait` calls are idempotent: no double-close, no leaked timer/task, no thrown error on the second call.

**Additional mandatory constraints:**

- Create the HTTP listener successfully **before** scheduling catalog refresh; the server must not await remote master download/parse/apply as a prerequisite for listening. Start refresh through an explicit lifecycle owner after the listener is established, with observable error handling (no unhandled rejected fire-and-forget promise).
- Give each active refresh a cancellation mechanism owned by the refresh run and propagated through all cancellable I/O stages.
- **Shutdown cancellation must never trigger reconciliation from an incomplete source.** Cancellation is recorded distinctly from provider failure and never as a successful refresh.
- A synchronous JSON parse cannot be pre-empted by an `AbortSignal`; the bounded streaming design should yield between records/chunks where the runtime allows. Consider a Worker only if stage-level measurements still show unacceptable event-loop stalls after WP1/WP2, and only after compatibility and operational trade-offs are audited (§6.1 row F).

#### WP3-B: Testable lifecycle acceptance criteria

| Lifecycle state / event | Deterministic assertion |
|---|---|
| Listener readiness | `/health` responds before any provider master download completes; refresh scheduling occurs only after `Bun.serve()` succeeds. |
| Enter `STOPPING` | State observable as `STOPPING`; a subsequent `startIfNeeded()`/schedule call is rejected and creates no task. |
| Timers cleared | No pending timer/interval handle remains; advancing the clock past the refresh interval produces no new refresh. |
| Active fetch aborted | `AbortSignal` observed by fetch/decompress/parse/staging; in-flight request terminates; no post-abort writes. |
| Staging cleanup | All temp files removed on success, failure, cancellation and simulated crash; no path traversal; bounded disk use. |
| Refresh before DB transaction | No catalog write, no reconciliation, no success record; DB remains usable and unchanged. |
| Refresh inside DB transaction | Transaction reaches its existing commit or rollback boundary; no partial commit; no forced DB close mid-transaction; rollback leaves last-known-good snapshot intact. |
| Await active task | `stopAndWait` resolves only after the active task settles; assertion fails if it resolves early. |
| DB closure order | DB close is observed to occur strictly after all refresh tasks and transactions settle; no task can use the DB afterward. |
| Startup failure | Partial-init failure runs the same drain sequence; no active timer, task or open resource leak remains. |
| Repeated shutdown | Second `stop`/`stopAndWait` is a no-op: no double-close, no error, no leak. |
| Cancellation vs failure | Cancellation is never recorded as success and never triggers reconciliation from an incomplete source. |

**WP3 acceptance:** every row of the WP3-B table passes deterministically; listener readiness is independent of remote refresh; stop prevents new work; in-flight cancellable work is aborted and awaited; the atomic transaction boundary is preserved with no partial commit or abandoned transaction; database closure happens only after refresh work and transactions settle; startup-failure cleanup leaves no active timer, task or open resource leak.

### WP4 — End-to-end verification and independent review

1. Run the existing test suite and the focused tests for catalog sync/refresh/import/apply using the repository's actual supported package scripts.
2. Run the complete provider refresh against representative current official public masters or a carefully versioned fixture set. Exercise both providers independently and together under the real scheduler/single-flight rules.
3. Verify provider coverage and record counts against the raw source and current MarketHubTS product scope. Report excluded source rows by reason and ensure BSE scope remains restricted as documented.
4. Exercise malformed JSON, truncated gzip/stream, HTTP error, timeout, cancellation, unchanged source/304 (only if implemented), partial segment failure, duplicate token, missing underlying, database failure, transaction rollback and shutdown during refresh.
5. Verify a failed provider refresh never reconciles/removes records from the last successful snapshot. Verify a successful complete refresh does reconcile according to current authoritative source semantics.
6. Capture stage-level wall-clock time, peak RSS, event-loop delay, source bytes, row counts, database query counts and database transaction duration. Record machine, OS, Bun version, fixture/source hashes and commands.
7. Compare WP4 metrics against WP0 using the same source data, runtime and environment where possible. Explain any unavoidable differences.
8. Perform an independent source diff review against this approved scope. Review all added/changed files, dependency/lockfile changes, query plans, lifecycle paths and test evidence.
9. Record any remaining limitations; do not declare the defect fixed solely because unit tests pass or a refresh eventually completes.

**WP4 acceptance:** functional and failure-matrix tests pass; the end-to-end refresh is complete and repeatable; the API remains responsive during refresh; memory and latency improvements are evidenced; all existing invariants are preserved; independent review finds no unresolved blocker.

### 6.1 Alternatives considered and decisions (A–G)

This table is a decision record, not permission to implement. "Mandatory" means required to close the defect; "Optional" means a bounded improvement that may be separately authorized; "Deferred" means explicitly outside WP1–WP4. Snapshot atomicity (row E) is a **PROTECTED INVARIANT**, not a discardable optimization.

| # | Decision area | Alternatives considered | Selected direction | Rejected / deferred direction | Technical rationale | Evidence required before implementation | Status |
|---|---|---|---|---|---|---|---|
| A | Upstox download source | (1) keep `complete.json.gz`; (2) separate `NSE.json.gz` + `BSE.json.gz`; (3) download all three | Retain `complete.json.gz` as the WP0/WP1 baseline source. Treat separate NSE+BSE as a bounded WP2 candidate only after coverage proof. | Switching to separate files without row-level coverage proof; downloading Complete **and** both exchange files together (no demonstrated requirement). | Official docs list all four BOD JSON files but do **not** state that Complete equals the union of NSE+BSE+MCX or that field sets match. Separate files are scope-aligned (NSE/BSE only) and smaller, but union completeness is unverified. | Official URLs/fields (fetched 2026-11-25, §6.4); row-level comparison of Complete vs union(NSE,BSE) for required segments and fields; proof no supported instrument/underlying is lost. | **Deferred / optional** (source switch is not a prerequisite for the primary fix). |
| B | Full-file buffering vs incremental streaming | (1) current full `ArrayBuffer` + full decompressed string + full parsed array; (2) incremental decompress/parse with bounded chunks | Bounded incremental streaming in WP2, with backpressure and no coexisting full representations. | Continued full-file buffering; moving the same buffering into a staging layer. | Multiple full-size representations coexist during refresh; peak memory scales with source size rather than being bounded. | WP0 baseline RSS and stage high-water marks; representative source sizes; parser compatibility with the supported Bun version; semantic equivalence of parsed output. | **Mandatory** for the memory goal (WP2, after WP1). |
| C | Parallel vs bounded concurrency | (1) unbounded `Promise.all` over providers/files; (2) fully sequential; (3) bounded concurrency limit | Sequential or strictly bounded concurrency; exact limit derived from measurement, not chosen arbitrarily. | Unbounded parallel downloads; an arbitrary fixed concurrency number without evidence. | Unbounded parallelism multiplies peak memory and can starve the event loop; a defensible limit needs empirical basis. | Peak RSS and elapsed time vs concurrency level from WP0/WP4; per-provider isolation preserved. | **Mandatory** (bounded concurrency); exact limit **optional/tunable**. |
| D | Repeated array searches / broad DB lookups vs keyed maps and canonical-ID-scoped indexed lookup | (1) `instruments.find()` inside loops + broad `findIdentifiers()` scope; (2) keyed maps + `listIdentifiersByCanonicalId()` on the existing index | Keyed maps built once per import; reuse existing `listIdentifiersByCanonicalId(merged.canonicalId)` and index `instrument_identifier_history_canonical_idx` (verified `catalog.ts:174,360`; `0001_lively_mauler.sql:134`). | New repository method, query parameter, index or migration without proof; broad-scope supersession query. | Repeated linear scans are O(n²); broad identifier reads materialize unrelated rows and parse provenance JSON. The existing indexed method already provides canonical-ID scope. | Verify key uniqueness/duplicate handling per provider; verify `merged.canonicalId` is final at lookup; deterministic query-scope assertion/instrumentation proving the broad lookup is gone; query plan only if needed. | **Mandatory** (WP1, P0). |
| E | One atomic snapshot transaction vs incremental/partial commits | (1) single atomic provider snapshot transaction (current); (2) incremental/partial batch commits | **Retain the single atomic transaction — PROTECTED INVARIANT.** Reconciliation only after a complete source is fetched, parsed, validated and imported. | Partial/incremental commits that weaken atomicity; reconciliation from an incomplete source; abandoning a running transaction mid-commit. | Fail-closed reconciliation depends on the all-or-nothing boundary; partial commits could remove stale records from an incomplete source. | Existing rollback / invalid-import / no-reconciliation-on-failure tests; transaction-boundary instrumentation; WP3 shutdown tests proving no partial commit or abandoned transaction. | **Mandatory / PROTECTED INVARIANT** (not negotiable). |
| F | Same-process processing vs Worker/process isolation | (1) same process with bounded streaming and yielding; (2) Worker thread / separate process | Same-process bounded streaming first; Worker isolation deferred. | Introducing a Worker as the first response to the defect. | Worker isolation adds compatibility, lifecycle and operational cost; it is only justified if event-loop stalls remain after WP1/WP2. | Stage-level event-loop delay measurements after WP1/WP2; Bun Worker API compatibility with the supported version; operational trade-off audit. | **Deferred** (conditional on measurements). |
| G | Conditional HTTP requests/caching and retry/backoff vs unconditional downloads | (1) unconditional download each refresh; (2) conditional GET with ETag/Last-Modified + persisted cache; (3) bounded retry/backoff only | **Defer conditional requests/caching to a separate optional follow-up** (precise contract in §6.2). Bounded retry/backoff is an optional reliability enhancement, not a prerequisite. | Conditional GET/caching inside WP1/WP2; treating a 304 as success without a valid previously accepted snapshot. | Caching introduces validator/cache-consistency hazards and is not needed to fix the primary defect; source validator support is unverified. | Verify source sends ETag/Last-Modified; define cache identity/validator contract before any implementation; tests proving a failed import cannot replace last-known-good cache/snapshot. | **Deferred / optional** (caching); retry/backoff **optional bounded**. |

### 6.2 Conditional requests and caching — explicit decision (deferred)

**Decision:** conditional HTTP requests and source caching are **deferred to a separate optional follow-up**, outside WP1–WP4. They are **not a prerequisite** for fixing the primary performance defect (the broad identifier lookup and repeated importer scans). WP1/WP2 proceed with the existing unconditional-download behavior. This keeps WP1/WP2 bounded and avoids a 304/cache-consistency hazard on the critical path.

If a later, separately authorized work package implements caching, the following contract is **mandatory** before any code is written:

- **Cache identity and association:** each cached body is keyed by the exact source URL **and** segment/file identity (e.g. Upstox `complete.json.gz` vs `NSE.json.gz`/`BSE.json.gz`; FYERS `NSE_FO`/`NSE_CM`/`BSE_FO`/`BSE_CM`). A validator from one URL/segment must never validate a body from another.
- **Persisted validator metadata:** store, per cache identity, the validator values, the accepted source hash, the acceptance timestamp and the schema/format version. Metadata is persisted atomically with the accepted snapshot, not written independently.
- **ETag vs Last-Modified precedence:** ETag takes precedence when present and syntactically valid; Last-Modified is used only when no valid ETag exists. If both are absent or unparseable, the request is unconditional and no 304 may be expected.
- **HTTP 200:** validate and import the new body; only after a **successful, complete import and atomic snapshot commit** may the cached body and validator metadata be replaced.
- **HTTP 304:** treat as "unchanged" **only** when a valid, previously accepted cached body and matching validator metadata exist for that exact cache identity. Otherwise it is a failure, never a success.
- **Missing validators:** no conditional request is sent; behavior is identical to the current unconditional path.
- **Invalid cached content:** if the cached body fails validation/hash/parse, it is discarded; a 304 must not be honored and a fresh unconditional download is required.
- **When validator metadata may be updated:** only after a complete source has been fetched, parsed, validated, imported and atomically committed. Never on a failed, cancelled, partial or in-transaction refresh.
- **304 without a valid previously accepted snapshot:** hard failure; no import, no reconciliation, no cache write, no "success" status. A 304 must **never** be success when cached content is absent, corrupt or unvalidated.
- **Source-hash consistency:** the hash contract must remain semantically identical to the current one (hash of the accepted source representation). Any change in what is hashed requires an explicit, documented, versioned migration and tests — never a silent switch between compressed bytes, decompressed text and concatenated segment data.
- **Required tests:** (a) failed/incomplete import cannot replace last-known-good cache or snapshot; (b) 304 with no cached body fails; (c) 304 with corrupt cached body fails; (d) validator from a different URL/segment is rejected; (e) 200 with valid body updates cache only after commit; (f) cancellation/rollback leaves cache and validator metadata unchanged.

### 6.3 Data-completeness and field-coverage compatibility reference (WP2 / WP4)

The refactor must preserve existing instrument fields, relationships, identifiers, specifications and provider mappings. The following are the authoritative compatibility references; this plan does **not** duplicate them or expand product scope.

- **Authoritative field-by-field checklist:** `docs/M4_STAGE_G_M5_PHASE_4B_DATA_COMPLETION_PLAN.md` §3 (field-by-field coverage checklist) and §6 (provider-by-provider coverage and missing fields). Note: that document is a **proposal**, its coverage statuses are `V-doc`/`UNVERIFIED` (documented, not live-proven), and its table primarily covers live streaming/REST fields. It is the closest field-coverage checklist in the repository, but it is **not** a catalog-master-import-specific checklist.
- **Canonical model and identity rules:** `docs/MARKET_DATA_AND_CATALOG.md` §3.1 (required canonical information), §3.2 (identity rules), §3.3 (provider mappings and aliases), §3.4 (transactional sync/evolution), §1.3 (dynamic catalog rule), §1.5 (four-way scope distinction) and §6 (current implementation status: local catalogue import covers NSE/BSE **option** contracts CE/PE plus referenced cash/index underlyings; futures and the full cash-index catalogue are not imported).
- **Product scope boundaries:** `docs/PRODUCT_REQUIREMENTS.md` and `docs/MARKET_DATA_AND_CATALOG.md` §1.1–§1.2 (six approved NSE index F&O underlyings; BSE restricted to SENSEX + SENSEX F&O). Do not broaden scope because a broker file supplies more rows.
- **Discovery/UI boundary:** `docs/METADATA_AND_CAPABILITY_DISCOVERY.md` (AD-025: backend-owned options; no duplicated frontend lists) and `docs/WEBUI_AND_CONFIGURATION.md` (user-enabled selections are separate from source data). This remediation adds no selector or option.
- **Minimum existing compatibility artifacts to use as reference (no new fields invented):**
  - `packages/contracts/src/market.ts` — Zod-validated canonical schemas/types.
  - `packages/database/drizzle/0001_lively_mauler.sql` — `canonical_instruments`, `derivative_contracts`, `provider_instrument_mappings`, `instrument_aliases`, `instrument_identifier_history`, `catalog_sync_runs` (PK/FK/unique/index constraints, JSON extensibility fields).
  - `packages/market-core/src/sync/import-report.ts` — existing import report shape/counts/conflicts.
  - `packages/market-core/src/sync/{upstox-master,fyers-master,apply,normalize}.ts` — current field mapping and relationship construction.
  - `tests/market/catalog.test.ts`, `tests/market/catalog-refresh.test.ts`, `tests/market/catalog-routes.test.ts` — regression fixtures and assertions.

**Statement on absence of a dedicated checklist:** there is **no single field-by-field checklist dedicated specifically to the catalog master import**. The artifacts above are the minimum authoritative compatibility reference. WP2/WP4 must prove preservation by comparing normalized import output (fields, relationships, identifiers, specifications, provider mappings, counts and conflicts) against the WP0 baseline fixtures using these artifacts. Any field not present in these references is out of scope and must not be invented.

### 6.4 Official source verification and download-source decision (Upstox / FYERS)

All URLs below were fetched directly on **2026-11-25**. These are documentation facts, not live-verified payloads.

**Upstox — Instruments / BOD JSON files** (`https://upstox.com/developer/api-documentation/instruments/`, fetched 2026-11-25):
- Official BOD JSON URLs: Complete `https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz`; NSE `.../NSE.json.gz`; BSE `.../BSE.json.gz`; MCX `.../MCX.json.gz`. CSV variants are deprecated.
- Official guidance: use `instrument_key` as the unique identifier; `exchange_token` may be reused by the exchange after expiry. Prefer JSON over CSV.
- Documented sample JSON fields: `segment`, `name`, `exchange`, `isin`, `instrument_type`, `instrument_key`, `lot_size`, `freeze_quantity`, `exchange_token`, `tick_size`, `trading_symbol`, `short_name`, `security_type`, `cas_eligible`. Documented `segment` values include `NSE_EQ`, `NSE_INDEX`, `NSE_FO`, `BSE_EQ`, `BSE_INDEX`, `BSE_FO` (plus out-of-scope `NCD_FO`, `BCD_FO`, `MCX_FO`, `NSE_COM`). The docs state the first four tabs (EQ, Futures, Options, Index) are included in the BOD JSON file.
- Refresh behavior: daily around 06:00 (IST), refreshed as needed during the day (seldom); next-day BOD excludes delisted stocks and expired contracts.

**Explicit evaluation of separate NSE+BSE files for MarketHubTS scope:** MarketHubTS covers NSE and BSE only (§6.3), so `NSE.json.gz` + `BSE.json.gz` are the scope-aligned candidates and avoid downloading MCX rows. However, the official documentation **does not state** that `complete.json.gz` equals the union of NSE+BSE+MCX, nor that the separate files carry identical fields/rows. **Union completeness is therefore UNVERIFIED.** Decision: retain `complete.json.gz` as the WP0/WP1 baseline; adopt separate NSE+BSE only after a row-level comparison proves no required instrument, underlying, derivative contract or field is lost for segments `NSE_EQ`, `NSE_INDEX`, `NSE_FO`, `BSE_EQ`, `BSE_INDEX`, `BSE_FO`. Do **not** download Complete and both exchange files together unless a demonstrated requirement justifies it. Exclusions (must not be imported): MCX, NCD_FO, BCD_FO, NSE_COM, mutual funds, MTF, MIS, suspended, global and US instruments; BSE stays SENSEX + SENSEX F&O. Remaining uncertainty: exact derivative-row field set in JSON (expiry/strike/option_type/instrument_type appear in the CSV sample and are expected in JSON but must be verified from an actual payload); whether separate files omit cross-exchange underlying references; update-timing differences; ETag/Last-Modified support (not documented).

**FYERS — Symbol Master JSON** (`https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-json/`, fetched 2026-11-25; page last updated 2026-10-14):
- Confirmed download URLs: `https://public.fyers.in/sym_details/NSE_FO_sym_master.json`, `NSE_CM_sym_master.json`, `BSE_FO_sym_master.json`, `BSE_CM_sym_master.json` (required for MarketHubTS); also `NSE_CD`, `NSE_COM`, `MCX_COM` (out of scope). The four required files are confirmed to exist.
- Confirmed field semantics: `fyToken` = unique token for the security; `underFyTok` = unique token for the underlying symbol (the derivative→underlying join key used by WP1-B); `expiryDate` = timestamp, derivative contracts only; `tradeStatus` = 1 active / 0 inactive; `isCasEligible` = true when present, absent otherwise; `qtyFreeze` = empty string when not applicable; `originalExpDate` = ignore; `exToken` = integer exchange token (non-canonical metadata); `exchange`, `segment`, `exInstType` are integers whose meanings are defined in the documentation appendix. The file is a map keyed by symbol ticker whose value is the detail object.
- Remaining uncertainty: exact integer→enum mappings for `exchange`/`segment`/`exInstType` (appendix not fetched); whether every required underlying appears in the CM files; actual row distributions and duplicate-token behavior; ETag/Last-Modified support (not documented). These must be verified from representative payloads before implementation; do not assume field meanings from names alone.

## 7. Performance and reliability measurement contract

The plan auditor must confirm the following measurements are feasible with the current runtime and tests. If any metric needs a different method, document it before implementation. This section deliberately separates four classes of evidence; they must never be conflated.

### 7.1 Evidence classes (do not conflate)

| Class | Definition | How it may be used |
|---|---|---|
| **Verified baseline measurement** | Reproduced in WP0 with recorded exact command, exit code, Bun version, machine/OS, source URL + hash, compressed/uncompressed bytes, row counts, elapsed time, peak RSS and event-loop delay. | May be used as the before-value in a before/after comparison and as the basis for any candidate target. |
| **Reported but unreproduced measurement** | A number stated in a prior investigation report without a reproducible command/environment in this plan. | Must be labelled "reported, not verified"; may motivate investigation but **must not** be used as a baseline, a pass/fail threshold or evidence of improvement. |
| **Candidate performance target** | A proposed numeric budget derived from a verified baseline on a representative source/runtime/machine. | May be adopted only after WP0 produces the baseline and the owner accepts the number. No absolute numeric target is adopted by this plan. |
| **Mandatory deterministic acceptance criterion** | A timing-independent, objectively testable assertion about query scope, materialized rows, concurrency bounds, atomicity, cancellation or lifecycle order. | These are the actual pass/fail gates for WP1–WP4; they do not depend on wall-clock or RSS thresholds. |

### 7.2 Reported but unreproduced measurements (explicitly not verified)

The prior OpenCode investigation report stated: a full refresh could exceed **15 minutes** in a problematic Upstox apply path; FYERS processing peaked around **979.5 MB RSS** in one run; source download/parse took approximately **five seconds**; and the local Bun version was **1.4.5** while the project target was reported as **1.4.4**. These are **reported, not independently reproduced**. They must not be presented as verified baselines, must not be used to justify absolute thresholds, and must be re-measured in WP0 with full environment capture. If they cannot be reproduced, WP0 records that as unverified rather than forcing a synthetic equivalent.

### 7.3 Candidate performance targets (no arbitrary thresholds adopted now)

**This plan adopts no absolute numeric pass/fail budgets** (for example, no "30 s" or "512 MB" threshold). Such numbers would be arbitrary without a verified baseline, a representative source size, a fixed runtime and a known machine. WP0 must produce those inputs; any candidate numbers it records are **proposals requiring owner acceptance**, not automatic gates. A candidate target is defensible only when it states: the metric, the verified baseline median and spread, the exact source hash/size, the Bun version, the machine/OS, and the derivation rule (e.g. a ratio to the measured baseline). Until then, the mandatory gates are the deterministic criteria in §7.4.

### 7.4 Mandatory deterministic acceptance criteria (timing-independent)

These criteria must hold regardless of measured timing or RSS:

1. The identifier-supersession path issues **no broad-scope `findIdentifiers()` query**; it uses the existing canonical-ID access path and returns only rows for the canonical instrument being applied. Proven by query-scope assertion or repository-boundary instrumentation, not by wall-clock.
2. Importer derivative→underlying resolution performs **no repeated full-array `find()` scans**; keyed maps are built once with documented duplicate/missing handling.
3. No new repository method, query parameter, index or migration is introduced unless a query-plan measurement proves the existing indexed method is inadequate.
4. No pair of avoidable full-size source representations (compressed buffer + decompressed string + parsed array/object graph) coexists; proven by instrumentation/allocation accounting, not by a peak-RSS number alone.
5. Concurrency is bounded by an explicit, justified limit; unbounded `Promise.all` over all providers/files is absent.
6. A provider snapshot is applied in **one atomic transaction**; reconciliation runs only after complete fetch/parse/validate/import; failed or cancelled sources never trigger reconciliation or stale-record removal.
7. Shutdown drains active refresh work and transactions before database closure; no transaction is partially committed or abandoned; cancellation never triggers reconciliation from an incomplete source (see WP3).
8. Per-provider failure isolation is preserved; fixed `UPSTOX`/`FYERS` identity and product-scope boundaries are unchanged.

### 7.5 Measurement matrix (evidence to capture)

| Area | Required measurement | What it proves |
|---|---|---|
| Download | source URL, status, compressed bytes, elapsed time | Separates network latency from local processing |
| Decompression/parsing | uncompressed bytes, rows, elapsed time, peak RSS | Identifies buffering and parser cost |
| Import construction | input/output rows, missing/duplicate references, elapsed time | Verifies lookup complexity and import correctness |
| Identifier supersession | rows returned per canonical ID, query count and duration | Proves the broad scope query is eliminated (with §7.4.1 assertion) |
| Database apply | writes, transaction duration, rollback result | Protects atomicity and identifies SQLite bottlenecks |
| Reconciliation | counts inserted/updated/unchanged/retired | Proves no false deletion or partial reconciliation |
| Runtime responsiveness | event-loop delay and API health/request latency during refresh | Proves refresh does not starve normal API work |
| Memory | peak RSS and stage-level high-water marks | Proves the ingestion redesign reduces peak memory |
| Shutdown | time to abort/drain and evidence DB closes afterward | Proves no refresh task outlives its dependencies |

**Benchmark rules:**

- Use the same fixture/source hash, Bun version and environment for before/after comparisons where possible.
- Separate cold-start, warm-cache and unchanged-source runs.
- Do not compare a small synthetic fixture to a full official source and call it an end-to-end improvement.
- Report medians and spread across repeated runs where practical; do not select a single best run.
- Avoid brittle CI timing tests as the primary regression guard. The mandatory gates are the deterministic criteria in §7.4; performance benchmarks are recorded evidence, not pass/fail thresholds.
- Numeric pass/fail budgets may be recommended only after WP0 captures a verified baseline on a representative source/runtime/machine and the owner accepts them. Do not manufacture absolute RSS or latency thresholds before those inputs exist.

## 8. Expected source areas to inspect

The list is a starting point, not permission to change every file. The auditor must locate current equivalents and report additions/removals since the reference snapshot.

### Market sync/import/apply

- `packages/market-core/src/sync/refresh.ts`
- `packages/market-core/src/sync/apply.ts`
- `packages/market-core/src/sync/normalize.ts`
- `packages/market-core/src/sync/upstox-master.ts`
- `packages/market-core/src/sync/fyers-master.ts`
- `packages/market-core/src/sync/import-report.ts`
- `packages/market-core/src/types.ts`

### Database repository/schema

- `packages/database/src/repositories/catalog.ts`
- Catalog repository transaction interfaces/implementations
- Instrument identifier schema and index definitions
- Existing migrations only if the audit finds a concrete schema need

### API lifecycle

- `apps/api/src/app.ts`
- `apps/api/src/index.ts`
- Refresh service construction/registration and shutdown hooks

### Tests and standards

- `tests/market/catalog-refresh.test.ts`
- Existing catalog import/apply/identity tests and test fixtures
- `docs/PROJECT_MANAGER_PROTOCOL.md`
- `docs/ENGINEERING_STANDARDS.md`
- `docs/TESTING_AND_ACCEPTANCE.md`
- `docs/MARKET_DATA_AND_CATALOG.md`
- `docs/METADATA_AND_CAPABILITY_DISCOVERY.md`
- `docs/ARCHITECTURE_DECISIONS.md`
- Current catalog refresh defect/status documentation, if present

## 9. External documentation that must be re-verified

The auditor must open the current official documentation, record the access date and verify that the selected capabilities apply to the repository's actual runtime version. These links are research starting points, not proof that a particular implementation is compatible. Access dates are recorded where a page was fetched for this revision; unverified items are marked honestly.

- Upstox instruments (**fetched 2026-11-25**; findings and exact BOD JSON URLs in §6.4): <https://upstox.com/developer/api-documentation/instruments/>
- Upstox Instrument Search (verify Beta/auth/pagination and whether it is relevant; do not substitute for public master data without proving completeness; **not re-fetched in this revision**): <https://upstox.com/developer/api-documentation/instrument-search/>
- FYERS Symbol Master JSON (**fetched 2026-11-25**, page last updated 2026-10-14; findings and exact segment URLs in §6.4): <https://fyers.in/api-docs/v3/api/market-information/symbol-master/symbol-master-json/>
- Bun Fetch (**not re-fetched in this revision**; verify against the supported Bun version): <https://bun.sh/docs/runtime/networking/fetch>
- Bun Hashing (**not re-fetched in this revision**): <https://bun.sh/docs/runtime/hashing>
- Bun Workers (**not re-fetched in this revision**; relevant only if §6.1 row F is revisited): <https://bun.sh/docs/runtime/workers>
- NSE equity derivatives contract information (scope validation only; this task must not expand scope; **not re-fetched in this revision**): <https://www.nseindia.com/products-services/equity-derivatives-contract-information>

The auditor should identify the actual official URLs used for Upstox separate BOD files and all required FYERS segment files, their current names/formats, update behavior and coverage. Do not assume an old URL, file name, field or endpoint remains valid. §6.4 records what was verified on 2026-11-25 and what remains unverified (Upstox Complete-vs-union coverage, derivative-row JSON field set, FYERS integer→enum mappings, validator support).

## 10. Architecture and implementation constraints

- Keep canonical identity, identifier history and provider-specific normalization inside their existing owning packages.
- Keep provider-specific source parsing in provider import/adapter modules; do not move provider-specific behavior into WebUI or generic API routes.
- Reuse existing repository and transaction interfaces before creating new abstractions.
- Preserve one authoritative definition for provider identities and shared contracts. No duplicate provider or segment lists in the frontend.
- Keep source data and user-enabled selections separate. This remediation changes ingestion reliability, not product scope or user settings.
- Do not let a parser emit a "complete" snapshot until all required files/segments have been received and validated.
- A source cache/conditional request (deferred per §6.2) must not be treated as fresh unless the source validator and cached content are both trustworthy and tied to the correct source URL/version; a 304 must never be success when cached content is absent, corrupt or unvalidated.
- A failed or cancelled refresh must leave the prior successful provider state usable.
- All diagnostics must be bounded and avoid dumping entire provider master payloads or secrets into logs.

## 11. Risks and mitigations

| Risk | Mitigation / required proof |
|---|---|
| Canonical-scoped identifier lookup changes supersession behavior | Add targeted history/scope tests and compare before/after imported identifiers for the same fixtures |
| Canonical ID is not final at lookup point | Verify resolution order and use the resolved ID; revise plan if needed |
| Provider token is not unique or not the correct underlying join key | Verify official schema and actual fixture distributions; define duplicate/missing behavior |
| Streaming parser changes parsing semantics | Compare normalized import output to the existing parser across full representative fixtures, including malformed-input tests |
| Two-pass FYERS processing loses required records or associations | Validate against raw FO/CM relationships and compare canonical output/counts to the current importer |
| Separate Upstox files have different coverage from `complete.json.gz` | Prove union coverage and scope before switching; otherwise retain current official source and optimize its processing |
| Incremental hashing changes snapshot identity semantics | Preserve current hash meaning or explicitly document/version the changed contract before coding |
| Temporary staging files leak or exhaust disk | Bounded disk quota, secure paths, deterministic cleanup and cancellation/crash tests |
| Refresh and database shutdown race | Explicit stop-and-drain contract and lifecycle tests at each stage |
| Synchronous SQLite apply still blocks the event loop | Measure after WP1/WP2; only then consider a separate worker/isolation proposal with compatibility evidence |
| Runtime-native stream/worker APIs differ across Bun versions | Test against the repository-supported version; no silent runtime upgrade |
| Scope drifts into futures/provider redesign | Keep product scope and provider contracts protected; separate approval for any scope change |

## 12. Option and Metadata Impact Assessment (18 required checks)

This remediation is not intended to add or change selectable WebUI options, providers, shared enum values, MCP operations or user-managed configuration. The implementation owner must nevertheless complete these checks in the implementation report, as required by `PROJECT_MANAGER_PROTOCOL.md` §4.1.

1. **New selectable options/capabilities/entities/configuration fields:** None expected. Any proposed addition is out of scope and must be separately justified.
2. **Source of truth:** Existing market-core sync/import logic, existing provider contracts and existing catalog repository remain authoritative.
3. **Classification:** This is internal ingestion/persistence reliability work, not a new shared enum, backend capability, domain option or user-managed setting.
4. **Consumer access:** No new WebUI/MCP/REST/SSE consumer is expected. Existing catalog APIs and consumers should continue unchanged.
5. **Existing API/schema/registry/repository:** Reuse `listIdentifiersByCanonicalId` and current repository/transaction contracts unless the audit demonstrates a concrete limitation.
6. **New discovery/read API:** Not required or authorized by this plan.
7. **WebUI update behavior:** No new UI values are introduced; therefore no frontend list or manual UI edit should be needed.
8. **Cache invalidation/refresh:** Internal source validators/cache behavior may be improved only if supported by the provider response and existing backend ownership. No frontend cache contract change is expected.
9. **Sensitive metadata:** Do not expose credentials, tokens, internal provider identifiers or raw source payloads through new logs/API responses.
10. **Consistency tests:** Existing API/WebUI metadata consistency must remain unchanged; no duplicated frontend options should be introduced.
11. **Shared contract impact:** None expected. If any contract changes, stop and revise the plan.
12. **Provider/runtime registration impact:** Preserve fixed `UPSTOX`/`FYERS` provider identity and registration behavior.
13. **MCP tool/resource/prompt impact:** None expected.
14. **REST/SSE/WebUI consumer impact:** No public interface behavior should change beyond reliable API startup and refreshed catalog data becoming available according to existing contracts.
15. **Domain-data discovery impact:** Existing bounded/paginated domain APIs remain the source for catalog discovery; this task must not add an unbounded endpoint.
16. **Configuration persistence impact:** No new user-managed settings are expected. Do not store user preferences in refresh internals or silently mutate them.
17. **Forward compatibility:** A newly supported instrument/source row should continue to flow through the existing backend catalogue/import path without a frontend list edit.
18. **Dependency direction:** Keep market-core, database, provider adapters and API dependencies acyclic; any new shared parser/helper module must be placed at the correct dependency layer.

## 13. Implementation authorization and assignment boundaries

This document is a remediation plan, not an implementation assignment.

After a successful independent audit and explicit product-owner acceptance:

1. Issue a **WP1-only implementation assignment** using all 12 required fields in `PROJECT_MANAGER_PROTOCOL.md` §4.
2. Complete the 18-question Option and Metadata Impact Assessment in that assignment/report, even where the answer is "no change".
3. Require `git status` before and after, preserve all existing local modifications, and restrict the allowed file list to WP1.
4. Independently review WP1's actual diff, tests and measured query behavior before authorizing WP2.
5. Issue WP2 and WP3 as separate bounded implementation assignments, or as separate independently reviewable sub-assignments if the auditor proves a tighter dependency.
6. Issue WP4 verification only after implementation work packages are accepted.

No implementation assignment grants permission to commit, push, merge, rebase, amend or rewrite history. Those actions require separate explicit authorization.

## 14. PROCEDURAL AUDIT APPENDIX — OpenCode audit instructions

> **Procedural appendix, separate from the technical remediation design.** This section is retained deliberately so the plan can be re-audited repeatably. It contains no new technical requirements and grants no implementation permission; the technical design is §§1–13 and §15–16. Do not remove this detail merely to shorten the document.

**Copy/paste the following task to OpenCode after placing this document in the repository.**

---

### OpenCode task: independent audit of Catalog Refresh remediation plan — NO IMPLEMENTATION

You are auditing the plan at `docs/CATALOG_REFRESH_RELIABILITY_REMEDIATION_PLAN.md` (adjust only if the owner copied it to a different path).

**This is a read-only plan audit. Do not implement anything. Do not edit application code, tests, manifests, lockfiles, schemas, migrations, runtime configuration or documentation. Do not edit this plan. Do not commit, push, merge, rebase, amend, stash, reset, clean or otherwise alter Git state.**

#### A. Establish actual repository state

1. Report repository path, branch, HEAD SHA and `git status --short` before the audit.
2. Preserve all pre-existing modified, staged and untracked files exactly as found.
3. Verify the plan against the actual HEAD, not only against its reference snapshot.
4. Read `docs/PROJECT_MANAGER_PROTOCOL.md`, `docs/ENGINEERING_STANDARDS.md`, `docs/TESTING_AND_ACCEPTANCE.md`, `docs/ARCHITECTURE.md`, relevant architecture decisions, catalog/metadata docs and current defect/status documentation.

#### B. Independently verify every technical claim

Inspect the current implementation and establish evidence for:

1. The `findIdentifiers` query in `apply.ts`: exact predicates, omitted predicates, caller intent and returned-row materialization cost.
2. The existing `listIdentifiersByCanonicalId` API: interface, transaction implementation, canonical-ID index, query plan and whether it can reproduce current supersession semantics without a migration.
3. Whether the canonical ID supplied to that query is final/resolved at the point of use.
4. Every repeated linear search in the Upstox/FYERS import builders, its true key, duplicate semantics and whether maps preserve existing behavior.
5. Every full-buffer/full-string/full-object-graph allocation in the Upstox and FYERS refresh/import paths. Verify whether the reported unused `rowByFyToken` is truly unused at current HEAD.
6. The atomic transaction boundary, fail-closed validation, reconciliation order and per-provider failure isolation. Identify any plan step that could weaken them.
7. Startup ordering, fire-and-forget behavior, scheduler/single-flight rules, stop semantics, active task tracking, abort propagation, shutdown ordering and startup-failure cleanup.
8. Actual Bun version requirements and compatibility/stability of the proposed fetch, stream, decompression, hashing and Worker APIs. Do not assume the local installed version equals the supported project version.
9. Current official Upstox and FYERS source URLs, file names, payload schemas, required segment coverage, update behavior, auth requirements and whether any source supports ETag/Last-Modified/conditional requests.
10. Whether the proposed FYERS two-pass/staging design can correctly resolve all underlying relationships and preserve the exact current product scope.

For each finding, cite repository path plus line numbers (or exact symbols and query/index names), official documentation URL and access date where relevant. Separate **verified**, **reported but not reproduced**, **inferred**, and **unknown** facts. Do not promote the prior OpenCode timing/RSS claims to verified measurements unless you reproduce them and record the environment and command.

#### C. Challenge the architecture, not just proofread it

Look specifically for:

- a simpler solution than the one proposed;
- hidden correctness risks in using canonical-ID lookup for supersession;
- source completeness loss from separate Upstox files or FYERS filtering;
- incorrect assumptions about streaming JSON parsing, gzip streams, hashing semantics or cache validators;
- unbounded buffering moved from one layer into another;
- event-loop blocking that remains after streaming because import/apply or SQLite work is synchronous;
- cancellation races and database-close races;
- a plan step that creates new abstractions, dependencies, indexes or configuration unnecessarily;
- missing negative tests, failure cases or operational acceptance evidence;
- any conflict with approved product scope, architecture decisions or project protocol.

Do not implement a quick spike or a "small fix" during the plan audit. Report technical uncertainties and propose the smallest read-only research or benchmark needed to resolve each one.

#### D. Check completeness and sequencing

Confirm that WP0–WP4 are correctly ordered, independently verifiable and sufficiently bounded. Determine whether WP1 should be split further. Determine whether WP2 needs a smaller first slice (for example one provider at a time). Confirm that lifecycle changes do not depend on parser implementation details and can be tested independently. Recommend changes if this sequencing is not safe.

#### E. Review acceptance criteria

For each WP, state whether its acceptance criteria are:

- objectively testable;
- linked to the failure they are intended to prevent;
- strong enough to prove correctness and performance;
- measurable without brittle timing-only assertions;
- compatible with existing tests and product requirements.

Where numeric performance budgets are needed, recommend values only after measuring representative source sizes and a reproducible baseline. Do not invent thresholds.

#### F. Verify all 18 Option and Metadata Impact Assessment answers

Check the plan's §12 against `PROJECT_MANAGER_PROTOCOL.md` §4.1. Report any missed option, metadata, shared contract, provider, MCP, REST/SSE, WebUI, dynamic domain-data, configuration persistence, forward-compatibility or dependency-direction consequence.

#### G. Required audit report format

Return exactly one top-level verdict:

- **KEEP** — plan is complete, technically sound and ready for owner approval;
- **NEEDS FIX** — plan is directionally correct but must be revised; list every blocking and non-blocking correction;
- **REJECT** — the plan's core approach is unsafe or materially wrong; explain the replacement architecture.

Then provide:

1. **Repository snapshot** — branch, HEAD, initial and final `git status --short` (they must match), Bun/package versions.
2. **Verdict and rationale** — concise, evidence-based.
3. **Verified findings** — file/line-level evidence.
4. **Claim corrections** — every inaccurate, stale or unverified plan statement.
5. **Architecture review** — recommended final approach and why it is the simplest safe design.
6. **WP-by-WP review** — KEEP / CHANGE / REMOVE for WP0–WP4, with exact edits required.
7. **Test and benchmark matrix** — missing tests, fixture needs, metrics and measurable gates.
8. **Official-source verification** — Upstox, FYERS and Bun URLs, access dates, relevant constraints.
9. **Risk register** — remaining risks and mitigations.
10. **Option/Metadata Assessment** — review all 18 checks.
11. **Plan corrections required** — exact section and replacement wording or additions. Do not edit the plan file yourself.
12. **Implementation authorization boundary** — explicitly confirm no code/test/config/doc changes were made and no implementation is authorized.
13. **Final Git state** — prove all pre-existing local changes were preserved.

A report that merely says "looks good" or repeats this plan without source evidence is not an acceptable audit. If a critical fact cannot be verified, mark it unknown and choose NEEDS FIX rather than guessing.

---

## 15. Definition of a plan accepted for implementation

The plan may be marked **KEEP** only when all of the following are true:

- The database lookup fix is grounded in the actual repository API/query/index and preserves identifier supersession semantics.
- The correct canonical ID and provider-specific underlying join keys are established.
- Upstox and FYERS source completeness and file-processing assumptions are verified from current official sources and representative payloads.
- The memory approach is genuinely bounded end-to-end, including temporary staging and importer data structures.
- Atomic snapshot semantics, fail-closed reconciliation and provider isolation are preserved.
- Startup, cancellation, drain and database shutdown order are fully specified and testable.
- Runtime/API compatibility is established for the project's supported Bun version.
- Every work package has concrete tests, benchmark evidence and objective completion criteria.
- All 18 Option and Metadata Impact Assessment checks are satisfied.
- No unresolved blocker remains and all plan corrections have been incorporated by the plan owner after audit.

**A KEEP verdict is permission to review/accept the plan, not permission to code.** Implementation starts only after the owner explicitly accepts the audited plan and requests the first bounded implementation assignment.

---

## 16. Status history

| Date | Status | Note |
|---|---|---|
| 2026-11-25 | Proposed for audit | Consolidates source-level findings and prior investigation report. Local performance claims remain unverified pending WP0. No implementation authorized. |
| 2026-11-25 | Revised in place (audit corrections A–G) | Added §6.1 A–G alternatives decision table (snapshot atomicity marked PROTECTED INVARIANT), §6.2 explicit caching deferral with full 304/cache contract, §6.3 data-completeness compatibility cross-reference, §6.4 re-verified Upstox/FYERS official sources; restructured §7 into evidence classes with no arbitrary numeric thresholds and deterministic WP1 gates; expanded WP3 into an exact 10-step shutdown contract with testable lifecycle criteria; labelled §14 as a procedural audit appendix. Official Upstox and FYERS pages fetched 2026-11-25. No implementation authorized; repository unchanged. |
| 2026-11-25 | Published and re-audited (KEEP) | Published to repository at `docs/CATALOG_REFRESH_RELIABILITY_REMEDIATION_PLAN.md` on `develop`; independent re-audit KEEP; two minor clarity observations resolved; plan remains PLAN AUDIT ONLY, no implementation authorized. |
