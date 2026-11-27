# ChatGPT Handoff Context — MarketHubTS

> **Document type:** Handoff aid for a fresh ChatGPT conversation. Not a governing architecture plan, not an implementation authorization, and not a status authority.
> **Created:** 2026-11-24 by OpenCode from direct repository inspection.
> **Status of this document:** Independently verified against the local checkout and `origin` at the time of writing. Re-check live SHAs before relying on it.
> **Reconciliation (2026-11-25):** the "current HEAD `d19d721`" and "awaiting independent review / not accepted" statements below were accurate at creation (2026-11-24) and are **preserved as historical**; see §12 for the current state.
> **Latest reconciliation (2026-11-26):** §12 is now historical; see §13 for the current state (HEAD `e440cdd`, with four uncommitted corrections and an unresolved G0 finding).

---

## Read this first / Current state / Next actions

**Read this first.** This document exists so a fresh ChatGPT can continue the current technical review without asking the user to repeat information. The user is the product owner, is not an experienced programmer, and needs plain-English explanations. ChatGPT is the independent technical lead/reviewer; OpenCode is the implementation executor.

**Current state (independently verified 2026-11-24):**
- Repository: `Rajendertyagi/MarketHubTS`, remote `origin` (`https://github.com/Rajendertyagi/MarketHubTS.git`).
- Branch: `develop`. Local HEAD and `origin/develop` both `d19d72120d8dd34a064f63fbe644dc67b61a15a7` (current). Historical baselines: corrections published at `9f99b9a`, prior published-plan baseline `72743cf`, original inspected implementation baseline `2ed4c1e`.
- `main` and `origin/main` both `865d86f393a29bc1ec8d455a51d9efa82d722c48` (unchanged; never modify without separate explicit authorization).
- Working tree: ` M docs/REFERENCES.md`, `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` and `?? docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md` — pre-existing user work, preserved, not part of any Phase 4 commit.
- Metadata-discovery Phase 4 (provider-backed derivative expiry discovery) is **complete, published, and audited KEEP**. The final published baseline is `2ed4c1e`, **not** `85bb8a6` (the baseline named in the handoff request is outdated by three commits).
- The four technical-lead findings A–D described in section 7 were **fixed in `13826fb` and independently re-audited KEEP**; Finding E (plan close-out) was completed in `1b51427`; the Windows `EBUSY` test flake was root-cause fixed in `2ed4c1e`. Details and evidence are in section 7.
- Latest independently re-run full suite: **1076 pass / 0 fail** (two consecutive runs by the audit agent). No GitHub CI status checks were reported for these commits — all results are local, not CI.
- The canonical M6 completion plan `docs/M6_B4_D_E_COMPLETION_PLAN.md` exists with **Corrections published in `9f99b9a` (historical); awaiting independent review; not implementation-authorized** (planning only, not finally approved or implementation-ready; grants no implementation authorization). **M6-B4 implementation is complete** (`tests/mcp/parity.test.ts` + named C3/C6/C18/C19/C21 assertions in `tests/mcp/conformance.test.ts`, source-level review KEEP) but **not formally accepted**; M6-D and M6-E remain not accepted; M6 is not complete. The M6-D slow-consumer bounded SSE mitigation is also implemented and published (`9728397`/`d19d721`), with its product-owner decision still OPEN.

**Next actions (recommended, not authorized):**
1. Re-verify live `develop`/`main` SHAs and `git status` before any work (current HEAD `d19d721`; corrections published at `9f99b9a` await independent review).
2. Read `docs/PROJECT_MANAGER_PROTOCOL.md` and `docs/METADATA_DISCOVERY_PHASE_4_PLAN.md` (the canonical Phase 4 plan with §13 close-out record).
3. Confirm the section 7 findings are closed in current source (paths and evidence provided).
4. Produce an independent technical disposition. Note the stale documentation entries in section 8.3.
5. For M6: the four independent-review corrections were published in `9f99b9a` (historical) and await independent review; B4 implementation is complete with a source-level KEEP review but B4/D/E remain not accepted and M6 is not complete. Do not treat the completion plan as implementation-authorized.
6. **Do not start Phase 7.** It remains separately gated and not authorized. Obtain explicit product-owner authorization before any code change or publication.

---

## 1. Current repository state (independently verified)

All facts in this section were verified directly from the local checkout on 2026-11-24.

| Item | Verified value |
|---|---|
| Branch | `develop` |
| Local HEAD / `origin/develop` | `d19d72120d8dd34a064f63fbe644dc67b61a15a7` (in sync) — **current HEAD**; historical: corrections published at `9f99b9a830252335456ef8232a2032ea9b85d6ea`, prior published-plan baseline `72743cfe68e665dda018a3f4e098208f880a979f` |
| Original inspected implementation baseline | `2ed4c1ef767462f8aa78be5cc29fd3e91006e5a0` — the checkout inspected when this handoff was first created; distinct from the planning-document baseline above |
| Local `main` / `origin/main` | `865d86f393a29bc1ec8d455a51d9efa82d722c48` (in sync; untouched) |
| `git status --short` | ` M docs/REFERENCES.md` ; `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` ; `?? docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md` (three preserved user-work items) |
| This handoff file | **Tracked** — added in `1ddf24b` and present at `72743cf`, `9f99b9a` and current HEAD `d19d721`. It did not exist when this document was first created, but it is **not untracked now**; preserve it, do not overwrite or delete it. |

**Recent commit history (newest first, verified with `git log --oneline -20`):**

```
2ed4c1e fix(test): yield event loop during temp-dir cleanup to release deferred SQLite handles
1b51427 docs: close Phase 4 plan with implementation record
13826fb fix(catalog): harden Phase 4 master import validation and shared-field preservation
85bb8a6 docs: record metadata-discovery Phase 4 (provider-backed derivative expiry discovery) complete
ed967e3 docs: add canonical Phase 4 provider-master implementation plan
13061da fix(web): drop stale Catalogue provenance when expiry fetch fails
9862464 feat(web): add provider-backed expiry discovery with manual fallback to Snapshot Panel
8785670 fix(catalog): derive provider source dates from master data, not fetch time
e99c5f3 feat(api): add bounded provider-aware derivative expiry API (WP4B)
bcec6ab fix(catalog): address WP4A audit findings for refresh, fixtures and conflict tests
03adab1 feat(catalog): import Upstox/FYERS masters with complete-snapshot reconciliation
cbb4e44 docs: record Phase 6 complete and add close-out record
b37fa67 fix(web): correct Overview status accuracy (WP6C)
75186ed docs: record Phase 6 WP6A/WP6B published, WP6C pending
d132894 feat(web): make snapshot provider selection explicit and contract-derived
61c90e5 docs: mark WP6A complete in Phase 6 plan status
2866bae fix(web): block retention save until initial settings load succeeds
128e44a test(web): pin retention save-block wiring and raw-text rendering
f25d514 feat(web): align retention response contracts and form validation
84f94cd docs: correct WP6B optional API test path in Phase 6 plan
```

