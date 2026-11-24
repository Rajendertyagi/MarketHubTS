# M6-B4 + M6-D + M6-E Completion Plan (planning only)

> **Document type:** Bounded implementation plan / assignment scaffold. **Not** an acceptance record, **not** a status authority, **not** an implementation authorization.
> **Status:** PLANNING ONLY. No implementation, source/test/manifest/DB change, commit, push, merge or publication is authorized by this document. Each work package (WP) requires its own separate product-owner authorization before any code is written.
> **Repository:** `Rajendertyagi/MarketHubTS`, remote `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`).
> **Branch:** `develop`. **Reviewed HEAD:** `2ed4c1ef767462f8aa78be5cc29fd3e91006e5a0` (local `develop` and `origin/develop` in sync at review time).
> **`main`:** `865d86f393a29bc1ec8d455a51d9efa82d722c48` (local and `origin/main` in sync; untouched; must never be modified without separate explicit authorization).
> **Date:** 2026-11-24.
> **Execution order (mandatory):** M6-B4 → M6-D → M6-E. M6-E final acceptance only after the B4 and D gates pass. M6 may be declared complete only when B4, D and E are all accepted and the combined gate (§8.3 of `M6_D_E_PLAN.md`) passes.
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

**The single most important distinction:** For M6-D and M6-E, the **code and tests already exist** on `develop`. That is **not** the same as those phases being accepted. Acceptance requires an independent review gate that has **never been completed** — every checkbox in `M6_D_E_PLAN.md` §8.1, §8.2 and §8.3 is still unchecked `[ ]`. Passing tests do not mark a phase complete. M6-B4 (conformance/parity closeout) has **not even been started**: there is no `parity.test.ts` and no `docs/M6_B4_PLAN.md`.

**Current state (all independently verified against the local checkout at the reviewed HEAD unless labeled otherwise):**
- Branch `develop`, HEAD `2ed4c1e`, in sync with `origin/develop`. `main`/`origin/main` at `865d86f`, untouched.
- Working tree has three pre-existing user-work items that must be preserved and never reverted: ` M docs/REFERENCES.md`, `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md`, `?? docs/CHATGPT_HANDOFF_CONTEXT.md`.
- **Verified baseline full suite: 1076 pass / 0 fail, 8833 `expect()` calls, 92 test files, exit 0.** This is the real current baseline (independently re-run by the audit agent at `2ed4c1e`, local — not CI). Do **not** inherit the older 1061/2 or 1073/1 figures from earlier handoff material. Re-confirm at the start of each WP.
- M6-A, B1, B2, B3 are implemented and published; M6-C is accepted and closed at `32b034a`. M6-D/E source and tests exist but are not accepted. M6-B4 is not started. M6 is therefore **not complete**.

**Next actions (recommended, not authorized):**
1. Obtain separate product-owner authorization for M6-B4 first. Do not begin D or E until B4's gate passes.
2. At implementation start, re-verify live `develop`/`main` SHAs, `git status`, and the official MCP spec/SDK versions (recorded target `2026-07-28` / SDK `2.4.0`; re-verify, do not assume).
3. Complete the 18-question Option and Metadata Impact Assessment for the WP before writing code (§4/§5/§6 placeholders below).
4. Follow the per-WP sequence in §3; finish with an independent fresh-context review before any acceptance claim.
5. Do not start Stage G, M5 Phase 4B, M7, provider activation, or any publication. Do not touch `main`.

---

## 1. Verified current state

### 1.1 Branch, SHAs and working tree (independently verified)

| Item | Verified value |
|---|---|
| Branch | `develop` |
| Local HEAD | `2ed4c1ef767462f8aa78be5cc29fd3e91006e5a0` |
| `origin/develop` | `2ed4c1ef767462f8aa78be5cc29fd3e91006e5a0` (in sync) |
| Local `main` | `865d86f393a29bc1ec8d455a51d9efa82d722c48` |
| `origin/main` | `865d86f393a29bc1ec8d455a51d9efa82d722c48` (in sync) |
| `git status --short --branch` | `## develop...origin/develop`; ` M docs/REFERENCES.md`; `?? docs/CHATGPT_HANDOFF_CONTEXT.md`; `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` |
| Recent `git log -5` | `2ed4c1e` (EBUSY cleanup fix), `1b51427` (Phase 4 plan closeout), `13826fb` (catalog hardening), `85bb8a6` (Phase 4 docs), `ed967e3` (Phase 4 plan) |

