# M6-B3 — MCP Resources, Prompts and Cache Hints

> **Status:** Authoritative B3 contract. **M6-B3 is implemented and published on `develop` at `0d58bbb`** (resources, prompts, cache hints, snapshot pagination), with focused verification passing and independent review clean. Integration into `main` remains a separate authorization. This document itself does not implement anything.
> **Last updated:** 2026-11-20 (corrected after independent review: SDK constructor, URI-template matching, cursor ownership, SQLite index evidence, error mapping, prompt dependency, filter consistency)
> **Depends on:** M6-A (`7860c7f`: Streamable HTTP at `/mcp`, retained STDIO, one shared factory); M6-B1 (`d50b372`, cursor fixes `6fd088d`/`be94219`: catalog-search and event-feed read seams + endpoints); M6-B2 (`0e0ec6d`, HTTP-adapter testability correction `a0e707e`: nine tools over both transports).
> **Governing design:** [`M6_PLAN.md`](M6_PLAN.md) §3.1 (C13–C15), §4.1 (shared factory / `McpServices`), §5 / §5.3 (inventory), §10 (M6-B); [`M6_B_PLAN.md`](M6_B_PLAN.md) §4.2–§4.3 (resources/prompts), §5 (seams), §7 (B3 sub-phase), §8–§9 (tests/acceptance). **§4 of this document is the single authoritative resource-URI contract**; the governing docs link here rather than restating it.

## 1. Objective and boundaries

Register the **resource** and **prompt** halves of the M6 capability inventory through the **single** shared factory in `packages/mcp-core`, for **both** HTTP and STDIO, and satisfy the 2026-07-28 cache-hint requirement. No duplicate registration, no second app/DB/provider, no new runtime dependency, no migration.

**In scope (M6-B3):**
- Register the six **logical** resource capabilities in §4 (implemented as **seven** registrations: 2 static + 5 templates, because snapshot pagination is split into two URI forms) and three prompts in §5, through one shared registration module in `packages/mcp-core`.
- Add **one** `McpServices` method — `listSnapshotsPage` — with one opaque cursor codec owned by market-core, one repository page method, and one read-only STDIO-parity endpoint (§7).
- Configure cache hints correctly on the `McpServer` constructor (§6) and prove them on the 2026 wire.
- Conformance items **C13** (standard resource/prompt operations, deterministic list order), **C14** (opaque pagination), **C15** (cache hints on six cacheable results). C16/C18/C19/C20/C21 remain B4/whole-M6 verification and are **not** claimed here.

**Out of scope — do not start (explicit):**
- **M6-B4:** conformance/parity test suite (`conformance.test.ts`, `parity.test.ts`), deterministic-discovery assertions as a milestone, final C13–C21 evidence. B3 produces capabilities and focused tests; B4 proves conformance/parity.
- **M6-C:** `mcp_activity` table/migration, activity endpoints, WebUI inspection, `startActivity`/`completeActivity`. No activity hooks in `McpServices`.
- **M6-D:** `subscriptions/listen`, event bridge, `handler.notify` wiring, read-after-notify. B3 registers the event-feed **resource** (read side) only.
- **M6-E:** broad integration, real-listener acceptance, concurrent-client/reconnect, standalone in-process LAN simulation (physical LAN reachability out of revised scope).
- Provider activation / Stage G, new dependencies, **database migrations**, auth/RBAC, `x-mcp-header`/`Mcp-Param-*`, futures/market-information tools, and any M6-A transport/CORS/Host-Origin/shutdown change.
- **No new tools and no changes to the nine B2 tool contracts.** B3 adds resources and prompts only.