**All SHAs named in the handoff request were verified to exist and match their described commits:** `03adab1`, `bcec6ab`, `8785670`, `e99c5f3`, `9862464`, `13061da`, `ed967e3`, `85bb8a6`. Additional commits after `85bb8a6`: `13826fb`, `1b51427`, `2ed4c1e`.

**Important correction to the handoff request:** it says to record `85bb8a657d690d2ad7f359f3cb058de7bf54e2ad` as the final published baseline "only if it is still the correct current published baseline." It is **not**. The current published baseline is `2ed4c1e`. `85bb8a6` is the Phase 4 documentation-sync commit that the technical-lead review was based on; three commits followed it.

**GitHub verification:** the user's review states GitHub `develop` matched `85bb8a6` at the time of that review. That was accurate then; it is now three commits behind. Re-check GitHub before relying on any SHA in this document. No CI status checks were reported for the Phase 4 commits.

---

## 2. People and agent workflow (user-approved / protocol-defined)

- **User = product owner.** Owns product requirements and major scope decisions; final authority on product scope. Approves changes requiring authorization. **Not an experienced programmer** — needs plain-English explanations of technical decisions, risks and consequences. Should receive recommendations and the reasoning behind important decisions, without being forced to make technical decisions they are not equipped to evaluate.
- **ChatGPT = independent technical lead, architect, research assistant and reviewer.** Owns independent technical research and architectural direction; studies official APIs/dependencies; reviews proposed designs; establishes precise implementation scope; independently reviews actual diffs and evidence. Must **not** delegate all architectural decisions to OpenCode, and must independently inspect actual source code and documentation rather than trusting an executor's completion report.
- **OpenCode = repository investigator / implementation executor.** Inspects actual local code and repository state; implements approved instructions; runs tests and reports evidence; must not silently redesign architecture or expand scope.
- **Separate fresh-context audit agent** performs independent code/diff review when appropriate. In recent Phase 4 work the configured reviewer was `opencode/iceman-free` and the code executor was `opencode/hy4-flash-free`.
- **Working rhythm that has been used successfully:** product owner authorizes one bounded work package → OpenCode implements and commits locally → independent audit → fix findings → re-audit until KEEP → product owner authorizes publication → push to `develop`. The user has repeatedly asked for this to run autonomously, one subagent at a time, with OpenCode managing and not writing code itself during those cycles.

Source: `docs/PROJECT_MANAGER_PROTOCOL.md` §1 (roles), §2 (lifecycle), §3 (strict rules). This collaboration model is user-approved and protocol-defined.

---

## 3. Project-management rules (authoritative: `docs/PROJECT_MANAGER_PROTOCOL.md`)

Summarized from the actual protocol. The protocol itself is authoritative — link to it rather than inventing alternative rules.

**Branches and authorization:**
- `main` is stable/production; `develop` is the active development branch. Two permanent branches only; no PR workflow required.
- Never modify `main` without separate explicit authorization. All recent work is on `develop`; `main` remains at `865d86f`.
- Each work package needs separate product-owner authorization.
- Implementation authorization does **not** authorize commit, push, merge, rebase, amend or publication. A request to investigate/document is not permission to implement.
- No destructive Git operations: no force-push, history rewrite, branch/file deletion, or destructive cleanup/branch consolidation without explicit permission.

**Work execution:**
- Bounded work packages with exact file scope, acceptance criteria, required tests, verification instructions and an expected report format (12 required elements, §4).
- Mandatory 18-question Option and Metadata Impact Assessment for every implementation assignment (§4.1). An assignment without it is incomplete.
- No blind coding; inspect actual repository state before and after every task (`git status` before/after).
- No unrelated refactoring, no undocumented architecture changes, no unnecessary scaffolding, no duplicated market-data services or business logic across MCP/REST-SSE/WebUI/adapters.
- No invented APIs or provider capabilities; mark unverified details explicitly.
- No deleting existing good code or user work; preserve unrelated modifications and untracked files.
- No dependency replacement/upgrade/removal without justification and approval; never in documentation-only tasks.
- No production/user database changes without authorization.

**Review and reporting:**
- Independently review the actual diff and test evidence; do not treat an OpenCode report as independent proof.
- Fix findings before accepting a work package; prefer one thorough pre-publication review over repeated post-publication corrections. When a correction is needed, add a regression test that would have caught it (§6).
- Report complete, incomplete and unverified work honestly; list exact files changed, commands run, actual results and failures.
- Clearly distinguish **implemented**, **placeholder/scaffold**, **planned** and **proposed**.
- Distinguish implementation evidence, agent-reported local tests, independently verified results and actual CI results. Never call local results CI. Never claim live API or provider verification without evidence.
- Review against the failure matrix, not just the happy path (§6).
- Keep solutions simple, durable and measurable. Do not turn a small project into an unnecessarily complicated enterprise system.

**Module organization (§3.3):** one clear responsibility per file; prefer small focused modules; ~300 lines is a review signal, not a hard limit; keep route/transport concerns separate from domain logic; descriptive file names; tests mirror source areas; no disconnected scaffolding; review file sizes/names before declaring a milestone complete.

---

## 4. Product and architecture boundaries (plain English)

**What MarketHubTS is:** a local-first, AI-first Indian stock-market **data platform** focused on NSE and BSE F&O information. Its job is to collect, normalize, organize, maintain and expose market data. It is explicitly **not** an order-placement, trading-recommendation, sentiment/chat, broker-account-management or general CSV-export product. News/X/Twitter and market-wide information remain required roadmap items, not implemented features.

**Local-first meaning:** data and the application run on the user's PC; LAN access is required so other apps/devices/MCP clients can connect. Local-first does **not** mean the app must work forever without internet — Phase 4 deliberately downloads public provider master files over HTTPS. It means the data stays local, there is no cloud hosting/public exposure, and there is no application-level login.

