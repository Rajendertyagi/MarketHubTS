# M6-E wrapped-SSE stall — technical diagnosis

**Status:** DIAGNOSIS ONLY. No production source, tests, manifests, lockfiles, buffer limits, overflow contract, acceptance status, tracked follow-up, or Phase 3 was changed. No commit/push. All disposable files live in `D:\Coding\OpenCode\user\tmp\opencode\diagnostics\` (outside the repository).

**Classification: ROOT CAUSE CONFIRMED** (for the stall mechanism). The correction is **not** a one-line fix: the smallest change that restores delivery removes the current overflow bound under Bun 1.4.5 (see §8–§9).

---

## 1. Runtime / dependency versions (verified)

| Item | Value | How verified |
|---|---|---|
| Branch / HEAD | `develop`, `02c817f0e7f57aad055891deaed12c9a6e25f7c2` | `git rev-parse HEAD` |
| `origin/develop` | `02c817f0e7f57aad055891deaed12c9a6e25f7c2` | `git rev-parse origin/develop` |
| `main` | `865d86f393a29bc1ec8d455a51d9efa82d722c48` | `git rev-parse main` |
| Working tree (pre-existing, preserved) | ` M docs/REFERENCES.md`, `?? docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md`, `?? docs/PENDING_REQUIREMENT_PREBUILT_OPTIONS.md` | `git status --short --branch` |
| Bun | **1.4.5** (`a7733435c`) | `bun --version`, `bun test` banner |
| `@modelcontextprotocol/server` | **2.4.0** | `node_modules/@modelcontextprotocol/server/package.json` + `bun.lock` |
| Standalone Node.js | **NOT installed on PATH** | environment; all "Node http client" cases use **Bun's `node:http` compatibility** (`require('node:http')` under Bun), which works. This is stated precisely: it is not a standalone Node.js runtime. |
| Wrapper under test | `apps/api/src/mcp-sse-bound.ts` (`boundSseResponse`, `wrapMcpHandlerFetch`) | read in full |

---

## 2. Minimal reproduction steps and commands

All commands run from `D:\Coding\OpenCode\user\tmp\opencode\diagnostics\`:

```powershell
bun exp-c-generic.mjs            # generic Web Streams isolation (key test)
bun exp-b-actual.mjs             # ACTUAL boundSseResponse from repo
bun exp-a-sdk.mjs                # real SDK handler, unwrapped vs wrapped
$env:WRAPPED="1"; bun exp-a-sdk.mjs; Remove-Item Env:WRAPPED
bun exp-d-clients.mjs            # Bun fetch vs Bun node:http client
bun exp-e-node-server.mjs        # Bun node:http SERVER (wrapped case hangs by design)
bun exp-f-alternatives.mjs       # designs A/B/C/D
bun exp-g-more-alternatives.mjs  # designs G/H
bun exp-e-targeted.mjs           # design E (enqueue-on-drain)
bun exp-i-repull.mjs             # design I (re-pull detection)
bun exp-h-minimal.mjs            # smallest pure-Web-Streams demo
bun exp-h2-minimal-detailed.mjs  # instrumented minimal demo (definitive)
```

Disposable source for the two most important experiments is included inline in §4. The rest are on disk at the paths above.

---

## 3. Results A / B / C / D (exact frame counts)

### A — unwrapped baseline, real SDK handler via `Bun.serve()`
Raw modern `subscriptions/listen` POST, 10 `notify.resourceUpdated` publications paced at 20 ms, continuous background drainer (no abandoned reads).

| Variant | Frames | ack | updates | EOF |
|---|---|---|---|---|
| A-unwrapped | **11** | 1 | 10 | yes (after `handler.close()`) |
| A-wrapped (actual wrapper) | **2** | 1 | 1 | stalled (no EOF until close/cancel) |

### B — ACTUAL `boundSseResponse()` via `Bun.serve()`
Generic SSE upstream (10 frames @ 20 ms), imported directly from `D:/Temp/MarketHubTS/apps/api/src/mcp-sse-bound.ts`.

| Variant | Frames | expected | EOF |
|---|---|---|---|
| B-unwrapped | **10** | 10 | yes |
| B-actual-wrapped | **2** | 10 | **no** |

### C — generic Web Streams, NO SDK, NO MarketHub (key isolation test)
Minimal SSE `ReadableStream` + a copy of the wrapper's buffering/drain/pull/waiter mechanism, served via `Bun.serve()`.

| Variant | Frames | expected | EOF | pullCalls | pendingPulls | enqueues | resolveWaitersCalls |
|---|---|---|---|---|---|---|---|
| C-passthrough | **10** | 10 | yes | 0 | 0 | 0 | 0 |
| C-wrapped | **2** | 10 | **no** | 5 | 3 | 2 | 3 |

Identical results at `INTERVAL_MS` = 5, 20, and 50. **The stall reproduces without MarketHub and without the MCP SDK.** It is a generic Web Streams / HTTP-server-boundary interaction with the wrapper's pull/waiter pattern.

### D — client comparison (same wrapped stream, same Bun.serve listener)

| Client | Frames | expected | EOF |
|---|---|---|---|
| Bun `fetch` | **2** | 10 | no |
| Bun `node:http` client (`require('node:http')`) | **2** | 10 | no |

Both clients stall identically. **The client is not responsible.**

### E — second server environment (Bun `node:http` server)
| Variant | Frames | expected | EOF |
|---|---|---|---|
| E-node-http-server-unwrapped | **10** | 10 | yes |
| E-node-http-server-wrapped | server read loop never completes → **hang** | 10 | no |

The wrapped downstream `reader.read()` stalls in the `node:http` server too. The stall is **not specific to `Bun.serve`'s response-body boundary**; it is in the Web Streams pull/waiter mechanism itself. (The experiment was terminated after the unwrapped case completed; the wrapped case hung as predicted.)

### In-process control (repo test, executed)
`bun test tests/mcp/slow-consumer.test.ts` → **4 pass, 0 fail** (21 assertions). The in-process SDK-client path works; the real-listener path stalls. This confirms the tracked follow-up's qualification that the in-process control is not real-listener evidence.

---

## 4. Smallest reproducible example (disposable source included)

### 4.1 Server-level minimal repro (`exp-c-generic.mjs`, abridged to the essential mechanism)

```js
function makeUpstream() {
  let i = 0, timer;
  return new ReadableStream({
    start(c) {
      timer = setInterval(() => {
        if (i >= 10) { clearInterval(timer); c.close(); return; }
        i++;
        c.enqueue(new TextEncoder().encode(`event: message\ndata: {"n":${i}}\n\n`));
      }, 20);
    },
    cancel() { clearInterval(timer); }
  });
}

