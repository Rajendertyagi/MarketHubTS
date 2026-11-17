# M4 Stage F — Reconnect, Concurrency and Resource Hardening Plan (Final)

> **Status:** Planning only. No implementation, file modification, commit or push of source/tests performed for Stage F. Awaiting independent review and explicit implementation authorization.
> **Order:** D → E → F → C → G. Production Upstox driver remains locked.

## 1. Verified current state and baseline

- Branch `develop`, HEAD `612a13baa4838335b808abbb6e484a5619e67581`; `main` unchanged at `277d5e2…`. Clean tree.
- **Stage D accepted** (`f51e7db` final), **Stage E accepted** (`ea0cae0`, `00e6830`, `a8f4eef` + closeout `612a13b`). Production Upstox driver locked; no live socket/feed verified.
- **Current verification:** 301 tests / 0 fail (1,162 assertions, 26 files); web 45 / 0 fail (159 assertions); typecheck 12 workspaces; build; diff-check — local verification, not CI.

**Verified code facts:**
- `StreamingDriver` (`stream-supervisor.ts:25-33`): `start(subscriptions, callbacks)`, `updateSubscriptions(subscriptions)`, `stop()`, `getConnectionState()`, `readonly locked?: boolean` — no signal parameter (plan extends this).
- `enqueueReconcile` (`:196-213`) serializes work through `this.queue` and awaits `applySelections` → `startDriver` → the raw driver promise. An unsettled driver promise blocks the queue indefinitely — logical completion addresses this.
- **`scheduleReconnect` (`:417-432`) silently returns at `reconnectAttempts >= maxAttempts` (`:421`) with NO connection-state transition and NO `lastError` update. Retry exhaustion is NOT currently reported.** The `setConnectionState("ERROR", lastError)` calls at `:301` and `:404` are immediate start-failure paths, not retry exhaustion — they must not be described as exhaustion reporting. `lastError` in `getView()` (`:449`) reflects whatever was last set, not an exhaustion decision.
- `onConnectionState` (`:363-379`) sets `lastError` only for `state === "ERROR"` (`:372`); DISCONNECTED without an error string leaves `lastError` unchanged.
- Callbacks check only `epoch !== this.epoch || this.stopped` (`:356`, `:364`) — no instance-level callback gate (plan adds one).
- `onConnectionState` can set STREAMING (`:366-368`) and schedule retries (`:374`) — must be gated during abort/quiescence.
- Supervisor has **no** `streamStatus` and **no** `retry()` method — those are WebUI-only (`live-stream.ts:37`, `:133`).
- Reconciliation triggers: `start()` (`:152`), `replaceSubscriptions()` (`:186`), reconnect timer `enqueueReconcile(this.generation)` (`:429`).
- `startDriver()` settle paths (`:381-414`) perform cleanup and retire + retry themselves — the race the review identified.
- `reconnectAttempts` resets only on STREAMING callback (`:367-368`).
- `LivePanel.tsx:105-108` adds an abort listener with `{ once: true }` but never removes it on normal timeout completion.
- `LiveEventHub` uses `setInterval` directly (`:170`) with no scheduler seam; `refreshIntervalMs: 0` disables the timer, so cleanup is untested.
- **Existing test-support file `tests/market/supervisor.test.ts`:** `FakeDriver` (`:24`), `DeferredDriver` (`:60`), `AllocatingFailDriver` (`:112`), `harnessWithCatalog()` (`:177`), `harness()` (`:233`), 4 `new StreamSupervisor(...)` sites (`:190`, `:246`, `:494`, `:553-554`) using the `driver` option; fake `start`/`updateSubscriptions` signatures (`:34`, `:42`, `:75`, `:86`, `:115`, `:119`) take no signal.
- Existing supervisor tests use `Bun.sleep()` at lines 172, 368, 447, 619, 648, 678, 774, 826, 871.

## 2. Objective and boundaries

Harden reconnect/recovery/concurrency/resource paths with targeted production changes plus deterministic tests. No new architecture, no new dependencies, no provider connectivity.

**Protected:** no changes to `@markethub/contracts` shared schemas/types or REST/SSE wire contracts; no driver unlock; no real SDK/socket/network; no Stage C/G; no Stage E UI redesign; no `main` changes; no dependency/manifest/lockfile changes; no unrelated refactoring; no changes to accepted Stage D/E records. Order remains **D → E → F → C → G**.