**Canonical foundation:** one canonical data and application-services foundation serves MCP, REST/SSE and WebUI. No independent market-data interpretation or duplicate business logic in consumers. Provider-specific logic stays inside adapters; canonical identity/normalization is shared.

**Key pieces that exist:**
- `@markethub/contracts` — shared Zod schemas/types (provider identity, instruments, derivatives, snapshots, MCP operations, etc.).
- `@markethub/market-core` — canonical identity (`computeIdentityKey`), catalog/sync services, live services, snapshot service.
- `@markethub/database` — SQLite + Drizzle, versioned migrations (`0000`–`0006`), repositories (`catalog.ts`, etc.).
- `apps/api` — Hono API: `/health`, `/ready`, `/api/status`, catalog search, derivative expiries, historical/snapshot/retention routes, MCP transports.
- `apps/web` — React+Vite WebUI with live-data, history/snapshots, MCP/Activity panels and selectors.
- MCP — stdio plus Streamable HTTP at `/mcp`, shared factory, operation descriptors.

**Upstox and FYERS:** two independent providers with fixed identities (`providerIdSchema = z.enum(["UPSTOX","FYERS"])`). One failing must not break the other. Provider-native identifiers (Upstox `instrument_key`, FYERS `fyToken`/`symTicker`) live in `provider_instrument_mappings` and mapping `sourceMeta`; they never enter canonical identity. Canonical identity is provider-neutral (exchange, segment, category, underlying, expiry, strike, option type).

**Why activation is separate:** offline/catalogue features (including Phase 4 expiry discovery) work from locally imported public master files and never call live market-data APIs. Provider activation (M5 Phase 4B) and real provider verification (Stage G) are separately gated, require explicit authorization, and remain locked. Production composition wires historical/snapshot services with empty provider collections.

**Preserved exclusions (do not violate):**
- No new database, duplicate catalogue, universal metadata registry or metadata microservice.
- No generic ingestion platform, enterprise scheduler, queue or worker framework.
- No new provider/plugin framework without a demonstrated requirement; provider identity stays fixed.
- No direct exchange data feeds merely for completeness (Phase 4 uses broker masters; exchange feeds are a possible future enhancement only if a coverage/validation gap is demonstrated).
- No live provider activation without the separate gate.
- No fabricated raw market fields; unavailable means unavailable.
- AI/MCP must not modify operational configuration; WebUI owns operational config.

Sources: `docs/PROJECT_OVERVIEW.md`, `docs/PRODUCT_REQUIREMENTS.md`, `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE_DECISIONS.md` (AD-025), `docs/METADATA_AND_CAPABILITY_DISCOVERY.md`, `AGENTS.md`.

---

## 5. Milestone history and current status

All items below are **independently verified from repository documentation** unless marked otherwise.

- **M1–M3 (foundation, catalog, provider auth):** implemented. M1 = validated config, SQLite/migrations, Hono API, WebUI shell, LAN operation. M2 = canonical contracts, identity, catalog persistence, transactional sync. M3 = encrypted credential store, independent Upstox/FYERS auth adapters, provider registry.
- **M4 Stages A/B/D/E/F:** implemented; D and E accepted; F passed independent review and was integrated into `main` by authorized fast-forward to `865d86f`. Stage C (FYERS Data Socket adapter) implemented at final reviewed state `e8ce409` (adapter-only). Stage G (real streaming verification) remains locked and separately gated.
- **M5 (offline historical/snapshot persistence):** offline implementation complete and published (Phases 1–4A): five-table persistence, derived coverage, first-write-wins conflicts, fail-closed retention, offline Upstox/FYERS REST adapters (mocked fetch), local API/WebUI. **M5 Phase 4B (provider-backed historical/option-chain activation) is NOT activated and remains Stage-G gated.** M5 Stage G REST verification is distinct from M4 Stage G streaming verification; success in one does not satisfy the other.
- **M6:** M6-A (Streamable HTTP + retained STDIO, shared factory), M6-B1 (catalog-search/event-feed read seams), M6-B2 (nine tools over both transports), M6-B3 (resources/prompts/cache hints, snapshot pagination at `0d58bbb`) implemented and published. M6-C (durable activity history/WebUI inspection) accepted and closed at `32b034a`. **M6-D/E source and tests present but not accepted** (independent review gate in `docs/M6_D_E_PLAN.md` §8.1–§8.3). **M6-B4 implementation complete with a source-level KEEP review, separately owned and not formally accepted.**
- **Metadata & Capability Discovery Phases 1–6:** Phases 1, 2, 3, 5 and 6 complete and published. Phase 4 (this work) complete and published. **Phase 7 (cross-system acceptance) planned, not implemented, separately gated.**
- **Phase 6 detail:** WP6A retention consistency (`f25d514`/`128e44a`/`2866bae`), WP6B explicit snapshot provider selection (`d132894`; no Automatic option, no FYERS default), WP6C Overview accuracy (`b37fa67`). Documentation close-out `cbb4e44`. All audited KEEP.

**Phase 4 publication sequence (all SHAs verified):**

| Commit | What |
|---|---|
| `03adab1` | WP4A — Upstox/FYERS master importers, reconciliation, shared-field conflicts, refresh |
| `bcec6ab` | WP4A audit fixes — daily timer, freshness failure, BSE fixtures, full field matrix |
| `8785670` | WP4A source-date honesty — derive from master data, not fetch time |
| `e99c5f3` | WP4B — bounded provider-aware expiry API |
| `9862464` | WP4C — Snapshot Panel expiry selector with manual fallback |
| `13061da` | WP4C provenance fix — drop stale Catalogue label on fetch error |
| `ed967e3` | Canonical Phase 4 plan |
| `85bb8a6` | Phase 4 documentation sync (the technical-lead review baseline) |
| `13826fb` | Technical-lead fix-forward — report validation, shared-field preservation, Upstox scope, index test |
| `1b51427` | Phase 4 plan close-out record |
| `2ed4c1e` | Root-cause fix for Windows `EBUSY` temp-dir cleanup flake |

**Critical naming distinction — never combine these:**
- **Metadata Discovery Phase 4** = provider-backed derivative expiry discovery. **Complete and published.**
- **M5 Phase 4B** = provider-backed historical/option-chain activation. **Separately gated, not activated.**
- **Stage G** = real provider verification and production activation. **Separately gated, locked.**
One does not unlock another. Phase 4 completion does not activate providers or satisfy Stage G.

---

## 6. Phase 4 implementation details (actual delivered code)