### 1.2 Baseline test result (verified for this plan; re-confirm at implementation start)

- Full suite: **1076 pass / 0 fail**, 8833 `expect()` calls, 92 files, exit 0.
- Source: independently re-run by the audit agent at `2ed4c1e` (two consecutive runs), recorded in `docs/CHATGPT_HANDOFF_CONTEXT.md` §8.1. **Local result — not CI.** No GitHub status checks were reported for these commits.
- This figure supersedes the stale 1061/2 and 1073/1 figures that appear in older handoff/status material. Any future report must compare against **1076/0**, not the old numbers.

### 1.3 What exists vs what is missing, per WP

| WP | Exists (independently verified) | Missing / not done (independently verified) |
|---|---|---|
| **M6-B4** | `tests/mcp/conformance.test.ts` (9 named C-assertions), `tools.test.ts`, `resources.test.ts`, `cache-hints.test.ts`, `feed-sync.test.ts`, `security.test.ts`, `tools-adapters.test.ts`, `stdio-adapter.test.ts`, `operation-descriptors.test.ts`, `operation-routes.test.ts`; B1–B3 implementation and tests. | `tests/mcp/parity.test.ts` does **not** exist. `docs/M6_B4_PLAN.md` does **not** exist. `docs/M6_B_PLAN.md` line 3 says "M6-B4 implementation not started." B4 owns the conformance/parity closeout evidence for C13–C16 and C18–C19 (implementation ownership per `M6_PLAN.md` §3.1); no B4 closeout/acceptance record. |
| **M6-D** | `apps/api/src/mcp-notification-bridge.ts` (one-listener bridge, stable URI `markethub://market/snapshot`, idempotent start/stop, contained errors); `tests/mcp/{subscriptions,notification-bridge,fanout}.test.ts`; evidence `docs/M6_D_FANOUT_EVIDENCE.md` (N=8/32/64, M=20, p95 ~3.6 ms, `maxSubscriptions=64`, 50 ms budget, slow-consumer queue 22 frames/4,126 bytes). Commits `dfa6aad`, `40c7b70`, `a9d20ae`, `aee329d`, `8ac4417`, `f70025e` (all 2026-11-21). | `M6_D_E_PLAN.md` §8.1 checklist entirely unchecked `[ ]`. No independent review gate completed. No acceptance record. Phase not accepted. |
| **M6-E** | `tests/mcp/{http-integration,stdio-modern,legacy-compat,conformance,lan-simulation,http-smoke}.test.ts`; `docs/M6_E_EVIDENCE.md` (C1–C21 matrix, all rows evidenced, partially evidenced, or justified N/A — C6 is partial: `subscriptionId` asserted, `serverInfo` `_meta` not asserted); `docs/M6_E_LAN_ACCEPTANCE.md` (user-approved scope change). Commits `57e1c7f` + fixes. | `M6_D_E_PLAN.md` §8.2 and §8.3 checklists entirely unchecked `[ ]`. No independent review gate completed. No acceptance record. Phase not accepted. M6-E must not claim B4 acceptance. |

### 1.4 Preserved user work (must not be reverted or overwritten)

- ` M docs/REFERENCES.md` — pre-existing modification.
- `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` — pre-existing untracked file.
- `?? docs/CHATGPT_HANDOFF_CONTEXT.md` — pre-existing untracked handoff aid.
- This plan adds exactly one new file: `docs/M6_B4_D_E_COMPLETION_PLAN.md`. No other file is created or modified by this planning task.

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

Every implementation assignment (each WP below) must specify: (1) objective; (2) verified current state; (3) exact scope; (4) architectural direction; (5) files/components allowed to change; (6) protected areas; (7) non-goals; (8) acceptance criteria; (9) required tests; (10) verification instructions; (11) expected report format; (12) completed Option and Metadata Impact Assessment. An assignment without a completed assessment is incomplete. The WP sections below are planning scaffolds; they become implementation assignments only when all 12 elements and the 18-question assessment are completed and separately authorized.