**Fixed decisions (evidence in the cited sections):**
1. **§4 is the canonical URI contract.** The template strings are chosen to match the installed SDK's actual matcher, not RFC 6570 assumptions (§4.1). Governing docs were reconciled to link here.
2. **`markethub://events/alerts` is retained** as a contract-only resource: discoverable, with an honest description and an explicit `unavailable` error (§8). Removing it would silently change the confirmed inventory (`M6_PLAN.md` §5.3, `M6_B_PLAN.md` decision 4); durable alert records are M7.
3. **Snapshot pagination uses an explicit discriminated selector** — `{ kind: "config", configId }` or `{ kind: "null-config" }`. There is **no reserved magic string**: capture-config IDs accept any non-empty string (`optionChainCaptureConfigSchema.id = z.string().min(1)`), so `"none"` is a valid real ID and must remain addressable. The `null-config` selector covers the **null-config partition** (`config_id IS NULL`), which contains **both** on-demand snapshots (`configId = null` at capture) **and** snapshots retained after their capture configuration was deleted (`ON DELETE SET NULL`; `packages/database/src/repositories/snapshots.ts:78-81`, `packages/market-core/src/snapshots/service.ts:62-64`). This is required by the SQLite query plan (§7.3), not a product-scope reduction: unfiltered "all snapshots" browsing remains in the unchanged B2 `option_chain_snapshot` tool (oldest-first, 200 cap).
4. **One opaque cursor codec**, owned by market-core. `McpServices`, HTTP and STDIO forward the cursor unchanged; only market-core decodes it (§7.1). No `afterCapturedAt`/`afterId` in the public seam.
5. **Cache hints** are set in the **second** `McpServer` constructor argument (§6). The explicit values equal SDK defaults; the wire assertion is the actual C15 evidence. No cache abstraction is introduced.
6. **Prompts are static text-only guidance** registered with `registerPrompts(server)` — no `McpServices` dependency (§5).
7. **STDIO parity** uses one read-only endpoint; the opaque cursor is forwarded byte-for-byte (§7.4).

**Protocol re-verification (performed for this revision, 2026-11-20):** official spec index at `https://modelcontextprotocol.io/specification/2026-07-28` still presents `2026-07-28` as the authoritative stable revision; the official TypeScript SDK releases page still marks **2.4.0** as `Latest` (published 23 Oct). Installed and locked versions are confirmed `2.4.0` (`bun.lock`, three workspace manifests). No retarget is needed. Re-verify again at implementation start; a `draft` spec is never a target.

## 2. Verified baseline (checked against source and installed SDK at `ca14e7b`)

| Fact | Evidence |
|---|---|
| Factory registers only the nine B2 tools; no resources/prompts/cache hints | `packages/mcp-core/src/factory.ts:11-16` — `new McpServer({ name, version })`, `registerTools` only |
| `McpServices` has 11 operations; no `listSnapshotsPage`, no activity hooks | `packages/mcp-core/src/services.ts:88-100` |
| `registerTools` registers nine tools in normative order | `packages/mcp-core/src/tools.ts:35-183` |
| HTTP adapter is extracted and testable; uses injected instances only | `apps/api/src/mcp-services.ts:18-87` |
| STDIO adapter is a thin local-API client; `listSnapshots` calls `GET /api/snapshots` | `apps/mcp-server/src/services.ts:12,183-197` |
| `SnapshotStore.listSnapshots` is oldest-first, default cap 200; no page method | `packages/market-core/src/snapshots/service.ts:7-15,66-68`; `packages/database/src/repositories/snapshots.ts:100-109` |
| Only snapshot index is `(config_id, captured_at)`; no `captured_at`-leading index | `packages/database/src/schema.ts:351-365`; migration `0005_bitter_kronos.sql:61-71` |
| **`McpServer` constructor is `(serverInfo: Implementation, options?: McpServerOptions)`** — `cacheHints` belongs in the **second** argument | installed `dist/mcp-BCJHyo7l.d.mts:3267`; `ServerOptions.cacheHints` at `:2865` |
| Six cacheable methods are a closed set; SDK default is `{ ttlMs: 0, cacheScope: 'private' }` | installed `dist/mcp-BCJHyo7l.d.mts:2696,2685-2689,2860-2865`; `dist/mcp-oHn3ureC.mjs:866-868,971` |
| `registerResource` (string + `ResourceTemplate`), `registerPrompt`, `ResourceTemplate` constructor requiring `list` | installed `dist/mcp-BCJHyo7l.d.mts:3335-3342,3421-3447,3496-3523` |
| Static resources match by exact `uri.toString()`; templates use `UriTemplate.match()` | installed `dist/mcp-oHn3ureC.mjs:1742,1748` |
| `ResourceNotFoundError(uri, message?)` is a `resources/read` miss: wire `-32602`, `data` exactly `{ uri }` | installed `dist/mcp-BCJHyo7l.d.mts:1610-1630` |
| Generic `ProtocolError(code, message, data?)`; `INVALID_PARAMS=-32602`, `INTERNAL_ERROR=-32603` | installed `dist/mcp-BCJHyo7l.d.mts:1590-1608`; core `dist/schemas-DscsoNZN.mjs:101-102` |
| SDK `UriTemplate.match()` requires **all** query variables, in declaration order; empty values do not match; values are **not** percent-decoded; `{name?}` makes `?` part of the variable name | installed `dist/src-DdvbAHrR.mjs` `UriTemplate.partToRegExp`/`match`; verified by read-only runtime snippets (§10) |
| SQLite `EXPLAIN QUERY PLAN`: existing index needs a temp B-tree for the `id` tie-break and a full scan for unfiltered ordering | read-only `EXPLAIN QUERY PLAN` on a representative in-memory table (§7.3) |