**What was delivered (independently verified from source):**

- **WP4A — local catalogue import.** Public HTTPS downloads of the Upstox BOD instrument JSON and FYERS Symbol Master JSON files (NSE_FO, BSE_FO, NSE_CM, BSE_CM). No broker login, no credentials, no live market-data calls. Parsers normalize to existing canonical instruments/derivatives and provider mappings; data persists in existing SQLite tables.
- **Provider-neutral identity + provider-specific mappings.** Same exchange contract from both providers converges on one canonical ID with two distinct provider mappings. Provider-native IDs stay in `provider_instrument_mappings`/`sourceMeta`.
- **Source-date/freshness handling.** FYERS source date derived from in-scope per-record `lastUpdate` (newest per required segment file, oldest across files); Upstox uses a parseable `Last-Modified` header only. If no reliable source date exists, `sourceObservedAt` is left unknown and freshness is `STALE` — fetch time is never substituted. Limitation: freshness reflects the master file's source date, not live market data.
- **Complete-snapshot reconciliation.** `applyCompleteProviderSnapshot` applies the batch, reconciles mappings and updates the sync-run record inside **one** `CatalogRepository.transaction`, using a shared internal tx-aware apply helper (not `applyBatch` called inside another transaction). Only currently `ACTIVE` mappings in exact coverage tuples that are absent from the snapshot become `REMOVED`; other providers/scopes untouched; no canonical deletes. Any failure rolls back everything.
- **Import-report validation (added in `13826fb`).** `validateCompleteImportReport` fails closed on invalid rows, unresolved underlyings, duplicate identities, mapping conflicts, no in-scope options/underlyings, and empty required segments. The refresh owner calls `assertValidCompleteImport` **before** reconciliation. Expected `skippedOutOfScope` rows are not failures.
- **Shared derivative-field conflicts.** Differing populated shared fields (`lotSize`, `tickSize`, `quantityFreeze`, `contractSource`, `contractObservedAt`) preserve the existing canonical value and emit a deterministic `DERIVATIVE_SHARED_FIELD_CONFLICT` WARNING with both values/provider/source; provider values are retained in that provider's mapping `sourceMeta`. Omitted incoming fields no longer erase existing canonical values (`13826fb`). `contractLifecycleStatus` is excluded from diffing. Warning-only complete snapshots remain `COMPLETED`; ERROR conflicts still roll back.
- **Upstox scope (`13826fb`).** Only cash/index underlyings actually referenced by in-scope option rows are imported, matching FYERS behavior.
- **WP4B — bounded expiry API.** `GET /api/catalog/derivative-expiries?underlyingCanonicalId=...&provider=...`. Shared Zod response schema. SQLite-side join/filter/DISTINCT/order/limit (hard cap 100); no in-memory filtering. Provider isolation (no borrowing). `FRESH`/`STALE`/`UNKNOWN` from the latest `COMPLETED`+`COMPLETE` sync run for the exact provider/source/scope, using `Asia/Kolkata` market dates and an injected clock. No native IDs/tokens/errors exposed.
- **WP4C — Snapshot Panel selector.** Catalogue-backed expiry suggestions plus the existing editable manual date field. Origin marker: `Catalogue` when the value exactly matches a current response option, otherwise `Manual — not verified against the current provider master`. Manual values validated as real `YYYY-MM-DD` calendar dates. Provider/underlying changes clear the value and marker before a new fetch; late responses ignored via generation guard + AbortController. Loading/empty/error-retry/stale states visible; manual fallback never hidden. Valid manual dates remain saveable in the existing capture-config schema. WP6B explicit provider selection preserved (UPSTOX/FYERS only, no Automatic, no FYERS default).
- **No live provider connection, activation, or Stage G verification.**

**Important implementation paths (repository-relative):**

| Path | Role |
|---|---|
| `packages/market-core/src/sync/upstox-master.ts` | Upstox BOD parser/normalizer; referenced-underlying filter; import report |
| `packages/market-core/src/sync/fyers-master.ts` | FYERS Symbol Master parser; `lastUpdate` source-date derivation; import report |
| `packages/market-core/src/sync/import-report.ts` | `ProviderImportReport`, required segments, `validateCompleteImportReport` |
| `packages/market-core/src/sync/refresh.ts` | `CatalogMasterRefresh`: public HTTPS download, single-flight, daily timer, validation gate, last-known-good |
| `packages/market-core/src/sync/shared-fields.ts` | Shared-field diff/warning/restore logic |
| `packages/market-core/src/sync/scope.ts` | Deterministic `scopeJson` serializer (shared write/read path) |
| `packages/market-core/src/sync/timestamps.ts` | India-market expiry timestamp conversion |
| `packages/market-core/src/sync/apply.ts` | `applyBatch` + `applyCompleteProviderSnapshot`, tx-aware helper, ERROR-only status |
| `packages/market-core/src/types.ts` | Repository/sync contracts (`listDerivativeExpiries`, `getLatestProviderSync`, reconciliation types) |
| `packages/database/src/repositories/catalog.ts` | SQLite implementations of expiry query, sync lookup, reconciliation |
| `packages/contracts/src/market.ts` | Expiry query/freshness/response schemas |
| `apps/api/src/derivative-routes.ts` | `GET /api/catalog/derivative-expiries` |
| `apps/api/src/app.ts`, `apps/api/src/index.ts` | Route registration; refresh-owner wiring |
| `apps/web/src/lib/expiries.ts`, `apps/web/src/lib/expiry-form.ts` | Expiry client and pure form/controller helpers |
| `apps/web/src/components/SnapshotPanel.tsx` | Selector UI, manual fallback, origin marker, race guard |
| `tests/fixtures/provider-masters.ts` | Sanitized official-format fixtures (no credentials) |
| `tests/market/master-import.test.ts`, `sync-reconciliation.test.ts`, `catalog-refresh.test.ts`, `derivative-expiries-*.test.ts`, `derivative-routes.test.ts`, `tests/web/expiries.test.ts` | Phase 4 test coverage |

**Design decisions in plain language:** use the brokers' public symbol masters as the catalogue source because they are sufficient for the supported instruments and need no credentials; keep one canonical catalogue with per-provider mappings so the same contract is not duplicated; fail closed on incomplete masters so a bad file cannot delete good mappings; keep manual expiry entry because a catalogue can be empty or stale and the app must stay honest about what is verified.

---

## 7. Current independent technical review — findings and their verified disposition

