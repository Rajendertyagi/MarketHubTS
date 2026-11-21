# M6-D — Fan-out measurement evidence

> **Status:** Recorded measurements supporting the `maxSubscriptions` value and latency budget in `apps/api/src/index.ts`. Not a new requirement; evidence for the M6-D acceptance gate (§8.1 of [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md)).
> **Last updated:** 2026-11-21
> **Source:** `tests/mcp/fanout.test.ts` — synthetic in-process load over the real SDK handler, pinned `2026-07-28`, no providers or external network.

## 1. Method

For each subscriber count N ∈ {8, 32, 64}, the test opens N real SDK clients, each with a `subscriptions/listen` stream filtered to `markethub://market/snapshot`, then publishes M = 20 canonical updates through `handler.notify.resourceUpdated(...)`. For each update it records the time until every subscriber observed it. It captures N, M, p95 and max publish latency, heap delta, and a **real** error count (subscribers that missed an expected delivery). The sweep is repeated; values below are representative of repeated runs.

## 2. Recorded results (representative run)

| N (subscribers) | M (events) | p95 latency | max latency | heap delta | errors |
|---|---|---|---|---|---|
| 8 | 20 | 3.51 ms | 3.54 ms | 4.86 MB | 0 |
| 32 | 20 | 3.53 ms | 5.35 ms | 0.96 MB | 0 |
| 64 | 20 | 3.57 ms | 3.68 ms | 1.44 MB | 0 |

Across four runs, p95 at N=64 ranged **3.57–3.69 ms** and max **3.68–6.47 ms** (one run showed a 20 ms outlier at N=8). Errors were 0 in every run.

## 3. Selected values and rationale

- **`maxSubscriptions = 64`** — a conservative bound for a single local owner with a handful of MCP clients (not a public service). The sweep shows no drops, no errors, and flat latency from 8 → 64 subscribers, so 64 is well above any realistic client count while bounding the number of open streams and total fan-out cost. It is not raised without further evidence.
- **Latency budget = 50 ms** — derived from the measured p95 at the bound (~3.6 ms): 50 ms gives >12× headroom over the worst observed p95 and >2× over the worst observed max (20 ms). It is **not** the test's per-update observation deadline (2 s), which is only a safety net for a stalled stream.

## 4. Slow-consumer evidence

A separate test opens a raw modern `subscriptions/listen` stream and deliberately leaves its SSE body unread, then publishes 20 updates. It records: publisher time (must stay < 500 ms — the unread stream does not block publishing), delivery count to a healthy subscriber (all 20 received), and heap delta. The SDK's `writeFrame` calls `controller.enqueue(...)` with no explicit per-stream frame/byte bound; the test records observed behavior and does **not** assert a queue bound the SDK does not provide. No custom queue or backpressure subsystem was added.

## 5. Limitations

- Measurements are local, in-process, and agent-reported; no CI run exists for these commits.
- Heap deltas are approximate (GC timing) and recorded as evidence, not as a hard bound.
- `maxSubscriptions` bounds **stream count only** — it does not bound per-stream queued frames/bytes (verified in SDK v2.4.0 `listenRouter-*.mjs`).