### 2.5 Mandatory 18-question Option and Metadata Impact Assessment (protocol §4.1)

Every WP must answer all 18 questions before implementation is authorized (source-of-truth ownership, shared contracts, provider/runtime registration, MCP/REST/WebUI consumers, domain-data discovery, config persistence, forward compatibility, dependency direction). Placeholders are provided in §4, §5 and §6; they must be completed in the implementation assignment/report. No backend-owned option may be introduced as a separately maintained frontend constant (AD-025 / `METADATA_AND_CAPABILITY_DISCOVERY.md`).

### 2.6 Evidence labeling (protocol §5, §6; `CHATGPT_HANDOFF_CONTEXT.md` §10)

Distinguish **implemented**, **placeholder/scaffold**, **planned**, **proposed**. Label evidence as **implemented**, **agent-reported (local)**, **independently verified (local)**, or **CI**. **Never call local tests CI.** Never claim a test/audit is complete without evidence. Review against the failure matrix, not just the happy path. Prefer one thorough pre-publication review over repeated post-publication corrections; when a correction is needed, add a regression test that would have caught it. Keep solutions simple, durable and non-enterprise.

---

## 3. Execution order and gates

### 3.1 Mandatory order

```
M6-B4 (conformance/parity closeout)  ──gate──▶  M6-D (notification bridge)  ──gate──▶  M6-E (acceptance)
                                                                                          │
                                                                                          ▼
                                                              combined §8.3 gate ──▶ M6 ACCEPTED/CLOSED
```

- **B4 first.** Its conformance/parity unit work must not be silently absorbed into D or E. M6-E may consume B4 evidence and close end-to-end gaps, but B4 rows remain owned by B4 until B4's own closeout is accepted (`M6_D_E_PLAN.md` §2.1.3, §6.5).
- **D second.** D must pass its phase gate (§8.1) before E begins (`M6_D_E_PLAN.md` §2.1.5).
- **E last.** E final acceptance only after B4 and D gates pass. E assembles the C1–C21 evidence matrix but does **not** claim B4 acceptance.
- **Combined gate (§8.3)** must pass before either D or E is declared complete. M6 may be declared complete only when B4, D and E are all accepted (`M6_D_E_PLAN.md` §8.3 final line).

### 3.2 Per-WP sequence (repeat for each of B4, D, E)

1. **18-question assessment** — complete and record the Option and Metadata Impact Assessment (§4/§5/§6 placeholders) in the assignment/report.
2. **State what exists** — re-verify branch/SHAs/status, baseline tests, and the exact existing files/evidence for this WP; do not re-implement what already works.
3. **Smallest changes** — make only the minimal additions/corrections needed to close the WP's gate; prefer reusing existing named assertions and files over creating new ones.
4. **Focused tests** — run the WP's focused suites first; they must be deterministic and leak no child processes or SSE streams before the full suite runs.
5. **Independent review** — fresh-context reviewer (`opencode/iceman-free`) reviews the actual diff and evidence against the failure matrix.
6. **Fix findings with regression tests** — every finding gets a fix plus a regression test that would have caught it; record the fix-forward.
7. **Clean re-review** — re-review until KEEP with no findings.
8. **Acceptance record** — only then record acceptance in the governing docs (§9), with commits, files, KEEP result, test outcomes, C1–C21 ownership, limitations, and locked gates.

### 3.3 Fix-forward blockers

If independent review finds a defect in an **already-accepted** package (e.g. M6-A/B/C), record it as a **fix-forward blocker** with its own regression test and separate authorization. Do **not** silently reopen or re-accept the accepted package. Note the defect, its owner package, the evidence, and the disposition in the acceptance record.

---

## 4. M6-B4 work package — conformance and parity closeout

### 4.1 Objective

Close the M6-B4 conformance/parity sub-phase: prove C13–C16 and C18–C19 with named assertions and a parity check, using the smallest possible changes. B4 is the first gate in the sequence and owns the **closeout evidence** for these rows until its closeout is accepted; implementation ownership remains with `M6_PLAN.md` §3.1 (C13/C14/C16/C19 = B; C15/C18 = A/B).

### 4.2 Verified current state