**Origin of the findings.** The user's latest ChatGPT review independently inspected GitHub source at the Phase 4 documentation-sync baseline `85bb8a6` and raised Findings A–E below. It recommended a focused fix-forward before Phase 7 and withheld final technical acceptance. **Do not silently omit these findings.** Their current disposition is recorded here with source and test evidence.

**Disposition summary (independently verified in this session):** Findings A–D were fixed in `13826fb` and re-audited KEEP with no findings; Finding E was completed in `1b51427`. The audit agent re-ran the full suite twice at 1076/0. The user's review predates these three commits. A fresh ChatGPT should still independently confirm the disposition rather than accept this document blindly.

### Finding A — Importer reports not enforced before reconciliation
- **Raised at:** `85bb8a6`. Files: `refresh.ts`, `upstox-master.ts`, `fyers-master.ts`, `import-report.ts`, `apply.ts`.
- **Concern:** parsers return a report (`invalidRows`, `unresolvedUnderlyings`, `duplicateIdentities`, `mappingConflicts`, `inScopeOptions`, `inScopeUnderlyings`, `skippedOutOfScope`) but the refresh flow passed the batch straight to `applyCompleteProviderSnapshot`; a syntactically valid but incomplete master could reconcile mappings as `REMOVED`.
- **Current disposition: FIXED (independently verified).** `packages/market-core/src/sync/import-report.ts:50-74` defines `validateCompleteImportReport` with fail-closed codes (`INVALID_ROWS`, `UNRESOLVED_UNDERLYINGS`, `DUPLICATE_IDENTITIES`, `MAPPING_CONFLICTS`, `NO_IN_SCOPE_OPTIONS`, `NO_IN_SCOPE_UNDERLYINGS`, `EMPTY_REQUIRED_SEGMENT:<segment>`); required segments are `NSE_FO`/`BSE_FO` for Upstox and `NSE_FO`/`BSE_FO`/`NSE_CM`/`BSE_CM` for FYERS; `skippedOutOfScope` is deliberately not a failure. `refresh.ts:124-125` and `:140-141` call `assertValidCompleteImport(report, provider)` **before** `applyCompleteProviderSnapshot`; the method is defined at `:195-196`. Tests in `tests/market/catalog-refresh.test.ts` prove an empty required segment or invalid/unresolved rows leave the catalogue unchanged, keep the prior COMPLETED run, and record a FAILED run.
- **Residual (non-blocking, agent-reported by auditor):** `applyCompleteProviderSnapshot` remains a public API that assumes callers pass a valid complete snapshot; the validation gate lives in the refresh owner. Future callers must enforce the same rule.

### Finding B — Missing provider fields may erase canonical shared values
- **Raised at:** `85bb8a6`. Files: `shared-fields.ts`, `apply.ts`, `normalize.ts`, `tests/market/sync-reconciliation.test.ts`.
- **Concern:** `analyzeSharedDerivativeFields` initialized `canonicalDerivative` from the incoming derivative and skipped absent fields; a later provider omitting `lotSize` could erase an existing canonical value.
- **Current disposition: FIXED (independently verified).** `shared-fields.ts:55-63` now starts from the incoming derivative and restores every populated existing field the incoming provider omitted, using `stableValue` so undefined/null/empty count as absent. The warning/idempotency loop still covers only `SHARED_DERIVATIVE_FIELDS`; omitted fields produce no warning and no false `sourceMeta` entry. `contractLifecycleStatus` remains canonical-owned. Tests cover each shared field for the omission case plus the differing-value cases.

### Finding C — Upstox imports unrelated cash/index instruments
- **Raised at:** `85bb8a6`. File: `upstox-master.ts`.
- **Concern:** Upstox imported every supported cash/index row, unlike FYERS which filters to referenced underlyings.
- **Current disposition: FIXED (independently verified).** `upstox-master.ts:89-100` Pass 0 collects `referencedUnderlyingKeys` from supported FO CE/PE rows; Pass 1 at `:133` skips EQ/INDEX rows whose `instrument_key` is not referenced. An option referencing a missing underlying is recorded as `unresolvedUnderlyings` and fails closed via Finding A's validation. `tests/market/master-import.test.ts` proves unrelated EQ/INDEX rows are skipped.

### Finding D — Index-option cross-provider canonical identity may diverge
- **Raised at:** `85bb8a6`. Files: `identity.ts`, both master parsers, fixtures, `master-import.test.ts`.
- **Concern:** the convergence test covered a stock option, not an index option; `indexIdentityBasis()` prefers `exchangeSecurityId` over `stableIdentifier`, and fixtures used different index tokens (Upstox `9999`, FYERS `26009`), so index identities could diverge.
- **Current disposition: HONESTLY RESOLVED AS A REAL LIMITATION (independently verified).** `tests/market/master-import.test.ts:206-251` verifies each provider resolves its own documented index underlying within its own snapshot (Upstox `NSE_INDEX|Nifty 50` token `9999`; FYERS `NSE:NIFTY50-INDEX` via `underFyTok`/`fyToken` `101000000026009`), then explicitly asserts **non-convergence** (`:243-246`) with a comment explaining that the masters carry provider-specific index tokens and no shared ISIN. No shared identity was fabricated and no display-name matching shortcut was introduced. **This remains a known limitation, not a bug fix:** cross-provider index-option convergence is not achievable from these masters without a source-correct shared identifier. If future requirements demand it, record options/tradeoffs for ChatGPT review before implementation.

### Finding E — Phase 4 canonical plan close-out
- **Raised at:** `85bb8a6`. File: `docs/METADATA_DISCOVERY_PHASE_4_PLAN.md`.
- **Concern:** planning-only wording and original `cbb4e44` research baseline despite implementation being published.
- **Current disposition: FIXED (independently verified).** The single canonical plan now has status "Complete and published" (line 3) and a `## 13. Close-out record (2026-11-24)` (lines 709+) listing WP commits, KEEP audits, the technical-lead fix-forward closure, verification figures and remaining separate gates. No second Phase 4 plan exists.

**Additional fix after the review — Windows `EBUSY` test flake (`2ed4c1e`):** root cause was Bun's `Database.close()` deferring OS handle release to GC finalization while the sync cleanup helper's blocking `Atomics.wait` starved finalizers under parallel load. Fix: `removeTempDirAsync` yields via `await Bun.sleep()` between GC-forced attempts (retry count unchanged); two supervisor harnesses adopted it; production DB behavior untouched. Audited KEEP with two independent full-suite runs at 1076/0.