function wrap(upstream) {
  const reader = upstream.getReader();
  let buffer = [], bufferedBytes = 0, upstreamDone = false, downstreamClosed = false, drainStopped = false;
  let controller = null;
  const waiters = [];
  const resolveWaiters = () => { for (const r of waiters.splice(0)) r(); };
  const closeDownstream = () => { if (downstreamClosed) return; downstreamClosed = true; try { controller?.close(); } catch {} };
  const downstream = new ReadableStream({
    start(c) { controller = c; },
    pull(c) {
      if (buffer.length > 0) { const ch = buffer.shift(); bufferedBytes -= ch.byteLength; c.enqueue(ch); return; }
      if (upstreamDone) { closeDownstream(); return; }
      return new Promise((resolve) => { waiters.push(resolve); }); // <-- pending promise
    },
    cancel(reason) { buffer = []; bufferedBytes = 0; resolveWaiters(); try { void reader.cancel(reason); } catch {} }
  });
  void (async () => {
    try {
      while (!drainStopped) {
        const { done, value } = await reader.read();
        if (drainStopped) break;
        if (done) { upstreamDone = true; resolveWaiters(); break; }
        if (!value) continue;
        buffer.push(value); bufferedBytes += value.byteLength;
        resolveWaiters(); // <-- resolves the pull promise but NEVER calls controller.enqueue()
      }
    } catch { upstreamDone = true; resolveWaiters(); closeDownstream(); }
  })();
  return downstream;
}

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch() { return new Response(wrap(makeUpstream()), { headers: { "content-type": "text/event-stream" } }); }
});
// Client: fetch(url).body.getReader(), count "event: message" for 1.5 s.
// Result: 2 frames, no EOF. Passthrough control: 10 frames, EOF.
```

### 4.2 Pure Web Streams, no server (`exp-h2-minimal-detailed.mjs`)

```js
async function trial(delayMs) {
  const waiters = [];
  let buffer = [], controller, pullCalls = 0, pendingPulls = 0, enqueues = 0;
  const stream = new ReadableStream({
    start(c) { controller = c; },
    pull(c) {
      pullCalls++;
      if (buffer.length > 0) { c.enqueue(buffer.shift()); enqueues++; return; }
      pendingPulls++;
      return new Promise((resolve) => { waiters.push(resolve); });
    }
  });
  const reader = stream.getReader();
  const readPromise = reader.read();            // triggers pull() -> pending promise
  const doResolve = () => {
    buffer.push(new TextEncoder().encode("frame-1"));
    for (const resolve of waiters.splice(0)) resolve(); // exactly what the wrapper does
  };
  if (delayMs > 0) await Bun.sleep(delayMs);
  else await Promise.resolve();                 // one microtask
  doResolve();
  const outcome = await Promise.race([
    readPromise.then((r) => ({ resolved: true, bytes: r.value?.byteLength })),
    new Promise((r) => setTimeout(() => r({ resolved: false }), 200))
  ]);
  return { delayMs, ...outcome, pullCalls, pendingPulls, enqueues, bufferLeft: buffer.length };
}
// Output for delayMs 0, 5, 20:
// {"delayMs":0,"resolved":false,"pullCalls":1,"pendingPulls":1,"enqueues":0,"bufferLeft":1}
// {"delayMs":5,"resolved":false,"pullCalls":1,"pendingPulls":1,"enqueues":0,"bufferLeft":1}
// {"delayMs":20,"resolved":false,"pullCalls":1,"pendingPulls":1,"enqueues":0,"bufferLeft":1}
```

This is the smallest possible demonstration: after the pending pull promise is resolved, `pullCalls` stays at 1, `enqueues` stays at 0, the chunk remains in `buffer`, and `read()` never resolves. (Note: if the waiter is resolved *synchronously in the same tick before `pull()` has run*, `waiters` is empty and the later `pull()` finds the buffered chunk — which is why a naive same-tick demo can appear to work. The wrapper's drain resolves asynchronously, matching the `resolved:false` cases.)

---

## 5. Root cause (CONFIRMED)

**The wrapper's downstream `ReadableStream.pull()` returns a pending promise when its private buffer is empty, and the active drain loop resolves that promise without ever calling `controller.enqueue()`.**

Relevant code (`apps/api/src/mcp-sse-bound.ts`):

- `:146-160` — `pull(c)`: if `buffer.length > 0` it shifts and `c.enqueue(chunk)`; if `upstreamDone || overflowed` it closes; **otherwise it returns `new Promise(resolve => waiters.push(resolve))`**.
- `:124-127` — `resolveWaiters()` splices the waiters and calls their `resolve` callbacks.
- `:174-220` — the active drain loop reads upstream, pushes chunks into `buffer`, and calls `resolveWaiters()` at `:210`. **It never calls `controller.enqueue()` on the data path.**
- `:129-133` — `closeDownstream()` is the only place that calls `controller.close()`, and it is reached only on upstream EOF, overflow, error, or consumer cancel.

Per the WHATWG Streams spec, `ReadableStreamDefaultControllerCallPullIfNeeded` (streams.spec.whatwg.org, §4.9.4) is:

```
Let shouldPull be ! ReadableStreamDefaultControllerShouldCallPull(controller).
If shouldPull is false, return.
If controller.[[pulling]] is true:
  Set controller.[[pullAgain]] to true.
  Return.