## 3. `McpServices` expansion (B3-only)

Add exactly one method to `packages/mcp-core/src/services.ts`:

```ts
// Selector is owned by market-core (packages/market-core/src/snapshots/page.ts)
// and imported as a type here. No magic string; "none" is a valid config id.
export type SnapshotPageSelector =
  | { kind: "config"; configId: string }
  | { kind: "null-config" };

// B3 — newest-first bounded snapshot page. Cursor is opaque end-to-end.
// The error carries a discriminator so the resource can distinguish an unknown
// config selector (genuine not-found) from a valid config with an empty page.
export type McpSnapshotPageResult =
  | { ok: true; value: { snapshots: McpOptionChainSnapshot[]; nextCursor: string | null } }
  | { ok: false; error: { category: "validation" | "unavailable" | "internal"; message: string; reason?: "unknown_config" } };

listSnapshotsPage(req: {
  selector: SnapshotPageSelector;  // discriminated; forwarded unchanged by both adapters
  limit: number;                   // 1..100, clamped in the service
  cursor?: string;                 // opaque; absent or "first" => first page
}): Promise<McpSnapshotPageResult>;
```

- **No `fromMs`/`toMs`** (no product requirement for date filtering in the paginated resource; the B2 tool keeps its existing filter). **No `afterCapturedAt`/`afterId`** in the public seam — those are internal keyset fields used only inside market-core (§7.1).
- `McpSnapshotPageResult` is the only new result type in mcp-core; it extends the `McpResult` error shape with one optional `reason` discriminator. All other `McpResult<T>` types stay unchanged. No activity hooks, no subscription methods, no speculative seams.
- Barrel `packages/mcp-core/src/index.ts`: export the two new registration functions and `McpSnapshotPageResult`.

## 4. Resource inventory — canonical URI contract

Register in `packages/mcp-core/src/resources.ts` via `registerResources(server, services)`. Use one shared helper to build `ReadResourceResult` (`{ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] }`) and one shared error helper (§8). **Never return an empty success for a failed operation.**

### 4.1 Verified URI-template rules (installed SDK 2.4.0)

These are measured behaviors of `UriTemplate.match()` / `partToRegExp`, not RFC 6570 assumptions:

- **All query variables are required and order-fixed.** `{?a,b}` compiles to `\?a=([^&]+)&b=([^&]+)`; a missing variable, a different order, or an empty value (`a=`) yields **no match**. There is no optional-variable support in matching.
- **First page uses a reserved non-empty sentinel** `first` for the cursor variable (`cursor=first`, `after=first`). The resource handler translates `first` to "no cursor" before calling the service. An empty value cannot be used.
- **`match()` does not percent-decode.** The callback receives raw strings (e.g. `NIFTY%20INDEX`, `r%3A5`). The callback **must** call `decodeURIComponent` on every variable before validation/use. `expand()` does encode with `encodeURIComponent`, so expand→match is symmetric only after decoding.
- **Path variables `{}` match `[^/,]+`** — a literal `/` or `,` in a value breaks matching. Clients must percent-encode such values; the callback decodes them.
- **`{name?}` is invalid**: the `?` becomes part of the variable name (`configId?`). Do not use it.
- **`expand({})` is asymmetric** for query templates (produces the bare URI, which `match()` rejects). Discovery uses `resources/templates/list`, not expansion of empty variables.
- **Static string-URI resources** are matched by exact `uri.toString()`; they cannot carry inputs.
- `ResourceTemplate` requires a `list` callback even if `undefined`; for non-enumerable templates pass `list: undefined` and rely on `resources/templates/list` for discovery.

### 4.2 Canonical resources (six logical capabilities / seven registrations)

