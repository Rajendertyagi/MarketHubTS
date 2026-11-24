# M6-D — Fan-out measurement evidence

> **Status:** Recorded measurements supporting the `maxSubscriptions` value and latency budget in `apps/api/src/index.ts`. Not a new requirement; evidence for the M6-D acceptance gate (§8.1 of [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md)).
> **Last updated:** 2026-11-24 (§7 slow-consumer mitigation evidence added)
> **Source:** `tests/mcp/fanout.test.ts` — synthetic in-process load over the real SDK handler, pinned `2026-07-28`, no providers or external network.

## 1. Method

For each subscriber count N ∈ {8, 32, 64}, the test opens N real SDK clients, each with a `subscriptions/listen` stream filtered to `markethub://market/snapshot`, then publishes M = 20 **canonical changes through the complete M6-D path**:

```
MarketDataService.track() → createMcpNotificationBridge → handler.notify.resourceUpdated() → subscribers
```

It does **not** call the notifier directly. For each update it records the time until every subscriber observed it, capturing N, M, min/mean/p95/max latency and heap delta.

**What the `errors` counter measures (precisely):** `errors = publisherErrors + missing + duplicates`, where
- `publisherErrors` is the number of times the bridge's `onError` callback fired (i.e. `handler.notify.resourceUpdated` threw and the bridge contained it) — wired to the real `createMcpNotificationBridge(..., onError)` seam;
- `missing` is the total number of not-delivered notifications across all subscribers (`Σ max(0, M − received_i)`);
- `duplicates` is the total number of extra notifications across all subscribers (`Σ max(0, received_i − M)`).

It does **not** count client-side notification-handler exceptions (none are thrown by the test handlers) and does not claim to observe anything the test cannot see. The assertion `counts.every(c => c === M)` additionally requires every subscribed client to receive exactly M notifications. The sweep was run four times; all individual runs are preserved below.

## 2. Individual run results

### Run 1

| N | M | min | mean | p95 | max | heap Δ | errors |
|---|---|---|---|---|---|---|---|
| 8 | 20 | 3.03 ms | 3.23 ms | 3.44 ms | 3.67 ms | 4.89 MB | 0 |
| 32 | 20 | 2.12 ms | 3.06 ms | 3.66 ms | 3.75 ms | 1.05 MB | 0 |
| 64 | 20 | 2.22 ms | 3.10 ms | 3.67 ms | 3.77 ms | 1.53 MB | 0 |

### Run 2

| N | M | min | mean | p95 | max | heap Δ | errors |
|---|---|---|---|---|---|---|---|
| 8 | 20 | 2.08 ms | 3.26 ms | 3.74 ms | 3.75 ms | 4.86 MB | 0 |
| 32 | 20 | 2.18 ms | 3.09 ms | 3.69 ms | 4.27 ms | 1.08 MB | 0 |
| 64 | 20 | 2.12 ms | 3.01 ms | 3.62 ms | 3.65 ms | 1.53 MB | 0 |

### Run 3

| N | M | min | mean | p95 | max | heap Δ | errors |
|---|---|---|---|---|---|---|---|
| 8 | 20 | 3.08 ms | 3.31 ms | 3.66 ms | 3.69 ms | 4.86 MB | 0 |
| 32 | 20 | 2.22 ms | 3.04 ms | 3.67 ms | 3.73 ms | 1.07 MB | 0 |
| 64 | 20 | 2.24 ms | 3.13 ms | 3.69 ms | 4.14 ms | 1.53 MB | 0 |

### Run 4

| N | M | min | mean | p95 | max | heap Δ | errors |
|---|---|---|---|---|---|---|---|
| 8 | 20 | 2.28 ms | 3.22 ms | 3.59 ms | 4.23 ms | 4.90 MB | 0 |
| 32 | 20 | 2.20 ms | 3.25 ms | 3.68 ms | 3.96 ms | 1.04 MB | 0 |
| 64 | 20 | 2.09 ms | 2.94 ms | 3.74 ms | 4.51 ms | 1.47 MB | 0 |

In every table the `errors` column is the total `publisherErrors + missing + duplicates` defined above (all zero in every run). Across the **four preserved runs**, p95 ranged **3.44–3.74 ms** and max **3.65–4.51 ms**. An earlier draft of this document reported p95 **3.62–7.91 ms** and max **3.65–10.28 ms** from a "heavier load" run; that run's full raw measurements were **not preserved**, so those two higher figures are **withdrawn** and are not used for any headroom claim here. If such a run is later produced, its complete raw table must be preserved before its figures can be cited.

## 3. Selected values and rationale

