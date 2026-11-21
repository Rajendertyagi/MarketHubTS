# M6-E — LAN scope decision (user-approved)

> **Status:** Scope changed by explicit user decision. This document is retained only as the stable reference for that decision.
> **Governing:** [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md) §6.4; [`M6_PLAN.md`](M6_PLAN.md) §10–§12.

## Decision

The user has explicitly removed the second-device / MacBook / Windows-PC physical LAN acceptance requirement from M6-E. There will be **no** manual LAN procedure, no second physical device, no test-only LAN harness, and no separate LAN client. The former artifacts (`apps/api/src/lan-test-entry.ts`, `scripts/m6e-lan-client.ts`, the `dev:lan-test` / `m6e:lan-client` scripts and the old two-machine procedure) have been deleted.

## Replacement

The composed behavior previously targeted by the manual procedure is now covered by **one standalone in-process simulation test**: [`tests/mcp/lan-simulation.test.ts`](../tests/mcp/lan-simulation.test.ts). It uses the official MCP SDK with a mocked in-process `fetch`, in-memory services and the real notification bridge — no listener, socket, second device, external dependency or temporary database. It covers discovery/version, `resources.subscribe`, tool/resource/template access, snapshot reads, `subscriptions/listen` ack ordering and filter, a simulated canonical update through the bridge, notification delivery, revision advancement, live-feed cursor reads, and valid/invalid Host/Origin via the production validation helper.

## Honest scope statement

- **Physical LAN reachability is NOT verified** and is **outside the revised M6 scope**. The simulation test is **not** proof of real LAN connectivity and must not be described as such.
- This is a **user-approved scope change**, not a successful LAN test. No physical LAN run was performed or claimed.
- The broader real-listener gate is unchanged and still required: [`tests/mcp/http-integration.test.ts`](http-integration.test.ts) verifies the real Hono/Bun HTTP listener with a pinned official client. The simulation does not replace or weaken it.
- M6-C acceptance remains closed; M6-B4 remains separately owned. Passing this simulation does not by itself declare M6-D, M6-E, M6-B4 or combined M6 complete.