| # | Canonical template / URI | Example concrete URI | Required inputs | Service call | Success body | Failure / special |
|---|---|---|---|---|---|---|
| 1 | `markethub://catalog/instruments{?query,limit,cursor}` | `markethub://catalog/instruments?query=NIFTY&limit=25&cursor=first` | `query` (non-empty), `limit` (1–100), `cursor` (`first` or opaque) | `searchCatalog({ text, limit, afterCanonicalId })` | `{ instruments, nextCursor }` | empty query → invalid params; `first` → no `afterCanonicalId` |
| 2 | `markethub://market/snapshot` | `markethub://market/snapshot` | none | `getLiveSnapshot()` | `liveSnapshotSchema` value | service failure → explicit error (§8) |
| 3 | `markethub://historical/{canonicalId}/{interval}{?from,to}` | `markethub://historical/NIFTY%20INDEX/1d?from=2026-01-01&to=2026-02-01` | `canonicalId`, `interval`, `from`, `to` (ISO-8601) | `getCachedCandles` + `getCoverage` (same range) | `{ candles, coverage }` | invalid/reversed range → invalid params via shared `parseRange` |
| 4a | `markethub://snapshots/config/{configId}{?cursor}` | `markethub://snapshots/config/none?cursor=first` | `configId` (any real non-empty id, **including `"none"`**), `cursor` (`first` or opaque) | `listSnapshotsPage({ selector: { kind: "config", configId }, limit: 25, cursor })` | `{ snapshots, nextCursor }` | unknown config → not-found (via `getCaptureConfig()`); malformed/mismatched cursor → invalid params |
| 4b | `markethub://snapshots/null-config{?cursor}` | `markethub://snapshots/null-config?cursor=first` | `cursor` (`first` or opaque) | `listSnapshotsPage({ selector: { kind: "null-config" }, limit: 25, cursor })` | `{ snapshots, nextCursor }` | null-config partition (on-demand **and** config-deleted snapshots); malformed/mismatched cursor → invalid params |
| 5 | `markethub://events/live{?after,limit}` | `markethub://events/live?after=first&limit=25` | `after` (`first` or opaque), `limit` | `readEventFeed({ after, limit })` | discriminated `McpFeedPage` | `snapshotRequired` is a **valid** body (no `resumeCursor`); service failure → explicit error |
| 6 | `markethub://events/alerts` | `markethub://events/alerts` | none | none | — | contract-only: explicit `unavailable` error, honest description, never empty |

- **Six logical capabilities, seven registered resources:** 2 static (`markethub://market/snapshot`, `markethub://events/alerts`) and 5 templates (catalog, historical, snapshots/config, snapshots/null-config, events/live). Register in table order; assert `resources/list` (static, in order) and `resources/templates/list` (templates, in order) in tests (C13). The split into two snapshot templates is required to keep `"none"` a valid config ID.
- Resource descriptions must state the cursor kind: #1/#4 use stored-data opaque cursors; #5 uses a **runtime-scoped** cursor that does not survive restart (`M6_PLAN.md` §6.1).
- No unfiltered catalog listing resource (`M6_PLAN.md` §5.1).

## 5. Prompt inventory (three prompts)

Register in `packages/mcp-core/src/prompts.ts` via **`registerPrompts(server)`** — no `services` argument. Prompts are static text; they do not call services or tools and have no side effects. Each returns `GetPromptResult` (`{ messages: [{ role: "user", content: { type: "text", text } }] }`).

| # | Name | Args (`argsSchema`) | Guidance content |
|---|---|---|---|
| 1 | `explain_market_snapshot` | `{ canonicalId?: string }` | How to read `market_snapshot` / `markethub://market/snapshot`: revision, capturedAtMs, selected provider, canonical fields, honest empty state |
| 2 | `interpret_coverage_gaps` | `{ canonicalId: string, interval: string, from: string, to: string }` | How to use `historical_candles` mode `coverage` and interpret gaps/unavailable notes; never invent missing candles |
| 3 | `how_to_capture_snapshot` | `{}` | How to use `option_chain_snapshot` mode `capture`; states it persists with `configId = null` and does not change saved capture config |

- Use Zod `argsSchema` wrapped with `z.object` (SDK `dist/mcp-BCJHyo7l.d.mts:3421-3447`). Deterministic `prompts/list` order = table order. Invalid args → SDK validation error.

## 6. Cache hints (C15)

In `packages/mcp-core/src/factory.ts`, pass hints as the **second** constructor argument:

```ts
const server = new McpServer(
  { name: "markethubts", version: "0.1.0" },
  {
    cacheHints: {
      "server/discover":          { ttlMs: 0, cacheScope: "private" },
      "tools/list":               { ttlMs: 0, cacheScope: "private" },
      "prompts/list":             { ttlMs: 0, cacheScope: "private" },
      "resources/list":           { ttlMs: 0, cacheScope: "private" },
      "resources/templates/list": { ttlMs: 0, cacheScope: "private" },
      "resources/read":           { ttlMs: 0, cacheScope: "private" }
    }
  }
);
```