- `docs/M6_B_PLAN.md` line 3: "M6-B4 implementation not started." §7 defines B4 as "Parity + conformance tests (C13–C16, C18–C19)" with exit condition "`parity.test.ts` passes; no extensions advertised; no MRTR/server-initiated requests."
- `tests/mcp/parity.test.ts` does **not** exist; `docs/M6_B4_PLAN.md` does **not** exist (independently verified).
- Existing reusable named assertions: `tests/mcp/conformance.test.ts` has 9 named tests (C2, C4, C3/C10, C3 version, C9, C3 invalid params, C11 SSE headers, C11 Last-Event-ID, C5 no server-initiated requests); `tools.test.ts`, `resources.test.ts`, `cache-hints.test.ts`, `feed-sync.test.ts`, `security.test.ts`, `tools-adapters.test.ts`, `stdio-adapter.test.ts`, `operation-descriptors.test.ts`, `operation-routes.test.ts` already cover much of C13–C16/C18–C19.
- `docs/M6_E_EVIDENCE.md` maps C13 (tools/resources/prompts), C14 (pagination), C15 (cache hints), C16 (MRTR N/A), C18 (no extensions), C19 (JSON Schema 2020-12, no remote `$ref`) to existing tests. **Ownership nuance:** `M6_PLAN.md` §3.1 is authoritative for implementation ownership — C13, C14, C16 and C19 are owned by M6-B; C15 and C18 are owned by M6-A/B. M6-B4 owns only the **conformance/parity closeout evidence** for C13–C16 and C18–C19 as the B4 sub-phase (per `M6_B_PLAN.md` §7); it does not transfer A/B implementation ownership or create a second owner of the same acceptance decision.

### 4.3 Exact scope (C13–C16, C18–C19)

- **C13** — standard operations (`tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`); deterministic `tools/list` order SHOULD.
- **C14** — opaque `nextCursor`, stable cursors, invalid cursor → `-32602`; bounded keyset cursors for catalog/feed/activity.
- **C15** — cache hints `ttlMs`/`cacheScope` MUST on `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`; same scope across pages; MRTR retries not cached.
- **C16** — MRTR `input_required` not used in M6; assert no server-initiated requests; document N/A; never use deprecated push pattern.
- **C18** — capability negotiation/extensions: advertise none; never claim unsupported extensions.
- **C19** — JSON Schema 2020-12 default; no auto-dereference of network `$ref`; bounded composition keywords.
- **Parity** — HTTP direct services and STDIO local-API client reach the same capabilities with identical response semantics where the local API exposes them; capabilities reported `unavailable` over STDIO are asserted as such, not silently omitted (`M6_PLAN.md` §4.1.3, §11a `parity.test.ts`).
- **Preserve honest-unavailable capabilities:** retain `futures_chain` and `market_information` as discoverable tools returning an explicit `unavailable` result, and retain `markethub://events/alerts` as discoverable-but-unavailable (M7 dependency). Do not fabricate data or remove these capabilities.
- **Do not add new tools/resources to pad the conformance matrix.** B4 is a verification/closeout sub-phase; any new capability requires its own authorized assignment.

### 4.4 Required tests (reuse existing assertions; create the B4 closeout artifact)

- **Prefer reusing existing named assertions.** Map each of C13–C16/C18–C19 to an existing named test in `conformance.test.ts`, `tools.test.ts`, `resources.test.ts`, `cache-hints.test.ts`, `feed-sync.test.ts`, `security.test.ts`, `tools-adapters.test.ts`, `stdio-adapter.test.ts`, `operation-descriptors.test.ts`, `operation-routes.test.ts`. Do not duplicate a test merely to match a filename.
- **Create `tests/mcp/parity.test.ts` as the required B4 closeout artifact.** `M6_B_PLAN.md` §7 sets the literal B4 exit condition "`parity.test.ts` passes"; the file does not exist today and must be created for B4 to close. It may wrap/reuse existing named assertions (importing or delegating to them) rather than duplicating test logic, so no duplicate tests are introduced. It must assert: both transports expose the same capabilities where the local API provides them; `catalog_search` and `events/live` are available over both (B decision 1); `futures_chain`, `market_information` and `markethub://events/alerts` are discoverable and return explicit `unavailable`; a capability in state (b) is tested as `unavailable`, not silently omitted.
- Add only missing named assertions (e.g. an explicit "no extensions advertised" assertion if not already present in `subscriptions.test.ts` "server/discover advertises explicit capabilities…").
- Focused command: `bun test tests/mcp/conformance.test.ts tests/mcp/tools.test.ts tests/mcp/resources.test.ts tests/mcp/cache-hints.test.ts tests/mcp/feed-sync.test.ts tests/mcp/security.test.ts tests/mcp/parity.test.ts` (the `parity.test.ts` file is required, not optional).