**Clarification:** "no backend contract changes" freezes the shared contracts package and wire format. The internal `StreamingDriver` interface and supervisor internals in `apps/api/src/stream-supervisor.ts` are explicitly in scope.

## 3. Internal StreamingDriver interface extension

```ts
export interface StreamingDriver {
  readonly locked?: boolean;
  start(subscriptions: DriverSubscription[], callbacks: DriverCallbacks, signal: AbortSignal): Promise<void>;
  updateSubscriptions(subscriptions: DriverSubscription[], signal: AbortSignal): Promise<void>;
  stop(): void;
  getConnectionState(): ProviderConnectionState;
}
```

- Signal is **mandatory** and passed to the underlying operation by every implementation; no signal-less overload retained.
- **Locked driver:** accepts and ignores the signal (throws `DriverLockedError` immediately, never starts work). Signature updated.
- **Fake drivers:** all fakes accept, record and honor the signal deterministically for cancellation tests.
- **Cancellation guarantee:** `abort()` must cause the operation to stop work and settle; otherwise quarantine after bounded quiescence. Not a claim that `abort()` forcibly terminates the promise.

## 4. Logical completion with explicit outcome (correction 3)

The supervisor must not couple its serialized reconciliation queue to the raw driver promise. Define a **supervisor-owned logical completion** per operation, separate from the underlying driver promise, with a **typed outcome** (not `Promise<void>`):

```ts
type OperationOutcome =
  | { kind: "applied" }                    // only normal successful completion
  | { kind: "failed"; error: string }      // normal rejection
  | { kind: "timed-out"; error: string }   // timeout — both quiescence branches (including quarantine)
  | { kind: "callback-retired"; reason: "DISCONNECTED" | "ERROR" }
  | { kind: "shutdown" };
```

- Each operation owns `logicalCompletion: Promise<OperationOutcome>` with a supervisor-held resolver. `applySelections` / `startDriver` await `logicalCompletion`, **not** the raw driver promise, so the queue can be released independently of driver settlement.
- **Outcome ownership — exactly one outcome and one retirement/retry owner per terminal path:** only a normal successful settle while the op is `active` resolves `{ kind: "applied" }`. Every other terminal path resolves exactly one non-applied outcome: normal rejection → `failed`; timeout (both quiescence branches, including quarantine) → `timed-out`; callback retirement → `callback-retired`; shutdown → `shutdown`. `abort()` and quarantine are internal steps of a lifecycle owner, not distinct outcomes — they are always subsumed by the owning path's outcome (`timed-out`, `callback-retired`, or `shutdown`). There are no `aborted` or `quarantined` outcome variants.
- **`appliedGeneration` advances only when `outcome.kind === "applied"`** in `enqueueReconcile`. Queue release never implies successful application. Every non-applied outcome (`failed`, `timed-out`, `callback-retired`, `shutdown`) cannot advance `appliedGeneration`.
- **Normal completion:** driver settles while `active` → run normal success/failure handling → resolve the corresponding outcome.
- **Late settlement consumption:** attach `then`/`catch` handlers to the original driver promise at operation start. These consume late resolve/reject so there is **no unhandled rejection**, and perform **no** state, callback, retry, `appliedGeneration`, or replacement-instance mutation. They may record `underlyingSettled` on the retired instance for diagnostics only.
- **Tests:** the unresolved-old-operation test and shutdown tests assert the resolved outcome kind and that `appliedGeneration` did not advance.

## 5. Every timeout permanently retires the instance (correction 1)

Both timeout branches retire the instance — there is no branch that merely records settlement and leaves the instance alive:

- **Timeout (op `active`):** synchronously (1) set `state = "aborting"`, (2) close the instance callback gate (`callbacksEnabled = false`), (3) set connection state `ERROR` with a timeout-specific `lastError`, (4) call `controller.abort()` (catch synchronous throws), (5) await bounded quiescence on the driver promise.
- **Branch A — driver settles during quiescence:** the settlement consumer records `underlyingSettled` and signals the quiescence waiter only — it performs no normal handling, no application-state mutation, and does not own retirement. The timeout lifecycle owner (awaiting quiescence) then calls the idempotent retirement owner `retireInstance(instance, "timeout")` → `stop()` exactly once, then resolves `logicalCompletion` with `{ kind: "timed-out", error }`.
- **Branch B — driver still pending at quiescence expiry:** the timeout lifecycle owner calls `retireInstance(instance, "timeout")` → `stop()` exactly once, quarantines the instance (fresh instance for the next attempt), then resolves `logicalCompletion` with `{ kind: "timed-out", error }`. Quarantine is an internal step of the timeout path, not a distinct outcome.
- **In both branches:** the instance is permanently retired and **never reused**; `stop()` executes at most once (idempotent owner); late settlement remains inert; the timeout lifecycle owner is the single owner of retirement, `stop()` and the one retry decision — the settlement consumer never owns retirement or `stop()`.
- **Test:** deterministic late-resolution and late-rejection during quiescence assert exactly one retirement, one `stop()`, one retry decision, and no premature `appliedGeneration` advancement in both branches.

## 6. Callback-triggered retirement while an operation is pending (correction 2)

When the current instance emits DISCONNECTED or ERROR while a start/update operation is still pending:

1. **Close callback authority** on the instance (`callbacksEnabled = false`) so no further callbacks from it are honored.
2. **Abort the active operation** via its `AbortController.signal` (catch synchronous throws).
3. **Run the bounded quiescence/retirement path:** await quiescence within the bounded window. If the underlying promise settles during quiescence, the settlement consumer records `underlyingSettled` and signals the quiescence waiter only — no normal handling, no application-state mutation, and no retirement ownership. The callback lifecycle owner then calls `retireInstance(instance, "callback:disconnected"|"callback:error")` → `stop()` exactly once; the instance is permanently retired and never reused.
4. **Resolve supervisor logical completion** with `{ kind: "callback-retired", reason }` so the serialized reconciliation queue is released immediately — it does **not** wait for the original operation timeout.
5. **The callback path owns the single retry decision** (schedule one bounded reconnect with a fresh factory instance).
6. **The operation timeout handler cannot duplicate:** the op is no longer `active` (state `aborting`/`retired`), so its timeout is a no-op; the idempotent retirement owner prevents a second `stop()`; the retry decision is already owned by the callback path.
7. **Preserve callback behavior when no operation is pending:** the existing path (close gate, retire instance, schedule one reconnect) remains unchanged.

**Tests:** deterministic DISCONNECTED and ERROR callbacks during a pending start/update, including a driver promise that remains unresolved until **after** the replacement instance has started. Assert: callback authority closed, operation aborted, exactly one `stop()`, exactly one retry decision, `logicalCompletion` resolved with `callback-retired`, `appliedGeneration` unchanged, and the late-settled old promise inert with no unhandled rejection.

## 7. Terminal driver-instance retirement

Remove the `active → stopped/reusable` path entirely. The instance lifecycle is terminal:

```
active -> retired   (any stop(): disconnect, failed start/update cleanup, timeout, callback retirement, shutdown)
```

- **Any instance that receives `stop()` becomes permanently retired** and cannot be restarted or reused. There is no reusable state.
- **Every subsequent start acquires a fresh factory-created instance** via `createDriver()`. Applied consistently to: DISCONNECTED callback, ERROR callback, failed start cleanup, failed update cleanup, timeout (both branches), callback-triggered retirement, and shutdown.
- **One idempotent retirement owner per instance:** a single `retireInstance(instance, reason)` helper is the only code that calls `instance.stop()`. It checks an instance-level `retired` flag; if already retired it is a no-op. Otherwise it sets `retired`, closes the callback gate, increments epoch, cancels the reconnect timer, calls `instance.stop()` **exactly once**, clears pending markers, and returns whether this caller owned the retirement. All paths call it; `driver.stop()` executes **at most once per instance**.
- **Test factories updated:** existing fakes in `tests/market/supervisor.test.ts` and new fakes return fresh instances per `createDriver()` call where reuse would otherwise occur; existing behavior and accepted assertions preserved.

## 8. Callback authority gate

Each driver instance carries an **instance-level callback gate** (`callbacksEnabled: boolean`), initially `true`.

