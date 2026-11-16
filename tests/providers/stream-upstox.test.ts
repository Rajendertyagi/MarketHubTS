import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizeObservationInput } from "../../packages/market-core/src/index";
import { openDatabase, SqliteCredentialStore } from "../../packages/database/src/index";
import {
  UPSTOX_FEED_AUTHORIZE_URL,
  UPSTOX_TOKEN_CREDENTIAL,
  UPSTOX_V3_LIMITS,
  UpstoxMarketDataStream,
  encodeFeedResponse,
  type StreamSocket
} from "../../packages/broker-upstox/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const NOW = 1_700_000_000_000;
const NIFTY_KEY = "NSE_INDEX|Nifty 50";
const NIFTY_CANONICAL = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";
const BANK_KEY = "NSE_INDEX|Nifty Bank";
const BANK_CANONICAL = "v1|NSE|INDEX|INDEX|CODE:NIFTYBANK";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

class MockSocket implements StreamSocket {
  binaryType = "nodebuffer";
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  closed = false;

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer));
  }
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.({}); }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  emit(bytes: Uint8Array): void { this.onmessage?.({ data: bytes }); }
  frames(): Array<Record<string, any>> {
    return this.sent.map((b) => JSON.parse(new TextDecoder().decode(b)));
  }
}

function ltpFeed(ltp: number, ltt = NOW - 1000, ltq = 75, cp = 26216.05): Record<string, unknown> {
  return { ltpc: { ltp, ltt, ltq, cp }, requestMode: 0 };
}

