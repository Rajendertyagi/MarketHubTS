# M6-E — Second-device LAN acceptance procedure

> **Status:** Repeatable manual procedure. **Result: NOT TESTED** — no second device was available in the implementation environment. LAN acceptance is therefore **not claimed**; this document records the procedure and the exact evidence required to close it.
> **Governing:** [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md) §6.4; [`M6_PLAN.md`](M6_PLAN.md) §12.
> **Target:** `2026-07-28` / SDK `2.4.0`.

## 1. Purpose

Automated loopback tests (`tests/mcp/http-integration.test.ts`) prove the handler works on `127.0.0.1`. They do **not** prove a second device on the private LAN can reach the configured LAN interface, pass Host/Origin validation, and receive a notification after a synthetic canonical change. This procedure closes that gap.

## 2. Test-only synthetic event harness (no production endpoint)

The LAN run needs a controlled canonical change the second device can trigger. **No production debug/mutation endpoint is added.** The harness is **implemented** at `apps/api/src/lan-test-entry.ts` (test-only; never imported by `apps/api/src/index.ts` or `app.ts`).

**Concrete command** (cross-platform, from the repo root):

```bash
MARKETHUB_HOST=<lan-ip> MARKETHUB_PORT=<port> bun run dev:lan-test
```

The `dev:lan-test` script sets `MARKETHUB_LAN_TEST=1` via `bun -e` (cross-platform). The entry **refuses to start** without that variable (`REFUSED: LAN test harness requires MARKETHUB_LAN_TEST=1`) before opening any port or DB — this is the confirmed test-build guard. On success it logs `lan_test_harness_ready` with `guard: "MARKETHUB_LAN_TEST=1"` and the bound host/port.

**Trigger:** type `emit` into the harness stdin to call `service.track("LAN-TEST-<n>")` — a canonical `item-updated` through the same `MarketDataService` path the bridge subscribes to, so the LAN notification exercises the real bridge/handler, not a stub. `status` prints the current revision; `quit` shuts down cleanly (handler → bridge → hub → server → DB). There is deliberately **no HTTP mutation endpoint**, not even in this test build.

**Guardrails:** no live provider, no broker credentials, no market session, no production/user DB — a temporary DB and synthetic instruments only. Confirm the test build is active by checking the `lan_test_harness_ready` log line and the `MARKETHUB_LAN_TEST=1` guard before the run.

## 3. Procedure

1. Record environment: API machine LAN IPv4, bind host (`config.host`), API port, `MARKETHUB_LAN` state, client device/interface, client MCP configuration, test date.
2. Start the test-only harness bound to the configured LAN interface (not `0.0.0.0` unless that is the documented config). Confirm from the second device that `http://<lan-ip>:<port>/mcp` is reachable.
3. From a modern-pinned MCP client on the second device:
   - `server/discover` returns `2026-07-28` and advertises `resources.subscribe: true`.
   - `tools/list`, `resources/list`, `resources/templates/list` succeed.
   - `resources/read` on `markethub://market/snapshot` returns a JSON body with `revision`.
   - Open `subscriptions/listen` with `resourceSubscriptions: ["markethub://market/snapshot"]`; confirm ack is first and the honored filter includes the URI.
4. Trigger one synthetic change via the test-only harness. Confirm the client receives `notifications/resources/updated` for the snapshot URI.
5. Read-after-notify: re-read the snapshot (revision advanced) and read `markethub://events/live?after=<resumeCursor>&limit=100`; confirm the event is present or an explicit `snapshotRequired` recovery is returned.
6. Host/Origin: a configured LAN Host/Origin is accepted; an unapproved Host/Origin is rejected with 403. Do **not** loosen SDK validation to make a failing case pass.
7. Confirm the endpoint is not reachable from the public internet (no port-forward; no-login LAN endpoint not exposed publicly).
8. Record expected vs actual results, timestamps, and redacted logs/screenshots as evidence. Note any deviation.

## 4. Result

| Field | Value |
|---|---|
| Executed | **No** — no second device available |
| LAN acceptance | **NOT TESTED** |
| Blocker | No second device on a private LAN with the harness running |
| Evidence | None (loopback evidence in `tests/mcp/http-integration.test.ts` is explicitly not LAN evidence) |

Per the phase gate, "not tested" blocks claiming LAN acceptance. M6-E cannot be declared complete on LAN grounds until this procedure is executed and its evidence recorded.