- **Synchronous suppression:** timeout, callback-triggered retirement and shutdown set `callbacksEnabled = false` **synchronously, before** `controller.abort()` / retirement.
- **Both callbacks check the gate:** `onObservation` and `onConnectionState` check `callbacksEnabled` **in addition to** epoch and shutdown checks:
  ```
  if (!instance.callbacksEnabled || epoch !== this.epoch || this.stopped) return;
  ```
- **Inert when closed:** no canonical market-data mutation, no provider connection-state mutation, no retry scheduling, no mutation from a retired instance.
- **Tests:** observations and DISCONNECTED/ERROR callbacks during quiescence; assert unchanged canonical revision, unchanged provider state, exactly one retry decision.

## 9. Canonical connection-state transitions

All transitions go through `setConnectionState()` → `MarketDataService`:

| Event | Connection state | lastError |
|---|---|---|
| Start operation begins | `CONNECTING` | cleared (null) |
| Start or update timeout | `ERROR` | timeout-specific message |
| Driver factory failure | `ERROR` | factory-specific message |
| Retry attempt begins | `CONNECTING` | cleared (null) |
| Retry exhaustion (ERROR or DISCONNECTED) | `ERROR` | final failure message (§10) |
| Shutdown | `NOT_STARTED` | cleared (null) |

- **The timeout handler owns the ERROR transition**; settlement during `aborting` does not independently mutate connection state.
- Ordinary STREAMING/DISCONNECTED/ERROR callbacks transition state normally **only while the callback gate is open** (§8).
- **Test:** a timed-out update cannot leave the service reporting STREAMING after the driver is stopped.

## 10. Retry exhaustion after ERROR and DISCONNECTED

Both ERROR and DISCONNECTED callbacks retire the instance and attempt a bounded retry. Exhaustion must be explicit and observable (the current `:421` silent return is the gap):

- **Exhaustion detection:** when `scheduleReconnect` finds `reconnectAttempts >= maxAttempts`, it must not silently return. It sets canonical provider state to **ERROR** with a meaningful final `lastError` (e.g. `"retry budget exhausted after N attempts: <last cause>"`).
- **DISCONNECTED fallback:** a DISCONNECTED callback without an error string receives a deterministic fallback failure message (e.g. `"provider disconnected"`), used as the cause in `lastError` and the exhaustion message. ERROR callbacks use their supplied error or a deterministic fallback.
- **Both paths** reach the same exhaustion handling; no path leaves provider state DISCONNECTED with no error after the budget is spent.
- **No new API:** re-attempt after exhaustion relies on an existing `PUT /api/market/subscriptions` (`replaceSubscriptions()`) or a fresh `start()`; no supervisor `retry()` method, endpoint or UI redesign.
- **Tests (separate deterministic cases):** (a) repeated ERROR callbacks through the retry limit → final state ERROR with exhaustion `lastError`; (b) repeated DISCONNECTED callbacks without error strings through the limit → final state ERROR with the deterministic fallback message in `lastError`.

## 11. Operation lifecycle (explicit)

```
active -> aborting -> settled
active -> aborting -> retired
```
- **Begin:** create op `{ epoch, kind, controller, state: "active", logicalCompletion, settledSignal, instance }`; set epoch-tagged pending marker; arm operation timeout; pass `controller.signal` to the driver operation; attach late-settlement consumers (§4).
- **Normal settle (active):** clear timeout; if still current marker and not stopped, run normal success/failure handling; set `settled`; resolve `logicalCompletion` with `applied` or `failed`.
- **Timeout (active):** §5 — the timeout lifecycle owner is the single owner of retirement, `stop()` and the retry decision; both quiescence branches retire, stop once, and resolve `timed-out`.
- **Callback retirement while pending:** §6 — the callback lifecycle owner is the single owner of retirement, `stop()` and the retry decision; close gate, abort, quiesce, retire, resolve `callback-retired`.
- **Settle during quiescence (aborting):** the settlement consumer records `underlyingSettled` and signals the quiescence waiter only — no normal handling, no `appliedGeneration`/`lastError`/`connectionState` change, no success marking, and no retirement or `stop()` by the consumer. Retirement and `stop()` are owned exclusively by the lifecycle owner: the timeout path (§5) or the callback-retirement path (§6), each of which calls `retireInstance()` → `stop()` exactly once before resolving `logicalCompletion`.
- **Late settle after `retired`:** may update `underlyingSettled` only; cannot change operation state, transition terminal `retired`, or affect the replacement.
- **Single-flight:** a second timeout or callback retirement for the same op is a no-op (state no longer `active`).