function setup() {
  const dir = join(tmpdir(), `mh-stream-upstox-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const handle = openDatabase({ dbPath: join(dir, "data", "markethub.sqlite"), migrate: true });
  handles.push(handle);
  const credentials = new SqliteCredentialStore(handle);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const sockets: MockSocket[] = [];
  const observations: NormalizeObservationInput[] = [];
  const states: Array<{ state: string; error?: string | null }> = [];
  const stream = new UpstoxMarketDataStream({
    credentials,
    now: () => new Date(NOW),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        status: "success",
        data: { authorized_redirect_uri: "wss://feed.upstox.test/v3?code=single-use" }
      }), { status: 200 });
    },
    webSocketFactory: () => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    }
  });
  return { stream, credentials, calls, sockets, observations, states, handle };
}

async function configure(stream: UpstoxMarketDataStream, credentials: SqliteCredentialStore) {
  await credentials.set("UPSTOX", UPSTOX_TOKEN_CREDENTIAL, "test-token");
  return stream;
}

afterEach(() => {
  while (handles.length) { try { handles.pop()?.close(); } catch {} }
  while (dirs.length) { try { removeTempDir(dirs.pop()!); } catch {} }
});

describe("Upstox V3 stream — authorize and connect", () => {
  test("uses the versioned authorize URL with Bearer token and no generic retry", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: (o) => h.observations.push(o), onConnectionState: (s, e) => h.states.push({ state: s, error: e }) }
    );
    expect(h.calls.length).toBe(1);
    expect(h.calls[0]!.url).toBe(UPSTOX_FEED_AUTHORIZE_URL);
    expect(h.calls[0]!.init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(h.sockets.length).toBe(1);
    expect(h.stream.getConnectionState()).toBe("CONNECTING");
  });

  test("rejects a malformed authorize response without opening a socket", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    h.stream["fetchImpl"] = async () => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    await expect(h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: () => {}, onConnectionState: () => {} }
    )).rejects.toThrow();
    expect(h.sockets.length).toBe(0);
    expect(h.stream.getConnectionState()).toBe("ERROR");
  });

  test("fails when no token is configured", async () => {
    const h = setup();
    await expect(h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: () => {}, onConnectionState: () => {} }
    )).rejects.toThrow("not configured");
    expect(h.calls.length).toBe(0);
  });
});

describe("Upstox V3 stream — binary subscribe frames", () => {
  test("sends a binary sub frame on open with mode and instrument keys", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "ltpc" }],
      { onObservation: (o) => h.observations.push(o), onConnectionState: (s, e) => h.states.push({ state: s, error: e }) }
    );
    h.sockets[0]!.open();
    const frames = h.sockets[0]!.frames();
    expect(frames.length).toBe(1);
    expect(frames[0]!.method).toBe("sub");
    expect(frames[0]!.data.mode).toBe("ltpc");
    expect(frames[0]!.data.instrumentKeys).toEqual([NIFTY_KEY]);
    expect(typeof frames[0]!.guid).toBe("string");
    expect(h.stream.getConnectionState()).toBe("STREAMING");
  });

  test("updateSubscriptions sends unsub and sub frames", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: () => {}, onConnectionState: () => {} }
    );
    h.sockets[0]!.open();
    await h.stream.updateSubscriptions([{ instrumentKey: BANK_KEY, canonicalId: BANK_CANONICAL }]);
    const frames = h.sockets[0]!.frames();
    expect(frames.map((f) => f.method)).toEqual(["sub", "unsub", "sub"]);
    expect(frames[1]!.data.instrumentKeys).toEqual([NIFTY_KEY]);
    expect(frames[1]!.data.mode).toBeUndefined();
    expect(frames[2]!.data.instrumentKeys).toEqual([BANK_KEY]);
  });

  test("enforces subscription limits", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    const tooMany = Array.from({ length: UPSTOX_V3_LIMITS.ltpc.combined + 1 }, (_, i) => ({
      instrumentKey: `K${i}`, canonicalId: `C${i}`
    }));
    await expect(h.stream.start(tooMany, { onObservation: () => {}, onConnectionState: () => {} })).rejects.toThrow("exceeds limit");
  });
});

describe("Upstox V3 stream — protobuf decode and validation", () => {
  test("decodes an LTPC feed into a canonical observation with provenance", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: (o) => h.observations.push(o), onConnectionState: (s, e) => h.states.push({ state: s, error: e }) }
    );
    h.sockets[0]!.open();
    h.sockets[0]!.emit(encodeFeedResponse({ type: 1, currentTs: NOW, feeds: { [NIFTY_KEY]: ltpFeed(26188.1) } }));

    expect(h.observations.length).toBe(1);
    const o = h.observations[0]!;
    expect(o.provider).toBe("UPSTOX");
    expect(o.canonicalId).toBe(NIFTY_CANONICAL);
    expect(o.value).toMatchObject({ ltp: 26188.1, lastTradedQuantity: 75, close: 26216.05 });
    expect(o.rawProviderTimestamp).toBe(NOW - 1000);
    expect(o.providerTimestampUnit).toBe("MS");
    expect(o.providerTimestampMeaning).toBe("last traded time");
    expect(o.receivedAtMs).toBe(NOW);
    expect(o.sourceVersion).toBe("v3");
  });

  test("ignores market_info and unsubscribed instruments", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: (o) => h.observations.push(o), onConnectionState: () => {} }
    );
    h.sockets[0]!.open();
    h.sockets[0]!.emit(encodeFeedResponse({ type: 2, currentTs: NOW, feeds: {} }));
    h.sockets[0]!.emit(encodeFeedResponse({ type: 1, currentTs: NOW, feeds: { [BANK_KEY]: ltpFeed(50000) } }));
    expect(h.observations.length).toBe(0);
  });

  test("malformed protobuf produces an error state, never an observation", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: (o) => h.observations.push(o), onConnectionState: (s, e) => h.states.push({ state: s, error: e }) }
    );
    h.sockets[0]!.open();
    h.sockets[0]!.emit(new Uint8Array([0xff, 0xff, 0xff]));
    expect(h.observations.length).toBe(0);
    expect(h.states.some((s) => s.state === "ERROR")).toBe(true);
  });

  test("preserves provider-native fields without fabricating missing ones", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL, mode: "full" }],
      { onObservation: (o) => h.observations.push(o), onConnectionState: () => {} }
    );
    h.sockets[0]!.open();
    h.sockets[0]!.emit(encodeFeedResponse({
      type: 1, currentTs: NOW,
      feeds: { [NIFTY_KEY]: { fullFeed: { indexFF: { ltpc: { ltp: 26188.1, ltt: NOW, ltq: 10, cp: 26216 } } }, requestMode: 3 } }
    }));
    expect(h.observations.length).toBe(1);
    expect(h.observations[0]!.value.ltp).toBe(26188.1);
    expect(h.observations[0]!.value.native).toBeUndefined();
  });
});

describe("Upstox V3 stream — lifecycle", () => {
  test("stop closes the socket and clears subscriptions", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: () => {}, onConnectionState: (s) => h.states.push({ state: s }) }
    );
    h.sockets[0]!.open();
    h.stream.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.stream.getSubscriptions().length).toBe(0);
    expect(h.stream.getConnectionState()).toBe("DISCONNECTED");
  });

  test("socket close reports DISCONNECTED without destroying state", async () => {
    const h = setup();
    await configure(h.stream, h.credentials);
    await h.stream.start(
      [{ instrumentKey: NIFTY_KEY, canonicalId: NIFTY_CANONICAL }],
      { onObservation: () => {}, onConnectionState: (s) => h.states.push({ state: s }) }
    );
    h.sockets[0]!.open();
    h.sockets[0]!.close();
    expect(h.states.map((s) => s.state)).toContain("DISCONNECTED");
    expect(h.stream.getSubscriptions().length).toBe(1);
  });
});
