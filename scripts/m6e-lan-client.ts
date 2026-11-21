/**
 * M6-E second-device LAN acceptance client — runs on the MacBook (client device).
 *
 * Connects to the guarded LAN test harness on the Windows PC over the private
 * Wi-Fi LAN using ONLY the official MCP TypeScript SDK (2.4.0). No MCP protocol
 * messages are hand-written: discovery, listing, reads, tool calls and the
 * subscription are all performed through the SDK Client API. Raw `fetch` is used
 * solely for the HTTP Host/Origin boundary checks (HTTP middleware, not MCP
 * protocol messages), which the SDK does not expose.
 *
 * Usage (from the repo root on the MacBook, after `bun install`):
 *   bun scripts/m6e-lan-client.ts <PC-LAN-IP> <PORT>
 * or:
 *   M6E_PC_IP=192.168.1.10 M6E_PC_PORT=3001 bun scripts/m6e-lan-client.ts
 *
 * The operator must type `emit` in the Windows harness when this client prints
 * "READY — type 'emit' on the Windows harness now".
 *
 * Prints PASS/FAIL per acceptance step and exits 0 only if every step passes.
 */
import { Client, StreamableHTTPClientTransport, type McpSubscription } from "@modelcontextprotocol/client";

const PROTOCOL_VERSION = "2026-07-28";
const SNAPSHOT_URI = "markethub://market/snapshot";
const EVENTS_URI = "markethub://events/live?after=first&limit=100";

const ip = process.env.M6E_PC_IP ?? process.argv[2];
const portRaw = process.env.M6E_PC_PORT ?? process.argv[3] ?? "3001";
const port = Number(portRaw);
const stepTimeoutMs = Number(process.env.M6E_STEP_TIMEOUT_MS ?? "15000");
const emitTimeoutMs = Number(process.env.M6E_EMIT_TIMEOUT_MS ?? "120000");

if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: bun scripts/m6e-lan-client.ts <PC-LAN-IP> <PORT>  (or set M6E_PC_IP / M6E_PC_PORT)");
  console.error(`  received ip=${JSON.stringify(ip)} port=${JSON.stringify(portRaw)}`);
  process.exit(2);
}

const baseUrl = `http://${ip}:${port}/mcp`;