Set controller.[[pulling]] to true.
Let pullPromise be the result of performing controller.[[pullAlgorithm]].
Upon fulfillment of pullPromise:
  Set controller.[[pulling]] to false.
  If controller.[[pullAgain]] is true:
    Set controller.[[pullAgain]] to false.
    Perform ! ReadableStreamDefaultControllerCallPullIfNeeded(controller).
```

Consequences, all verified:

1. **Fulfilling a pull promise does not, by itself, re-invoke `pull()`.** It re-invokes only if `pullAgain` was set — i.e., another `CallPullIfNeeded` happened while `pulling === true` (typically a second consumer `read()` arriving during the pending pull).
2. **Bun.serve's response-body sink has exactly one outstanding read at a time.** It does not issue a second read while the first is pending. Therefore `pullAgain` is never set (design I measured `repulls = 0`), and `pull()` is never re-invoked after the waiter is resolved.
3. **A pending read request is fulfilled only by `controller.enqueue()`, `controller.close()`, or `controller.error()`.** The drain loop does none of these on the data path. The chunk stays in the wrapper's private `buffer` array forever.
4. The spec also states: *"it will only be called repeatedly if it enqueues at least one chunk or fulfills a BYOB request; a no-op `pull()` implementation will not be continually called."* The wrapper's `pull()` is effectively a no-op on the empty-buffer path — it violates the expected pull contract.

**Why the first 1–2 frames arrive:** at stream start, the SDK enqueues the ack synchronously in its `start()` (`listenRouter-Bartj63y.mjs:223-246`), and the drain loop may have 1–2 chunks in `buffer` at the moment Bun first calls `pull()`. Those are enqueued synchronously by the `buffer.length > 0` branch. After the buffer empties, every subsequent `pull()` returns a pending promise and the stream stalls. The exact count (1 in exp-a, 2 in exp-b/c/d) is timing-dependent.

**Why the in-process test passes:** the SDK client's in-process transport reads the body with a pattern/timing that either has multiple outstanding reads (setting `pullAgain`) or finds buffered data at `pull()` time (frames are produced rapidly in-process). It works by timing, not by correctness — which is exactly why the tracked follow-up qualifies it as not real-listener evidence.

**This is spec-conformant behavior, not a Bun bug.** Bun's docs (`bun.sh/docs/api/streams`) recommend `start()` + `controller.enqueue()` from events, or async-generator response bodies, for SSE — not a `pull()` that returns a promise which later resolves without enqueueing. Bun issue tracker entries (#32469 backpressure, #48449 header completion, #17947 pending-pull disconnect crash, #7321 buffering) are related context about Bun's response-body boundary but are **not** this root cause.

---

## 6. Relevant source references

**WHATWG Streams spec** — https://streams.spec.whatwg.org/ (Living Standard, last updated 25 Oct 2026)
- §4.2.3 `pull(controller)`: "If the function returns a promise, then it will not be called again until that promise fulfills… it will only be called repeatedly if it enqueues at least one chunk or fulfills a BYOB request; a no-op `pull()` implementation will not be continually called."
- §4.2.4: default queuing strategy is `CountQueuingStrategy` with high water mark **1**.
- §4.9.4 `ReadableStreamDefaultControllerCallPullIfNeeded` and `ReadableStreamDefaultControllerShouldCallPull` (`desiredSize > 0` → pull).

**Bun docs**
- https://bun.sh/docs/api/http — `Bun.serve`, streaming responses, `server.timeout(req, 0)` for SSE, `idleTimeout` 10 s default.
- https://bun.sh/docs/api/streams — "A destination that takes the whole body (`Bun.serve`, `fetch`, …) calls `pull()` once…"; "When the stream is read through a reader… `pull()` is a demand signal… never while a previous call's promise is still pending"; recommended SSE patterns (`start()` + `enqueue`, async generators).

**Bun issue tracker** (context only, not root cause)
- https://github.com/oven-sh/bun/issues/32469 — `Bun.serve` ignores TCP backpressure for `Response(ReadableStream)`; fix in #32475.
- https://github.com/oven-sh/bun/issues/48449 — streaming response header block completed only by first body write; silent stream hangs.
- https://github.com/oven-sh/bun/issues/17947 — SSE stream with pending `pull()` on client disconnect (fixed by #32781).
- https://github.com/oven-sh/bun/issues/7321 — `ReadableStream` reads to completion, does not stream (fixed).

**MCP SDK 2.4.0** (`node_modules/@modelcontextprotocol/server/dist/`)
- `listenRouter-Bartj63y.mjs:182-189` — `writeFrame` plain `controller.enqueue(encoder.encode(frame))`.
- `listenRouter-Bartj63y.mjs:223-246` — `new ReadableStream({ start, cancel })` with **no custom `queuingStrategy`** (default HWM = 1); `start()` enqueues the ack; `cancel()` → `teardown(false)`.
- `listenRouter-Bartj63y.mjs:197-222` — `teardown(graceful)`: unsubscribe, clear keepalive, `controller.close()`.
- `listenRouter-Bartj63y.mjs:253-261` — `new Response(readable, { status: 200, headers: text/event-stream … })`.
- `index.mjs:1172-1176, 1284-1295` — handler composition (already inspected by orchestrator).

**Repo files**
- `apps/api/src/mcp-sse-bound.ts:99-227` — `boundSseResponse` (the defect is at `:146-160` + `:206-210`).
- `apps/api/src/index.ts:150-182` — production composition (wrapper applied before bridge/app/shutdown capture handler identity).
- `tests/mcp/slow-consumer.test.ts:90-99, 144-324` — in-process healthy control (passes).
- `tests/mcp/http-integration.test.ts:190-208, 555-634` — E2 with explicitly qualified in-process control.
- `docs/M6_E_EVIDENCE.md:49-54` — tracked follow-up (OPEN).

---

## 7. Why the current wrapper stalls — step by step

1. Bun.serve receives the wrapped `Response` and acquires a reader on the downstream `ReadableStream`.
2. Bun's sink issues **one** `reader.read()`. The stream's queue is empty, so the read request is queued in `[[readRequests]]` and `CallPullIfNeeded` invokes `pull(c)`.
3. `pull(c)` finds `buffer.length === 0`, `upstreamDone === false`, `overflowed === false` → returns a pending promise; `waiters` gets its `resolve`. The spec sets `pulling = true`.
4. The active drain loop (running independently) reads the next upstream chunk, pushes it into the private `buffer`, and calls `resolveWaiters()` → the pull promise fulfills.
5. Spec fulfillment handler: `pulling = false`; `pullAgain` is **false** (no second read arrived — Bun's sink is waiting for the first read to resolve) → **`pull()` is not re-invoked**.
6. The consumer's read request is still in `[[readRequests]]`. The chunk is still in the wrapper's private `buffer`. Nothing calls `controller.enqueue()`, `close()`, or `error()` on the data path. **The read never resolves → the stream stalls.**
7. This repeats for every subsequent frame. The stream reaches EOF only when `handler.close()` (SDK `teardown(true)` → `controller.close()`) or overflow/consumer-cancel calls `closeDownstream()`.

The wrapper's own comment at `:198-200` is the tell: *"Resolve any in-flight downstream pull so its read() ends with EOF instead of hanging on a promise that will never be fulfilled."* It resolves the promise but does not deliver the data — resolving the promise is not a substitute for enqueueing.

---

## 8. Comparison of alternative stream-handling approaches

All measured with the same harness (200 frames for overflow/healthy-long, 10 for healthy-short; caps 16 KiB / 96 frames). "Bound" = private buffer accumulates and overflow fires for an unread client.

| Design | Healthy delivery | Bounded accumulation | Slow-consumer overflow | Upstream cancel + SDK teardown | Downstream EOF | Client disconnect cleanup | Bun listener compat |
|---|---|---|---|---|---|---|---|
| **A — current pending-promise pull/waiter** | **FAIL** (2 frames, stall) | PASS | PASS (96 frames, cancel `overflow`) | PASS | PASS (on overflow/close) | PASS | **FAIL for healthy** |
| **B — no pending pull; `pullWanted` flag, drain enqueues** | PASS (10/10) | **FAIL** (200 delivered, no overflow) | **FAIL** | PASS | PASS | PASS | partial |
| **C — TransformStream with cap check** | PASS only <96 frames; **FAIL for >96** (counts total, not unread) | PASS (96) | PASS | **FAIL** (no cancel on downstream cancel) | PASS | FAIL | partial |
| **D — direct pass-through** | PASS (10/10) | **FAIL** (no cap) | FAIL | N/A | PASS | N/A | PASS |
| **E — pending pull + drain enqueues directly when waiter exists** | **PASS (200/200)** | **FAIL** (200 delivered, no overflow) | **FAIL** | PASS | PASS | PASS | PASS for delivery |
| **G — async-generator body with bounded handoff** | PASS (200/200) | **FAIL** (no overflow) | FAIL | **FAIL** | PASS | FAIL | PASS for delivery |
| **H — direct enqueue + outstanding counter decremented in `pull()`** | PASS (200/200) | **FAIL** (Bun's eager pulls decrement counter) | FAIL | PASS | PASS | PASS | PASS for delivery |
| **I — re-pull (`pullAgain`) detection** | **FAIL** (2 frames; `repulls = 0`) | PASS | PASS | PASS | PASS | PASS | FAIL for healthy |

**Critical trade-off discovered:** under Bun 1.4.5, `Bun.serve`'s response-body sink eagerly pulls the stream (cf. Bun #32469/#32475). Every design that *makes data available* to the stream (B, E, G, H) has that data drained immediately into Bun's sink buffer, so the wrapper's private "unread" buffer never accumulates and the overflow bound never fires. The **only** designs that preserve the bound (A, C, I) do so by *withholding* data — which is exactly what stalls a healthy consumer. **There is no one-line change that fixes the stall while preserving the current overflow contract.**

Design C is the closest to preserving both, but its cap counts *total* frames enqueued (never decremented), so a healthy stream longer than 96 frames would falsely overflow — unacceptable for a long-lived `subscriptions/listen` stream.

---

## 9. Recommended smallest safe correction (design-level, NOT applied)

**The minimal change that restores healthy delivery** is design E: in the drain loop, when a chunk arrives and a downstream pull is pending, call `controller.enqueue(chunk)` directly (fulfilling the read) and resolve the waiter — instead of only resolving the waiter. Concretely, replace the `:206-210` append-and-resolve with a handoff that enqueues to the captured controller when `waiters.length > 0`, and keep the buffer path only when no pull is pending. This is the smallest change that makes the real-listener healthy path work (measured 200/200 frames, EOF).

**However, this alone removes the slow-consumer overflow bound under Bun.serve** (§8). Therefore a *safe* correction requires an explicit decision on where the bound lives. Options, in increasing order of scope:

1. **Smallest, behavior-changing:** drop the private buffer/gate entirely (pass-through, design D) and rely on Bun's TCP backpressure (#32475) plus `maxSubscriptions` for bounds. This **changes the M6-D `slow_consumer_bound_exceeded` overflow contract** — a product/acceptance decision, explicitly out of scope for this diagnosis.
2. **Preserve the overflow contract:** keep the gate but deliver via a rolling-window cap — enqueue directly on pending pull (design E) and enforce the cap on a rolling count of frames enqueued since the last consumer read, resetting on `pull()`. Under Bun's eager pulls this does **not** reliably bound a fully unread client (measured: no overflow), so it is not sufficient by itself.
3. **Most robust:** move the bound to the SDK boundary — pause draining the SDK when the downstream stream's `desiredSize <= 0`, making the SDK's own queue the backpressured buffer; accept that a fully stalled client can grow that queue (the original M6-D problem). Requires re-opening the M6-D mitigation design.

**Recommendation:** adopt design E as the delivery fix **only together with** an explicit, reviewed decision on option 1 vs 3. Do not ship E alone — it would silently remove the overflow protection that E2 currently verifies. No production change is authorized by this report.

---

## 10. Potential regressions and consequences

- **Removing the gate (E/D/G/H)** → the deliberately unread stream in E2 no longer overflows; `onOverflow` never fires; `reader.cancel(SSE_OVERFLOW_REASON)` never runs; SDK `teardown(false)` (bus unsubscribe + keepalive clear + open removal) does not occur on overflow. `handler.close()` may still clean up, but the documented overflow contract and its evidence are void.
- **Keeping the gate (A/I)** → the real-listener healthy subscriber stalls; clients see only the ack + 1 frame and no EOF until shutdown; `subscriptions/listen` is effectively unusable over the real listener. This is the current state.
- **TransformStream cap (C)** → false overflow on any healthy stream exceeding 96 frames total; downstream cancel does not propagate to the SDK (leaked subscription).
- **Any change to `pull()` semantics** must preserve: ack-first delivery, subscription-id stamping, per-stream filtering, graceful completion on `handler.close()` (E1), and the `close`/`notify`/`bus` handler shape used by composition.
- **Bun `idleTimeout`** (10 s default) interacts with a stalled stream: a quiet stream is closed mid-response unless `server.timeout(req, 0)` is set. The production `Bun.serve` call in `apps/api/src/index.ts:203` does not set it; this is separate from the stall but relevant to any long-lived listen stream.

---

## 11. Tests needed to prove the correction

1. **Real-listener healthy subscriber (the missing test):** open `subscriptions/listen` through `Bun.serve`, publish **N > cap** (e.g. 200) notifications, assert all N frames arrive with no stall and EOF on close. This is the assertion the tracked follow-up says is absent.
2. **Real-listener unread stream:** assert overflow fires, `onUpstreamCancel` receives `slow_consumer_bound_exceeded`, downstream reaches EOF, delivered pre-EOF frames ≤ cap, and no frames after overflow.
3. **Both clients through the real listener:** Bun `fetch` and Bun `node:http` client, identical frame counts.
4. **Second server environment:** Bun `node:http` server, wrapped stream, no hang.
5. **Long healthy stream > cap:** 200+ frames at realistic pacing, assert **no** false overflow (guards against design C's defect).
6. **Client disconnect cleanup:** cancel the downstream reader, assert upstream cancel + SDK `openCount` returns to baseline (no leaked subscription).
7. **Graceful shutdown:** `handler.close()` completes an active listen stream with `"graceful"` (E1) after the correction.
8. **Pure Web Streams regression guard:** assert that resolving a waiter without enqueueing leaves `read()` pending (documents the mechanism so it is not reintroduced), and that direct `controller.enqueue()` resolves it.
9. **In-process control retained** (`slow-consumer.test.ts`) to ensure the fix does not regress the existing path.

---

## 12. Remaining uncertainty

- **Exact "first frames" count is timing-dependent** (1 in exp-a, 2 in exp-b/c/d); not a deterministic threshold.
- **Why the in-process SDK client succeeds** is inferred (multiple outstanding reads / buffered-at-pull-time) but not isolated with a dedicated instrumented in-process experiment. It does not affect the real-listener conclusion.
- **Whether Bun 1.4.5 includes the #32475 TCP-backpressure fix** was not verified; the small-frame experiments cannot distinguish backpressure states. This matters for option 1 in §9.
- **Other MCP clients / transports** (non-Bun-hosted clients, STDIO) were not tested; no claim is made that they are affected or unaffected.
- **Where the slow-consumer bound should live** is a product/acceptance decision, not established by this diagnosis. The tracked follow-up remains OPEN; this report does not close it, change acceptance status, or authorize a production change.

---

## Final disposition

- **Stall mechanism: ROOT CAUSE CONFIRMED** — pending-promise `pull()` resolved without `controller.enqueue()`; spec `CallPullIfNeeded` does not re-invoke `pull()` without `pullAgain`; Bun's single-outstanding-read sink never sets `pullAgain`; read request hangs with the chunk stranded in the private buffer.
- **Isolation: CONFIRMED** — reproduces with generic Web Streams, no SDK, no MarketHub; both clients; both Bun server environments.
- **Correction: NOT applied** — smallest delivery fix (design E) breaks the overflow bound; a safe correction needs a reviewed decision on bound ownership. Submit for independent technical review before any production change authorization.