### 4.5 Ownership boundary

- Do **not** redesign M6-A (transport/lifecycle), B1 (catalog/event-feed seams), B2 (tools) or B3 (resources/prompts/cache hints/pagination). B4 is a verification/closeout package, not a re-implementation.
- Do **not** modify application source unless a concrete defect is found; if one is found, use the fix-forward path (§3.3) with a regression test and separate authorization.
- Do **not** claim M6-D or M6-E acceptance; do not touch their tests or evidence.

### 4.6 Exit gate

- Every C13–C16/C18–C19 row has a named assertion (existing or new) and is recorded in a B4 closeout record. Implementation ownership stays with `M6_PLAN.md` §3.1 (C13/C14/C16/C19 = B; C15/C18 = A/B); B4 owns only the closeout evidence.
- `tests/mcp/parity.test.ts` exists and passes (the literal `M6_B_PLAN.md` §7 exit condition; it may wrap/reuse existing named assertions); no capability silently dropped; no extensions advertised; no MRTR/server-initiated requests.
- Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; full suite shows no new failures vs the 1076/0 baseline.
- Independent review KEEP with no findings; acceptance recorded in `docs/M6_B_PLAN.md` (and referenced from `M6_PLAN.md`/`PROJECT_STATUS.md` per §9).
- No provider activation, Stage G, M7, new dependency, migration or protocol redesign.

### 4.7 Option and Metadata Impact Assessment — 18 questions (TEMPLATE — complete at authorized implementation)

> All answers below are **TBD — complete at implementation** unless marked with a verified fact. The executor must fill every row in the implementation assignment/report before code is written (protocol §4.1). "No change" is a valid answer where verified.

| # | Question (protocol §4.1) | Answer (complete at implementation) |
|---|---|---|
| 1 | New selectable options, capabilities, entities or config fields? | TBD — expected "none" (verification-only WP) |
| 2 | Who owns their source of truth (exact module/contract/registry)? | TBD |
| 3 | Shared contract enums, backend capabilities, domain data or user-managed values? | TBD |
| 4 | How does each consumer (WebUI, MCP, REST/SSE, adapters) obtain them? | TBD |
| 5 | Does an existing API/schema/registry/repository already provide the information? | TBD |
| 6 | Is a new discovery/read API necessary, or is a direct shared-package import sufficient? | TBD — expected "sufficient" |
| 7 | How does the UI update when new values are registered, without a frontend-list edit? | TBD — expected "no UI change" |
| 8 | Cache invalidation / refresh behavior needed? | TBD |
| 9 | Any metadata fields sensitive or unsafe to expose? | TBD — expected "none added" |
| 10 | Tests proving frontend/backend consistency and no duplicate definition? | TBD |
| 11 | Shared contract impact — existing enum/schema changed; all consumers updated? | TBD — expected "none" |
| 12 | Provider/runtime registration impact — fixed `UPSTOX`/`FYERS` contract preserved? | TBD — expected "preserved" |
| 13 | MCP tool/resource/prompt impact — descriptor derived from same registration source? | TBD — expected "no new operation" |
| 14 | REST/SSE/WebUI consumer impact — which consumers read it, any hardcoding today? | TBD |
| 15 | Domain-data discovery impact — bounded/paginated domain API if large/changing? | TBD |
| 16 | Configuration persistence impact — can MCP on-demand ops avoid silently changing config? | TBD — expected "no config change" |
| 17 | Forward compatibility — new value appears without a frontend/second backend list edit? | TBD |
| 18 | Dependency direction — circular import introduced? | TBD — expected "no new dependency" |

---

## 5. M6-D work package — notification bridge and event delivery

### 5.1 Objective