interface StepRecord { name: string; ok: boolean; detail: string }
const results: StepRecord[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`;
  if (ok) console.log(line); else console.error(line);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    const detail = await withTimeout(fn(), stepTimeoutMs, name);
    record(name, true, detail);
    return true;
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
    return false;
  }
}

function parseJson(text: string | undefined): Record<string, unknown> {
  if (!text) throw new Error("resource returned no text content");
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("resource content is not a JSON object");
  return parsed as Record<string, unknown>;
}

async function readJsonResource(client: Client, uri: string): Promise<Record<string, unknown>> {
  const result = await client.readResource({ uri });
  const first = result.contents?.[0];
  if (!first || !("text" in first)) throw new Error("resource returned no text content");
  return parseJson(first.text);
}

let client: Client | null = null;
let subscription: McpSubscription | null = null;

async function main(): Promise<void> {
  console.log(`M6-E LAN acceptance client — target ${baseUrl} (protocol ${PROTOCOL_VERSION}, SDK 2.4.0)`);
  console.log(`Started ${new Date().toISOString()}`);

  // ---- 1. Connect + protocol negotiation ----
  const connected = await step("connect + negotiate protocol 2026-07-28", async () => {
    client = new Client(
      { name: "markethub-m6e-lan-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } }
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
    const negotiated = client.getNegotiatedProtocolVersion();
    if (negotiated !== PROTOCOL_VERSION) {
      throw new Error(`negotiated ${JSON.stringify(negotiated)}, expected ${PROTOCOL_VERSION}`);
    }
    return `negotiated ${negotiated}`;
  });
  if (!connected || !client) {
    record("remaining steps", false, "connection failed; aborting dependent steps");
    return;
  }
  const c = client;

  // ---- 2. server/discover + subscribe capability ----
  await step("server/discover + resources.subscribe === true", async () => {
    const discovery = await c.discover();
    const subscribe = discovery.capabilities?.resources?.subscribe;
    if (subscribe !== true) throw new Error(`resources.subscribe = ${JSON.stringify(subscribe)}, expected true`);
    const versions = discovery.supportedVersions ?? [];
    if (!versions.includes(PROTOCOL_VERSION)) {
      throw new Error(`supportedVersions does not include ${PROTOCOL_VERSION}: ${JSON.stringify(versions)}`);
    }
    return `subscribe=true, supportedVersions=${JSON.stringify(versions)}`;
  });

  // ---- 3. tools/list, resources/list, resources/templates/list, markethub_health ----
  await step("tools/list + resources/list + resources/templates/list", async () => {
    const [tools, resources, templates] = await Promise.all([
      c.listTools(), c.listResources(), c.listResourceTemplates()
    ]);
    const toolNames = tools.tools.map((t) => t.name);
    if (!toolNames.includes("markethub_health")) throw new Error("markethub_health missing from tools/list");
    if (resources.resources.length === 0) throw new Error("resources/list returned no resources");
    if (templates.resourceTemplates.length === 0) throw new Error("resources/templates/list returned no templates");
    return `tools=${tools.tools.length}, resources=${resources.resources.length}, templates=${templates.resourceTemplates.length}`;
  });

  await step("call markethub_health", async () => {
    const result = await c.callTool({ name: "markethub_health", arguments: {} });
    if (result.isError === true) throw new Error("markethub_health returned isError=true");
    return "markethub_health ok";
  });

  // ---- 4. Initial snapshot revision ----
  let initialRevision = -1;
  await step("read markethub://market/snapshot (initial revision)", async () => {
    const snap = await readJsonResource(c, SNAPSHOT_URI);
    if (typeof snap.revision !== "number") throw new Error("snapshot has no numeric revision");
    initialRevision = snap.revision;
    return `revision=${initialRevision}`;
  });

  // ---- 5. Register notification handler BEFORE opening the subscription ----
  let notifyResolve: (() => void) | null = null;
  const notificationPromise = new Promise<void>((resolve) => { notifyResolve = resolve; });
  let ackDone = false;
  let notifiedBeforeAck = false;
  let notificationCount = 0;
  c.setNotificationHandler("notifications/resources/updated", (notification) => {
    notificationCount++;
    if (!ackDone) notifiedBeforeAck = true;
    if (notifyResolve) { const resolve = notifyResolve; notifyResolve = null; resolve(); }
    void notification; // params intentionally not asserted; delivery is the signal
  });

  // ---- 6. Open subscriptions/listen for exactly the snapshot URI ----
  await step("subscriptions/listen for exactly markethub://market/snapshot", async () => {
    subscription = await c.listen({ resourceSubscriptions: [SNAPSHOT_URI] });
    ackDone = true; // listen() resolves only after the acknowledgement
    const honored = subscription.honoredFilter.resourceSubscriptions;
    if (!honored || honored.length !== 1 || honored[0] !== SNAPSHOT_URI) {
      throw new Error(`honoredFilter.resourceSubscriptions = ${JSON.stringify(honored)}`);
    }
    if (notifiedBeforeAck) throw new Error("a resource-updated notification arrived before the acknowledgement");
    return `ack first, honoredFilter=${JSON.stringify(honored)}`;
  });

  // ---- 7. Wait for the notification caused by the harness `emit` ----
  await step("notification after harness emit", async () => {
    console.log("\n>>> READY — type 'emit' on the Windows harness now (then 'status' to confirm).\n");
    await withTimeout(notificationPromise, emitTimeoutMs, "waiting for harness emit notification");
    if (notificationCount < 1) throw new Error("notification handler did not fire");
    return `received ${notificationCount} resource-updated notification(s)`;
  });

  // ---- 8. Re-read snapshot, verify revision advanced ----
  await step("snapshot revision advanced after notification", async () => {
    const snap = await readJsonResource(c, SNAPSHOT_URI);
    const revision = snap.revision;
    if (typeof revision !== "number") throw new Error("snapshot has no numeric revision");
    if (!(revision > initialRevision)) {
      throw new Error(`revision did not advance: ${initialRevision} -> ${revision}`);
    }
    return `revision ${initialRevision} -> ${revision}`;
  });

  // ---- 9. Read live event feed, verify synthetic event ----
  // Outbound feed events are shaped { event, id, data: { type, revision, canonicalId, ... } }.
  const isSynthetic = (e: Record<string, unknown>): boolean => {
    const data = (e.data && typeof e.data === "object") ? e.data as Record<string, unknown> : {};
    return e.event === "item-updated" && typeof data.canonicalId === "string" && data.canonicalId.startsWith("LAN-TEST-");
  };
  let resumeCursor: string | undefined;
  await step("read markethub://events/live?after=first&limit=100 (synthetic event)", async () => {
    const feed = await readJsonResource(c, EVENTS_URI);
    const events = Array.isArray(feed.events) ? feed.events as Record<string, unknown>[] : [];
    const synthetic = events.find(isSynthetic);
    if (!synthetic) {
      throw new Error(`no synthetic LAN-TEST-* item-updated event in ${events.length} event(s): ${JSON.stringify(events)}`);
    }
    if (typeof feed.resumeCursor === "string") resumeCursor = feed.resumeCursor;
    const canonicalId = (synthetic.data as Record<string, unknown>).canonicalId;
    return `found ${String(canonicalId)} in ${events.length} event(s)`;
  });

  // ---- 10. Incremental cursor read ----
  await step("incremental cursor read (resumeCursor)", async () => {
    if (!resumeCursor) throw new Error("no resumeCursor returned by the first feed read");
    const uri = `markethub://events/live?after=${encodeURIComponent(resumeCursor)}&limit=100`;
    const feed = await readJsonResource(c, uri);
    if (!Array.isArray(feed.events)) throw new Error("incremental read returned no events array");
    const replayed = (feed.events as Record<string, unknown>[]).some(isSynthetic);
    if (replayed) throw new Error("incremental read replayed already-consumed events");
    return `incremental read ok (${(feed.events as unknown[]).length} new event(s))`;
  });

  // ---- 11. HTTP Host/Origin boundary (raw fetch: HTTP middleware, not MCP messages) ----
  // A complete modern-envelope body so the valid case reaches the handler (200)
  // rather than failing header/body classification (400); the security assertion
  // is "not 403" for valid values and "403" for unapproved values.
  const modernDiscoverBody = JSON.stringify({
    jsonrpc: "2.0", id: 9001, method: "server/discover",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} } }
  });
  await step("Host/Origin boundary: valid private-LAN values accepted", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "server/discover",
        Host: `${ip}:${port}`,
        Origin: `http://${ip}`
      },
      body: modernDiscoverBody
    });
    if (res.status === 403) throw new Error(`valid Host/Origin rejected with 403: ${await res.text()}`);
    return `Host=${ip}:${port}, Origin=http://${ip} -> HTTP ${res.status} (not 403)`;
  });

  await step("Host/Origin boundary: unapproved Host rejected with 403", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "server/discover",
        Host: `evil.example:${port}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9002, method: "server/discover", params: {} })
    });
    if (res.status !== 403) throw new Error(`unapproved Host returned HTTP ${res.status}, expected 403`);
    return `Host=evil.example:${port} -> HTTP 403`;
  });

  await step("Host/Origin boundary: unapproved Origin rejected with 403", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "server/discover",
        Host: `${ip}:${port}`,
        Origin: "http://evil.example"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9003, method: "server/discover", params: {} })
    });
    if (res.status !== 403) throw new Error(`unapproved Origin returned HTTP ${res.status}, expected 403`);
    return `Origin=http://evil.example -> HTTP 403`;
  });

  // ---- 12. Clean close ----
  await step("clean close of subscription and client", async () => {
    if (subscription) await subscription.close();
    await c.close();
    return "subscription and client closed";
  });
}

main()
  .catch((err) => record("unexpected client error", false, err instanceof Error ? err.stack ?? err.message : String(err)))
  .finally(() => {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n=== M6-E LAN acceptance summary: ${passed} PASS / ${failed} FAIL ===`);
    console.log(`Finished ${new Date().toISOString()}`);
    process.exit(failed === 0 ? 0 : 1);
  });
