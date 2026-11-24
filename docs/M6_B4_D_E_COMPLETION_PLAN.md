# M6-B4 + M6-D + M6-E Completion Plan (planning only)

> **Document type:** Bounded implementation plan / assignment scaffold. **Not** an acceptance record, **not** a status authority, **not** an implementation authorization.
> **Status:** PLANNING ONLY — **Corrections published in `9f99b9a`; awaiting independent review; not implementation-authorized.** Not a finally approved or implementation-ready plan. This document was first published on `develop` at `72743cf`; the four independent-review corrections were published at `9f99b9a` (a **historical** published baseline — current `develop` HEAD is `d19d72120d8dd34a064f63fbe644dc67b61a15a7`, in sync with `origin/develop`). It grants no implementation, commit or publication authorization. No implementation, source/test/manifest/DB change, commit, push, merge or publication is authorized by this document. Each work package (WP) requires its own separate product-owner authorization before any code is written. **Subsequently, under separate authorizations, B4 conformance/parity closeout and the M6-D slow-consumer mitigation were implemented and published on `develop`; this plan's "missing/not started" statements below are historical and are reconciled in §0/§1.3.** B4, D and E remain **not accepted** until their own gates actually pass.
> **Reconciliation (2026-11-25):** the "current HEAD `d19d721`", "awaiting independent review" and "not implementation-authorized" wording above was accurate when this plan was published and is **preserved as historical**. As of 2026-11-25, B4, D and E are **accepted** and the combined §8.3 gate is **PASSED**; see §14. This document remains planning-only for the original assignment.
> **Repository:** `Rajendertyagi/MarketHubTS`, remote `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`).
> **Branch:** `develop`. **Current HEAD (2026-11-24):** `d19d72120d8dd34a064f63fbe644dc67b61a15a7` (local `develop` and `origin/develop` in sync). **Historical published baseline (corrections):** `9f99b9a830252335456ef8232a2032ea9b85d6ea` (the commit that published the four independent-review corrections). **Prior published-plan baseline:** `72743cfe68e665dda018a3f4e098208f880a979f` (the commit that first published this plan and its cross-references). **Original inspected implementation baseline:** `2ed4c1ef767462f8aa78be5cc29fd3e91006e5a0` (the checkout on which the implementation/test facts and the 1076/0 baseline were independently verified). These are distinct historical SHAs and must not be conflated with current HEAD.
> **`main`:** `865d86f393a29bc1ec8d455a51d9efa82d722c48` (local and `origin/main` in sync; untouched; must never be modified without separate explicit authorization).
> **Date:** 2026-11-24.
> **Execution order (scheduling, not a technical dependency):** M6-B4 → M6-D → M6-E. B4 and D are **independently owned**; B4 is scheduled first for sequential work and separate conformance-evidence closure, **not** because D depends architecturally on B4. D's technical gate is its own §8.1. E requires **both** B4 and D. M6 may be declared complete only when B4, D and E are all accepted and the combined gate (§8.3 of `M6_D_E_PLAN.md`) passes.
>
> **Governing documents (authoritative; this plan narrows but does not replace them):**
> - [`AGENTS.md`](../AGENTS.md) — repository entry point, invariants, working rules.
> - [`PROJECT_MANAGER_PROTOCOL.md`](PROJECT_MANAGER_PROTOCOL.md) — roles, mandatory lifecycle, strict rules, 12-element assignment format (§4), mandatory 18-question Option and Metadata Impact Assessment (§4.1), independent-review checklist (§4.3), reporting standards (§5), quality/safety (§6).
> - [`ENGINEERING_STANDARDS.md`](ENGINEERING_STANDARDS.md) — canonical architecture/isolation, reliability, code quality, config/data, UI, testing, dependencies.
> - [`TESTING_AND_ACCEPTANCE.md`](TESTING_AND_ACCEPTANCE.md) — validation strategy, provider-state matrix, scenario coverage, reporting requirements (§8).
> - [`M6_PLAN.md`](M6_PLAN.md) — governing M6 plan; §3.1 C1–C21 matrix, §3.2 extensions, §3.3 modern-vs-legacy, §10 phases, §11 test allocation, §12 acceptance, §13 gates.
> - [`M6_B_PLAN.md`](M6_B_PLAN.md) — B4 scope (§7–§11), C13–C16/C18–C19 ownership.
> - [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md) — D (§§2, 5, 7, 8.1) and E (§§6–8.3) execution detail and phase gates.
> - [`MCP_INTERFACE.md`](MCP_INTERFACE.md) §8.1 — read-after-notify design.
> - [`M6_E_EVIDENCE.md`](M6_E_EVIDENCE.md), [`M6_D_FANOUT_EVIDENCE.md`](M6_D_FANOUT_EVIDENCE.md), [`M6_E_LAN_ACCEPTANCE.md`](M6_E_LAN_ACCEPTANCE.md) — existing evidence and the user-approved LAN scope decision.
> - [`REFERENCES.md`](REFERENCES.md) §8 — official MCP/SDK source URLs and access dates.
>
> **Permission boundary:** This document grants no permission. Every WP below needs a separate, explicit product-owner authorization. No commit, push, merge, rebase, amend, force-push, branch change or publication is authorized here. `main` is never touched. Implementation authorization (if later granted) does **not** itself authorize commit or push. A request to investigate/document is not permission to implement.

---

## 0. Read this first / current state / next actions (plain English)

**Read this first.** The user (product owner) is not an experienced programmer and needs plain-English explanations. ChatGPT is the independent technical lead/reviewer; OpenCode is the implementation executor; a separate fresh-context audit agent performs independent review. This plan is a map for that workflow — it does not start any work.

**The single most important distinction:** For M6-D and M6-E, the **code and tests already exist** on `develop`. That is **not** the same as those phases being accepted. Acceptance requires an independent review gate that has **never been completed** — every checkbox in `M6_D_E_PLAN.md` §8.1, §8.2 and §8.3 is still unchecked `[ ]`. Passing tests do not mark a phase complete. M6-B4 (conformance/parity closeout) **implementation is complete** — `tests/mcp/parity.test.ts` exists with meaningful real HTTP/STDIO parity tests and the named C3/C6/C18/C19/C21 assertions exist in `tests/mcp/conformance.test.ts` (source-level independent review verdict **KEEP**) — but B4 is **not formally accepted**; closeout is a separate product-owner gate. There is still no `docs/M6_B4_PLAN.md` (B4 closeout is recorded in `M6_B_PLAN.md` and `M6_E_EVIDENCE.md`).

**Current state (all independently verified against the local checkout unless labeled otherwise):**
- Branch `develop`, current HEAD `d19d721` (in sync with `origin/develop`). Historical baselines: corrections published at `9f99b9a`, prior published-plan baseline `72743cf`, original inspected implementation baseline `2ed4c1e`. `main`/`origin/main` at `865d86f`, untouched.
- Working tree has **three** pre-existing user-work items that must be preserved and never reverted: ` M docs/REFERENCES.md`, `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md`, `?? docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md`. `docs/CHATGPT_HANDOFF_CONTEXT.md` is **tracked** (added in `1ddf24b`, present at `72743cf` and still present at current HEAD `d19d721`) — it is preserved, but it is **not** an untracked user-work item.
- **Original pre-B4 baseline full suite: 1076 pass / 0 fail, 8833 `expect()` calls, 92 test files, exit 0.** Independently re-run by the audit agent at `2ed4c1e` (local — not CI). Do **not** inherit the older 1061/2 or 1073/1 figures. This figure is retained for historical comparison only; it is **not** a permanent pass-count requirement — adding tests is expected to grow the count. Re-run and record the actual result immediately before B4, then use each accepted WP's result as the next WP's baseline (§8.1).
- M6-A, B1, B2, B3 are implemented and published; M6-C is accepted and closed at `32b034a`. M6-D/E source and tests exist but are not accepted. M6-B4 implementation is complete with a source-level KEEP review but is **not formally accepted**. M6 is therefore **not complete**. Corrections were published in `9f99b9a` (historical) and this plan is not an approved implementation-ready plan.

**Next actions (recommended, not authorized):**
1. Obtain separate product-owner authorization for each WP. B4 is **scheduled** first for sequential work and separate conformance-evidence closure; D is independently owned and may proceed under its own §8.1 gate. E requires both B4 and D. Do not treat B4 as an architectural prerequisite for D (§3.1).
2. At implementation start, re-verify live `develop`/`main` SHAs, `git status`, and the official MCP spec/SDK versions (recorded target `2026-07-28` / SDK `2.4.0`; re-verify against official sources, do not assume).
3. Complete the 18-question Option and Metadata Impact Assessment for the WP before writing code (§4.7/§5.11/§6.9 are now fully answered; re-confirm answers against live source at implementation time).
4. Follow the per-WP sequence in §3; finish with an independent fresh-context review before any acceptance claim.
5. Do not start Stage G, M5 Phase 4B, M7, provider activation, or any publication. Do not touch `main`.

---

## 1. Verified current state

### 1.1 Branch, SHAs and working tree (independently verified)

| Item | Verified value |
|---|---|
| Branch | `develop` |
| Local HEAD / `origin/develop` | `d19d72120d8dd34a064f63fbe644dc67b61a15a7` (in sync) — **current HEAD**. Historical: corrections published at `9f99b9a830252335456ef8232a2032ea9b85d6ea`, prior published-plan baseline `72743cfe68e665dda018a3f4e098208f880a979f`. |
| Original inspected implementation baseline | `2ed4c1ef767462f8aa78be5cc29fd3e91006e5a0` — the checkout where implementation/test facts and 1076/0 were verified; historical, distinct from current HEAD |
| Local `main` / `origin/main` | `865d86f393a29bc1ec8d455a51d9efa82d722c48` (in sync; untouched) |
| `git status --short --branch` | `## develop...origin/develop`; ` M docs/REFERENCES.md`; `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md`; `?? docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md` (three preserved user-work items). `docs/CHATGPT_HANDOFF_CONTEXT.md` is **tracked** (added in `1ddf24b`). |
| Recent `git log -5` (at current HEAD) | `d19d721` (SSE wrapper scope note + T4 mapping), `9728397` (bounded slow-consumer SSE wrapper), `7926809` (M6-D audit findings), `c3b1753` (M6-D cancellation/honored-filter evidence), `a51ceb4` (M6-B4 conformance/parity evidence). Historical: `9f99b9a` (independent-review corrections), `72743cf` (canonical plan published). |

### 1.2 Baseline test result (original pre-B4 baseline; re-confirm at implementation start)

- Full suite at the **original inspected implementation baseline `2ed4c1e`**: **1076 pass / 0 fail**, 8833 `expect()` calls, 92 files, exit 0.
- Source: independently re-run by the audit agent at `2ed4c1e` (two consecutive runs), recorded in `docs/CHATGPT_HANDOFF_CONTEXT.md` §8.1. **Local result — not CI.** No GitHub status checks were reported for these commits.
- This figure supersedes the stale 1061/2 and 1073/1 figures in older handoff/status material. It is the **ORIGINAL pre-B4 baseline** retained for historical comparison, **not** a permanent exact pass-count requirement: adding tests is expected to increase the count. The live baseline procedure is in §8.1.

### 1.3 What exists vs what is missing, per WP

| WP | Exists (independently verified) | Missing / not done (independently verified) |
|---|---|---|
| **M6-B4** | `tests/mcp/conformance.test.ts` (named C-assertions incl. C3/C6/C18/C19/C21), `tests/mcp/parity.test.ts` (meaningful real HTTP/STDIO parity), `tools.test.ts`, `resources.test.ts`, `cache-hints.test.ts`, `feed-sync.test.ts`, `tools-adapters.test.ts`, `stdio-adapter.test.ts`, `operation-descriptors.test.ts`, `operation-routes.test.ts`; B1–B3 implementation and tests. **Note:** `security.test.ts (under tests/mcp/)` does **not** exist — the correct files are `tests/providers/security.test.ts`, `tests/mcp/activity.test.ts` and `tests/mcp/http-integration.test.ts` (§4.2). Source-level independent review verdict **KEEP**. | `docs/M6_B4_PLAN.md` does **not** exist (B4 closeout is recorded in `M6_B_PLAN.md`/`M6_E_EVIDENCE.md`). B4 owns the conformance/parity closeout evidence for C13–C16 and C18–C19 (implementation ownership per `M6_PLAN.md` §3.1); **no formal B4 closeout/acceptance record** — acceptance is a separate product-owner gate. The previously planned named assertions (C3 negative, C6 `serverInfo`, C18 no-extensions, C19 `tools/list` wire schema, C21 deprecated-method negatives) now exist in `tests/mcp/conformance.test.ts`. |
| **M6-D** | `apps/api/src/mcp-notification-bridge.ts` (one-listener bridge, stable URI `markethub://market/snapshot`, idempotent start/stop, contained errors); `tests/mcp/{subscriptions,notification-bridge,fanout}.test.ts`; evidence `docs/M6_D_FANOUT_EVIDENCE.md` (N=8/32/64, M=20, preserved p95 3.44–3.74 ms, max 3.65–4.51 ms, `maxSubscriptions=64`, 50 ms budget, slow-consumer queue 22 frames/4,126 bytes; unpreserved 7.91/10.28 ms run withdrawn). **Bounded SSE mitigation subsequently implemented and published** (`9728397`, scope note `d19d721`): `apps/api/src/mcp-sse-bound.ts` (`wrapMcpHandlerFetch`, production caps 16 KiB / 96 frames) with `tests/mcp/slow-consumer.test.ts` and evidence in `M6_D_FANOUT_EVIDENCE.md` §7. Commits `dfa6aad`, `40c7b70`, `a9d20ae`, `aee329d`, `8ac4417`, `f70025e` (all 2026-11-21). | `M6_D_E_PLAN.md` §8.1 checklist entirely unchecked `[ ]`. No independent review gate completed. No acceptance record. Phase not accepted. The named "D slow-consumer residual risk" decision remains **OPEN** pending the product-owner disposition (mitigation implemented ≠ decision closed). |
| **M6-E** | `tests/mcp/{http-integration,stdio-modern,legacy-compat,conformance,lan-simulation,http-smoke}.test.ts`; `docs/M6_E_EVIDENCE.md` (C1–C21 matrix, all rows evidenced or justified N/A — C6 is now evidenced: `subscriptionId` + `serverInfo` `_meta`; E1 real-listener graceful-shutdown and E2 real-listener bounded-SSE tests added to `http-integration.test.ts`); `docs/M6_E_LAN_ACCEPTANCE.md` (user-approved scope change). | `M6_D_E_PLAN.md` §8.2 and §8.3 checklists entirely unchecked `[ ]`. No independent review gate completed. No acceptance record. Phase not accepted. M6-E must not claim B4 acceptance. |