- The six methods are the closed `CACHEABLE_RESULT_METHODS` set (`dist/mcp-BCJHyo7l.d.mts:2696`). No other operation receives cache fields.
- These values **equal the SDK defaults** (`ttlMs: 0`, `cacheScope: 'private'`); the explicit configuration documents intent but is not what makes C15 pass — the **wire assertion** in `cache-hints.test.ts` is the evidence. Invalid values throw `RangeError` at construction (`dist/mcp-oHn3ureC.mjs:866-868`).
- `server/discover` is installed on the server instance and reads the same hint map (`dist/mcp-oHn3ureC.mjs:827,971`); `CreateMcpHandlerOptions` has no cache-hint field.
- Per-resource `registerResource(..., { cacheHint })` overrides field-by-field for that resource's `resources/read` (`dist/mcp-BCJHyo7l.d.mts:2854-2858,3335-3342`). **B3 sets none.** No cache abstraction is added.
- Same scope across pages holds by construction. MRTR is unused (C16 N/A, asserted in B4). 2025-era responses are unaffected (cache fields are 2026-wire-only).

## 7. Snapshot pagination and cursor contract

### 7.1 One opaque cursor codec (market-core owns it)

- **Structure:** versioned `v1.<base64url(JSON)>` where JSON is `{ c: <capturedAt ISO string>, i: <snapshot id>, s: <SnapshotPageSelector> }`. Version prefix allows future evolution without breaking old cursors silently.
- **Selector binding:** decode verifies `s` deep-equals the requested discriminated selector (`{ kind: "config", configId }` or `{ kind: "null-config" }`); a mismatch is a validation error. A cursor cannot be replayed against a different config or across the config/null-config boundary. In particular, if a configuration is deleted between page requests its snapshots move to the null-config partition, and the old config-scoped cursor **must not** be silently reused with the `null-config` selector — the selector mismatch is rejected.
- **First page:** `cursor` absent at the `McpServices` layer; the resource maps the `first` sentinel to absent. No cursor is fabricated for the first page.
- **Malformed cursor:** undecodable, wrong version, missing fields, or filter mismatch → validation error (`-32602`), **never** a silent empty page.
- **Expiration and anchor-row deletion:** **cursors do not expire** — no TTL or expiry is implemented, and none is claimed. A cursor is a **self-contained keyset boundary** (`capturedAt`, `id`, config selector); the repository's comparison `(captured_at < ?) OR (captured_at = ? AND id < ?)` does **not** require the anchor row to exist. Therefore a cursor is **not invalidated when its anchor row is deleted** (e.g. by retention cleanup). Do **not** add an anchor-row existence check — it would cost an extra database lookup on every page and would break naturally with retention cleanup. Deleting the anchor row between page requests must still yield the correct next page.
- **Final page:** `nextCursor: null` when the `limit + 1` lookahead finds no extra row; the lookahead row is discarded.
- **Tie-breaking:** `captured_at DESC, id DESC` (stable UUID `id`), encoded in the cursor.
- The codec lives in `packages/market-core/src/snapshots/` (small dedicated module). `McpServices`, HTTP and STDIO treat the cursor as an opaque string; only market-core encodes/decodes it. No duplicate codec in MCP, REST adapters, HTTP/STDIO adapters or the repository.

### 7.2 Store / service / repository

- `SnapshotStore.listSnapshotsPage(filter: { selector: SnapshotPageSelector; limit: number; afterCapturedAt?: string; afterId?: string }): OptionChainSnapshot[]` in `packages/market-core/src/snapshots/service.ts` returns `limit + 1` rows (lookahead). `OptionChainSnapshotService.listSnapshotsPage` decodes the opaque cursor into `afterCapturedAt`/`afterId`, calls the store, trims to `limit`, and encodes `nextCursor`. `listSnapshots` stays unchanged for REST/WebUI.
- **Config-selector validation (required):** for `{ kind: "config", configId }`, `OptionChainSnapshotService.listSnapshotsPage` **must call the existing `getCaptureConfig(configId)`** (`packages/market-core/src/snapshots/service.ts:54-56`; repository `:42-58`) before reading the page. `null` means the configuration is unknown → return `ok: false` with `reason: "unknown_config"` (the resource maps this to `ResourceNotFoundError`). A non-null config with zero snapshots is a **valid empty page** (`ok: true`, `snapshots: []`, `nextCursor: null`), never not-found and never an error. For `{ kind: "null-config" }`, skip this check — the partition is valid by definition and includes both on-demand snapshots and snapshots retained after config deletion (`ON DELETE SET NULL`). This distinction must not be inferred from an empty result.
- **Deletion race:** config validation and page retrieval are two repository calls. A config deleted between them moves its snapshots to the null-config partition; the next config-scoped page may then be empty. This is an honest, bounded outcome (no fabricated data, no cross-selector cursor reuse because the cursor is selector-bound). No new transaction or abstraction is introduced for this rare race.
- Repository (`packages/database/src/repositories/snapshots.ts`): `WHERE config_id = ?` (config selector) or `WHERE config_id IS NULL` (null-config selector) + keyset `(captured_at < ?) OR (captured_at = ? AND id < ?)` + `ORDER BY captured_at DESC, id DESC LIMIT limit + 1`. `limit` default 25, max 100. The repository receives the **selector** and **internal keyset fields only**, never the opaque cursor.