---

## 8. Verification honesty and known documentation drift

### 8.1 Test evidence — label carefully
- **Agent-reported at the `85bb8a6` baseline (from the handoff request):** WP4A focused 83, WP4B focused 27, WP4C focused 38; full suite 1061 pass / 2 fail (reported as Windows `EBUSY` temp-dir cleanup flakes in untouched supervisor tests, 45/45 in isolation); typecheck/build/diff-check reportedly passed. These are **agent-reported local results**, not CI.
- **Independently re-run by the audit agent after `13826fb`:** focused suites 118/0 and 52/0; full suite 1073 pass / 1 fail (one `EBUSY` flake, 19/19 in isolation); typecheck/build/diff-check clean.
- **Independently re-run by the audit agent after `2ed4c1e` (then-current HEAD; current HEAD is `d19d721`):** full suite **1076 pass / 0 fail** on two consecutive runs; typecheck/build/diff-check clean. This is historical evidence and is **independently verified by the audit agent, still local — not CI**.
- **CI:** GitHub status checks were empty when the user checked the Phase 4 commits. Do not call any of the above CI results. A fresh ChatGPT should re-run the suite and re-check GitHub before making claims.

### 8.2 Rejected approaches (preserve the reasoning)
- **Direct NSE/BSE exchange-master ingestion in Phase 4** — rejected as unnecessary complexity; broker masters cover the supported universe. Exchange feeds remain a possible future enhancement only with a demonstrated coverage/validation gap.
- **"Automatic" provider option / FYERS default** — rejected in WP6B; explicit-only selection derived from `providerIdSchema`.
- **Live option-chain APIs to populate the expiry dropdown** — rejected: authenticated/rate-limited/entitlement-constrained and Stage-G gated; local masters are the source.
- **JSON blob for provider mappings** — rejected in favor of the existing indexed `provider_instrument_mappings` table with built-in merge/conflict logic.
- **Increasing retry counts to fix the `EBUSY` flake** — rejected as a patch; the real fix yields the event loop so GC finalizers can release the handle.
- **Fabricating a shared index identity** — rejected; the honest non-convergence is tested instead.

### 8.3 Stale documentation entries observed (independently verified — do not treat as authoritative status)
These are documentation drift, not code defects. They should be corrected in a future documentation-only task with authorization, not during this handoff:
- `docs/PROJECT_STATUS.md` §3.15 (lines 157-165) still reports the old verification figures (1061/2) and does not mention `13826fb`, `1b51427` or `2ed4c1e`.
- `docs/METADATA_DISCOVERY_PHASE_4_PLAN.md` §13 close-out record (line 724) still reports 1073/1 rather than the final 1076/0.
- `docs/METADATA_DISCOVERY_IMPLEMENTATION_PLAN.md` line 23 dependency table still says Phase 4 "Deferred — blocked", contradicting its own status line and §0/§1 text.
- `docs/REFERENCES.md` is modified in the working tree (pre-existing user work) and must be preserved, not reverted.

---

## 9. How the next ChatGPT conversation should continue

1. **Read this handoff document first.**
2. **Check current GitHub `develop` and `main` SHAs** and local `git status`; compare with section 1. Do not trust recorded SHAs without checking.
3. **Read the current `docs/PROJECT_MANAGER_PROTOCOL.md` and `docs/METADATA_DISCOVERY_PHASE_4_PLAN.md`** (including §13 close-out record).
4. **Check current code for Findings A–D** using the exact paths and line evidence in section 7. Compare with tests and the latest agent reports.
5. **Produce an independent technical disposition** for each finding: confirmed, not confirmed, fixed, or still open. Do not label a finding resolved without source and test evidence.
6. **Recommend a small fix-forward work package only after understanding all findings.** No new architecture, database, framework or provider integration.
7. **Get the user's explicit authorization before code changes or publication.** Explain recommendations in plain English with reasons and consequences.
8. **Do not automatically start Phase 7.** First close any genuinely open Phase 4 issues and obtain final technical acceptance. Phase 7 (cross-system acceptance) is separately gated, requires all prior phases complete, and has its own authorization requirement.

---

## 10. Writing and labeling conventions used in this document

- Statements are labeled **independently verified** (checked directly against local checkout/`origin` in this session), **agent-reported** (from an executor/auditor report, not independently re-checked here), **user-approved**, **recommended but not approved**, or **unresolved** wherever the distinction matters.
- Exact repository-relative paths, commit SHAs and source links are included.
- A timeline of decisions, corrections and current work is in sections 5 and 7.
- Rejected approaches and their reasons are in section 8.2.
- The user's preference for simple, understandable explanations and durable, non-enterprise solutions is recorded in sections 2 and 3.
- No credentials, tokens, private account data or irrelevant personal/health information are included.
- No claim of a completed audit or test is made without evidence; where evidence is agent-reported rather than independent, it is labeled as such.

---

## 11. Scope and publication restrictions for this handoff task

This document is a **handoff aid only**. It is not a new governing architecture plan and grants no implementation or publication permission.

- **Created only (at original creation time):** `docs/CHATGPT_HANDOFF_CONTEXT.md` (this file). It did not previously exist; no duplicate or numbered copy was created. **It was subsequently committed in `1ddf24b` and is now tracked (present at `72743cf`, `9f99b9a` and current HEAD `d19d721`) — it is not untracked in the current repository state.**
- **Not modified:** `docs/METADATA_DISCOVERY_PHASE_4_PLAN.md`, `docs/PROJECT_STATUS.md`, any code or test file, any other documentation, and any pre-existing user work.
- **No commit, push, merge, rebase, branch change or other Git write was performed** as part of creating this document. (The later `1ddf24b` commit was a separate, authorized documentation publication.)
- **Pre-existing user work preserved:** ` M docs/REFERENCES.md` and `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md`.

**`git status --short` before creating this document (historical, independently verified at creation time):**
```
 M docs/REFERENCES.md
?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md
```

**`git status --short` after creating this document (historical, independently verified at creation time):**
```
 M docs/REFERENCES.md
?? docs/CHATGPT_HANDOFF_CONTEXT.md
?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md
```

These two blocks are **historical snapshots from the original creation task**. In the current state the handoff file is tracked (added in `1ddf24b`), and the working tree contains only the two preserved user-work items. The only difference at creation time was the addition of the requested handoff file; all pre-existing user work is untouched.

---

**End of handoff context.**

---