### 1.4 Preserved user work (must not be reverted or overwritten)

- ` M docs/REFERENCES.md` — pre-existing modification (user work; do not modify in this task).
- `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` — pre-existing untracked file (user work; do not modify in this task).
- `?? docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md` — pre-existing untracked file (user work; do not modify in this task).
- `docs/CHATGPT_HANDOFF_CONTEXT.md` — **tracked**, added in `1ddf24b` and present at `72743cf`, `9f99b9a` and current HEAD `d19d721`. It is **not** untracked and is **not** new user work in this task; it is preserved and must not be overwritten or deleted. Earlier snapshots that listed it as `??` describe the state before `1ddf24b` and are historical only.
- This plan was first published as one new file at `72743cf`; the four independent-review corrections were published at `9f99b9a`. **Historical:** that original documentation-only correction pass modified only the eight named docs and created no new plan file. Subsequent separately authorized work added source/tests (B4 closeout, slow-consumer mitigation, M6-E real-listener corrections); this reconciliation pass changes only the listed M6 docs and `tests/mcp/http-integration.test.ts`, and does not touch the three preserved user-work items.

### 1.5 Labeling convention used throughout this plan

- **Independently verified** — checked directly against the local checkout/`origin` during this planning task.
- **Agent-reported** — from an executor/auditor report, not independently re-checked here.
- **User-approved** — explicit product-owner decision (e.g. LAN scope change).
- **Recommended, not approved** — this plan's recommendation; requires authorization.
- **Unresolved** — open decision to settle at implementation time.

---

## 2. People / agent workflow and PM rules

The full rules are authoritative in [`PROJECT_MANAGER_PROTOCOL.md`](PROJECT_MANAGER_PROTOCOL.md); this section summarizes and links rather than restating them.

### 2.1 Roles (protocol §1; user-approved working model)

- **Product owner (user):** owns product requirements and major scope decisions; final authority on scope; approves changes requiring authorization. Not an experienced programmer — receive plain-English explanations, recommendations and reasoning, not forced technical decisions.
- **ChatGPT — technical lead / architect / independent reviewer:** owns independent technical research and architectural direction; studies official APIs/dependencies; reviews proposed designs; establishes precise scope; independently reviews actual diffs and evidence. Must not delegate all architectural decisions to OpenCode and must not trust an executor's completion report without inspecting source.
- **OpenCode — repository investigator / implementation executor:** inspects actual local code and repository state; implements approved instructions; runs tests and reports evidence; must not silently redesign architecture or expand scope.
- **Independent fresh-context audit agent:** performs independent code/diff review per WP. The configured reviewer in recent project work is **`opencode/iceman-free`** (user-approved per project memory / `CHATGPT_HANDOFF_CONTEXT.md` §2); the executor in those cycles was `opencode/hy4-flash-free`. Record the actual reviewer identity and diff range in each acceptance record (§10).

### 2.2 Working rhythm (user-approved)

Product owner authorizes one bounded WP → OpenCode implements → independent audit → fix findings with regression tests → re-audit until KEEP → product owner authorizes publication → push to `develop`. The user has repeatedly asked for this to run one subagent at a time with OpenCode managing and not writing code during audit cycles. **This plan authorizes none of it** — it only defines the sequence.

### 2.3 Branch and authorization rules (protocol §3, §3.1)

- Two permanent branches: `main` (stable) and `develop` (active). No PR workflow required.
- Never modify `main` without separate explicit authorization. All work is on `develop`; `main` stays at `865d86f`.
- Each WP needs its own authorization. Implementation authorization does not authorize commit/push/merge/publication. Investigation/documentation is not implementation permission.
- No destructive Git operations (force-push, history rewrite, branch/file deletion) without explicit permission.
- Preserve unrelated modifications and untracked files; inspect `git status` before and after every task.

### 2.4 Mandatory 12-element assignment format (protocol §4)

Every implementation assignment (each WP below) must specify: (1) objective; (2) verified current state; (3) exact scope; (4) architectural direction; (5) files/components allowed to change; (6) protected areas; (7) non-goals; (8) acceptance criteria; (9) required tests; (10) verification instructions; (11) expected report format; (12) completed Option and Metadata Impact Assessment. An assignment without a completed assessment is incomplete. **All 12 elements are now mapped per WP in §3.4 and all 18-question assessments are answered in §4.7/§5.11/§6.9**; these are planning answers, not implementation evidence. They become implementation assignments only when separately authorized and re-confirmed against live source.

### 2.5 Mandatory 18-question Option and Metadata Impact Assessment (protocol §4.1)

Every WP must answer all 18 questions before implementation is authorized (source-of-truth ownership, shared contracts, provider/runtime registration, MCP/REST/WebUI consumers, domain-data discovery, config persistence, forward compatibility, dependency direction). **All 18 answers are now completed in §4.7 (B4), §5.11 (D) and §6.9 (E)** — every row is answered; re-confirm them against live source at implementation start. No backend-owned option may be introduced as a separately maintained frontend constant (AD-025 / `METADATA_AND_CAPABILITY_DISCOVERY.md`).

### 2.6 Evidence labeling (protocol §5, §6; `CHATGPT_HANDOFF_CONTEXT.md` §10)

Distinguish **implemented**, **placeholder/scaffold**, **planned**, **proposed**. Label evidence as **implemented**, **agent-reported (local)**, **independently verified (local)**, or **CI**. **Never call local tests CI.** Never claim a test/audit is complete without evidence. Review against the failure matrix, not just the happy path. Prefer one thorough pre-publication review over repeated post-publication corrections; when a correction is needed, add a regression test that would have caught it. Keep solutions simple, durable and non-enterprise.

---

## 3. Execution order and gates

### 3.1 Scheduling order and technical dependencies (distinct)

```
SCHEDULING (sequential work):   M6-B4  ──▶  M6-D  ──▶  M6-E
TECHNICAL GATES:                B4 closeout gate   (independent owner)
                                D §8.1 gate        (independent owner; NOT dependent on B4)
                                E §8.2 gate        (requires B4 closeout AND D §8.1)
                                combined §8.3 gate (D+E; mandatory) ──▶ M6 ACCEPTED/CLOSED
```

- **B4 is scheduled first**, for sequential work and to close its conformance/parity evidence separately. Its rows must not be silently absorbed into D or E; B4 rows remain B4-owned until B4's own closeout is accepted (`M6_D_E_PLAN.md` §2.1.3, §6.5). **This is a scheduling choice, not an architectural prerequisite.** Neither `M6_D_E_PLAN.md` nor `M6_PLAN.md` establishes that D depends on B4; do not describe B4 as D's technical prerequisite.
- **D is independently owned.** D's only technical gate is its own §8.1 (`M6_D_E_PLAN.md` §2.1.5). D does not inherit B4 ownership, and B4 acceptance is not an entry condition for D.
- **E requires both B4 and D.** E final acceptance only after B4 closeout and D §8.1 pass. E assembles the C1–C21 evidence matrix but does **not** claim B4 acceptance or transfer B4 ownership to E.
- **Combined gate (§8.3)** is mandatory and must pass before either D or E is declared complete. M6 may be declared complete only when B4, D and E are all accepted (`M6_D_E_PLAN.md` §8.3 final line).

### 3.2 Per-WP sequence (repeat for each of B4, D, E)

1. **18-question assessment** — re-confirm and record the already-completed Option and Metadata Impact Assessment (§4.7/§5.11/§6.9) against live source in the assignment/report.
2. **State what exists** — re-verify branch/SHAs/status, baseline tests, and the exact existing files/evidence for this WP; do not re-implement what already works.
3. **Smallest changes** — make only the minimal additions/corrections needed to close the WP's gate; prefer reusing existing named assertions and files over creating new ones.
4. **Focused tests** — run the WP's focused suites first; they must be deterministic and leak no child processes or SSE streams before the full suite runs.
5. **Independent review** — fresh-context reviewer (`opencode/iceman-free`) reviews the actual diff and evidence against the failure matrix.
6. **Fix findings with regression tests** — every finding gets a fix plus a regression test that would have caught it; record the fix-forward.
7. **Clean re-review** — re-review until KEEP with no findings.
8. **Acceptance record** — only then record acceptance in the governing docs (§9), with commits, files, KEEP result, test outcomes, C1–C21 ownership, limitations, and locked gates.

### 3.3 Fix-forward blockers

If independent review finds a defect in an **already-accepted** package (e.g. M6-A/B/C), record it as a **fix-forward blocker** with its own regression test and separate authorization. Do **not** silently reopen or re-accept the accepted package. Note the defect, its owner package, the evidence, and the disposition in the acceptance record.

### 3.4 12-element assignment maps (one per WP)

Protocol §4 requires all 12 elements in every implementation assignment. These are **planning maps**; they become assignments only after separate product-owner authorization. Allowed-file lists are deliberately narrow; everything else is protected. "Existing only where a real defect requires it" means a fix-forward with regression test and separate authorization (§3.3), never a repository-wide edit permission.

**B4 — conformance/parity closeout**

| # | Element | B4 planning answer |
|---|---|---|
| 1 | Objective | Close C13–C16/C18–C19 with named assertions + real HTTP/STDIO parity; no new user-facing capability. |
| 2 | Verified current state | Current HEAD `d19d721`; historical baselines `9f99b9a` (corrections), `72743cf` (plan), `2ed4c1e` (original implementation); named C-assertions incl. C3/C6/C18/C19/C21 in `conformance.test.ts`; `parity.test.ts` exists with meaningful real HTTP/STDIO tests; no `security.test.ts (under tests/mcp/)`. |
| 3 | Exact scope | Named negative/gap assertions (C3/C6/C18/C19/C20/C21), snapshot pagination (C14), parity test; no new tools/resources. |
| 4 | Architectural direction | Reuse existing named assertions and shared registration; SDK-owned protocol; no source redesign. |
| 5 | Allowed files | New `tests/mcp/parity.test.ts` (the required B4 closeout artifact); existing B4-owned conformance/parity evidence files `tests/mcp/conformance.test.ts`, `docs/M6_E_EVIDENCE.md`, `docs/M6_B_PLAN.md`, `docs/M6_B4_D_E_COMPLETION_PLAN.md` **only where a named assertion is missing**. All other existing tests — including M6-A/B1/B2/B3 tests (`tools`, `resources`, `cache-hints`, `feed-sync`, `tools-adapters`, `stdio-adapter`, `operation-descriptors`, `operation-routes`, `snapshot-page*`, `activity`, `http-integration`, `legacy-compat`, `stdio-modern`, `lan-simulation`, `http-smoke`) — and M6-D-owned tests (`subscriptions.test.ts`, `notification-bridge.test.ts`, `fanout.test.ts`) are **reused as evidence only**; any change to them requires a separately documented fix-forward with its own authorization (§3.3), not B4 scope. `subscriptions.test.ts` is **not** a B4 allowed file. |
| 6 | Protected files | All application source (`apps/**`, `packages/**`), manifests/lockfiles, DB, `main`, Stage G/M5 Phase 4B/M7, `docs/REFERENCES.md`, `docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md`, `docs/CHATGPT_HANDOFF_CONTEXT.md`; **protected from modification by B4:** all existing tests from previously accepted phases (M6-A/B1/B2/B3 — `tests/mcp/{tools,resources,cache-hints,feed-sync,tools-adapters,stdio-adapter,operation-descriptors,operation-routes,snapshot-page,snapshot-page-routes,activity,http-integration,legacy-compat,stdio-modern,lan-simulation,http-smoke}.test.ts`) and M6-D-owned tests (`tests/mcp/{subscriptions,notification-bridge,fanout}.test.ts`). These are evidence-only for B4; changes require a separately authorized fix-forward (§3.3). |
| 7 | Non-goals | No new capability, no provider activation, no commit/push, no D/E acceptance claim. |
| 8 | Acceptance criteria | §4.6: every row named-asserted, parity passes, focused + full + typecheck + build + diff-check, independent KEEP. |
| 9 | Required tests | §4.4 focused command incl. `parity.test.ts`; full suite vs immediately preceding accepted baseline (§8.1). |
| 10 | Verification instructions | §8: exact commands/exit codes/counts, failure names, isolation, local-vs-CI labels, baseline comparison. |
| 11 | Report format | §12 10-item report; C1–C21 ownership table; no commit/push confirmation. |
| 12 | 18-question assessment | §4.7 — fully answered; re-confirm against live source at implementation time. |