Complete and accept the M6-D notification bridge: connect canonical `MarketDataService` live-state changes to MCP `subscriptions/listen` notifications over the existing Streamable HTTP `/mcp` endpoint, with read-after-notify, correct capability advertisement, bounded fan-out, race-safe recovery and correct shutdown — without a second event system.

### 5.2 Verified current state

- Source exists: `apps/api/src/mcp-notification-bridge.ts` — one process-lifetime bridge; `MARKET_SNAPSHOT_URI = "markethub://market/snapshot"`; `start()` subscribes once to `service.subscribe()`; `stop()` idempotent unsubscribe; every `LiveChangeEvent` maps to one `notifier.resourceUpdated(uri)`; publisher errors contained via best-effort `onError`.
- Tests exist: `tests/mcp/subscriptions.test.ts`, `tests/mcp/notification-bridge.test.ts`, `tests/mcp/fanout.test.ts`.
- Evidence exists: `docs/M6_D_FANOUT_EVIDENCE.md` — N ∈ {8,32,64}, M=20, p95 ~3.6 ms, `maxSubscriptions=64`, 50 ms budget, slow-consumer queue 22 frames / 4,126 bytes, no per-stream bound claimed.
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
- Slow-consumer test (required): hold one stream open but stop reading; measure queue growth, memory, impact on others/publisher; document that `maxSubscriptions` bounds **stream count only**, not per-stream frames/bytes; add no custom queue.
- Notification storms: one notification per canonical event initially; measure before any coalescing; no speculative debounce.
- Configure `maxSubscriptions`, `keepAliveMs`, `maxRequestBodySize`, `onerror` deliberately; reuse existing config conventions, no new settings framework.

### 5.8 Shutdown checklist

- Order: stop coordinator → `await mcpHandler.close()` → unsubscribe bridge → stop `LiveEventHub` → stop Bun HTTP listener → close/checkpoint SQLite. Never let the handler outlive SQLite.
- Test both an active listen stream (graceful completion, `closed === 'graceful'`) and an in-flight request (closed/aborted, **not** completed successfully).
- Bridge unsubscribed only after `handler.close()`; no publish after teardown begins.

### 5.9 STDIO HTTP-only boundary

- Active `MarketDataService → MCP` delivery acceptance is **HTTP only**. STDIO is a local-API client with no canonical live-event source/relay; do not advertise `resources.subscribe` or claim live updates on STDIO.
- M6-E tests modern `subscriptions/listen` **control-plane** behavior on a real STDIO process (ack ordering, actually honored — possibly empty — filter, cancellation, correlation, clean shutdown). Adding an API SSE relay for active STDIO delivery is an explicit scope decision requiring separate authorization.

### 5.10 Exit gate (§8.1 of D plan)

All §8.1 checkboxes must be independently verified and checked: one process-wide bridge; modern HTTP client receives correct `resources/updated`; ack-first/filter/ID/isolation/cancellation/graceful close/bounded subscriptions proven; capabilities explicitly initialized with modern/legacy assertions; read-after-notify with wire-visible shapes and all race/recovery tests passing; bounded fan-out measured with documented `maxSubscriptions` and latency budget; slow-consumer limitation recorded; shutdown distinguishes graceful vs aborted; notification failures cannot change data outcomes; no custom protocol/SSE/migration/dependency/provider activation; focused tests + typecheck + build + diff-check pass; full suite no new failures vs 1076/0; independent review KEEP.

### 5.11 Option and Metadata Impact Assessment — 18 questions (TEMPLATE — complete at authorized implementation)