## 12. Reconciliation note (2026-11-25) — current state supersedes historical SHAs

> **Scope:** documentation-only reconciliation. This handoff was written on 2026-11-24 as a snapshot for a fresh ChatGPT conversation. Its recorded SHAs, "current HEAD" labels, "awaiting independent review" wording and "not accepted" status statements were **accurate at that time** and are preserved unchanged above as historical evidence and decisions. They are **not** claims about the current repository. This note corrects the stale references without rewriting the historical record.

- **Current HEAD (updated 2026-11-25):** `28a2f3416f9ddcfdf5fab72abc4f3e26671d04b6` on `develop` — the closeout is **PUBLISHED** there (commit `docs(m6): close B4, D, E and combined acceptance gates`, 12 files: 8 docs + 4 tests); `develop` and `origin/develop` are both at `28a2f34`. The earlier "current HEAD `d19d72120d8dd34a064f63fbe644dc67b61a15a7`" references in §§1, 5, 8 and 11 are **historical**. Historical pre-publication snapshot (2026-11-25): at that time HEAD was `9b47bdd8d8fafaab138bbff83ebc2cf716617041` and the closeout documentation and the two new E tests were uncommitted in the working tree; that state was superseded by the publication at `28a2f34`. `main` / `origin/main` remain untouched at `865d86f393a29bc1ec8d455a51d9efa82d722c48`.
- **M6 status correction:** the "Corrections published in `9f99b9a`; awaiting independent review; not implementation-authorized" and "B4/D/E not accepted; M6 not complete" statements in §§1, 5 and 8 are **historical**. As of 2026-11-25, **M6-B4, M6-D and M6-E are all ACCEPTED**, the combined §8.3 gate is **PASSED**, and **M6 is accepted and closed**. Acceptance records: [`M6_B_PLAN.md`](M6_B_PLAN.md) §12, [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md) §14/§8.3.1, [`M6_PLAN.md`](M6_PLAN.md) §16, [`PROJECT_STATUS.md`](PROJECT_STATUS.md) §8.
- **Independent review:** three fresh-context reviews by `opencode/iceman-free`, all verdict **KEEP**, no blockers/majors. Reviewed ranges (historical pre-publication snapshot, 2026-11-25): B4 — `9b47bdd` committed B4 scope (E tests excluded, uncommitted at review time); D — `9b47bdd` committed D scope (E/B4 fixes excluded, uncommitted at review time); E — `9b47bdd` plus E test changes (uncommitted at review time). Those excluded/uncommitted changes were subsequently published with the closeout at `28a2f34`.
- **Verification correction:** the historical 1076/0 figure at `2ed4c1e` (§§1, 7, 8) is retained for comparison. The **final** full suite is **1115 pass / 0 fail**, 9164 `expect()` calls, 96 files, exit 0 (baseline 1113/0 at `8291738`, +2 = two new E tests); `bun run typecheck` and `bun run build` exit 0 (pre-existing web chunk >500 kB warning); `git diff --check` clean. **All results are local agent-reported evidence — NOT CI**; GitHub reported zero status checks / workflow runs.
- **Preserved user work:** `docs/REFERENCES.md`, `docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` and `docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md` remain preserved and untouched by this closeout.
- **Unchanged gates and decisions:** Stage G, M5 Phase 4B and M7 remain locked; no live provider connection, live REST verification, production activation or provider activation occurred; production drivers remain locked. The LAN scope decision (physical LAN out of revised M6 scope), the CLOSED — MITIGATED slow-consumer decision, the 16 KiB / 96-frame caps, SDK 2.4.0, dependencies, manifests, lockfiles, DB and all application source/tests are unchanged. The section 7 findings A–E dispositions and section 8.2 rejected approaches remain as recorded — this note does not claim they proved more than they did.

---

## 13. Latest-state reconciliation (2026-11-26) — current state supersedes §12

> **Scope:** documentation-only reconciliation. §12 (2026-11-25) and the original handoff snapshot (2026-11-24) are **preserved as historical** evidence and decisions; their "current HEAD" labels, status statements and SHAs are **not** claims about the current repository. This note records the latest verified state without rewriting that record. Product scope, architecture decisions, the 18-check references and the [`PROJECT_MANAGER_PROTOCOL.md`](PROJECT_MANAGER_PROTOCOL.md) lifecycle remain unchanged.