**Invariants:** exactly one `stop()` per instance, owned by a single lifecycle owner (§5 timeout or §6 callback retirement); exactly one retirement/retry decision per timed-out or callback-retired op; the settlement consumer never owns retirement or `stop()`; `appliedGeneration` advances only on `outcome.kind === "applied"`; no normal handling or connection-state mutation after `aborting`; no `Promise.race()`, `stop()`, epoch invalidation or callback gate claimed to cancel the underlying promise; a retired instance is never reused; the serialized queue is released via `logicalCompletion` regardless of driver settlement.

**Field changes:** replace boolean `startPending` / `updatePending` with typed op objects; add `currentDriver: StreamingDriver | null`; add `quiescenceWaiters: Set<() => void>`; add instance-level `retired` / `underlyingSettled` / `callbacksEnabled` tracking (no `reusable` state). `driverStarted` resets on every fresh instance acquisition.

## 12. Locked-driver detection vs factory failure

| Condition | Meaning | Retry behavior |
|---|---|---|
| `createDriver()` throws synchronously | Factory failure — no instance acquired | **Eligible for bounded retry**; counted against `maxAttempts`; `lastError` set; desired state preserved |
| `createDriver()` returns instance with `locked === true` | Successfully created locked driver (Stage D production) | **No provider retries** — `scheduleReconnect()` must not schedule |
| `currentDriver === null` | No instance acquired yet (lazy) or acquisition failed | **Never implies locked**; retry eligibility decided by the failure path |

- `locked` read only from non-null `currentDriver.locked` at all three sites (`:369`, `:412`, `:418`).
- Factory exception caught at acquisition, reported via `lastError`, scheduled for bounded retry — never classified as locked.
- Locked driver throws `DriverLockedError` on `start()`/`updateSubscriptions()`; no provider retries scheduled.
- **Tests:** factory failure→successful recovery; repeated failures through retry limit; locked no-retry; null-not-locked.

## 13. Shutdown cancellation

`StreamSupervisor.stop()` in order: (1) set `stopped = true` first; (2) for every `active` op, synchronously set `aborting`, close the callback gate, then `controller.abort()` (catch throws); (3) resolve all quiescence waiters and all outstanding `logicalCompletion` signals with `{ kind: "shutdown" }` so the queue is released; (4) clear operation timeout and reconnect timers; (5) call `retireInstance(currentDriver, "shutdown")` — exactly one stop; (6) set `connectionState = NOT_STARTED`; (7) make late settlements inert; (8) idempotent, graceful, no factory calls after shutdown.

Tests: pending-start and pending-update shutdown; timeout/shutdown race asserting exactly one `stop()`; late settlement after quarantine inert; callbacks during shutdown inert; **shutdown tests assert `logicalCompletion` resolves `shutdown` and `appliedGeneration` does not advance**.

## 14. Driver-factory isolation

- `StreamSupervisorOptions.driver` replaced by `createDriver: () => StreamingDriver`.
- Lazy acquisition on first `startDriver()` need and on every retirement/quarantine — not at construction.
- Each instance owns independent mutable connection/operation state and callback gate; a retired instance is never reused; callbacks capture instance epoch and gate and are inert after retirement.
- Factory failure handling per §12. Locked boundary: `apps/api/src/index.ts` passes `() => new LockedUpstoxDriver()` only.

## 15. Other production changes (preserved)

- **Jittered backoff:** injected `random?: () => number`; delay = `base * 2^attempt * (0.5 + random() * 0.5)`; deterministic in tests; `maxAttempts` unchanged; **no `reconnectAttempts` reset on start resolution** — reset only on confirmed STREAMING callback.
- **Operation timeout options:** `operationTimeoutMs?` (default 5000), `quiescenceMs?` (default 1000) as constructor options — **no new env var, no config schema change**; injected timer seam.
- **LivePanel retry-sleep cleanup** (`apps/web/src/lib/retry-sleep.ts` new + `LivePanel.tsx`): extract `createRetrySleep()`; remove abort listener on normal completion and on abort; already-aborted resolves immediately; lifecycle cleanup only.
- **Hub timer seam** (`hub.ts`, `types.ts`): narrow `timerScheduler?: { setInterval, clearInterval }`, default globals; no production telemetry; pending `next()` closure observed via `null`.