### 7.3 SQLite query plan — evidence and decision

`EXPLAIN QUERY PLAN` on a representative 5,000-row table with the **existing** `(config_id, captured_at)` index produced:

| Query | Plan |
|---|---|
| `WHERE config_id = ? ORDER BY captured_at DESC, id DESC LIMIT 26` | `SEARCH ... USING INDEX (config_id=?)` + **`USE TEMP B-TREE FOR LAST TERM OF ORDER BY`** |
| `WHERE config_id IS NULL ORDER BY captured_at DESC, id DESC LIMIT 26` | `SEARCH ... USING INDEX (config_id=?)` + **`USE TEMP B-TREE FOR LAST TERM OF ORDER BY`** |
| unfiltered `ORDER BY captured_at DESC, id DESC LIMIT 26` | **`SCAN option_chain_snapshots`** + **`USE TEMP B-TREE FOR ORDER BY`** |
| unfiltered, with a hypothetical `(captured_at DESC, id DESC)` index | `SCAN ... USING COVERING INDEX` (ordered, no temp B-tree) |

**Decision:** the existing index serves the `config_id` prefix (including `IS NULL`) but **not** the `id` tie-break, and **does not** support unfiltered newest-first ordering. Therefore:
- The paginated resource **requires an explicit config selector** (§1 decision 3). Unfiltered browsing stays in the unchanged B2 tool.
- The `id` tie-break uses a temp B-tree **over one config's partition only**, which retention bounds. This is acceptable and is documented honestly — the plan does **not** claim index-only ordering.
- **No migration in B3.** If unfiltered newest-first pagination is ever required, it needs a separate additive `(captured_at DESC, id DESC)` index migration with its own authorization; that is a documented future decision, not a silent B3 change.

### 7.4 STDIO parity endpoint

- Add read-only **`GET /api/snapshots/page?scope=config&configId=<id>&limit=<n>&cursor=<opaque>`** and **`GET /api/snapshots/page?scope=null-config&limit=<n>&cursor=<opaque>`** → `{ snapshots, nextCursor }`. No `from`/`to` (§3). Strict validation: `scope=config` requires a non-empty `configId`; `scope=null-config` must not receive `configId`; unknown scopes, missing/conflicting parameters and non-integer/out-of-range `limit` → 400 validation error; unknown config → 404 not-found. A real config ID equal to `"none"` remains valid. Register in `snapshot-routes.ts` **before** the dynamic `GET /api/snapshots/:id` route, and the router before the SPA fallback in `app.ts`. No `isLocalPeer` requirement (read-only LAN model), consistent with B1 parity endpoints.
- `McpServicesStdio.listSnapshotsPage` maps `selector.kind` to `scope`, forwards `configId` (config scope only), `limit` and the **opaque cursor unchanged**, and validates the response with `optionChainSnapshotSchema` (pattern: `apps/mcp-server/src/services.ts:183-197`). It maps 404 to `reason: "unknown_config"` and 400 to a validation error.
- `McpServicesHttp.listSnapshotsPage` calls `snapshotService.listSnapshotsPage` directly with the same injected instances as REST — never through guarded REST routes.

## 8. Error semantics (verified against installed SDK)

`ResourceNotFoundError` is **only** for a genuine `resources/read` miss; it is not a generic mapper. Mapping:

| Condition | Throw | Wire |
|---|---|---|
| Malformed/unparseable URI | SDK before callback: `ProtocolError(INVALID_PARAMS, ..., { uri, reason: "invalid_uri" })` | `-32602`, `data` has `uri` **and** `reason` |
| Invalid input, invalid/reversed range, malformed cursor, or cursor whose bound selector differs from the requested selector | `new ProtocolError(INVALID_PARAMS, sanitizedMessage)` — **no `data.uri`** | `-32602` (distinguishable from not-found by absent `data.uri`) |
| Genuine not-found: `{ kind: "config", configId }` where `getCaptureConfig(configId)` returns `null` (mapped from `reason: "unknown_config"`) | `new ResourceNotFoundError(uri)` | `-32602`, `data` exactly `{ uri }` |
| Provider/service unavailable; contract-only `events/alerts` | `new ProtocolError(INTERNAL_ERROR, "unavailable in M6 — <reason>")` | `-32603` |
| Database/internal failure | `new ProtocolError(INTERNAL_ERROR, generic sanitized message)` | `-32603` |