| # | Question (protocol §4.1) | Answer (complete at implementation) |
|---|---|---|
| 1 | New selectable options, capabilities, entities or config fields? | TBD — note `resources.subscribe` capability is conditional, not a user option |
| 2 | Who owns their source of truth (exact module/contract/registry)? | TBD — expected `apps/api` composition + SDK handler |
| 3 | Shared contract enums, backend capabilities, domain data or user-managed values? | TBD |
| 4 | How does each consumer (WebUI, MCP, REST/SSE, adapters) obtain them? | TBD |
| 5 | Does an existing API/schema/registry/repository already provide the information? | TBD — expected reuse of `MarketDataService`/`LiveEventHub` |
| 6 | Is a new discovery/read API necessary, or is a direct shared-package import sufficient? | TBD — expected "sufficient" |
| 7 | How does the UI update when new values are registered, without a frontend-list edit? | TBD — expected "no UI change" |
| 8 | Cache invalidation / refresh behavior needed? | TBD — notification is a change signal; client re-reads |
| 9 | Any metadata fields sensitive or unsafe to expose? | TBD — notifications carry URI + SDK metadata only |
| 10 | Tests proving frontend/backend consistency and no duplicate definition? | TBD |
| 11 | Shared contract impact — existing enum/schema changed; all consumers updated? | TBD — expected "none" |
| 12 | Provider/runtime registration impact — fixed `UPSTOX`/`FYERS` contract preserved? | TBD — expected "preserved" |
| 13 | MCP tool/resource/prompt impact — descriptor derived from same registration source? | TBD — expected "no new operation; capability flags only" |
| 14 | REST/SSE/WebUI consumer impact — which consumers read it, any hardcoding today? | TBD |
| 15 | Domain-data discovery impact — bounded/paginated domain API if large/changing? | TBD — `events/live` bounded to 100 |
| 16 | Configuration persistence impact — can MCP on-demand ops avoid silently changing config? | TBD — expected "no config change" |
| 17 | Forward compatibility — new value appears without a frontend/second backend list edit? | TBD |
| 18 | Dependency direction — circular import introduced? | TBD — expected "no new dependency" |

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

- Use `docs/M6_PLAN.md` §3.1 matrix and maintain a test-to-requirement table with one explicit named assertion per applicable MUST. `docs/M6_E_EVIDENCE.md` already contains a complete matrix (all rows evidenced, partially evidenced, or justified N/A) — reuse and re-verify it; do not duplicate tests merely to match a filename. **C6 is partial** (`subscriptionId` asserted in `subscriptions.test.ts`; `serverInfo` `_meta` not asserted); C5 and C16 are justified N/A. Do not describe the matrix as fully evidenced where a row is partial.
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

### 6.9 Option and Metadata Impact Assessment — 18 questions (TEMPLATE — complete at authorized implementation)

| # | Question (protocol §4.1) | Answer (complete at implementation) |
|---|---|---|
| 1 | New selectable options, capabilities, entities or config fields? | TBD — expected "none" (acceptance-only WP) |
| 2 | Who owns their source of truth (exact module/contract/registry)? | TBD |
| 3 | Shared contract enums, backend capabilities, domain data or user-managed values? | TBD |
| 4 | How does each consumer (WebUI, MCP, REST/SSE, adapters) obtain them? | TBD |
| 5 | Does an existing API/schema/registry/repository already provide the information? | TBD — expected reuse of existing tests/evidence |
| 6 | Is a new discovery/read API necessary, or is a direct shared-package import sufficient? | TBD — expected "sufficient" |
| 7 | How does the UI update when new values are registered, without a frontend-list edit? | TBD — expected "no UI change" |
| 8 | Cache invalidation / refresh behavior needed? | TBD |
| 9 | Any metadata fields sensitive or unsafe to expose? | TBD — expected "none added" |
| 10 | Tests proving frontend/backend consistency and no duplicate definition? | TBD |
| 11 | Shared contract impact — existing enum/schema changed; all consumers updated? | TBD — expected "none" |
| 12 | Provider/runtime registration impact — fixed `UPSTOX`/`FYERS` contract preserved? | TBD — expected "preserved" |
| 13 | MCP tool/resource/prompt impact — descriptor derived from same registration source? | TBD — expected "no new operation" |
| 14 | REST/SSE/WebUI consumer impact — which consumers read it, any hardcoding today? | TBD |
| 15 | Domain-data discovery impact — bounded/paginated domain API if large/changing? | TBD |
| 16 | Configuration persistence impact — can MCP on-demand ops avoid silently changing config? | TBD — expected "no config change" |
| 17 | Forward compatibility — new value appears without a frontend/second backend list edit? | TBD |
| 18 | Dependency direction — circular import introduced? | TBD — expected "no new dependency" |

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

### 8.1 Establish baseline before changes

- Re-run and record the full suite at the reviewed HEAD before any WP: expected **1076 pass / 0 fail**, 8833 `expect()` calls, 92 files, exit 0 (verified baseline). If it differs, stop and investigate before proceeding; do not silently adopt a new baseline.
- Re-verify `git status`, branch and SHAs; confirm the three preserved user-work items are intact.