**D — notification bridge and event delivery**

| # | Element | D planning answer |
|---|---|---|
| 1 | Objective | Accept the existing one-process bridge + `subscriptions/listen` delivery with read-after-notify, correct capability advertisement, bounded fan-out, race-safe recovery, ordered shutdown. |
| 2 | Verified current state | Source/tests exist (`mcp-notification-bridge.ts`, `subscriptions/notification-bridge/fanout.test.ts`); §8.1 all `[ ]`; not accepted. |
| 3 | Exact scope | Close §8.1; correct only a real defect in the bridge, API composition/capability wiring, D-specific tests and fan-out evidence. |
| 4 | Architectural direction | One canonical source (`MarketDataService.subscribe()`), one process-wide bridge, SDK-owned listen/IDs/SSE, stable URI `markethub://market/snapshot`, feed catch-up via `markethub://events/live`. |
| 5 | Allowed files | `apps/api/src/mcp-notification-bridge.ts`, `apps/api/src/index.ts`/`app.ts` (composition/capability wiring) **only if a real defect requires it**; `tests/mcp/{subscriptions,notification-bridge,fanout}.test.ts`; `docs/M6_D_FANOUT_EVIDENCE.md`, `docs/M6_D_E_PLAN.md`, `docs/M6_B4_D_E_COMPLETION_PLAN.md`. |
| 6 | Protected files | `packages/mcp-core/src/factory.ts` and other shared source except a documented fix-forward; all other `apps/**`/`packages/**`; manifests/lockfiles/DB; `main`; Stage G/M5 Phase 4B/M7; the three preserved docs in §1.4. |
| 7 | Non-goals | No second event system, no custom SSE/protocol, no API SSE relay for STDIO, no provider activation, no commit/push. |
| 8 | Acceptance criteria | §5.10 / `M6_D_E_PLAN.md` §8.1 all checked after independent KEEP. |
| 9 | Required tests | Focused D suites; full suite vs B4's accepted baseline (§8.1). |
| 10 | Verification instructions | §8; wire-visible shapes, race/recovery, fan-out arithmetic (§5.7, `M6_D_FANOUT_EVIDENCE.md`). |
| 11 | Report format | §12 10-item report; C17 ownership; limitations (stream-count bound only, no STDIO live delivery). |
| 12 | 18-question assessment | §5.11 — fully answered; re-confirm against live source at implementation time. |

**E — end-to-end conformance and transport acceptance**

| # | Element | E planning answer |
|---|---|---|
| 1 | Objective | Final acceptance: real HTTP listener + pinned client, STDIO spawned process, legacy posture, LAN simulation, C1–C21 assembly. Final acceptance, **not** a new feature. |
| 2 | Verified current state | E tests/evidence exist; §8.2/§8.3 all `[ ]`; not accepted; B4/D not yet accepted. |
| 3 | Exact scope | Real HTTP integration, STDIO (incl. re-listen after reconnect), legacy compat, LAN simulation, conformance evidence, acceptance docs. |
| 4 | Architectural direction | Reuse M6-A/B/C/D; no duplicate market logic; thin local-API STDIO; no API SSE relay; physical LAN out of scope. |
| 5 | Allowed files | `tests/mcp/{http-integration,stdio-modern,legacy-compat,conformance,lan-simulation,http-smoke}.test.ts`; `docs/M6_E_EVIDENCE.md`, `docs/M6_E_LAN_ACCEPTANCE.md`, `docs/M6_D_E_PLAN.md`, `docs/M6_PLAN.md`, `docs/PROJECT_STATUS.md`, `docs/IMPLEMENTATION_ROADMAP.md`, `docs/M6_B4_D_E_COMPLETION_PLAN.md`. Application source changes **only** via documented fix-forward + separate authorization. |
| 6 | Protected files | All `apps/**`/`packages/**` source except an authorized fix-forward; manifests/lockfiles/DB; `main`; Stage G/M5 Phase 4B/M7; the three preserved docs in §1.4. |
| 7 | Non-goals | No new capability, no B4 ownership transfer, no physical LAN claim, no commit/push. |
| 8 | Acceptance criteria | §6.8 §8.2 + combined §8.3 after independent KEEP. |
| 9 | Required tests | §6.3 16-item real-listener list; §6.4 STDIO incl. re-listen; §6.5 legacy; §6.6 simulation; full suite vs D's accepted baseline (§8.1). |
| 10 | Verification instructions | §8; real listener never replaced by `handler.fetch`; official spec/SDK re-verified (§6.2). |
| 11 | Report format | §12 10-item report; C1–C21 ownership/gap map; one unambiguous result (§12.2). |
| 12 | 18-question assessment | §6.9 — fully answered; re-confirm against live source at implementation time. |

---

## 4. M6-B4 work package — conformance and parity closeout

### 4.1 Objective

Close the M6-B4 conformance/parity sub-phase: prove C13–C16 and C18–C19 with named assertions and a parity check, using the smallest possible changes. B4 is the first gate in the sequence and owns the **closeout evidence** for these rows until its closeout is accepted; implementation ownership remains with `M6_PLAN.md` §3.1 (C13/C14/C16/C19 = B; C15/C18 = A/B).

### 4.2 Verified current state

- **Historical:** `docs/M6_B_PLAN.md` line 3 previously said "M6-B4 implementation not started." It now records B4 implementation complete with a source-level KEEP review, not formally accepted. §7 defines B4 as "Parity + conformance tests (C13–C16, C18–C19)" with exit condition "`parity.test.ts` passes; no extensions advertised; no MRTR/server-initiated requests."
- `tests/mcp/parity.test.ts` **exists** with meaningful real HTTP/STDIO parity tests (identical capability inventory, `catalog_search`/`events/live` over both transports, explicit-unavailable capabilities); `docs/M6_B4_PLAN.md` does **not** exist (B4 closeout is recorded in `M6_B_PLAN.md`/`M6_E_EVIDENCE.md`).
- Existing reusable named assertions: `tests/mcp/conformance.test.ts` had 9 named tests at the planning baseline (C2, C4, C3/C10, C3 version, C9, C3 invalid params, C11 SSE headers, C11 Last-Event-ID, C5 no server-initiated requests) and now also includes the C3/C6/C18/C19/C21 closeout assertions; `tools.test.ts`, `resources.test.ts`, `cache-hints.test.ts`, `feed-sync.test.ts`, `tools-adapters.test.ts`, `stdio-adapter.test.ts`, `operation-descriptors.test.ts`, `operation-routes.test.ts` already cover much of C13–C16/C18–C19. **Corrected paths:** `security.test.ts (under tests/mcp/)` does **not** exist. The real files are `tests/providers/security.test.ts` (provider management/status secret exposure), `tests/mcp/activity.test.ts` (MCP activity error/summarization redaction) and `tests/mcp/http-integration.test.ts` (actual Host/Origin and HTTP security). None of these proves JSON Schema 2020-12; that needs a `tools/list` wire assertion (§4.3 C19).
- `docs/M6_E_EVIDENCE.md` maps C13 (tools/resources/prompts), C14 (pagination), C15 (cache hints), C16 (MRTR N/A), C18 (no extensions), C19 (JSON Schema 2020-12, no remote `$ref`) to existing tests. **Ownership nuance:** `M6_PLAN.md` §3.1 is authoritative for implementation ownership — C13, C14, C16 and C19 are owned by M6-B; C15 and C18 are owned by M6-A/B. M6-B4 owns only the **conformance/parity closeout evidence** for C13–C16 and C18–C19 as the B4 sub-phase (per `M6_B_PLAN.md` §7); it does not transfer A/B implementation ownership or create a second owner of the same acceptance decision.

### 4.3 Exact scope (C13–C16, C18–C19)

- **C13** — standard operations (`tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`); deterministic `tools/list` order SHOULD.
- **C14** — opaque `nextCursor`, stable cursors, invalid cursor → `-32602`; bounded keyset cursors for catalog/feed/activity **and snapshot pagination (M6-B3)**. Map each cursor to its real test/service interface: catalog → `tools.test.ts` / `CatalogRepository.searchInstruments`; feed → `feed-sync.test.ts` / `LiveEventHub.readAfter`; snapshot → `tests/mcp/snapshot-page.test.ts` and `tests/mcp/snapshot-page-routes.test.ts` / `OptionChainSnapshotService.listSnapshotsPage` (versioned opaque cursor, stable progression, malformed/wrong-version cursor rejected, bounded page size, final page `nextCursor: null`); activity → `tests/mcp/activity.test.ts` / activity repository. Clients treat every cursor as opaque; no client decodes it.
- **C15** — cache hints `ttlMs`/`cacheScope` MUST on `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`; same scope across pages; MRTR retries not cached.
- **C16** — MRTR `input_required` not used in M6; assert no server-initiated requests; document N/A; never use deprecated push pattern.
- **C18** — capability negotiation/extensions: advertise none; never claim unsupported extensions.
- **C19** — JSON Schema 2020-12 default; no auto-dereference of network `$ref`; bounded composition keywords.
- **Parity** — HTTP direct services and STDIO local-API client reach the same capabilities with identical response semantics where the local API exposes them; capabilities reported `unavailable` over STDIO are asserted as such, not silently omitted (`M6_PLAN.md` §4.1.3, §11a `parity.test.ts`).

**Named assertions for conformance gaps (cross-owner; `M6_PLAN.md` §3.1 is authoritative for ownership).** **Historical:** these were planned gaps when this plan was published; the named assertions below now exist in `tests/mcp/conformance.test.ts` (B4 closeout, source-level review KEEP). Passing assertions are evidence, not acceptance — B4 closeout remains a separate product-owner gate:

| Row | Owner | Planned named assertion (target file) | Current honest status |
|---|---|---|---|
| C3 | M6-A/B | Wire-level negative **scoped to modern 2026-07-28 requests**: for a request carrying `_meta['io.modelcontextprotocol/protocolVersion'] = '2026-07-28'`, the server MUST NOT emit `-32002` or `-32042` (per the official 2026-07-28 spec, which reserves these codes but forbids implementations of this version from emitting them). Legacy **handshake** coverage is in `tests/mcp/legacy-compat.test.ts`; it does **not** test an older client accepting a `-32002` response, and that compatibility is **not** prohibited by this assertion; do not conflate the two (`tests/mcp/conformance.test.ts`). | **Present** — "C3: modern 2026-07-28 requests never emit -32002 or -32042" in `tests/mcp/conformance.test.ts` (B4 closeout). |
| C6 | M6-A/D | Wire-level verification of `io.modelcontextprotocol/serverInfo` in result `_meta` (prefer official SDK wire behavior; `tests/mcp/conformance.test.ts`). If the wire assertion belongs in M6-D's `subscriptions.test.ts`, that is M6-D-owned and requires separate authorization (§3.3/§3.4), not a B4 edit. The mandatory `subscriptionId` requirement stays a **separate** assertion. If the SHOULD cannot be satisfied, record a reasoned deviation with owner. | **Present** — "C6: modern results carry io.modelcontextprotocol/serverInfo in _meta (wire)" in `tests/mcp/conformance.test.ts`; `subscriptionId` remains a separate M6-D assertion. |
| C18 | M6-A/B | Modern `server/discover` result advertises **no** unsupported extension map (`tests/mcp/conformance.test.ts`). | **Present** — "C18: modern server/discover advertises no unsupported extension map" in `tests/mcp/conformance.test.ts`. |
| C19 | M6-B | Actual `tools/list` wire output uses JSON Schema 2020-12 and contains no auto-dereferenced network `$ref` (`tests/mcp/tools.test.ts`, or the smallest correct new MCP test). Provider credential tests do **not** prove this. | **Present** — "C19: tools/list wire output uses JSON Schema 2020-12 with no network $ref" in `tests/mcp/conformance.test.ts`; `security.test.ts (under tests/mcp/)` still does not exist. |
| C20 | M6-A/B/D | Split by responsibility: `tests/providers/security.test.ts` = provider management/status secret exposure; `tests/mcp/activity.test.ts` = MCP activity error/summarization redaction; `tests/mcp/http-integration.test.ts` = actual Host/Origin and HTTP security. Verify each against the exact C20 part it proves. | Evidenced in three parts; wrong path removed. |
| C21 | M6-A/B/D | Explicit negatives: `ping`, `logging/setLevel`, `resources/subscribe` rejected with method-not-found on the modern protocol; deprecated capabilities/surfaces not advertised; legacy HTTP+SSE not implemented; no SSE `Last-Event-ID` replay (reuse `tests/mcp/http-integration.test.ts` / `conformance.test.ts`). Do **not** confuse retained 2025-era Streamable HTTP/STDIO compatibility with deprecated legacy HTTP+SSE. | **Present** — "C21: deprecated methods are rejected and deprecated surfaces are not advertised on modern protocol" in `tests/mcp/conformance.test.ts`; `legacy-compat.test.ts` alone ("modern client uses discover") does not prove absence. |
- **Preserve honest-unavailable capabilities:** retain `futures_chain` and `market_information` as discoverable tools returning an explicit `unavailable` result, and retain `markethub://events/alerts` as discoverable-but-unavailable (M7 dependency). Do not fabricate data or remove these capabilities.
- **Do not add new tools/resources to pad the conformance matrix.** B4 is a verification/closeout sub-phase; any new capability requires its own authorized assignment.