- Never return an empty success for a failed operation. Never expose credentials, provider-native identifiers, raw arguments or unsanitized internal errors; reuse `sanitizeError`/`sanitizeMessage` conventions.
- `ResourceNotFoundError` wire code and `data` shape are documented at `dist/mcp-BCJHyo7l.d.mts:1610-1630`; generic `ProtocolError` at `:1590-1608`; codes at core `schemas-DscsoNZN.mjs:101-102`.

## 9. File scope

**`packages/mcp-core`:** `src/factory.ts` (correct constructor + call `registerResources`, `registerPrompts`); `src/services.ts` (add `listSnapshotsPage`); `src/index.ts` (barrel); **new** `src/resources.ts`, `src/prompts.ts` (`registerPrompts(server)`).

**`apps/api`:** `src/mcp-services.ts` (implement `listSnapshotsPage` via injected `snapshotService`); `src/snapshot-routes.ts` (add `GET /api/snapshots/page` before `/:id`); `src/app.ts` (router registration before SPA fallback).

**`apps/mcp-server`:** `src/services.ts` (implement `listSnapshotsPage` via the new endpoint, forwarding the opaque cursor unchanged).

**`packages/market-core`:** `src/snapshots/service.ts` (`listSnapshotsPage` on `SnapshotStore` + service); **new** `src/snapshots/page.ts` (selector type, versioned opaque cursor codec, page result type); `src/index.ts` (exports).

**`packages/database`:** `src/repositories/snapshots.ts` (implement `listSnapshotsPage`). **No schema/migration change.**

**Tests (`tests/mcp/`):** new `resources.test.ts`, `prompts.test.ts`, `cache-hints.test.ts`, `snapshot-page.test.ts`; extend `tools-adapters.test.ts` and `http-smoke.test.ts`. **No dependency changes.**

## 10. Required focused tests

Tests must exercise the **installed SDK matcher**, not hand-written assumptions. Use `new UriTemplate(...)` / a real pinned client against `handler.fetch` for URI cases.

- **URI matching (`resources.test.ts`):** for each canonical template — exact match with all variables; missing variable → no match; reordered variables → no match; empty value → no match; percent-encoded value delivered raw and decoded by the callback; path value containing `/` percent-encoded; `first` sentinel maps to first page; `{configId?}`-style templates are absent. Assert `resources/list` (2 static) and `resources/templates/list` (5 templates, including both snapshot forms) order.
- **Resource reads:** valid read → JSON `contents`; catalog empty query → invalid params; historical invalid/reversed range → invalid params; snapshot first page and subsequent page (opaque cursor round-trip), final-page `nextCursor: null`, malformed/mismatched cursor → invalid params; **a real config whose ID is exactly `"none"` resolves through `snapshots/config/none` (not the null-config partition)**; **unknown config (`getCaptureConfig()` returns `null`) → not-found, while a valid config with zero snapshots → valid empty page (not not-found, not error)**; **the `null-config` selector returns the whole null-config partition — both an on-demand snapshot and a snapshot whose config was deleted (`ON DELETE SET NULL`)**; `events/live` normal page with `resumeCursor` and `snapshotRequired` envelope without one; `events/alerts` explicit unavailable; service failure → explicit error, never empty success.
- **Prompts (`prompts.test.ts`):** `prompts/list` order; `prompts/get` returns user text; assert **no service calls**; invalid args → validation error.
- **Cache hints (`cache-hints.test.ts`):** wire assertions on 2026 responses that all six methods carry `ttlMs: 0` / `cacheScope: "private"`; same scope across pages; no cache fields on non-cacheable operations; 2025-era responses unaffected if dual-era retained.
- **Snapshot page (`snapshot-page.test.ts`):** newest-first ordering, `id` tie-break with equal `captured_at`, bound (default/max), `limit + 1` lookahead (`nextCursor` present vs `null`), versioned opaque cursor encode/decode round-trip, **selector binding (config vs null-config, and config id `"none"` vs null-config)**, malformed/mismatched cursor rejection, first-page sentinel, **config ID `"none"` works as a real config**, other arbitrary non-empty IDs work, null-config covers both on-demand and config-deleted snapshots, `getCaptureConfig()`-based unknown-config vs valid-empty-page distinction, **anchor-row deletion between page requests still returns the correct next page (no existence check)**, **config deletion between requests does not allow cross-selector cursor reuse**, no change to `listSnapshots`.
- **Adapters (`tools-adapters.test.ts`):** HTTP and STDIO forward the **same opaque cursor unchanged**; STDIO validates the response envelope; no `afterCapturedAt`/`afterId` in the seam.
- **Real HTTP smoke (`http-smoke.test.ts`):** read one resource and get one prompt over the real listener (broad acceptance stays M6-E).
- **Regression:** existing nine B2 tools unchanged (`tools.test.ts`, `tools-adapters.test.ts`).