- **Current HEAD (updated 2026-11-26):** `e440cdd146a1f9b222753b59ade34ae2887db62d` on `develop`; `develop` and `origin/develop` are both at `e440cdd`. `main` / `origin/main` remain untouched at `865d86f393a29bc1ec8d455a51d9efa82d722c48`. The §12 "current HEAD `28a2f3416f9ddcfdf5fab72abc4f3e26671d04b6`" and all earlier HEAD references (`d19d721`, `9b47bdd`, `9f99b9a`, `2ed4c1e`, etc.) are **historical**.
- **Commits since `28a2f34` (all on `develop`, pushed), oldest first:** `c26531a` docs — reconcile market-data discovery and WebUI configuration model; `4c018e0` docs — add catalog refresh reliability remediation plan; `5046188` fix(market-core) — WP1 canonical-scoped identifier supersession + keyed importer lookups; `3d40441` chore — align Bun baseline to 1.4.5 + finalize WP1 documentation; `1fd70bf` docs — incorporate WP0 verified baseline corrections into remediation plan; `905ac1e` docs — correct post-publication Bun, link and G0 acceptance references; `e440cdd` fix(market-core) — WP2–WP4 bounded catalog refresh ingestion + lifecycle hardening (9 files: 5 source + 4 tests).
- **Bun baseline:** declared and installed baseline is now **1.4.5** (aligned at `3d40441`). The WP0-time 1.4.4 declared/installed mismatch is **historical** and preserved in the remediation plan.
- **Catalog refresh remediation (WP1–WP4):** the canonical plan is [`CATALOG_REFRESH_RELIABILITY_REMEDIATION_PLAN.md`](CATALOG_REFRESH_RELIABILITY_REMEDIATION_PLAN.md) (do not duplicate it here). WP1 — identifier supersession reuses the existing indexed `listIdentifiersByCanonicalId`; keyed importer maps; deterministic query-scope tests. WP2 — bounded streaming ingestion for Upstox (~37% RSS reduction, 2-run median) and FYERS (~34%); exact hash/count preservation; fail-closed parsing; atomic snapshot transaction retained; no new dependency and no Worker. WP3 — listener-first scheduling; RUNNING→STOPPING→STOPPED lifecycle; cancellation/drain; DB close after settle; a G0 real-listener API test. WP4 — full verification: **1164/1164 tests locally**, typecheck/build/diff-check clean; **all local, NOT CI** (GitHub reported zero status checks). All stages were independently audited **KEEP** by `opencode/iceman-free`, with fixes for parser escape sequences, fail-closed string primitives and G0 test determinism.
- **Post-publication corrections — UNCOMMITTED (4 files):** after independent review of `e440cdd` the technical lead found substantive gaps; a narrow correction assignment produced four **uncommitted working-tree changes** (NOT published, NOT committed): `packages/market-core/src/sync/refresh.ts` (Upstox array parser now rejects missing/leading/repeated commas, fail-closed); `packages/market-core/src/sync/upstox-master.ts` (restored pre-WP2 validation order — unreferenced cash rows skipped before `canonicalSymbol` validation); `tests/market/catalog-refresh-wp2-upstox.test.ts` (negative tests for invalid separators + independent pre-WP2 golden fingerprints); `tests/market/catalog-refresh-wp2-fyers.test.ts` (independent pre-WP2 golden fingerprints). Verification of these uncommitted changes: focused catalog **70/70 pass**; full suite **1168 pass / 1 fail / 1 error** (pre-existing `runtime.test.ts` timing flake, passes on rerun); typecheck/build/diff-check clean. Do not describe these four files as committed or published.
- **G0 finding — STOP, accepted and NOT bypassed:** real SQLite apply blocks the event loop for its entire duration — a probe showed `/health` fired during a 2,734 ms real apply was answered only after completion. The published G0 test uses a **stubbed apply gate** and does **not** prove responsiveness during real import/apply. Correction 3 (real-apply proof) was **STOPPED**: proving it requires a Worker or an `apply.ts` change, both forbidden without separate approval. **G0 remains unproven/unresolved — do not claim it is fixed.**
- **Design-only G0 architecture investigation (complete, outside the repo):** report at `D:\Coding\OpenCode\user\tmp\opencode\g0-architecture\G0_ARCHITECTURE_RECOMMENDATION.md` (35 KB). Recommendation: move the entire refresh pipeline into a dedicated execution context with its own SQLite connection to the same WAL DB — prefer `Bun.spawn` child process (stable termination/crash isolation), Worker as an alternative with an experimental-termination caveat; transaction-yielding rejected (would expose uncommitted rows). Key evidence: `busy_timeout=5000`, `BEGIN IMMEDIATE` held for the whole apply, probe showed HTTP 1 ms during a 6 s writer transaction, a competing write stalled 5,565 ms then `database is locked`. Residuals: 5 s write contention needs owner acceptance; Worker termination is experimental; a referenced Worker keeps the process alive. Audited **KEEP** with minor findings (all addressed). **Design only — implementation requires separate approval.**
- **Preserved user work:** the seven other modified docs (`IMPLEMENTATION_ROADMAP.md`, `M6_B4_D_E_COMPLETION_PLAN.md`, `M6_B_PLAN.md`, `M6_D_E_PLAN.md`, `M6_PLAN.md`, `OPEN_QUESTIONS_AND_TECHNICAL_RISKS.md`, `REFERENCES.md`) and four untracked docs (`CATALOG_REFRESH_STARTUP_DEFECT.md`, `M4_STAGE_G_M5_PHASE_4B_DATA_COMPLETION_PLAN.md`, `M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md`, `PENDING_REQUIREMENT_PREBUILT_OPTIONS.md`) are pre-existing user work, preserved untouched by this reconciliation.
- **Locked gates unchanged:** Stage G, M5 Phase 4B, M7, Phase 3 and production provider activation remain locked; no live provider connection or live REST verification; no CI claim. This note changes no product scope or architecture decision.

---

## 14. Latest-state reconciliation (2026-11-27) — G0 implementation complete, uncommitted

> **Scope:** documentation-only reconciliation. §§12–13 and the original 2026-11-24 handoff snapshot are **preserved as historical** evidence; their "current HEAD" labels, status statements and SHAs are **not** claims about the current repository. This note records the latest verified state without rewriting that record. Product scope, architecture decisions, the 18-check references and the [`PROJECT_MANAGER_PROTOCOL.md`](PROJECT_MANAGER_PROTOCOL.md) lifecycle remain unchanged.

- **Current HEAD (updated 2026-11-27):** `c70b99909f6e3710076ef34eed0c13505e1dbdff` on `develop`. The §13 "current HEAD `e440cdd146a1f9b222753b59ade34ae2887db62d`" and all earlier HEAD references are **historical**. `main` / `origin/main` remain untouched at `865d86f393a29bc1ec8d455a51d9efa82d722c48`.
- **G0 implementation complete and audited KEEP:** packages **G0-A through G0-E** are implemented; each was independently audited **KEEP**. The previously accepted **G0 STOP finding** (real SQLite apply blocked the API event loop; the old G0 test used a stubbed apply gate) is **resolved** by real-listener / real-child / real-transaction evidence. Canonical design/implementation record: [`G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md`](G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md); the startup defect record [`CATALOG_REFRESH_STARTUP_DEFECT.md`](CATALOG_REFRESH_STARTUP_DEFECT.md) is now marked RESOLVED by its 2026-11-27 note. Architecture: `Bun.spawn` child per provider run with its own SQLite connection to the same WAL DB; two-phase write permit with fail-fast HTTP 503 `CATALOG_WRITE_BUSY`; monotonic generation fencing; fail-closed recovery; atomic snapshot transaction preserved.
- **Verification (local, agent-reported — NOT CI):** full suite **1244 pass / 0 fail**; `bun run typecheck`, `bun run build` and `git diff --check` clean. GitHub reported zero status checks / workflow runs; no CI pass is claimed. No live provider connection or live REST verification was performed.
- **Git state / authorization:** all G0 changes are **uncommitted in the working tree** at `c70b999` — **not published, not committed**. Awaiting product-owner review and explicit commit authorization. No commit, push, merge, rebase, amend or stage was performed by this documentation update.
- **Preserved user work:** all pre-existing modified and untracked docs (including the seven modified docs and four untracked docs listed in §13, plus `G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md`) remain preserved untouched by this reconciliation.
- **Locked gates unchanged:** Stage G, M5 Phase 4B, M7, Phase 3 and production provider activation remain locked; no live provider connection or live REST verification; no CI claim. This note changes no product scope or architecture decision.