## 16. Corrected await inventory (grouped by test file)

**Supervisor external I/O — `tests/market/stage-f-supervisor-await.test.ts` (#1–#8):**
| # | Await point | Phase | Failure behavior |
|---|---|---|---|
| 1 | `subscriptions.load()` in `start()` (`:149`) | startup load | Propagates out of `start()` — **untyped**. |
| 2 | `catalog.getInstrumentByCanonicalId()` (`:170`) | validation | Propagates raw — **not** `SubscriptionValidationError`. |
| 3 | `subscriptions.replace()` (`:178`) | persistence | `SubscriptionPersistenceError` → 500 `persistence_failed`. |
| 4 | `subscriptions.load()` in `enqueueReconcile.run()` (`:200`) | reconcile load | Caught → `lastError`. |
| 5 | `catalog.listMappingsByCanonicalId()` (`:224`) | mapping resolution | Caught → `lastError`; desired state preserved. |
| 6 | `subscriptions.load()` generation guard (`:247`) | stale check | Caught → `lastError`; no application. |
| 7 | `driver.updateSubscriptions()` (`:285`) | driver update | Retire + bounded retry. |
| 8 | `driver.start()` (`:354`) | driver start | Epoch guards + callback gate + settle cleanup + timeout/quarantine. |

**WebUI recovery/refresh — `tests/web/stage-f-recovery-refresh.test.ts` (#9–#12):**
| # | Await point | Phase | Failure behavior |
|---|---|---|---|
| 9 | `fetchSnapshot()` in `runRecovery()` | recovery fetch | Bounded retry; exhaustion → WebUI `streamStatus=error`. |
| 10 | `sleep()` via `waitForRetry()` in recovery | recovery delay | Abort-aware; false on stop. |
| 11 | `fetchSnapshot()` in `runRefresh()` | refresh fetch | Bounded fetch-only retry; exhaustion → WebUI `refreshStatus=error`. |
| 12 | `sleep()` via `waitForRetry()` in refresh | refresh delay | Abort-aware; false on stop. |

**Async control/lifecycle — `tests/market/stage-f-timeout.test.ts` (#13, not external I/O):**
- `sleep(0).then(enqueueReconcile)` in `scheduleReconnect()` (`:429`) — generation-guarded dispatch; lifecycle control test.

Wrapper awaits (`enqueueReconcile()`, `applySelections()`, `startDriver()` calls) excluded as duplicates.

## 17. Exact proposed paths

**Source (6 — unchanged):**
1. `apps/api/src/stream-supervisor.ts` — mandatory-signal driver interface; typed logical-completion outcome; instance callback gate; terminal instance retirement; idempotent retirement owner; canonical connection-state transitions; ERROR/DISCONNECTED exhaustion handling; timeout (both branches retire) and callback-triggered retirement; locked-vs-factory-failure separation; shutdown cancellation; driver factory; jitter; no start-resolution reset.
2. `apps/api/src/index.ts` — `createDriver: () => new LockedUpstoxDriver()`.
3. `apps/web/src/lib/retry-sleep.ts` *(new)* — abort-safe retry sleep.
4. `apps/web/src/components/LivePanel.tsx` — use `createRetrySleep()`.
5. `packages/realtime/src/hub.ts` — timer scheduler seam.
6. `packages/realtime/src/types.ts` — `timerScheduler` option type.

**New Stage F test files (6 — unchanged):**
1. `tests/market/stage-f-supervisor-await.test.ts` — await points #1–#8; phase-specific failure behavior; reuse existing fakes.
2. `tests/market/stage-f-timeout.test.ts` — operation/instance lifecycles; signal-propagation assertion; callbacks during quiescence inert; canonical connection-state transition table; timed-out update cannot leave service STREAMING; **both timeout branches retire and stop exactly once (settle-during-quiescence and pending-at-expiry)**; **DISCONNECTED and ERROR callbacks during pending start/update (including promise unresolved until after replacement starts)**; deterministic unresolved-old-operation test (quarantine A, retry with fresh B while A pending, then settle A resolve/reject — assert inert, no unhandled rejection, queue released, outcome `timed-out`, `appliedGeneration` unchanged); separate ERROR-exhaustion and DISCONNECTED-exhaustion tests with final ERROR state and fallback message; timed-out instance never reused; late settlement updates `underlyingSettled` only; exactly one retirement/retry and one `stop()`; timeout/shutdown races; shutdown pending-start/update with outcome `shutdown` and no `appliedGeneration` advance; factory failure→recovery, repeated failures to limit, locked no-retry, null-not-locked; jitter; repeated successful-start/never-streaming budget; reconnect dispatch #13.
3. `tests/market/stage-f-hub.test.ts` — fake timer scheduler; 10,000-event soak; 100-client load; 1,000 open/close cycles; pending `next()` → `null`; timer armed/cleared.
4. `tests/market/stage-f-store.test.ts` — `LiveStateStore` stress: bounded size, monotonic revision, detached snapshots, listener isolation.
5. `tests/web/stage-f-recovery-refresh.test.ts` — WebUI recovery/refresh #9–#12; 500 cycles; listener counts zero; monotonic applied revision; deterministic fake sleep, no `Bun.sleep()`.
6. `tests/web/retry-sleep.test.ts` — normal timeout listener removal; abort clears timer and removes listener; already-aborted signal; repeated cycles no accumulation.

**Existing test-support file (1 — separate from the six new files):**
- `tests/market/supervisor.test.ts` — migrated in place to `createDriver` and mandatory-signal fakes: 4 construction sites (`:190`, `:246`, `:494`, `:553-554`) use `createDriver` (existing tests may return their existing driver instance; timeout/quarantine tests use fresh instances); 2 harness helpers (`harness()` `:233`, `harnessWithCatalog()` `:177`) take a factory parameter; 3 fake-driver classes (`FakeDriver`, `DeferredDriver`, `AllocatingFailDriver`) add the mandatory `signal: AbortSignal` parameter. All existing behavior and accepted assertions preserved; `Bun.sleep()` usages unchanged.

**No generic fault-injection framework** — reuse existing harnesses; add only narrow seams where none exists.

## 18. Acceptance criteria

- Internal `StreamingDriver.start(subscriptions, callbacks, signal)` and `updateSubscriptions(subscriptions, signal)` have mandatory signals passed to the underlying operation; locked driver, all existing fakes in `tests/market/supervisor.test.ts`, and all new fakes updated; cancellation guarantee = abort stops work and settles, else quarantine after bounded quiescence.
- **Typed logical-completion outcome with exactly one outcome and one retirement/retry owner per terminal path; only normal successful completion reports `applied`; timeout (both quiescence branches, including quarantine) → `timed-out`, callback-triggered retirement → `callback-retired`, shutdown → `shutdown`, normal rejection → `failed` — all non-applied and unable to advance `appliedGeneration`; `abort()` and quarantine are internal steps, not distinct outcomes (no `aborted`/`quarantined` variants); queue release never implies successful application; unresolved-operation and shutdown tests assert outcome kind and unchanged `appliedGeneration`.**
- **Every timeout permanently retires its instance in both branches (settles during quiescence, or pending at expiry): consume settlement if present, call the idempotent retirement owner, stop exactly once, resolve `timed-out`, never reuse; late settlement inert; at-most-once stop.**
- **Callback-triggered retirement while an operation is pending: close callback authority, abort via signal, bounded quiescence/retirement, resolve `callback-retired` so the queue is released, callback path owns the single retry decision, timeout handler cannot duplicate retry or double-stop; behavior preserved when no operation pending; deterministic DISCONNECTED/ERROR tests including a promise unresolved until after replacement starts.**
- Terminal instance retirement: no `stopped/reusable` state; any `stop()` permanently retires; every start acquires a fresh factory instance; applied consistently to disconnect, failed start/update cleanup, timeout, callback retirement and shutdown; idempotent stop ownership, at-most-once stop per instance; test factories updated with behavior/assertions preserved.
- Retry exhaustion after both ERROR and DISCONNECTED: final canonical state ERROR with meaningful `lastError`; DISCONNECTED without error string gets deterministic fallback message; separate deterministic tests for both paths; the current silent `:421` return is replaced.
- Instance-level callback gate closed synchronously before `abort()`; both callbacks check the gate; callbacks during abort/quiescence inert — no canonical mutation, no connection-state mutation, no retry scheduling, no retired-instance mutation.
- Canonical connection-state transitions defined and tested: start→CONNECTING; start/update timeout→ERROR with timeout-specific lastError; factory failure→ERROR with factory-specific lastError; retry attempt→CONNECTING; exhaustion→ERROR with final failure; shutdown→NOT_STARTED. Timeout handler owns the ERROR transition; settlement during aborting does not independently mutate connection state. A timed-out update cannot leave the service reporting STREAMING after the driver is stopped.
- Locked detection separated from factory failure: factory exception eligible for bounded retry; successfully created locked driver schedules no provider retries; `currentDriver === null` never implies locked; factory failure→recovery, repeated-failure-to-limit and locked-no-retry tests.
- Retry exhaustion reported as provider connection ERROR + `lastError` in `getView()`; no `streamStatus` in supervisor; no promised supervisor manual retry; re-reconciliation via existing `replaceSubscriptions()` / fresh `start()` only.
- Shutdown aborts pending ops, closes callback gates, resolves quiescence waiters and logical completions with `shutdown`, clears timers, stops driver once, blocks retries/factory calls after shutdown, late settlements inert, idempotent, graceful.
- Factory isolation: lazy acquisition; independent instance state and callback gate; retired instance never reused; `locked` read from current instance.
- Existing `tests/market/supervisor.test.ts` migrated to `createDriver` and mandatory-signal fakes with all existing behavior and accepted assertions preserved; existing `Bun.sleep()` usages unchanged.
- Jitter bounded/deterministic; `maxAttempts` preserved; no budget reset on start resolution; repeated successful-start/never-streaming cycles cannot bypass budget.
- LivePanel retry sleep removes abort listener on normal completion and abort; already-aborted resolves immediately; no accumulation.
- Await points #1–#8 and #9–#12 in correct test files; #13 lifecycle control.
- Hub timer armed/cleared deterministically; pending `next()` closes with `null`; no production telemetry.
- `LiveStateStore` stress confirms bounded size, monotonic revision, detached snapshots.
- Concurrency acceptance asserts convergence of **desired generation, desired selections and applied generation** via `getView()`.
- All **new Stage F tests** deterministic with no real-time waiting; existing accepted tests (including the migrated `supervisor.test.ts`) unchanged in behavior.
- Focused Stage F tests, `bun test`, `bun run typecheck`, `bun run build`, `git diff --check` pass.

## 19. Remaining limitations

- **Physical overlap of a retired operation:** the old promise may still run inside the retired instance; safety is by instance isolation, epoch invalidation, the callback gate and logical completion, not cancellation. Inherent to the current driver interface; mandatory signal plus quiescence/quarantine is the strongest available guarantee.
- **Quiescence/operation timeout defaults** are defensible constants, not measured SLAs; no live feed exists to calibrate them; no new env var by design.
- **Driver factory change** touches composition, all existing fakes in `tests/market/supervisor.test.ts`, and new fakes; accepted tests must still pass unchanged after migration.
- **`getConnectionState()`** remains an unused interface member; left to avoid unrelated refactoring.
- **No supervisor manual-retry API:** re-attempt after exhaustion relies on an existing PUT or restart; a dedicated control needs separate scope.
- **Soak targets** (10k events, 100 clients, 1,000/500 cycles) are deterministic stress choices, not performance SLAs; M9 owns measured targets.
- **Hub timer seam** narrow to Stage F need; other timers out of scope.

## 20. Final git state (at plan time)

```
## develop...origin/develop
```
HEAD `612a13b`; `main` `277d5e2…` unchanged; no staged/untracked files.

---

**FINAL STAGE F PLAN — NO IMPLEMENTATION, FILE MODIFICATION, COMMIT OR PUSH PERFORMED — AWAITING INDEPENDENT REVIEW AND EXPLICIT IMPLEMENTATION AUTHORIZATION.**