### 8.2 Focused tests after each WP

- Run the WP's focused suites first (§4.4, §7.1/§7.2 of D plan). They must be deterministic and leak no child processes or SSE streams before the full suite runs.
- Then run the final command set:

```bash
bun run typecheck
bun run build
bun test
git diff --check
```

- Full-suite acceptance is **no new failures vs the 1076/0 baseline**, not merely "some tests pass." Any new failure must be fixed before exit. Report the exact failure list and compare to the baseline.

### 8.3 Evidence reporting requirements

For every command, report:
- **Exact command** and **exit code**.
- **Pass/fail counts** (e.g. `1076 pass / 0 fail`, `8833 expect() calls`, `92 files`).
- **Failure names** (if any) with file and test name.
- **Baseline comparison** (vs 1076/0; list any new failures).
- **Isolation** — whether a failing test passes in isolation (e.g. `bun test <file>`).
- **Local vs CI** — label results as **local (agent-reported)**, **local (independently verified)**, or **CI**. **Never call local tests CI.** No CI status checks were reported for these commits; do not imply otherwise.

### 8.4 Evidence honesty

- Never claim a test validates a feature that has not been implemented. Never claim an audit is complete without evidence.
- Distinguish implemented / agent-reported / independently verified / CI (§1.5).
- Review against the failure matrix, not just the happy path (protocol §6).
- No live provider calls, credentials, market sessions or external network in any test; use synthetic/injected state and honest empty/unavailable provider states.

---

## 9. Documentation and acceptance records

### 9.1 Update only after a WP genuinely passes

After each WP's independent review is KEEP and its gate passes, update **only** these governing docs (no other docs, no source/manifests/DB):
- `docs/M6_B_PLAN.md` — B4 closeout/acceptance record (new section), status line update.
- `docs/M6_D_E_PLAN.md` — check the applicable §8.1 (D) and/or §8.2 (E) checkboxes; add acceptance records; check §8.3 only when the combined gate passes.
- `docs/M6_PLAN.md` — status line and phase disposition (B4/D/E accepted) only when true.
- `docs/PROJECT_STATUS.md` — repository status and verification figures (use 1076/0 baseline and the new measured figures).
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
- `tests/mcp/conformance.test.ts` — 9 named C-assertions (reuse for B4).
- `tests/mcp/subscriptions.test.ts`, `notification-bridge.test.ts`, `fanout.test.ts` — M6-D tests.
- `tests/mcp/http-integration.test.ts`, `stdio-modern.test.ts`, `legacy-compat.test.ts`, `lan-simulation.test.ts`, `http-smoke.test.ts` — M6-E tests.
- `tests/mcp/parity.test.ts` — **does not exist**; required B4 closeout artifact (may wrap/reuse existing named assertions).
- `docs/M6_E_EVIDENCE.md` — C1–C21 evidence map with strict ownership.
- `docs/M6_D_FANOUT_EVIDENCE.md` — fan-out measurements, `maxSubscriptions=64`, 50 ms budget, slow-consumer limitation.
- `docs/M6_E_LAN_ACCEPTANCE.md` — user-approved LAN scope change (physical LAN out of scope).
- `docs/CHATGPT_HANDOFF_CONTEXT.md` — workflow, reviewer identity, baseline evidence, labeling conventions (pre-existing user work; preserve).

### 13.3 Official sources (re-verify at implementation start)
- MCP 2026-07-28 spec: `https://modelcontextprotocol.io/specification/2026-07-28`
- Spec announcement: `https://blog.modelcontextprotocol.io/posts/2026-07-28/`
- SDK support guide: `https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md`
- SDK protocol versions: `https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md`
- SDK releases: `https://github.com/modelcontextprotocol/typescript-sdk/releases` (latest stable `v2.4.0`, 2026-10-23, as verified 2026-11-21)
- Subscriptions spec: `https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md`

---

**End of plan.** This document is planning-only. It authorizes no implementation, no source/test/manifest/DB change, no commit, no push, no merge and no publication. Each WP requires separate product-owner authorization, and M6 may be declared complete only when B4, D and E are all accepted and the combined §8.3 gate passes.