### 4.4 Required tests (reuse existing assertions; create the B4 closeout artifact)

- **Prefer reusing existing named assertions.** Map each of C13–C16/C18–C19 to an existing named test in `conformance.test.ts`, `tools.test.ts`, `resources.test.ts`, `cache-hints.test.ts`, `feed-sync.test.ts`, `tools-adapters.test.ts`, `stdio-adapter.test.ts`, `operation-descriptors.test.ts`, `operation-routes.test.ts`, plus `snapshot-page.test.ts`/`snapshot-page-routes.test.ts` for C14 snapshot pagination. Do not duplicate a test merely to match a filename. `security.test.ts (under tests/mcp/)` does **not** exist; use the three correct files listed in §4.2/§4.3. **Ownership boundary:** every one of these existing tests (M6-A/B1/B2/B3) and the M6-D-owned `subscriptions.test.ts`/`notification-bridge.test.ts`/`fanout.test.ts` is **reused as evidence only** — B4 must not modify them. A genuine defect in one requires a separately documented fix-forward with its own authorization (§3.3), not a B4 edit. Only `tests/mcp/conformance.test.ts` and the three named B4 evidence docs may be edited by B4, and only to add a missing named assertion.
- **Create `tests/mcp/parity.test.ts` as the required B4 closeout artifact — it must be a meaningful test, not an empty filename-satisfying wrapper.** `M6_B_PLAN.md` §7 sets the literal B4 exit condition "`parity.test.ts` passes"; the file **now exists** with meaningful real HTTP/STDIO parity tests (identical capability inventory, `catalog_search`/`events/live` over both transports, explicit-unavailable capabilities). It **exercises the actual HTTP and STDIO adapters** (real `createMcpHandler` HTTP path and a spawned/STDIO local-API client, reusing genuine helpers such as those in `http-integration.test.ts`, `stdio-adapter.test.ts` and `stdio-modern.test.ts`) and assert equivalent capability/result behavior **wherever the local API exposes the capability**. It must assert: `catalog_search` and `events/live` are available over both (B decision 1); `futures_chain`, `market_information` and `markethub://events/alerts` are discoverable and return explicit `unavailable`; a capability in state (b) is tested as `unavailable`, **not** treated as parity by silent omission. It may import/delegate to existing named assertions to avoid duplicate logic, but a file that merely imports a test and asserts nothing is not acceptable.
- The named assertions from the §4.3 gap table (C3 negative, C6 `serverInfo` `_meta`, C18 no-extensions, C19 `tools/list` wire schema, C20 split paths, C21 deprecated-method negatives) **now exist** in `tests/mcp/conformance.test.ts` (B4 closeout, source-level review KEEP). Passing assertions are evidence, not B4 acceptance.
- Focused command: `bun test tests/mcp/conformance.test.ts tests/mcp/tools.test.ts tests/mcp/resources.test.ts tests/mcp/cache-hints.test.ts tests/mcp/feed-sync.test.ts tests/mcp/snapshot-page.test.ts tests/mcp/snapshot-page-routes.test.ts tests/mcp/parity.test.ts` (the `parity.test.ts` file is required, not optional; no nonexistent `security.test.ts (under tests/mcp/)`).

### 4.5 Ownership boundary

- Do **not** redesign M6-A (transport/lifecycle), B1 (catalog/event-feed seams), B2 (tools) or B3 (resources/prompts/cache hints/pagination). B4 is a verification/closeout package, not a re-implementation.
- Do **not** modify application source unless a concrete defect is found; if one is found, use the fix-forward path (§3.3) with a regression test and separate authorization.
- Do **not** claim M6-D or M6-E acceptance; do not touch their tests or evidence.

### 4.6 Exit gate

- Every C13–C16/C18–C19 row has a named assertion (existing or new) and is recorded in a B4 closeout record. Implementation ownership stays with `M6_PLAN.md` §3.1 (C13/C14/C16/C19 = B; C15/C18 = A/B); B4 owns only the closeout evidence.
- `tests/mcp/parity.test.ts` exists and passes (the literal `M6_B_PLAN.md` §7 exit condition; it may wrap/reuse existing named assertions); no capability silently dropped; no extensions advertised; no MRTR/server-initiated requests. **Source-level status: satisfied (KEEP review); formal B4 closeout/acceptance remains a separate product-owner gate.**
- Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; full suite shows no new failures vs the **immediately preceding accepted baseline** (the freshly re-run pre-B4 result per §8.1; 1076/0 at `2ed4c1e` is retained only as the original historical baseline). Expected pass-count growth from new tests is not a failure; unexplained failures are investigated, not silently adopted.
- Independent review KEEP with no findings; acceptance recorded in `docs/M6_B_PLAN.md` (and referenced from `M6_PLAN.md`/`PROJECT_STATUS.md` per §9).
- No provider activation, Stage G, M7, new dependency, migration or protocol redesign.

### 4.7 Option and Metadata Impact Assessment — 18 questions (answered)

> All 18 answers are completed from source/evidence inspection at the published planning baseline. They are **planning answers**, not implementation evidence; re-confirm against live source at implementation start (protocol §4.1). B4 is test/acceptance work and adds **no new user-facing capability**; "N/A" below is justified by that scope, not a blank.

| # | Question (protocol §4.1) | Answer |
|---|---|---|
| 1 | New selectable options, capabilities, entities or config fields? | **None.** B4 adds named assertions and `parity.test.ts` only; no new user-facing capability, selector or config field. N/A for new options — justified by verification-only scope. |
| 2 | Who owns their source of truth (exact module/contract/registry)? | Unchanged. MCP capability registration: `packages/mcp-core/src/factory.ts` + `tools.ts`/`resources.ts`/`prompts.ts`; requirement matrix: `docs/M6_PLAN.md` §3.1; evidence: `docs/M6_E_EVIDENCE.md` and `tests/mcp/*`. B4 owns no new registry. |
| 3 | Shared contract enums, backend capabilities, domain data or user-managed values? | **None added.** B4 only asserts existing enums/capabilities/domain data. N/A — verification only. |
| 4 | How does each consumer (WebUI, MCP, REST/SSE, adapters) obtain them? | Unchanged: WebUI via existing REST/discovery endpoints; MCP via `server/discover` + `tools/list`/`resources/list`/`prompts/list`; REST/SSE via existing routes; STDIO via the thin local-API adapters. B4 adds no new consumer path. |
| 5 | Does an existing API/schema/registry/repository already provide the information? | **Yes.** `M6_PLAN.md` §3.1, `M6_E_EVIDENCE.md`, existing tests and shared registration already provide everything B4 asserts. No new source needed. |
| 6 | Is a new discovery/read API necessary, or is a direct shared-package import sufficient? | **Direct shared-package import / existing test helpers are sufficient.** No new discovery or read API. |
| 7 | How does the UI update when new values are registered, without a frontend-list edit? | **No UI change.** B4 registers no value the UI could display. N/A — no frontend-list edit. |
| 8 | Cache invalidation / refresh behavior needed? | **None introduced.** Existing cache hints (`ttlMs: 0`, `cacheScope: "private"` on six operations) are asserted, not changed; no new invalidation path. |
| 9 | Any metadata fields sensitive or unsafe to expose? | **None added.** Negative assertions only; no credentials, tokens, provider-native identifiers or secrets in tests/docs/`_meta`. N/A — nothing new exposed. |
| 10 | Tests proving frontend/backend consistency and no duplicate definition? | `tests/mcp/parity.test.ts` (real HTTP + STDIO adapters) plus reused named assertions prove transport consistency; no duplicate definition because assertions are reused, not copied, and no frontend constant is added. |
| 11 | Shared contract impact — existing enum/schema changed; all consumers updated? | **None.** No enum/schema changed; all consumers unchanged. N/A — verification only. |
| 12 | Provider/runtime registration impact — fixed `UPSTOX`/`FYERS` contract preserved? | **Preserved.** No provider identity or registration change; fixed `UPSTOX`/`FYERS` contract untouched. |
| 13 | MCP tool/resource/prompt impact — descriptor derived from same registration source? | **No new operation.** Descriptors remain derived from the same `packages/mcp-core` registration source; parity asserts the existing inventory only. |
| 14 | REST/SSE/WebUI consumer impact — which consumers read it, any hardcoding today? | **None.** No consumer reads a new value; no hardcoding introduced or removed. N/A — verification only. |
| 15 | Domain-data discovery impact — bounded/paginated domain API if large/changing? | **No new domain API.** Existing bounded/paginated catalog, feed, snapshot and activity interfaces are asserted (C14), not changed. |
| 16 | Configuration persistence impact — can MCP on-demand ops avoid silently changing config? | **No config change.** MCP on-demand operations remain side-effect-free; B4 adds no config write. |
| 17 | Forward compatibility — new value appears without a frontend/second backend list edit? | **No new value introduced.** N/A — no frontend or second backend list edit; verification only. |
| 18 | Dependency direction — circular import introduced? | **No new dependency, no circular import.** Tests import existing helpers only; dependency direction unchanged. |

---

## 5. M6-D work package — notification bridge and event delivery

### 5.1 Objective

Complete and accept the M6-D notification bridge: connect canonical `MarketDataService` live-state changes to MCP `subscriptions/listen` notifications over the existing Streamable HTTP `/mcp` endpoint, with read-after-notify, correct capability advertisement, bounded fan-out, race-safe recovery and correct shutdown — without a second event system.

### 5.2 Verified current state

- Source exists: `apps/api/src/mcp-notification-bridge.ts` — one process-lifetime bridge; `MARKET_SNAPSHOT_URI = "markethub://market/snapshot"`; `start()` subscribes once to `service.subscribe()`; `stop()` idempotent unsubscribe; every `LiveChangeEvent` maps to one `notifier.resourceUpdated(uri)`; publisher errors contained via best-effort `onError`.
- Tests exist: `tests/mcp/subscriptions.test.ts`, `tests/mcp/notification-bridge.test.ts`, `tests/mcp/fanout.test.ts`.
- Evidence exists: `docs/M6_D_FANOUT_EVIDENCE.md` — N ∈ {8,32,64}, M=20, preserved p95 3.44–3.74 ms, max 3.65–4.51 ms, `maxSubscriptions=64`, 50 ms budget, slow-consumer queue 22 frames / 4,126 bytes, no per-stream bound claimed by the SDK; a separately authorized application-owned bounded SSE wrapper was subsequently added (`apps/api/src/mcp-sse-bound.ts`, evidence in §7 of that file); unpreserved 7.91/10.28 ms run withdrawn.
- Commits: `dfa6aad`, `40c7b70`, `a9d20ae`, `aee329d`, `8ac4417`, `f70025e` (all 2026-11-21).
- **Not accepted:** `M6_D_E_PLAN.md` §8.1 checklist all `[ ]`; no independent review gate; no acceptance record.

### 5.3 Exact scope (C17)

