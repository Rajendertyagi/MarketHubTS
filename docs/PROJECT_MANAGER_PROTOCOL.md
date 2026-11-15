# Project Manager Protocol

> **Status:** Durable operating manual for all future MarketHubTS development (authoritative).
> **Last updated:** 2026-11-16
> **Related:** [AGENTS.md](../AGENTS.md), [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) (canonical), [ARCHITECTURE.md](ARCHITECTURE.md), [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md), [TESTING_AND_ACCEPTANCE.md](TESTING_AND_ACCEPTANCE.md)

This protocol governs how work is planned, executed, reviewed, and reported. It applies to documentation, research, implementation, testing, and operations tasks.

## 1. Roles

### 1.1 ChatGPT — Technical Lead / Architect / Independent Reviewer
- Owns independent technical research and architectural direction.
- Studies official APIs and dependencies.
- Reviews proposed designs.
- Establishes precise implementation scope.
- Independently reviews actual diffs and evidence.
- **Does not** delegate all architectural decisions to OpenCode.

### 1.2 Product owner
- Owns product requirements and major scope decisions.
- Approves changes requiring authorization.
- Final authority on product scope.

### 1.3 OpenCode — Repository Investigator / Implementation Executor
- Inspects actual local code and repository state.
- Implements approved instructions.
- Runs tests and reports evidence.
- **Does not** silently redesign architecture or expand scope.

## 2. Mandatory development lifecycle

**Agreed development sequence (project-level):**
1. Establish the essential product requirements, architecture, and engineering standards.
2. Research and verify technical choices using current official documentation, supported versions, and actual compatibility information.
3. Start building the real MarketHubTS application in controlled phases.
4. Verify and test actual components as they are implemented.
5. Integrate features progressively and verify the complete application.

**Task-level lifecycle (for each bounded assignment):**
1. **Understand the requirement** (confirmed scope, constraints, acceptance criteria).
2. **Inspect actual repository state** (files, manifests, docs, config, `git status` before task).
3. **Establish verified current behavior** (what exists/works today; distinguish implemented vs planned).
4. **Research official APIs and dependencies** (verify capabilities, limits, compatibility; record sources/dates). Evidence-driven: support technical decisions with evidence, not assumptions.
5. **Select a solution** (aligned with architecture/invariants; simplest adequate approach).
6. **Document an implementation plan** where appropriate (scope, files, risks, tests).
7. **Obtain required user approval** for changes requiring authorization.
8. **Implement the bounded assignment** only (build real application components; do not create separate throwaway prototypes or an experimental phase before building).
9. **Run targeted and relevant regression tests** (and report actual results). Do not test functionality that has not been implemented.
10. **Independently review the actual diff and test evidence**.
11. **Report complete, incomplete, and unverified work honestly** (and `git status` after task).

**Research and uncertainty handling:** research official documentation first. When a significant technical uncertainty cannot be resolved through research, a narrowly scoped experiment may be used to answer it; keep it proportionate and reuse the result in the actual product wherever practical. The first meaningful end-to-end vertical slice must become part of the real MarketHubTS application, not a temporary discarded demonstration.

**Documentation discipline:** maintain lean, useful documentation (requirements, architecture decisions, contracts, references, acceptance criteria). Avoid repeated documentation polishing; update docs when evidence or decisions change. Preserve confirmed product scope/features (lean means avoiding unnecessary implementation complexity, not reducing required product scope).

## 3. Strict rules

- **No blind coding.** Inspect and understand before changing.
- **No unrelated refactoring.** Stay within approved scope.
- **No undocumented architecture changes.** Update docs/decisions when architecture changes (with approval as required).
- **No unnecessary scaffolding.** Create only what is needed for the task.
- **No duplicated market-data services or business logic** across MCP, REST/SSE, WebUI, or adapters.
- **No invented APIs or provider capabilities.** Mark unverified details explicitly.
- **No deleting existing good code** or user work.
- **No changing protected implementation** without an explicit approved assignment.
- **No dependency replacement/upgrade/removal** without justification and approval (and not in documentation-only tasks).
- **No production/user database changes** without authorization.
- **No destructive Git operations.** No force-push, history rewrite, branch/file deletion.
- **No commit, push, merge, rebase, or amend** without separate authorization.
- **No claiming tests passed** unless actually executed; report commands and outcomes.
- **No treating an OpenCode report as independent proof** without evidence/diff review.
- **Preserve unrelated modifications.** Do not revert or overwrite others’ work.
- **Inspect `git status` before and after every assigned task** (when a git repo exists; if not, state that clearly).

### 3.1 Permission boundaries
- A request to **investigate or document** is **not** permission to implement.
- A request to **implement** is **not** automatically permission to commit or push.
- Documentation-only tasks must not modify application source, tests, manifests, lockfiles, database schemas/data, runtime config, or credentials/sessions.

### 3.2 Product/engineering boundaries
- Do not ask the product owner to decide routine technical details that can be established from official documentation and engineering evidence.
- Do not reopen questions already answered by the product owner.
- Do not turn ordinary engineering work into unnecessary questions for the product owner.
- Do not silently convert assumptions into architectural decisions.

## 4. Agent task format (required for future implementation assignments)

Every implementation assignment must specify:

1. **Objective** — what outcome is required.
2. **Verified current state** — relevant existing behavior/files/evidence.
3. **Exact scope** — what is included.
4. **Architectural direction** — constraints, invariants, chosen approach.
5. **Files/components allowed to change**.
6. **Protected areas** — must not be modified.
7. **Non-goals** — explicitly out of scope.
8. **Acceptance criteria** — observable/measurable completion conditions.
9. **Required tests** — targeted and regression checks to run.
10. **Verification instructions** — how to validate.
11. **Expected report format** — including evidence, diffs summary, test results, `git status`, complete/incomplete/unverified items.

Do not repeatedly ask OpenCode to make product decisions or research the entire product from scratch; provide bounded, well-scoped assignments.

## 5. Reporting standards

- Distinguish **implemented**, **placeholder/scaffold**, **planned**, and **proposed**.
- List exact files created/updated and purpose when relevant.
- Include commands run, actual results, and any failures/blockers.
- Record uncertainties, verification gaps, and source disagreements explicitly.
- Confirm preservation of unrelated modifications and state before/after `git status`.

## 6. Quality and safety expectations

- Follow [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) (canonical) for architecture/module isolation, reliability/fault containment, code quality, configuration/data, UI, testing, and dependencies.
- Prefer simple, durable, measurable solutions over unnecessary complexity.
- Keep canonical data/services as the single source of truth for all consumers.
- Never fabricate raw market data; never expose/log credentials or sensitive tokens.
- Treat provider limits/entitlements and official API behavior as verification-required unless confirmed.
- Ensure backup/restore and recovery claims are evidenced (especially when encryption/key material is involved).