- **`maxSubscriptions = 64`** — a conservative bound for a single local owner with a handful of MCP clients (not a public service). The sweep shows no drops, no errors, and flat latency from 8 → 64 subscribers, so 64 is well above any realistic client count while bounding the number of open streams and total fan-out cost. It is not raised without further evidence.
- **Latency budget = 50 ms** — derived from the preserved measurements at the bound: worst preserved p95 = 3.74 ms → **50 / 3.74 ≈ 13.4× headroom**; worst preserved max = 4.51 ms → **50 / 4.51 ≈ 11.1× headroom**. (For reference only, the withdrawn unpreserved figures would give 50 / 7.91 ≈ 6.3× and 50 / 10.28 ≈ 4.9×; they are not used.) It is **not** the test's per-update observation deadline (2 s), which is only a safety net for a stalled stream. The `maxSubscriptions = 64` value and the 50 ms budget are **retained** because the preserved evidence justifies them (flat latency from 8 → 64, zero drops/errors); they are not changed merely for arithmetic consistency.

## 4. Slow-consumer evidence

A separate test opens a raw modern `subscriptions/listen` stream and deliberately leaves its SSE body unread, then publishes 20 canonical changes through the bridge. It records:

| Metric | Observed (3 runs) |
|---|---|
| publish time | 0.21–0.31 ms (publisher not blocked) |
| healthy subscriber deliveries | 20 / 20 |
| heap delta | ~0 MB |
| queued frames after draining the unread stream | 22 (20 notifications + ack + graceful close) |
| queued encoded bytes | 4,126 bytes |
| unread stream status / content type | 200 / `text/event-stream` |

The stream is closed gracefully before draining so the queue can be counted. The SDK's `writeFrame` calls `controller.enqueue(...)` with no explicit per-stream frame/byte bound; the test records the observed queue size and does **not** assert a bound the SDK does not provide. No custom queue or backpressure subsystem was added.

## 5. Limitations

- Measurements are local, in-process, and agent-reported; no CI run exists for these commits.
- Heap deltas are approximate (GC timing) and recorded as evidence, not as a hard bound.
- `maxSubscriptions` bounds **stream count only** — it does not bound per-stream queued frames/bytes (verified in SDK v2.4.0 `listenRouter-*.mjs`).

## 6. Named acceptance decision — D slow-consumer residual risk

- **Decision:** "D slow-consumer residual risk"
- **Owner:** product owner
- **Status:** **OPEN — product-owner decision required before M6-D acceptance.**
- **Risk (not mitigated):** the SDK imposes no per-stream frame or byte limit; `maxSubscriptions = 64` bounds stream count only, and the 50 ms budget bounds publish latency only. The slow-consumer evidence in §4 measures only **M = 20 updates** (22 queued frames / 4,126 bytes on one unread stream) and does **not** establish a safe upper bound under sustained load. No custom queue, byte cap or backpressure subsystem was added.
- **Disposition required:** the product owner must either explicitly accept this residual risk or authorize a separately scoped bounded follow-up. An OPEN decision blocks M6-D acceptance even if every other §8.1 item passes. Do not record the risk as mitigated; do not change `maxSubscriptions = 64` or the 50 ms budget on account of this item.
- **2026-11-24 update:** the product owner authorized the separately scoped bounded follow-up in `docs/M6_D_SLOW_CONSUMER_MITIGATION_PLAN.md`. The mitigation is implemented and locally verified; see §7. The decision stays **OPEN** until the independent review gate passes (§7.6).

## 7. Slow-consumer mitigation — sustained-load evidence and derived bound (2026-11-24)

> **Status:** Implementation and local verification complete for the separately tracked M6-D slow-consumer mitigation follow-up. This section records the measurement-derived bound, the overflow contract and the verification evidence. It does **not** by itself close the §6 decision or accept M6-D.

### 7.1 Method

`tests/mcp/slow-consumer.test.ts` (T5) runs a local, in-process, synthetic sustained load through the complete canonical path (`MarketDataService.track()` → bridge → wrapped `handler.notify` → subscribers), pinned to `2026-07-28`, with no providers or external network. The handler's `fetch` is wrapped by `apps/api/src/mcp-sse-bound.ts` with a deliberately large measurement cap (4 MiB / 100,000 frames) so neither stream overflows. One healthy `Client` drains normally; one raw `subscriptions/listen` stream is deliberately left unread. The wrapper's `onBuffered` diagnostic hook records the application-owned buffer high-water per stream (identified by a monotonic `streamId`). M = 300 canonical changes are published with realistic pacing (a 1 ms pause every 10 updates).

### 7.2 Raw measurements (3 preserved runs)

| Run | M | publish ms | healthy delivered | heap Δ | healthy high-water (frames / bytes) | unread high-water (frames / bytes) |
|---|---|---|---|---|---|---|
| 1 | 300 | 58.01 | 300/300 | ~0 MB | 6 / 1,152 | 301 / 55,431 |
| 2 | 300 | 52.33 | 300/300 | ~0 MB | 6 / 1,152 | 301 / 55,431 |
| 3 | 300 | 58.37 | 300/300 | ~0 MB | 6 / 1,152 | 301 / 55,431 |