## 11. Acceptance criteria (M6-B3 exit)

- Six logical resource capabilities registered as seven resources (2 static + 5 templates) and three prompts through the single shared factory; identical over HTTP and STDIO; no duplicate registration.
- `McpServices` contains only `listSnapshotsPage` beyond B2 — no activity hooks, no subscription methods, no `fromMs`/`toMs`, no split cursor fields.
- Canonical URI templates match the installed SDK exactly; first-page sentinel, percent-decoding and required-variable behavior verified by tests.
- One opaque cursor codec in market-core; HTTP/STDIO forward unchanged; no expiration claimed; final page via lookahead; **no anchor-row existence check — cursors remain valid keyset boundaries after row deletion, verified by test**.
- Snapshot pagination uses a discriminated selector with no magic string: `"none"` remains a valid config ID; the `null-config` selector covers the full null-config partition (on-demand **and** config-deleted snapshots); cursors bind the full selector and reject cross-selector reuse; `getCaptureConfig()` distinguishes unknown config (not-found) from a valid empty page; index limitation documented; **no migration**; unfiltered browsing remains in the B2 tool.
- `markethub://events/alerts` discoverable with an explicit `unavailable` error; no fabricated or empty data.
- Cache hints correct on all six cacheable results, verified on the 2026 wire; per-resource override unused; 2025-era unaffected.
- Prompts static, `registerPrompts(server)`, no service calls.
- Error mapping per §8; no empty success on failure; no sensitive data exposed.
- Focused tests, `bun run typecheck`, `bun run build`, `git diff --check` pass; independent diff review before merge.
- **Full suite (`bun test`):** no new failures vs the documented Windows baseline — two `EBUSY` temp-dir cleanup failures in `tests/market/stage-f-timeout.test.ts` and `tests/market/supervisor.test.ts`. Report the exact failure list.
- No B4/C/D/E work, provider activation/Stage G, new dependency, migration, auth/RBAC, or M6-A transport change. No commit/push without separate authorization.

## 12. Failure cases and security boundaries

- Malformed URI/input/cursor → explicit `-32602`; genuine not-found → `ResourceNotFoundError`; unavailable/internal → `-32603`; never empty success.
- No credentials, tokens, provider-native identifiers, raw arguments or unsanitized errors in resources, prompts, errors or logs.
- MCP must not modify operational configuration; all B3 capabilities are reads. LAN reads use the existing model; no new auth framework.
- Bounded work: `limit` clamped 1–100; snapshot page work bounded by the config partition (§7.3); event feed bounded by the existing hub seam.
- Live cursors (`events/live`) do not survive restart; resource descriptions say so. Stored-data cursors do not expire and are **not** invalidated by deletion of their anchor row — they are self-contained keyset boundaries with no existence check (§7.1), so retention cleanup does not break pagination. They **are** rejected when the requested selector differs from the selector bound into the cursor (e.g. after a config is deleted and its snapshots move to the null-config partition).

## 13. Non-goals and separate authorization boundaries

- B4 conformance/parity, M6-C activity/WebUI, M6-D subscriptions/notifications, M6-E integration/LAN, Stage G/provider activation, new dependencies, migrations, auth/RBAC, M6-A transport changes — all excluded.
- A future unfiltered newest-first snapshot index migration requires its own authorization (§7.3).
- No commit/push without separate authorization.

## 14. Reporting format for the implementation assignment

Report: what was implemented; exact files added/modified; dependency changes (expected: none); tests and actual results (including full-suite failure list vs baseline); URI-matching evidence; cursor and index evidence; cache-hint wire evidence; STDIO parity evidence; acceptance-criteria checklist; remaining issues; exact `git status` and HEAD. Do not claim M6-B4/C/D/E or M6 complete. No commit/push without separate authorization.
