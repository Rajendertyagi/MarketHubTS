# M6-E — Second-device LAN acceptance procedure

> **Status:** Executable, repeatable two-machine procedure. **Result: NOT TESTED** — the real MacBook → Windows-PC run has **not** been executed in the implementation environment. LAN acceptance is therefore **not claimed**. A localhost preflight of the client/harness was run (see §8) but does **not** count as second-device LAN acceptance.
> **Governing:** [`M6_D_E_PLAN.md`](M6_D_E_PLAN.md) §6.4; [`M6_PLAN.md`](M6_PLAN.md) §12.
> **Target:** protocol `2026-07-28` / official MCP TypeScript SDK `2.4.0`.

## 1. Purpose

Automated loopback tests (`tests/mcp/http-integration.test.ts`) prove the handler works on `127.0.0.1`. They do **not** prove a second device on the private LAN can reach the configured LAN interface, pass Host/Origin validation, and receive a notification after a synthetic canonical change. This procedure closes that gap with an executable client and a guarded harness.

**Devices (actual):**
- **API host:** Windows 11 PC running MarketHubTS (the harness, not production composition).
- **Client:** MacBook Air M1 on the same private Wi-Fi network.

## 2. Executable client and test-only harness

**MacBook acceptance client:** [`scripts/m6e-lan-client.ts`](../scripts/m6e-lan-client.ts). It uses **only** the official `@modelcontextprotocol/client` SDK (`2.4.0`) for all MCP operations (discovery, listing, reads, tool call, subscription). Raw `fetch` is used **only** for the HTTP Host/Origin boundary checks (HTTP middleware, not MCP protocol messages). It accepts the PC LAN IPv4 and port as arguments or env vars, prints `PASS`/`FAIL` per step, and exits `0` only if every step passes.

**Test-only harness:** `apps/api/src/lan-test-entry.ts` (never imported by `apps/api/src/index.ts` or `app.ts`). **No production debug/mutation endpoint is added.** Guard: `MARKETHUB_LAN_TEST=1`; without it the process exits before opening any port or DB (`REFUSED: LAN test harness requires MARKETHUB_LAN_TEST=1. This entry is test-only.`). On success it logs `lan_test_harness_ready` with `guard: "MARKETHUB_LAN_TEST=1"` and the bound host/port.

**Trigger:** type `emit` into the harness stdin → `service.track("LAN-TEST-<n>")`, a canonical `item-updated` through the same `MarketDataService` path the notification bridge subscribes to (real bridge/handler, not a stub). `status` prints the current revision; `quit` shuts down cleanly (handler → bridge → hub → server → DB). There is deliberately **no HTTP mutation endpoint**, not even in this test build.

**Guardrails:** no live provider, no broker credentials, no market session, no production/user DB — a temporary DB and synthetic instruments only. Confirm the guard by checking the `lan_test_harness_ready` log line before the run.

## 3. Windows PC — start the guarded harness

Run all commands in **PowerShell** from the repo root (`D:\Temp\MarketHubTS`).

### 3.1 Find the active private Wi-Fi IPv4

```powershell
Get-NetIPConfiguration |
  Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway } |
  ForEach-Object {
    [pscustomobject]@{
      Adapter   = $_.InterfaceAlias
      Profile   = (Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex).NetworkCategory
      LANIPv4   = $_.IPv4Address.IPAddress
      Gateway   = $_.IPv4DefaultGateway.NextHop
    }
  } | Format-Table -Auto
```

Pick the adapter whose `Profile` is **Private** and whose `LANIPv4` is in `192.168.x.x`, `10.x.x.x`, or `172.16–31.x.x`. Call this `<PC-LAN-IP>`. Do **not** use a `169.254.x.x` (APIPA) address.

### 3.2 Choose a free test port

```powershell
$port = 31337
$inUse = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
if ($inUse) { throw "Port $port is in use; choose another." }
Write-Output "Using test port $port"
```

### 3.3 Start the harness bound to the private LAN interface

Bind to the concrete `<PC-LAN-IP>` (not `0.0.0.0`) so the listener is limited to the private interface:

```powershell
$env:MARKETHUB_LAN_TEST = '1'
$env:MARKETHUB_LAN      = 'true'
$env:MARKETHUB_HOST     = '<PC-LAN-IP>'   # e.g. 192.168.1.10
$env:MARKETHUB_PORT     = '31337'
bun run dev:lan-test
```

`dev:lan-test` sets `MARKETHUB_LAN_TEST=1` cross-platform via `bun -e`. Confirm this line appears before continuing:

```
{"level":"info","msg":"lan_test_harness_ready","meta":{"host":"<PC-LAN-IP>","port":31337,"lan":true,"guard":"MARKETHUB_LAN_TEST=1"}}
LAN test harness listening on http://<PC-LAN-IP>:31337/mcp — type 'emit' to trigger a synthetic change, 'quit' to stop.
```

Leave this terminal open. The client will ask you to type `emit` when it is ready.

### 3.4 Windows Firewall — allow ONLY the test port on the Private profile

Do **not** disable the firewall. Add a narrowly scoped inbound rule for the test port, restricted to the Private profile and the PC LAN IP:

```powershell
New-NetFirewallRule -DisplayName 'MarketHubTS M6-E LAN test (Private)' `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 31337 `
  -Profile Private -LocalAddress '<PC-LAN-IP>' | Out-Null
Get-NetFirewallRule -DisplayName 'MarketHubTS M6-E LAN test (Private)' |
  Format-List DisplayName, Enabled, Direction, Action, Profile
```

Remove the rule after the run:

```powershell
Remove-NetFirewallRule -DisplayName 'MarketHubTS M6-E LAN test (Private)'
```

Confirm there is **no** port-forward or public exposure: the rule is `Profile Private`, `LocalAddress` is the private LAN IP, and no router port-forward points at `<port>`.

### 3.5 Trigger and stop

When the MacBook client prints `READY — type 'emit' on the Windows harness now`, type into the harness terminal:

```
emit
status
```

Expected: `emitted synthetic item-updated revision 1` then `revision=1 emitted=1`. After the client finishes, stop the harness:

```
quit
```

Expected: `LAN test harness stopped.` (exit 0).

## 4. MacBook — run the acceptance client

Run in **Terminal** from the repo root (after `bun install`; the SDK is a devDependency pinned to `2.4.0`).

### 4.1 Find the MacBook Wi-Fi IPv4 and confirm the same network

```bash
ipconfig getifaddr en0        # usually en0 on MacBook Air; try en1 if empty
```

Confirm it is on the same private subnet as `<PC-LAN-IP>` (e.g. both `192.168.1.x`). Verify reachability:

```bash
PC_IP=192.168.1.10
PORT=31337
ping -c 2 "$PC_IP"
nc -z -v "$PC_IP" "$PORT" && echo "port reachable"
```

### 4.2 Run the client and capture output + exit status

```bash
bun scripts/m6e-lan-client.ts "$PC_IP" "$PORT" 2>&1 | tee m6e-lan-client.log
echo "CLIENT_EXIT=${PIPESTATUS[0]}"
```

Equivalent one-command form via the package script:

```bash
M6E_PC_IP="$PC_IP" M6E_PC_PORT="$PORT" bun run m6e:lan-client 2>&1 | tee m6e-lan-client.log
echo "CLIENT_EXIT=${PIPESTATUS[0]}"
```

`CLIENT_EXIT=0` means all 14 steps passed. The client prints `PASS`/`FAIL` per step and a final `=== M6-E LAN acceptance summary: N PASS / M FAIL ===`.

## 5. What the client verifies (mapped to the requirement)

| # | Step | Mechanism (official SDK unless noted) |
|---|---|---|
| 1 | Connect to `http://<PC-LAN-IP>:<PORT>/mcp`, negotiate `2026-07-28` | `Client.connect` + `getNegotiatedProtocolVersion()` |
| 2 | `server/discover`, `resources.subscribe === true` | `client.discover()` → `capabilities.resources.subscribe` |
| 3 | `tools/list`, `resources/list`, `resources/templates/list` | `client.listTools/listResources/listResourceTemplates()` |
| 4 | `markethub_health` | `client.callTool()` |
| 5 | Read snapshot, record initial revision | `client.readResource()` |
| 6 | Register notification handler **before** `listen()` | `client.setNotificationHandler("notifications/resources/updated", …)` |
| 7 | `subscriptions/listen` for exactly the snapshot URI; ack first; honored filter | `client.listen({ resourceSubscriptions: [SNAPSHOT_URI] })` → `honoredFilter` |
| 8 | Wait for notification after harness `emit` | deferred promise resolved by the handler (bounded by `M6E_EMIT_TIMEOUT_MS`, default 120 s) |
| 9 | Re-read snapshot, revision advanced | `client.readResource()` |
| 10 | Read `markethub://events/live?after=first&limit=100`, synthetic event present | `client.readResource()` |
| 11 | Incremental cursor read | `client.readResource()` with `after=<resumeCursor>` |
| 12 | Host/Origin positive + negative | raw `fetch` (HTTP middleware, not MCP messages) |
| 13 | Clean close | `subscription.close()` + `client.close()` |