With the cap effectively disabled, the unread stream grows linearly (~184 bytes/frame) to 301 frames / 55,431 bytes — confirming the §4 risk under sustained load (vs 22 frames / 4,126 bytes for M = 20). The healthy subscriber's buffer stays at a 6-frame / 1,152-byte high-water because it drains continuously. Heap deltas are approximate (GC timing) and recorded as evidence, not a hard bound.

### 7.3 Derived bound

- **Healthy burst envelope (measured):** 6 frames / 1,152 bytes high-water under sustained paced load.
- **Selected caps:** `MCP_SSE_MAX_BUFFERED_FRAMES = 96` (16× the measured 6-frame envelope) and `MCP_SSE_MAX_BUFFERED_BYTES = 16 KiB = 16,384` (~14.2× the measured 1,152-byte envelope). Both are small integer multiples of the observed envelope, rounded to a clear value, comfortably above normal bursts so healthy clients are not torn down.
- **Worst-case memory ceiling:** 16 KiB/stream × `MCP_MAX_SUBSCRIPTIONS = 64` = **1 MiB** for all listen streams combined — an explicit, acceptable ceiling for a single local owner.
- **Orthogonal constants:** `MCP_MAX_SUBSCRIPTIONS = 64` and `FANOUT_LATENCY_BUDGET_MS = 50` are unchanged. 64 bounds stream count, 50 ms bounds publish latency, the new caps bound per-stream queued frames/bytes.
- **Cap check:** the wrapper checks the cap *before* appending each upstream chunk, so the application-owned buffer never exceeds either cap (T1 asserts high-water ≤ cap).

### 7.4 Overflow contract decision

On overflow the wrapper calls `reader.cancel(SSE_OVERFLOW_REASON)` on the upstream reader (normative — triggers SDK `cancel()` → `teardown(false)` → bus unsubscribe + keepalive clear + open removal), drops queued frames, and ends the downstream response with a **plain EOF** (clean `controller.close()`), with no synthesized completion frame. Rationale: the SDK owns the subscription id and generates the graceful completion frame internally; synthesizing it from the wrapper would duplicate SDK protocol logic and risk an id mismatch. A plain EOF is fully recoverable: the client treats it as terminal for that listen stream, re-opens `subscriptions/listen` and re-reads `markethub://market/snapshot` / `markethub://events/live` (read-after-notify). Notifications are change signals only, so no market data is lost. Diagnostics are logged via the existing best-effort seam as `mcp_sse_slow_consumer_overflow` with reason, observed bytes/frames and the caps; nothing throws into a canonical mutation.

### 7.5 Verification evidence (local, not CI)

- **T1** (sustained unread bounded): buffer high-water ≤ caps; `onUpstreamCancel` observed `slow_consumer_bound_exceeded`; downstream EOF with 0 surviving frames.
- **T2** (black-box cleanup): after overflow, N=10 further canonical changes produce **0** frames on the bounded stream, while a healthy sibling receives all 146; `handler.close()` completes cleanly. No SDK internals / `openCount` used.
- **T3** (healthy unaffected): with an unread stream present, a healthy subscriber receives all 20 notifications with p95 < 50 ms, no drops/duplicates.
- **T4** (canonical publishing unaffected): the bridge's best-effort `onError` is not invoked by the bounded wrapper — overflow is contained in the wrapper's `onOverflow` diagnostic (`mcp_sse_slow_consumer_overflow`), never propagated to `MarketDataService` or the bridge; canonical mutations and `LiveStateStore` are untouched. Covered by T3/T5 delivery assertions plus unchanged `tests/mcp/notification-bridge.test.ts` (publisher-error containment) and the full suite.
- **T5** (sustained load): table above; 300/300 delivered, publisher not blocked (~52–58 ms for 300), heap Δ ~0 MB.
- **T6** (regression): `tests/mcp/fanout.test.ts`, `tests/mcp/subscriptions.test.ts`, `tests/mcp/notification-bridge.test.ts` unchanged and passing; full-suite baseline 1095 pass / 0 fail at `7926809` (post-change results recorded in the implementation report).

### 7.6 Decision disposition

The named decision **"D slow-consumer residual risk"** (§6) remains **OPEN** pending the independent review gate (plan §7.8 / §10). The mitigation is implemented and all local verification gates pass; closure as **"CLOSED — mitigated by bounded SSE wrapper"** requires the `opencode/iceman-free` KEEP audit, which is outside this implementation session. M6-D acceptance and Phase 3 remain gated.
