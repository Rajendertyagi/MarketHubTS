# M6-D — Fan-out measurement evidence

> **Status:** Recorded measurements supporting the `maxSubscriptions` value and latency budget in `apps/api/src/index.ts`. Not a new requirement; evidence for the M6-D acceptance gate (§8.1 of [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md)).
> **Last updated:** 2026-11-21
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