**Host/Origin values tested (do not weaken validation):**
- Valid Host: `<PC-LAN-IP>:<PORT>` → accepted (HTTP 200).
- Valid Origin: `http://<PC-LAN-IP>` → accepted (HTTP 200).
- Unapproved Host: `evil.example:<PORT>` → **HTTP 403**.
- Unapproved Origin: `http://evil.example` → **HTTP 403**.

Rationale: `buildMcpAllowlists()` (`apps/api/src/mcp-routes.ts`) adds loopback, the concrete `config.host`, and all private LAN IPv4 addresses when `MARKETHUB_LAN=true`; the SDK validates hostname only (port-agnostic). A missing Origin passes; an invalid/unapproved Origin returns 403 JSON-RPC `-32003`.

## 6. Evidence template (fill in after the real run)

Copy this into the run record. Redact any sensitive values (none expected — synthetic data only).

```
Run ID:            M6-E-LAN-<YYYYMMDD>-<HHMMSS>
Executed (UTC):    <timestamp>
PC:                Windows 11, <PC-LAN-IP>, adapter <name>, profile Private
MacBook:           MacBook Air M1, Wi-Fi IPv4 <ip>, macOS <version>
Network:           <SSID / subnet>, same-private-LAN confirmed: yes/no
Port:              <port>, firewall rule Private-only confirmed: yes/no
Harness guard:     lan_test_harness_ready seen: yes/no; guard=MARKETHUB_LAN_TEST=1
Harness log:       <redacted ready + emit + status + stopped lines>
Client command:    bun scripts/m6e-lan-client.ts <PC-LAN-IP> <PORT>
Client exit:       <0 or non-zero>
Summary:           <N> PASS / <M> FAIL
Per-step results:  <paste the PASS/FAIL lines from m6e-lan-client.log>
Host/Origin:       valid=<status>, badHost=<status>, badOrigin=<status>
Expected vs actual:<any deviation, or "all as expected">
Public exposure:   no port-forward / no public exposure confirmed: yes/no
```

## 7. Result

| Field | Value |
|---|---|
| Executed | **No** — real MacBook → Windows-PC run not performed in this environment |
| LAN acceptance | **NOT TESTED** |
| Blocker | No second device was driven against the harness in the implementation environment |
| Executable client | `scripts/m6e-lan-client.ts` (14 steps, PASS/FAIL, exit code) |
| CI-safe regression test | `tests/mcp/lan-path.test.ts` — same 14-step client on a real `127.0.0.1` listener; runs with `bun test` on any machine, no external dependency (see §8) |
| Local preflight | Passed (see §8) — **not** LAN evidence |
| Evidence | None for the real two-device run; template in §6 |

Per the phase gate, "not tested" blocks claiming LAN acceptance. M6-E cannot be declared complete on LAN grounds until this procedure is executed on the actual devices and its evidence recorded. Do **not** change `LAN acceptance` to `PASS` until the real run succeeds.

## 8. Local preflight performed (NOT LAN acceptance)

The following were run locally to verify the client/harness mechanics only:

- Harness guard refusal: `bun apps/api/src/lan-test-entry.ts` → `REFUSED: … MARKETHUB_LAN_TEST=1`, exit 1.
- Harness start with temp DB / no providers: `lan_test_harness_ready` observed on `127.0.0.1` with `guard: "MARKETHUB_LAN_TEST=1"`.
- Client typecheck: `tsc --noEmit … scripts/m6e-lan-client.ts` → exit 0.
- Client end-to-end against the harness on `127.0.0.1` (coordinated `emit`): **14 PASS / 0 FAIL**, exit 0.
- CI-safe regression test: `bun test tests/mcp/lan-path.test.ts` → 1 pass / 0 fail. It imports the exported `runAcceptance()` from the client and drives the same 14 steps against a real `Bun.serve` listener on `127.0.0.1`, triggering the canonical change in-process. No Mac, WSL, Docker, second PC, or new dependency — runs unchanged on the Windows PC and on a GitHub runner as part of the normal `bun test` suite.

This loopback preflight (including the CI test) does **not** satisfy the second-device requirement. Only the §3–§4 procedure on the actual Windows PC and MacBook can close LAN acceptance.