- **C17** — `subscriptions/listen`: filter (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`); MUST NOT send unrequested types; ack MUST be first message with `subscriptionId`; all notifications carry `subscriptionId`; multiple concurrent subscriptions isolated; graceful close sends completion result. No `resources/subscribe` on modern connections.

### 5.4 Architecture requirements (normative)

- **Single canonical source:** `MarketDataService.subscribe()` is the only change source. `LiveEventHub` remains the bounded feed/replay source for REST/SSE and the `events/live` resource — **not** a second MCP notification source.
- **One process-wide bridge:** created once in `apps/api` composition, never inside `createMcpServer()` or per HTTP request/subscription stream. `start()` subscribes exactly once; `stop()` idempotent.
- **SDK notification:** publish only `handler.notify.resourceUpdated("markethub://market/snapshot")` — one stable URI, no market payload, no credentials, no provider-native identifiers, no custom notification methods.
- **Stable URI:** `markethub://market/snapshot` is the topic; `markethub://events/live?after=<cursor>&limit=100` is the catch-up mechanism (bootstrap `after=first`). Do not publish cursor-specific template URLs as fixed resources.
- **No second event system:** no new bus, queue, worker, table, broker, Redis, custom SSE, custom resumability or hand-written subscription-ID handling. `InMemoryServerEventBus` (SDK-owned) is sufficient for this single-process monolith.
- **Capability advertisement (§5.3 of D plan):** initialize `tools.listChanged: false`, `resources.listChanged: false`, `prompts.listChanged: false` explicitly in the `McpServer` constructor **before** `register*` (SDK defaults them to `true` when absent). Set `resources.subscribe: true` **only** for modern HTTP (`ctx.era === "modern" && ctx.requestInfo !== undefined`); false for legacy HTTP and all STDIO. `server/discover` and listen-ack assertions only on modern connections; `initialize`/legacy assertions on legacy connections.

### 5.5 Protocol behavior checklist

- Ack (`notifications/subscriptions/acknowledged`) is the first message; carries `io.modelcontextprotocol/subscriptionId` in `_meta` and the honored subset; no notification before it.
- Every notification carries the subscription ID; multiple concurrent subscriptions demultiplex by listen request ID; closing one does not suppress another.
- Exact filter semantics: only requested notification types; `resourceSubscriptions` honored only for the exact snapshot URI on modern HTTP; all `listChanged` bits refused everywhere.
- Cancellation: HTTP closes the request SSE stream; stdio uses `notifications/cancelled`; server sends `notifications/cancelled` only to tear down a listen stream.
- Graceful close: `handler.close()` calls `listenRouter.closeAll()` → successful `subscriptions/listen` completion result (`closed === 'graceful'`); in-flight requests are aborted, **not** promised to complete successfully.
- No `resources/subscribe` on modern; no deprecated methods for new functionality.

### 5.6 Read-after-notify / recovery checklist (§5.2 of D plan)

- **Wire interface:** all catch-up/bootstrap/pagination/recovery assertions use `resources/read` on `markethub://events/live?after=<cursor>&limit=100` (bootstrap `after=first`). The MCP result is a `ReadResourceResult`: assert `contents[0].mimeType === "application/json"`, then `JSON.parse(contents[0].text)`; shapes are `{ events, nextCursor, resumeCursor }` (page) or `{ events: [], nextCursor: null, snapshotRequired: { reason } }` (recovery). **No `outcome` property; no internal `readAfter()` shape.**
- **Two separate state values:** `snapshotRevision` (`R`) = revision of currently adopted snapshot, for dedup only, updated on every snapshot adoption; `lastFeedRevision` = last consumed feed event (including skipped ones), for continuity only, persisted **atomically with the opaque `resumeCursor` as one checkpoint pair**. A missing/inconsistent pair is discarded and re-bootstrapped with `after=first`.
- **Empty bootstrap:** fresh store revision 0, no events → normal empty page with `resumeCursor` at 0; initialize `lastFeedRevision = 0` and persist with the cursor.
- **Immediate post-ack catch-up:** after every successful acknowledgement (including reconnect), begin a serialized catch-up loop — one `resources/read` at a time, paging through `nextCursor` until exhausted; recover every event missed while disconnected, including >100 events, with no later mutation needed.
- **Continuity validation:** first event `= R+1` on no-cursor bootstrap (snapshot-boundary check); first event `= lastFeedRevision+1` on value-cursor read; contiguous thereafter across pages and buffer drains. On any gap: persist neither cursor nor `lastFeedRevision`, do not mark ready, re-read snapshot for new `R`, retry `after=first`, then explicit recovery failure if still broken.
- **Process events before persisting the cursor** (the cursor is the checkpoint *after* the last returned event). Notifications arriving during sync are buffered and never advance the cursor; drain by re-running catch-up from the persisted pair until a pass returns no new events.
- **Snapshot re-adoption:** on a later notification, re-read and adopt the new snapshot (update `R`), leave `lastFeedRevision`/cursor unchanged, apply only events with `revision > R` so an event already in the fresh snapshot is not re-applied.
- **Feed bound:** 100 events per read; `replayMaxEvents`/`replayMaxBytes` eviction can remove `R+1` without `snapshotRequired` — continuity must be validated by the client, not assumed.

### 5.7 Bounds / performance evidence checklist

- Explicit `maxSubscriptions` (starting hypothesis **64**, not SDK default 1024) with evidence from the synthetic-load test; record selected value and rationale. Do not raise without evidence.
- Bounded fan-out test: N concurrent subscriptions × M canonical updates through the complete bridge path; record N, M, min/mean/**p95**/max latency, error count, memory/CPU; assert no dropped/misrouted notifications; derive the latency budget from measurement (existing evidence: 50 ms).
- Slow-consumer test (required): hold one stream open but stop reading; measure queue growth, memory, impact on others/publisher; document that `maxSubscriptions` bounds **stream count only**, not per-stream frames/bytes. **Current state:** the separately authorized bounded follow-up added an application-owned bounded SSE wrapper (`apps/api/src/mcp-sse-bound.ts`) with measurement-derived caps and `tests/mcp/slow-consumer.test.ts`; the SDK itself still has no per-stream bound. No second event system was introduced.
- **Residual risk — slow-consumer memory/queue bound (named acceptance decision):** the SDK imposes **no per-stream frame or byte limit**; `maxSubscriptions` bounds **stream count only**. The original evidence (`docs/M6_D_FANOUT_EVIDENCE.md` §4) measured only **M = 20 updates** (22 queued frames / 4,126 bytes on one unread stream) and did **not** establish a safe upper bound under sustained load. **Current state:** the product owner authorized a separately scoped bounded follow-up; the bounded SSE wrapper is implemented and published (`9728397`/`d19d721`) with sustained-load evidence in `M6_D_FANOUT_EVIDENCE.md` §7 (16 KiB / 96-frame caps, plain-EOF overflow contract). The SDK itself still has no per-stream bound; the mitigation is application-owned. Record as: **Acceptance decision "D slow-consumer residual risk" — owner: product owner; status: OPEN — product-owner decision required before D acceptance.** Implementation is **not** decision closure: do not claim the decision closed or M6-D accepted; do not change `maxSubscriptions=64` or the 50 ms budget on account of this item.
- Notification storms: one notification per canonical event initially; measure before any coalescing; no speculative debounce.
- Configure `maxSubscriptions`, `keepAliveMs`, `maxRequestBodySize`, `onerror` deliberately; reuse existing config conventions, no new settings framework.

### 5.8 Shutdown checklist

- Order: stop coordinator → `await mcpHandler.close()` → unsubscribe bridge → stop `LiveEventHub` → stop Bun HTTP listener → close/checkpoint SQLite. Never let the handler outlive SQLite.
- Test both an active listen stream (graceful completion, `closed === 'graceful'`) and an in-flight request (closed/aborted, **not** completed successfully).
- Bridge unsubscribed only after `handler.close()`; no publish after teardown begins.

### 5.9 STDIO HTTP-only boundary

- Active `MarketDataService → MCP` delivery acceptance is **HTTP only**. STDIO is a local-API client with no canonical live-event source/relay; do not advertise `resources.subscribe` or claim live updates on STDIO.
- M6-E tests modern `subscriptions/listen` **control-plane** behavior on a real STDIO process (ack ordering, actually honored — possibly empty — filter, cancellation, correlation, clean shutdown). **Explicit M6-E test step (§6.4): after an established STDIO connection is closed and a new one opened, the client opens `subscriptions/listen` again and the server returns a fresh ack with the correct honored filter; no subscription state is assumed to survive the old connection, and no active live notification delivery is claimed for STDIO.** Adding an API SSE relay for active STDIO delivery is an explicit scope decision requiring separate authorization.

### 5.10 Exit gate (§8.1 of D plan)

All §8.1 checkboxes must be independently verified and checked: one process-wide bridge; modern HTTP client receives correct `resources/updated`; ack-first/filter/ID/isolation/cancellation/graceful close/bounded subscriptions proven; capabilities explicitly initialized with modern/legacy assertions; read-after-notify with wire-visible shapes and all race/recovery tests passing; bounded fan-out measured with documented `maxSubscriptions` and latency budget (correct arithmetic per `M6_D_FANOUT_EVIDENCE.md`); slow-consumer limitation recorded and bounded SSE mitigation implemented (`apps/api/src/mcp-sse-bound.ts`, evidence in `M6_D_FANOUT_EVIDENCE.md` §7); shutdown distinguishes graceful vs aborted; notification failures cannot change data outcomes; no custom protocol/SSE/migration/dependency/provider activation; focused tests + typecheck + build + diff-check pass; full suite no new failures vs the immediately preceding accepted baseline (§8.1; 1076/0 at `2ed4c1e` is the original historical baseline); independent review KEEP.

- **Residual-risk acceptance decision (mandatory before D acceptance):** the named decision "D slow-consumer residual risk" (§5.7) must be recorded with owner (product owner) and an explicit disposition — accepted, or a separately authorized bounded follow-up. Its status is **OPEN — product-owner decision required before D acceptance**; an open decision blocks D acceptance even if every other §8.1 checkbox passes. The SDK has no per-stream frame/byte bound; the separately authorized bounded follow-up is implemented and published (`9728397`/`d19d721`, evidence in `M6_D_FANOUT_EVIDENCE.md` §7), but implementation is **not** decision closure — do not record the decision as closed or the risk as accepted until the product owner records a disposition and the independent review gate passes.

### 5.11 Option and Metadata Impact Assessment — 18 questions (answered)

> All 18 answers are completed from source/evidence inspection at the published planning baseline. Re-confirm against live source at implementation start. **Special note:** `resources.subscribe` is a **conditional MCP protocol capability**, **not** a user-selectable option, frontend selector, provider identity or config field. Its source of truth is the shared MCP factory (`packages/mcp-core/src/factory.ts`, `createMcpServer`) reading the SDK request context (`McpRequestContext.era` and `requestInfo`), with the process-wide bridge created in `apps/api` composition. It is advertised **only** when `ctx.era === "modern" && ctx.requestInfo !== undefined` (modern HTTP); legacy HTTP and **all** STDIO contexts do not advertise it. No new frontend selector, no new provider identity, no new user config and no new REST discovery endpoint are needed.

| # | Question (protocol §4.1) | Answer |
|---|---|---|
| 1 | New selectable options, capabilities, entities or config fields? | **No user-selectable option.** `resources.subscribe` is a conditional MCP protocol capability computed from the SDK request context, not a user choice. No new entity or config field. |
| 2 | Who owns their source of truth (exact module/contract/registry)? | Shared MCP factory `packages/mcp-core/src/factory.ts` (`createMcpServer`) computes `subscribe = ctx.era === "modern" && ctx.requestInfo !== undefined` and sets it in the `McpServer` constructor capabilities; the SDK request context (`McpRequestContext`) supplies `era`/`requestInfo`; the one process-wide bridge is created in `apps/api` composition (`apps/api/src/index.ts`, `mcp-notification-bridge.ts`). No new registry. |
| 3 | Shared contract enums, backend capabilities, domain data or user-managed values? | No new enum or user-managed value. The only capability change is the existing conditional `resources.subscribe` flag; `listChanged` flags are explicitly `false`. Domain data remains the canonical snapshot/feed. |
| 4 | How does each consumer (WebUI, MCP, REST/SSE, adapters) obtain them? | MCP clients read the flag via `server/discover` capabilities; WebUI/REST/SSE are unaffected and continue to use existing routes; STDIO clients see the flag absent/false. No new consumer path. |
| 5 | Does an existing API/schema/registry/repository already provide the information? | **Yes.** `MarketDataService.subscribe()` is the canonical change source; `LiveEventHub` is the bounded feed/replay source; `markethub://market/snapshot` and `markethub://events/live` already exist. Reuse them; no new source. |
| 6 | Is a new discovery/read API necessary, or is a direct shared-package import sufficient? | **Sufficient.** `server/discover` already advertises capabilities; `resources/read` on the existing snapshot/feed URIs is the read path. No new discovery or read API. |
| 7 | How does the UI update when new values are registered, without a frontend-list edit? | **No UI change.** No user-facing value is registered; the capability is protocol-level. N/A — no frontend-list edit. |
| 8 | Cache invalidation / refresh behavior needed? | Notification is a **change signal only** — it carries the URI and SDK metadata, no payload. The client re-reads `markethub://market/snapshot` and catches up via `markethub://events/live?after=<cursor>&limit=100` (bootstrap `after=first`), validating continuity and persisting the opaque cursor with `lastFeedRevision` as one checkpoint. Existing cache hints are unchanged. **Residual risk:** the SDK has no per-stream frame/byte bound; a separately authorized bounded SSE wrapper is implemented and published (`apps/api/src/mcp-sse-bound.ts`, evidence in `M6_D_FANOUT_EVIDENCE.md` §7), but this is the named product-owner acceptance decision "D slow-consumer residual risk" (§5.7), status **OPEN — product-owner decision required before D acceptance**; implementation is not decision closure. |
| 9 | Any metadata fields sensitive or unsafe to expose? | **None added.** Notifications carry only the stable URI and SDK metadata (`subscriptionId`); no market payload, credentials, tokens or provider-native identifiers. `serverInfo` is self-reported and must not drive behavior or security decisions. |
| 10 | Tests proving frontend/backend consistency and no duplicate definition? | `tests/mcp/subscriptions.test.ts`, `notification-bridge.test.ts`, `fanout.test.ts` plus `http-integration.test.ts` assert the capability/filter/notification behavior; no duplicate definition because the flag is computed once in the shared factory. |
| 11 | Shared contract impact — existing enum/schema changed; all consumers updated? | **None.** No enum/schema changed; only capability flags are set explicitly. N/A — verification of existing contracts. |
| 12 | Provider/runtime registration impact — fixed `UPSTOX`/`FYERS` contract preserved? | **Preserved.** No provider identity or registration change; fixed `UPSTOX`/`FYERS` contract untouched; no provider activation. |
| 13 | MCP tool/resource/prompt impact — descriptor derived from same registration source? | **No new operation.** Descriptors remain derived from the same `packages/mcp-core` registration source; only capability flags change. `subscriptions/listen` is SDK-owned. |
| 14 | REST/SSE/WebUI consumer impact — which consumers read it, any hardcoding today? | **None.** REST/SSE and WebUI do not read the MCP capability; no hardcoding introduced. The app's `/api/market/stream` SSE remains unrelated to MCP listen streams. |
| 15 | Domain-data discovery impact — bounded/paginated domain API if large/changing? | **No new domain API.** `markethub://events/live` is bounded to 100 events per read with an opaque runtime-scoped cursor; snapshot reads are the bootstrap. |
| 16 | Configuration persistence impact — can MCP on-demand ops avoid silently changing config? | **No config change.** The bridge is process-lifetime and in-memory; no operational config, credential, connection or retention setting is written by MCP. |
| 17 | Forward compatibility — new value appears without a frontend/second backend list edit? | **No new value introduced.** The capability is derived from the request context at runtime; no frontend or second backend list edit. N/A. |
| 18 | Dependency direction — circular import introduced? | **No new dependency, no circular import.** The bridge uses the existing SDK notifier and shared services; dependency direction unchanged. |

---

## 6. M6-E work package — end-to-end conformance and transport acceptance

### 6.1 Objective

Prove the composed system with the real official MCP client against the running Hono/Bun listener, verify modern STDIO behavior with a spawned process, prove legacy posture, run the in-process LAN simulation, and assemble the C1–C21 evidence matrix — without redesigning M6-A/B/C/D.

### 6.2 Re-verify official spec/SDK at implementation start

- Recorded target: MCP specification **`2026-07-28`**, TypeScript SDK **`2.4.0`** (latest stable verified 2026-11-19/21; `v2.4.0` published 2026-10-23). **Re-verify both against official sources at implementation start; if a newer stable spec/SDK exists, target it and update the C1–C21 matrix (`M6_PLAN.md` §3.1) before coding.** The `draft` spec is not a target.
- **No dependency upgrade without separate authorization.** `@modelcontextprotocol/client` 2.4.0 remains dev-only; no runtime dependency change.

### 6.3 Real HTTP listener with real pinned client — 16-item verification list

> Exact 16-item list from the authoritative implementation request. All items use a **real `Bun.serve` listener**, a **real official client pinned to the verified target version**, a temporary SQLite DB, synthetic canonical live-state changes, the actual `/mcp` route and production Host/Origin validation. In-process `handler.fetch` alone never satisfies acceptance. No provider authentication, socket or live network calls.

1. Modern `server/discover`.
2. Advertised HTTP capabilities.
3. Real `subscriptions/listen`.
4. Ack-first ordering and exact honored filter.
5. Correct subscription ID correlation.
6. Notification delivery after a synthetic canonical change.
7. No notification to unsubscribed clients.
8. Snapshot re-read after notification.
9. Event-feed cursor recovery.
10. Concurrent subscription isolation.
11. Cancellation.
12. Disconnect, reconnect and missed-event recovery.
13. Host and Origin allowed/rejected scenarios.
14. CORS and HTTP error behavior.
15. Graceful shutdown.
16. No provider authentication, socket or live network calls (asserted across the whole suite).

The deeper wire-level recovery scenarios required by `M6_D_E_PLAN.md` §5.2/§6.1 (missed-event catch-up >100 events via `nextCursor`, snapshot-to-checkpoint race, separate `snapshotRevision`/`lastFeedRevision` with atomic checkpoint, retained-event pagination, snapshot re-adoption, empty-bootstrap checkpoint, replay-history gap, and `resources/read` wire assertions on `markethub://events/live?after=<cursor>&limit=100` with `contents[0].text`) remain mandatory and are covered in §5 (M6-D) and the M6-D exit gate; they are the detailed mechanism behind items 8, 9 and 12 above and must not be dropped when implementing this list.

### 6.4 STDIO spawned-process integration

- Extend `tests/mcp/stdio-modern.test.ts` (do not build another harness): spawn the actual `apps/mcp-server/src/index.ts` with `StdioClientTransport` and a test local API server; pin to `2026-07-28`.
- Verify `server/discover` body (`supportedVersions`, `capabilities`, `_meta['io.modelcontextprotocol/serverInfo']`), tool listing/call, resource reads, prompt retrieval.
- Verify `subscriptions/listen` is handled by the SDK; because there is no event relay, confirm the ack does **not** claim `resourceSubscriptions` honored; verify cancellation and clean process shutdown with no leaked child.
- **Explicit reconnect/re-listen test step (not only part of the combined gate):** (1) establish a STDIO connection and open `subscriptions/listen`, receiving the ack; (2) close that connection; (3) establish a **new** STDIO connection; (4) open `subscriptions/listen` again on the new connection; (5) assert the server returns a **fresh ack** with the correct honored filter (no `resourceSubscriptions` on STDIO, no `listChanged` bits). **No subscription state is assumed to survive the old connection, and no active live notification delivery is claimed for STDIO.** This is a control-plane assertion only; the thin local-API STDIO architecture is preserved (no SQLite, no `MarketDataService`, no API SSE relay).
- Assert stdout carries only protocol messages; diagnostics on stderr. Preserve the thin local-API architecture (no SQLite, no `MarketDataService` in the STDIO app).

### 6.5 Legacy posture

- Current composition uses default dual-era posture (`createMcpHandler` legacy stateless fallback; `serveStdio` legacy serving by default). Unless a separate decision changes it, `tests/mcp/legacy-compat.test.ts` must prove: 2025-era HTTP uses the stateless path; 2025-era STDIO uses the legacy opening path; modern pinned clients use `server/discover`/`_meta` and the 2026 listen mechanism; no unsolicited notifications or deprecated `resources/subscribe` leak into the modern path.
- If dual-era support is intentionally removed, document it, set `legacy: 'reject'` deliberately and test the rejection — do not let posture change accidentally.
- Legacy combinations use `initialize` assertions; **no** `server/discover` or listen-ack assertions on legacy connections (`M6_D_E_PLAN.md` §5.3).

### 6.6 LAN simulation (in-process only; no physical claim)

- **User-approved scope change** (`M6_E_LAN_ACCEPTANCE.md`): the second-device physical LAN requirement was explicitly removed. Physical LAN reachability is **not verified** and is **outside revised M6 scope**. The in-process simulation is **not** proof of real LAN connectivity and must never be described as such.
- One standalone test `tests/mcp/lan-simulation.test.ts`: official SDK with mocked in-process `fetch`, in-memory services, real notification bridge — no listener, socket, second device, temp DB, CLI or external dependency. Covers discovery/version, `resources.subscribe`, tool/resource/template access, snapshot reads, `subscriptions/listen` ack ordering/filter, simulated canonical update through the bridge, notification delivery, revision advancement, live-feed cursor reads, valid/invalid Host/Origin via the production helper.
- The real-listener gate (`http-integration.test.ts`) remains mandatory and is **not** replaced or weakened by the simulation.

### 6.7 C1–C21 evidence matrix with strict ownership

- Use `docs/M6_PLAN.md` §3.1 matrix and maintain a test-to-requirement table with one explicit named assertion per applicable MUST. **Current state:** `docs/M6_E_EVIDENCE.md` has no partial/planned rows — the previously planned C3/C6/C18/C19/C21 assertions now exist in `tests/mcp/conformance.test.ts` (B4 closeout, source-level KEEP review) and C14 snapshot pagination is evidenced. **C5 and C16 remain justified N/A.** The table below records the **historical planning-baseline** status and gaps; the "Gap / planned assertion" column is now satisfied as noted per row. Reuse and re-verify; do not duplicate tests merely to match a filename. Passing assertions are evidence, not B4/D/E acceptance.

**Corrected C1–C21 ownership / gap map (`M6_PLAN.md` §3.1 authoritative for ownership):**

| Row(s) | Owner | Evidence status at planning baseline (historical) | Gap / planned assertion (now satisfied where noted) |
|---|---|---|---|
| C1, C2, C4, C7–C13, C15, C17 | M6-A/B (C17 = M6-D) | Evidenced by named tests in `conformance.test.ts`, `http-integration.test.ts`, `subscriptions.test.ts`, `cache-hints.test.ts`, `tools.test.ts`, `resources.test.ts`. | None identified; re-verify at implementation start. |
| C3 | M6-A/B | Partial — `-32602`/`-32601`/`-32020`/`-32022` asserted; negative codes not asserted. | **Satisfied:** "C3: modern 2026-07-28 requests never emit -32002 or -32042" in `tests/mcp/conformance.test.ts`, scoped to modern requests. Legacy **handshake** coverage is in `legacy-compat.test.ts`; it does **not** test an older client accepting a `-32002` response, which remains untested and is not prohibited by this assertion. |
| C5 | M6-A/B | Justified N/A — no capability-gated methods in M6. | None. |
| C6 | M6-A/D | Partial — `subscriptionId` asserted; `serverInfo` `_meta` not asserted. | **Satisfied:** "C6: modern results carry io.modelcontextprotocol/serverInfo in _meta (wire)" in `tests/mcp/conformance.test.ts`; no SHOULD deviation recorded. |
| C14 | M6-B | Evidenced for catalog/feed/activity; **snapshot pagination omitted from the evidence map**. | **Satisfied:** `tests/mcp/snapshot-page.test.ts` + `snapshot-page-routes.test.ts` (opaque versioned cursor, stable progression, invalid cursor, bounded pages, client treats cursor opaque) are in the evidence map. |
| C16 | M6-B | Justified N/A — MRTR not used in M6. | None. |
| C18 | M6-A/B | Partial — explicit capabilities asserted; no-extensions not asserted. | **Satisfied:** "C18: modern server/discover advertises no unsupported extension map" in `tests/mcp/conformance.test.ts`. |
| C19 | M6-B | Partial — no named wire assertion; wrong `security.test.ts (under tests/mcp/)` reference removed. | **Satisfied:** "C19: tools/list wire output uses JSON Schema 2020-12 with no network $ref" in `tests/mcp/conformance.test.ts`. |
| C20 | M6-A/B/D | Evidenced in three parts. | Correct paths: `tests/providers/security.test.ts` (provider management/status secrets), `tests/mcp/activity.test.ts` (activity error/summarization redaction), `tests/mcp/http-integration.test.ts` (Host/Origin + HTTP security). |
| C21 | M6-A/B/D | Partial — "modern client uses discover" does not prove deprecated methods absent. | **Satisfied:** "C21: deprecated methods are rejected and deprecated surfaces are not advertised on modern protocol" in `tests/mcp/conformance.test.ts`; no `Last-Event-ID` replay covered by the C11 tests. Do not conflate retained 2025-era Streamable HTTP/STDIO compatibility with deprecated legacy HTTP+SSE. |
- **Ownership (must stay separate; `M6_PLAN.md` §3.1 is authoritative for implementation ownership):**
  - **M6-A/B own** their transport/capability rows (C1–C12, C15, C18–C21 as applicable). Specifically, C15 and C18 are A/B implementation rows.
  - **M6-B4 owns** the conformance/parity **closeout evidence** for C13–C16 and C18–C19 as the B4 sub-phase (per `M6_B_PLAN.md` §7), without transferring A/B implementation ownership of C15/C18 or creating a second owner of the same acceptance decision. C13, C14, C16 and C19 implementation ownership is M6-B.
  - **M6-D owns C17** and its subscription tests.
  - **M6-E assembles evidence** across all owners and adds actual-listener/real-client assertions. **M6-E must not claim M6-B4 acceptance** — B4 rows remain owned by B4 until B4 closeout is accepted. Assembling a B4 row's evidence into the matrix is not the same as accepting B4.
- No row is accepted because an in-process `handler.fetch` test passed where the master plan requires an actual listener. Document any SHOULD deviation with reason and owner. Do not reimplement the protocol manually to satisfy a row.
- Documented N/A: `-32021` (C5) — no capability-gated methods in M6; `-32022` (C3) is asserted, not N/A; C16 MRTR — not used in M6.

### 6.8 Exit gates

- **§8.2 (E definition of done):** C1–C21 matrix complete with strict ownership; real pinned client passes full HTTP integration against the running listener; modern STDIO process tests pass with honest listen-filter/capability behavior; legacy paths tested if retained; Host/Origin, CORS, error/cancellation, reconnect/read-after-notify, multi-client isolation, graceful shutdown, bounded resources pass; in-process LAN simulation passes with honest scope statement; full tests/typecheck/build/diff-check pass; independent review finds no scope creep or regression; M6-C closure and B4 closeout reconciled; M6 separate from Stage G/M7.
- **§8.3 (combined D+E gate):** real pinned client over actual listener opens `subscriptions/listen`, receives a supported notification after a canonical change, re-reads `markethub://market/snapshot` and `markethub://events/live` by cursor, observes graceful close — using the **same** bridge and handler D wired; same client set verifies discovery/tools/resources/prompts over both transports with no duplicate market logic and no deprecated methods; STDIO and HTTP expose the same notification control-plane semantics, STDIO re-listen after reconnect verified, no false capability advertisement; no D interface untested by E and no E assertion depending on behavior D did not implement; evidence assembled in one report referencing both gates. A gap in either blocks the combined gate and any M6-complete claim.
- **Implementation or passing tests alone do not mark a phase complete — the independent review gate is required.**

### 6.9 Option and Metadata Impact Assessment — 18 questions (answered)

> All 18 answers are completed from source/evidence inspection at the published planning baseline. Re-confirm against live source at implementation start. **E is final acceptance, not a new feature** — it assembles evidence and adds real-listener/real-client assertions; "N/A" below is justified by that scope, not a blank.

| # | Question (protocol §4.1) | Answer |
|---|---|---|
| 1 | New selectable options, capabilities, entities or config fields? | **None.** E is acceptance-only; no new user-facing capability, selector or config field. N/A for new options — justified by acceptance scope. |
| 2 | Who owns their source of truth (exact module/contract/registry)? | Unchanged. Requirements: `docs/M6_PLAN.md` §3.1; registration: `packages/mcp-core/src/factory.ts` + `tools.ts`/`resources.ts`/`prompts.ts`; capability flag: shared factory + SDK request context; bridge: `apps/api` composition. E owns no new registry. |
| 3 | Shared contract enums, backend capabilities, domain data or user-managed values? | **None added.** E asserts existing enums/capabilities/domain data only. N/A — acceptance only. |
| 4 | How does each consumer (WebUI, MCP, REST/SSE, adapters) obtain them? | Unchanged: WebUI via existing REST/discovery endpoints; MCP via `server/discover` + list operations; REST/SSE via existing routes; STDIO via thin local-API adapters. E adds no new consumer path. |
| 5 | Does an existing API/schema/registry/repository already provide the information? | **Yes.** Existing tests/evidence (`M6_E_EVIDENCE.md`, `M6_D_FANOUT_EVIDENCE.md`, `M6_E_LAN_ACCEPTANCE.md`) and shared services provide everything E assembles. No new source. |
| 6 | Is a new discovery/read API necessary, or is a direct shared-package import sufficient? | **Sufficient.** `server/discover` and existing `resources/read` paths are asserted; no new discovery or read API. |
| 7 | How does the UI update when new values are registered, without a frontend-list edit? | **No UI change.** E registers no displayable value. N/A — no frontend-list edit. |
| 8 | Cache invalidation / refresh behavior needed? | **None introduced.** Existing cache hints are asserted; notification remains a change signal with client re-read of `markethub://market/snapshot` and cursor catch-up via `markethub://events/live`. |
| 9 | Any metadata fields sensitive or unsafe to expose? | **None added.** E asserts redaction (`tests/mcp/activity.test.ts`) and secret exposure (`tests/providers/security.test.ts`); no credentials/tokens in tests, docs or `_meta`. |
| 10 | Tests proving frontend/backend consistency and no duplicate definition? | `http-integration.test.ts`, `stdio-modern.test.ts`, `legacy-compat.test.ts`, `lan-simulation.test.ts` prove transport consistency; no duplicate definition because assertions reuse existing helpers and no frontend constant is added. |
| 11 | Shared contract impact — existing enum/schema changed; all consumers updated? | **None.** No enum/schema changed; all consumers unchanged. N/A — acceptance only. |
| 12 | Provider/runtime registration impact — fixed `UPSTOX`/`FYERS` contract preserved? | **Preserved.** No provider identity or registration change; fixed `UPSTOX`/`FYERS` contract untouched; no provider activation. |
| 13 | MCP tool/resource/prompt impact — descriptor derived from same registration source? | **No new operation.** Descriptors remain derived from the same `packages/mcp-core` registration source; E asserts the existing inventory over both transports. |
| 14 | REST/SSE/WebUI consumer impact — which consumers read it, any hardcoding today? | **None.** No consumer reads a new value; no hardcoding introduced or removed. N/A — acceptance only. |
| 15 | Domain-data discovery impact — bounded/paginated domain API if large/changing? | **No new domain API.** Existing bounded/paginated catalog, feed, snapshot and activity interfaces are asserted (C14), not changed. |
| 16 | Configuration persistence impact — can MCP on-demand ops avoid silently changing config? | **No config change.** E adds no config write; MCP on-demand operations remain side-effect-free. |
| 17 | Forward compatibility — new value appears without a frontend/second backend list edit? | **No new value introduced.** N/A — no frontend or second backend list edit; acceptance only. |
| 18 | Dependency direction — circular import introduced? | **No new dependency, no circular import.** E reuses existing test helpers and the pinned dev-only client; dependency direction unchanged. |

---

## 7. Shared architectural restrictions — full "Do not" list

These apply to **all three WPs** and are non-negotiable. Violation is a scope breach requiring fix-forward and re-review.

- **Do not** start or unlock **Stage G** (live provider verification / production activation) — separately gated and locked.
- **Do not** activate providers or perform **M5 Phase 4B** provider-backed historical/option-chain activation — separately gated.
- **Do not** start **M7** (alerts/scanners/watchlists, durable alert-trigger records/feeds) — M6 defines the event-delivery contract only; `markethub://events/alerts` stays contract-only/unavailable.
- **Do not** add a new database, table, migration or schema change (the only historical exception was the M6-C `mcp_activity` migration, already accepted — no new one here). No production/user DB changes.
- **Do not** add Redis, a broker, external pub/sub, queue, worker framework, event store, audit/telemetry platform or new runtime service.
- **Do not** create a second MCP server, second event system, second database, second runtime, second app process or duplicate market-data/business logic across MCP, REST/SSE and WebUI.
- **Do not** implement a custom MCP JSON-RPC router, custom SSE implementation, custom resumability protocol, hand-written subscription-ID handling, or a separate legacy HTTP+SSE transport. SSE here is only the notification channel inside Streamable HTTP.
- **Do not** add application-level login, authentication, RBAC, OAuth or a new security framework. Preserve Host/Origin validation and the local-owner/LAN boundary.
- **Do not** advertise or implement unsupported extensions (Tasks, Skills, MCP Apps, authorization extensions) or deprecated features (Roots, Sampling, Logging, `resources/subscribe`, `ping`, `logging/setLevel`, SSE resumability) for new functionality.
- **Do not** upgrade, replace, remove or add any dependency without separate justification and authorization. `@modelcontextprotocol/client` stays dev-only at 2.4.0; no runtime dependency change.
- **Do not** make unnecessary shared-contract changes; reuse existing schemas/types. No new backend-owned option as a separately maintained frontend constant (AD-025).
- **Do not** rework or re-open already-accepted milestones (M6-A/B1/B2/B3/C). Use the fix-forward path (§3.3) with separate authorization for genuine defects.
- **Do not** delete existing good code, tests or user files (including the three preserved user-work items in §1.4).
- **Do not** commit, push, merge, rebase, amend, force-push, change branches or publish without separate explicit authorization. Never change `main`.
- **Do not** fabricate raw market fields, provider capabilities, limits or APIs. Unavailable means unavailable. No credentials/secrets in code, tests, docs, `_meta`, activity or logs.

---

## 8. Testing and evidence standards

### 8.1 Baseline procedure (per-WP, chained)

- **Original pre-B4 baseline (historical):** **1076 pass / 0 fail**, 8833 `expect()` calls, 92 files, exit 0, independently verified at `2ed4c1e` (local, not CI). Retain this for historical comparison; it is **not** a permanent exact pass-count requirement — adding tests is expected to grow the count.
- **Immediately before B4:** re-run the full suite on the live checkout and record the **actual** result (commit SHA, counts, exit code). This freshly measured result is B4's baseline. If it differs from 1076/0, investigate and explain the difference before proceeding; do not silently adopt it.
- **After B4 is accepted:** use B4's **accepted commit and recorded result** as D's baseline.
- **After D is accepted:** use D's **accepted commit and recorded result** as E's baseline.
- Each WP is compared **only to the immediately preceding accepted baseline**, while the original 1076/0 figure is preserved for historical comparison. Distinguish **expected pass-count growth** from **new failures**: growth from added tests is normal; any new failure must be named, investigated and fixed, never silently adopted as the new normal.
- Re-verify `git status`, branch and SHAs at each step; confirm the two preserved user-work items are intact and that `docs/CHATGPT_HANDOFF_CONTEXT.md` remains tracked.

### 8.2 Focused tests after each WP

- Run the WP's focused suites first (§4.4, §7.1/§7.2 of D plan). They must be deterministic and leak no child processes or SSE streams before the full suite runs.
- Then run the final command set:

```bash
bun run typecheck
bun run build
bun test
git diff --check
```

- Full-suite acceptance is **no new failures vs the immediately preceding accepted baseline** (§8.1), not merely "some tests pass" and not "exactly 1076." Any new failure must be fixed before exit. Report the exact failure list and compare to that baseline; also note the count relative to the original 1076/0 historical baseline.

### 8.3 Evidence reporting requirements

For every command, report:
- **Exact command** and **exit code**.
- **Pass/fail counts** (e.g. `1076 pass / 0 fail`, `8833 expect() calls`, `92 files`).
- **Failure names** (if any) with file and test name.
- **Baseline comparison** (vs the immediately preceding accepted baseline per §8.1; list any new failures; note count vs the original 1076/0 historical baseline).
- **Isolation** — whether a failing test passes in isolation (e.g. `bun test <file>`).
- **Local vs CI** — keep these labels distinct: **existing test evidence**, **test needing future authorization**, **agent-reported local**, **independently verified local**, **GitHub CI**. **Never call local tests CI.** The 1076/0 figure is a **local baseline**, not CI. No CI status checks were reported for these commits; do not imply otherwise.

### 8.4 Evidence honesty

- Never claim a test validates a feature that has not been implemented. Never claim an audit is complete without evidence.
- **Do not invent missing test results, and do not mark a missing assertion passed merely because this plan requires it.** The planned assertions in §4.3/§6.7 now exist in `tests/mcp/conformance.test.ts` and were source-level reviewed KEEP; passing assertions are evidence, not B4/D/E acceptance.
- Distinguish implemented / agent-reported / independently verified / CI (§1.5 and §8.3).
- Review against the failure matrix, not just the happy path (protocol §6).
- **Preserve the official re-verification requirement:** MCP specification `2026-07-28` and TypeScript SDK `2.4.0` must be re-verified against official sources at implementation start (§6.2); if newer stable versions exist, retarget and update `M6_PLAN.md` §3.1 before coding.
- No live provider calls, credentials, market sessions or external network in any test; use synthetic/injected state and honest empty/unavailable provider states.

---

## 9. Documentation and acceptance records

### 9.1 Update only after a WP genuinely passes

After each WP's independent review is KEEP and its gate passes, update **only** these governing docs (no other docs, no source/manifests/DB):
- `docs/M6_B_PLAN.md` — B4 closeout/acceptance record (new section), status line update.
- `docs/M6_D_E_PLAN.md` — check the applicable §8.1 (D) and/or §8.2 (E) checkboxes; add acceptance records; check §8.3 only when the combined gate passes.
- `docs/M6_PLAN.md` — status line and phase disposition (B4/D/E accepted) only when true.
- `docs/PROJECT_STATUS.md` — repository status and verification figures (use the immediately preceding accepted baseline per §8.1 and the new measured figures; retain 1076/0 at `2ed4c1e` as the original historical baseline).
- `docs/IMPLEMENTATION_ROADMAP.md` — M6 milestone status only when all three WPs are accepted.

### 9.2 Record in each acceptance record

- Exact commits (SHAs) and the diff range reviewed.
- Exact files added/modified.
- KEEP result and reviewer identity (§10).
- Test outcomes (focused + full + typecheck + build + diff-check) with baseline comparison.
- C1–C21 ownership table (which owner closed which row; B4 rows still B4-owned until B4 closeout).
- Limitations and honest scope statements (e.g. LAN simulation is not physical LAN proof; `maxSubscriptions` bounds stream count only; STDIO has no active live delivery).
- Locked gates restated: Stage G and M5 Phase 4B remain locked; M7 remains separate; no provider activation.

### 9.3 Completion rule

- **Do not mark M6 complete** until B4, D and E are all accepted **and** the combined §8.3 gate passes.
- Do not let documentation drift: correct stale figures (e.g. old 1061/2 or 1073/1) only in an authorized documentation task, using the verified 1076/0 baseline.

---

## 10. Independent review

### 10.1 Fresh-context reviewer per WP

Each WP gets a fresh-context independent review. The configured reviewer is **`opencode/iceman-free`** (per project memory / `CHATGPT_HANDOFF_CONTEXT.md` §2). The reviewer must not rely on the executor's completion report; it inspects the actual diff and evidence.

### 10.2 Review focus

Find:
- Defects and protocol violations (C1–C21, especially the WP's owned rows).
- Races (snapshot-to-checkpoint, reconnect, buffer drain, shutdown ordering).
- Security issues (Host/Origin, credential leakage, capability over-advertisement, LAN boundary).
- Missed failures (tests that pass but do not prove the requirement; in-process test used where a real listener is required).
- Scope creep (Stage G/provider activation/M7/new dependency/migration/second event system/custom protocol).
- Failure-matrix coverage, not just happy paths (protocol §6).

### 10.3 Fix and re-review loop

- Every finding gets a fix **plus a regression test that would have caught it** (protocol §6). Record the fix-forward.
- Re-review until **KEEP with no findings**. Prefer one thorough pre-publication review over repeated post-publication corrections.
- Record the **reviewer identity** and the **exact diff range** (commit SHAs / file list) reviewed in the acceptance record (§9.2).
- If a finding concerns an already-accepted package, use the fix-forward blocker path (§3.3), not silent re-opening.

---

## 11. Git and publication rules

- Work on `develop` only. Never modify `main` (`865d86f`) without separate explicit authorization.
- Before and after each WP, report exact `git status --short --branch`, branch name, HEAD SHA, and `git log -5 --oneline`.
- Preserve the three pre-existing user-work items (§1.4); do not revert, overwrite or delete them.
- **NO commit, push, merge, rebase, amend, force-push, branch change or publication is authorized by this plan.** Any such action requires a separate, explicit product-owner authorization after KEEP review.
- Implementation authorization (if later granted) does not itself authorize commit or push.
- No destructive Git operations. No history rewrite or file/branch deletion.

---

## 12. Final report format

The final report (produced only after all three WPs are accepted and the combined gate passes) must contain **three distinct package sections**, each with the following **10 items**:

1. Objective (restated from §4/§5/§6).
2. Verified current state at WP start (branch/SHAs/status/baseline).
3. Exact scope and what was actually changed (files added/modified; dependency changes expected: none).
4. Architectural direction and invariants upheld (single canonical source, one bridge, SDK-owned protocol, etc.).
5. Acceptance criteria result (gate checklist, each item evidenced).
6. Required tests and actual results (commands, exit codes, pass/fail counts, baseline comparison, failure names, isolation, local-vs-CI labeling).
7. Verification evidence (named assertions, C1–C21 ownership, real-HTTP/STDIO/LAN evidence, fan-out measurements).
8. Independent review (reviewer identity, diff range, findings, fix-forwards, KEEP result).
9. Complete / incomplete / unverified items and limitations (honest scope statements, locked gates).
10. Before/after `git status`, branch, HEAD, `git log -5`, and confirmation of no commit/push.

### 12.1 Combined M6 acceptance table

| Area | Rows / gate | Owner | Evidence | Status |
|---|---|---|---|---|
| M6-A/B | C1–C12, C15, C18–C21 (as applicable) — **M6-A/B implementation ownership** per `M6_PLAN.md` §3.1 (C15 and C18 are A/B rows) | M6-A/B | `M6_E_EVIDENCE.md`, `conformance.test.ts`, `http-integration.test.ts` | accepted at prior closeout; re-verified |
| M6-B4 | C13–C16, C18–C19 — **M6-B4 conformance closeout evidence**; implementation ownership per `M6_PLAN.md` §3.1 (C13/C14/C16/C19 = B; C15/C18 = A/B) | M6-B4 (closeout evidence only) | B4 closeout record; required `parity.test.ts`; reused named assertions | accepted only after B4 gate |
| M6-D | C17 | M6-D | `subscriptions.test.ts`, `notification-bridge.test.ts`, `fanout.test.ts`, `M6_D_FANOUT_EVIDENCE.md` | accepted only after §8.1 |
| M6-E | C1–C21 assembly + real listener | M6-E | `http-integration.test.ts`, `stdio-modern.test.ts`, `legacy-compat.test.ts`, `lan-simulation.test.ts`, `M6_E_EVIDENCE.md` | accepted only after §8.2 |
| Real HTTP | actual `Bun.serve` listener + pinned client | M6-E | `http-integration.test.ts` (16-item list §6.3) | pass/fail |
| STDIO | spawned process, modern + legacy posture | M6-E | `stdio-modern.test.ts`, `legacy-compat.test.ts` | pass/fail |
| LAN | in-process simulation only (no physical claim) | M6-E | `lan-simulation.test.ts`, `M6_E_LAN_ACCEPTANCE.md` | pass/fail; physical LAN out of scope |
| Combined gate | §8.3 | D+E | one report referencing both gates | pass/fail |

### 12.2 One unambiguous result

End with exactly one of:
- **M6 ACCEPTED / CLOSED** — only if B4, D and E are all accepted and §8.3 passes; or
- **M6 NOT CLOSED** — with a numbered list of blockers (which gate/checklist is open, which owner, what evidence is missing).

No hedging. Passing tests without the independent review gate is **M6 NOT CLOSED**.

---

## 13. Reference index

### 13.1 Governing docs (repository-relative)
- `AGENTS.md`
- `docs/PROJECT_MANAGER_PROTOCOL.md` (§1 roles, §2 lifecycle, §3 rules, §4 12-element format, §4.1 18-question assessment, §4.3 review checklist, §5 reporting, §6 quality/safety)
- `docs/ENGINEERING_STANDARDS.md`
- `docs/TESTING_AND_ACCEPTANCE.md` (§8 reporting requirements)
- `docs/M6_PLAN.md` (§3.1 C1–C21, §3.2 extensions, §3.3 modern-vs-legacy, §10 phases, §11 tests, §12 acceptance, §13 gates)
- `docs/M6_B_PLAN.md` (§7–§11 B4 scope/tests/acceptance)
- `docs/M6_D_E_PLAN.md` (§§2, 5, 7, 8.1 D; §§6–8.3 E)
- `docs/MCP_INTERFACE.md` §8.1
- `docs/ARCHITECTURE_DECISIONS.md` (AD-018 MCP transports, AD-025 metadata ownership)
- `docs/METADATA_AND_CAPABILITY_DISCOVERY.md`
- `docs/IMPLEMENTATION_ROADMAP.md`, `docs/PROJECT_STATUS.md`
- `docs/REFERENCES.md` §8 (official MCP/SDK source URLs, access dates)

### 13.2 Key source and evidence files
- `apps/api/src/mcp-notification-bridge.ts` — one-listener bridge, stable URI, contained errors.
- `apps/api/src/index.ts`, `apps/api/src/app.ts` — composition, handler, shutdown order, `/mcp` route.
- `packages/mcp-core/src/factory.ts`, `tools.ts`, `resources.ts`, `prompts.ts`, `services.ts`, `operation-descriptors.ts` — shared registration.
- `tests/mcp/conformance.test.ts` — named C-assertions incl. C3/C6/C18/C19/C21 (B4 closeout; source-level KEEP review).
- `tests/mcp/subscriptions.test.ts`, `notification-bridge.test.ts`, `fanout.test.ts` — M6-D tests.
- `tests/mcp/http-integration.test.ts`, `stdio-modern.test.ts`, `legacy-compat.test.ts`, `lan-simulation.test.ts`, `http-smoke.test.ts` — M6-E tests; `http-integration.test.ts` now uses the production wrapped handler and includes E1 real-listener graceful-shutdown and E2 real-listener bounded-SSE tests.
- `tests/mcp/parity.test.ts` — **exists** with meaningful real HTTP/STDIO parity tests (identical capability inventory, `catalog_search`/`events/live` over both transports, explicit-unavailable capabilities); required B4 closeout artifact.
- `tests/providers/security.test.ts`, `tests/mcp/activity.test.ts`, `tests/mcp/http-integration.test.ts` — the **actual** C20 evidence files; `security.test.ts (under tests/mcp/)` does **not** exist.
- `tests/mcp/snapshot-page.test.ts`, `tests/mcp/snapshot-page-routes.test.ts` — M6-B3 snapshot pagination evidence for C14.
- `docs/M6_E_EVIDENCE.md` — C1–C21 evidence map with strict ownership (no rows remain partial; B4 closeout assertions recorded, plus E1/E2 real-listener evidence).
- `docs/M6_D_FANOUT_EVIDENCE.md` — fan-out measurements, `maxSubscriptions=64`, 50 ms budget, slow-consumer limitation and §7 bounded-SSE mitigation evidence.
- `docs/M6_E_LAN_ACCEPTANCE.md` — user-approved LAN scope change (physical LAN out of scope).
- `docs/CHATGPT_HANDOFF_CONTEXT.md` — workflow, reviewer identity, baseline evidence, labeling conventions (**tracked**, added in `1ddf24b`; preserve, do not overwrite or delete).

### 13.3 Official sources (re-verify at implementation start)
- MCP 2026-07-28 spec: `https://modelcontextprotocol.io/specification/2026-07-28`
- Spec announcement: `https://blog.modelcontextprotocol.io/posts/2026-07-28/`
- SDK support guide: `https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md`
- SDK protocol versions: `https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md`
- SDK releases: `https://github.com/modelcontextprotocol/typescript-sdk/releases` (latest stable `v2.4.0`, 2026-10-23, as verified 2026-11-21)
- Subscriptions spec: `https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md`

---

**End of plan.** This document is planning-only. It authorizes no implementation, no source/test/manifest/DB change, no commit, no push, no merge and no publication. Each WP requires separate product-owner authorization, and M6 may be declared complete only when B4, D and E are all accepted and the combined §8.3 gate passes.

---

## 14. Reconciliation note (2026-11-25) — acceptance recorded, plan remains historical

> **Scope:** documentation-only reconciliation. This plan was a bounded implementation/assignment scaffold and remains **planning-only for the original assignment**; it grants no implementation, commit or publication authorization. Its historical SHAs, "current HEAD `d19d721`" labels, "awaiting independent review", "not implementation-authorized" and "not accepted / not started" statements are **preserved unchanged above** and are superseded only by this note. Nothing here rewrites the plan's historical content or claims it proved more than it did.

- **Current HEAD:** `9b47bdd8d8fafaab138bbff83ebc2cf716617041` on `develop`; the earlier "current HEAD `d19d72120d8dd34a064f63fbe644dc67b61a15a7`" references (header, §0, §1.1, §3.4) are **historical**. The closeout documentation and the two new E tests are **uncommitted** at this HEAD — nothing here claims publication. `main` / `origin/main` remain untouched at `865d86f393a29bc1ec8d455a51d9efa82d722c48`.
- **Acceptance recorded:** **M6-B4, M6-D and M6-E are all ACCEPTED (2026-11-25)** and the combined **§8.3 gate is PASSED**; **M6 is complete and closed**. The completion rule in §3.1/§9.3/§12.2 is satisfied. Acceptance records: [`M6_B_PLAN.md`](M6_B_PLAN.md) §12 (B4), [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md) §14 (D/E) and §8.3.1 (combined gate), [`M6_PLAN.md`](M6_PLAN.md) §16, [`PROJECT_STATUS.md`](PROJECT_STATUS.md) §8.
- **Independent review:** three fresh-context reviews by `opencode/iceman-free`, all verdict **KEEP**, no blockers/majors. Reviewed ranges: B4 — `9b47bdd` committed B4 scope (uncommitted E tests excluded); D — `9b47bdd` committed D scope (uncommitted E/B4 fixes excluded); E — `9b47bdd` plus uncommitted E test changes. Findings/fixes: B4 — 2 minor (C3 test name FIXED; STDIO stub-API backend recorded as a documented limitation, not a defect) and 2 nit (C14 matrix cell FIXED; stale C20 command path — no stale ref found, no change); D — 2 nit (fanout test comment FIXED; range-label ambiguity — no code change); E — 1 minor (evidence traceability FIXED via a dated subsection in `M6_E_EVIDENCE.md`) and 1 nit (C3 evidence wording FIXED).
- **Final verification (local, not CI):** `bun run typecheck` exit 0; `bun run build` exit 0 (pre-existing web chunk >500 kB warning); `bun test` **1115 pass / 0 fail**, 9164 `expect()` calls, 96 files, exit 0 (baseline 1113/0 at `8291738`, +2 = two new E tests; historical 1076/0 at `2ed4c1e` retained); `git diff --check` clean. GitHub reported zero status checks / workflow runs — **no CI pass is claimed**.
- **Preserved user work:** `docs/REFERENCES.md`, `docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` and `docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md` remain preserved and untouched by this closeout.
- **Unchanged gates:** Stage G, M5 Phase 4B and M7 remain locked; no live provider connection, live REST verification, production activation or provider activation occurred; production drivers remain locked. The 16 KiB / 96-frame caps, overflow contract, SSE wrapper, SDK 2.4.0, dependencies, manifests, lockfiles, DB and all application source/tests were not changed by this closeout. The "D slow-consumer residual risk" decision remains CLOSED — MITIGATED as recorded in `M6_D_E_PLAN.md` §5.4/§13.2.