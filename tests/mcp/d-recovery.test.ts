import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

/**
 * M6-D §8.1 / §6.1 evidence — read-after-notify and recovery semantics.
 *
 * Every assertion below goes through the REAL wire interface: `resources/read`
 * on `markethub://events/live?after=<cursor>&limit=100` (bootstrap `after=first`)
 * and `markethub://market/snapshot`, asserting `contents[0].mimeType` and
 * parsing `contents[0].text`. No internal `readAfter()` shape or `outcome`
 * property is used. The in-process SDK handler/client path keeps these tests
 * deterministic and local-only (no listener, provider, credential or network).
 * M6-E owns the broad real-HTTP integration; this file is D's wire-level gate.
 */

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

interface FeedEvent { event: string; id: string; data: { revision: number; type: string; [k: string]: unknown } }
interface FeedPage { events: FeedEvent[]; nextCursor: string | null; resumeCursor: string }
interface FeedRecovery { events: FeedEvent[]; nextCursor: null; snapshotRequired: { reason: string } }
type FeedBody = FeedPage | FeedRecovery;
interface Checkpoint { resumeCursor: string; lastFeedRevision: number }

/** Test-side implementation of the §5.2 client synchronization procedure. */
class WireSyncClient {
  snapshotRevision = 0;
  lastFeedRevision: number | null = null;
  checkpoint: Checkpoint | null = null;
  applied: number[] = [];
  recoveryFailure = false;
  feedReads = 0;
  /** Fires after the snapshot read — used by the snapshot-to-checkpoint race test. */
  onAfterSnapshot?: () => void | Promise<void>;
  /** Fires after the catch-up loop, before sync returns — used by the buffer-during-sync test. */
  onBeforeReturn?: () => void | Promise<void>;
  /** Fires before an after=first retry — used by the replay-history gap test. */
  onBeforeRetry?: () => void | Promise<void>;

  constructor(private readonly client: Client) {}

  private async read(uri: string): Promise<unknown> {
    const res = await this.client.readResource({ uri });
    expect(res.contents[0]!.mimeType).toBe("application/json");
    return JSON.parse(res.contents[0]!.text);
  }

  /** Snapshot-boundary validation for an after=first response (§5.2 step 4.3). */
  private bootstrapBoundaryOk(page: FeedPage): boolean {
    if (page.events.length === 0) return true;
    const firstNewer = page.events.find((e) => e.data.revision > this.snapshotRevision);
    return !firstNewer || firstNewer.data.revision === this.snapshotRevision + 1;
  }

  async adoptSnapshot(): Promise<void> {
    const body = await this.read("markethub://market/snapshot") as { revision: number };
    this.snapshotRevision = body.revision; // adopt: update dedup baseline, leave feed state
    await this.onAfterSnapshot?.();
  }

  private async readFeed(after: string): Promise<FeedBody> {
    this.feedReads++;
    return await this.read(`markethub://events/live?after=${after}&limit=100`) as FeedBody;
  }

  /** Full §5.2 sync: bootstrap/continue, validate continuity, apply, persist atomically. */
  async sync(): Promise<void> {
    let after = this.checkpoint?.resumeCursor ?? "first";
    let body = await this.readFeed(after);
    if ("snapshotRequired" in body) {
      // The API returns no cursor on this outcome — the only valid bootstrap
      // is after=first (§5.2 step 4.2).
      await this.adoptSnapshot();
      this.lastFeedRevision = null;
      this.checkpoint = null;
      after = "first";
      body = await this.readFeed(after);
      if ("snapshotRequired" in body) { this.recoveryFailure = true; return; }
    }

    let page: FeedPage = body as FeedPage;
    let retried = false;

    // Every after=first response — initial OR retry — must pass the snapshot
    // boundary check. A retry that also has a gap is an explicit recovery
    // failure, never a silently accepted first event.
    if (after === "first" && !this.bootstrapBoundaryOk(page)) {
      if (retried) { this.recoveryFailure = true; return; }
      retried = true;
      await this.adoptSnapshot();
      this.lastFeedRevision = null;
      this.checkpoint = null;
      await this.onBeforeRetry?.();
      const retry = await this.readFeed("first");
      if ("snapshotRequired" in retry || !this.bootstrapBoundaryOk(retry as FeedPage)) {
        this.recoveryFailure = true; return;
      }
      page = retry as FeedPage;
    }

    outer: for (;;) {
      for (const ev of page.events) {
        const rev = ev.data.revision;
        if (this.lastFeedRevision !== null && rev !== this.lastFeedRevision + 1) {
          if (retried) { this.recoveryFailure = true; return; }
          retried = true;
          // Gap: do NOT persist; re-baseline and restart from after=first.
          await this.adoptSnapshot();
          this.lastFeedRevision = null;
          this.checkpoint = null;
          await this.onBeforeRetry?.();
          const retry = await this.readFeed("first");
          if ("snapshotRequired" in retry || !this.bootstrapBoundaryOk(retry as FeedPage)) {
            this.recoveryFailure = true; return;
          }
          page = retry as FeedPage;
          continue outer; // fully consume the retry page before any persistence
        }
        this.lastFeedRevision = rev;
        if (rev > this.snapshotRevision) this.applied.push(rev);
      }
      // Persist checkpoint atomically only after the whole page is consumed.
      if (page.events.length > 0) {
        this.checkpoint = { resumeCursor: page.resumeCursor, lastFeedRevision: this.lastFeedRevision! };
      } else if (this.lastFeedRevision === null) {
        // Fresh revision-zero empty bootstrap.
        this.lastFeedRevision = 0;
        this.checkpoint = { resumeCursor: page.resumeCursor, lastFeedRevision: 0 };
      }
      if (page.nextCursor === null) break;
      page = await this.readFeed(page.nextCursor) as FeedPage;
    }
    // A notification arriving while sync is still running is a change signal
    // with no cursor: it must never advance the checkpoint. The hook simulates
    // such an arrival after the last page read but before sync returns.
    await this.onBeforeReturn?.();
  }
}

function makeServices(): McpServices {
  return {
    getHealth: async () => ({ ok: true, value: HEALTH }),
    searchCatalog: async () => ({ ok: true, value: { instruments: [], nextCursor: null } }),
    readEventFeed: async () => ({ ok: true, value: { events: [], nextCursor: null, resumeCursor: "r:0" } }),
    getProviderStatus: async () => ({ ok: true, value: {} as never }),
    getLiveSnapshot: async () => ({ ok: true, value: { revision: 0, capturedAtMs: 0, items: [], connections: [] } as never }),
    getCachedCandles: async () => ({ ok: true, value: { candles: [] } }),
    getCoverage: async () => ({ ok: true, value: { gaps: [], unavailableNotes: [] } }),
    fetchHistorical: async () => ({ ok: true, value: { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] } }),
    listSnapshots: async () => ({ ok: true, value: { snapshots: [] } }),
    listSnapshotsPage: async () => ({ ok: true, value: { snapshots: [], nextCursor: null } }),
    getSnapshot: async (id) => ({ ok: true, value: { id } as never }),
    captureSnapshot: async () => ({ ok: true, value: { snapshot: null, error: "no provider available" } }),
    startActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured" } }),
    completeActivity: async () => ({ ok: false, error: { category: "unavailable", message: "not configured" } })
  };
}

function makeHarness(opts: { replayMaxEvents?: number; replayMaxBytes?: number } = {}) {
  const service = new MarketDataService({
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    policy: { openMaxAgeMs: 60_000, unknownMaxAgeMs: 60_000, maxRetainedObservationAgeMs: 86_400_000 },
    maxInstruments: 500,
    session: () => "OPEN" as const
  });
  const hub = new LiveEventHub(service, {
    replayMaxEvents: opts.replayMaxEvents ?? 1000,
    replayMaxBytes: opts.replayMaxBytes ?? 10_000_000,
    clientMaxEvents: 1000, clientMaxBytes: 10_000_000, refreshIntervalMs: 0
  });
  hub.start();
  const services = makeServices();
  services.getLiveSnapshot = async () => ({ ok: true, value: service.getSnapshot() as never });
  services.readEventFeed = async (req) => {
    const r = hub.readAfter(req.after, req.limit);
    if (r.outcome === "snapshot-required") {
      return { ok: true, value: { events: [], nextCursor: null, snapshotRequired: { reason: r.reason } } };
    }
    return { ok: true, value: { events: r.events, nextCursor: r.nextCursor, resumeCursor: r.resumeCursor } };
  };
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
  return { service, hub, handler };
}

async function connect(handler: ReturnType<typeof createMcpHandler>) {
  const client = new Client({ name: "d-recovery", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  return client;
}

function emit(service: MarketDataService, count: number, start = 1) {
  for (let i = start; i < start + count; i++) service.track(`D-REC-${i}`);
}

describe("M6-D §8.1 read-after-notify / recovery (wire-visible, in-process)", () => {
  test("wire shapes via resources/read + contents[0].text: page and snapshotRequired, no outcome property", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 1000 });
    const client = await connect(handler);
    try {
      emit(service, 2);
      const pageRes = await client.readResource({ uri: "markethub://events/live?after=first&limit=100" });
      expect(pageRes.contents[0]!.mimeType).toBe("application/json");
      const page = JSON.parse(pageRes.contents[0]!.text) as Record<string, unknown>;
      expect(Array.isArray(page.events)).toBe(true);
      expect(typeof page.resumeCursor).toBe("string");
      expect("nextCursor" in page).toBe(true);
      expect("outcome" in page).toBe(false);

      const recRes = await client.readResource({ uri: "markethub://events/live?after=old-runtime:1&limit=100" });
      expect(recRes.contents[0]!.mimeType).toBe("application/json");
      const rec = JSON.parse(recRes.contents[0]!.text) as Record<string, unknown>;
      expect(rec.events).toEqual([]);
      expect(rec.nextCursor).toBeNull();
      expect(rec.snapshotRequired).toBeDefined();
      expect(typeof (rec.snapshotRequired as { reason: string }).reason).toBe("string");
      expect("resumeCursor" in rec).toBe(false);
      expect("outcome" in rec).toBe(false);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("immediate post-ack catch-up pages through nextCursor past 100 missed events with no later mutation", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 1000 });
    const client = await connect(handler);
    try {
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot(); // R = 0, before the missed events
      emit(service, 150); // 150 events missed while disconnected
      // No later mutation: the catch-up must page through nextCursor and
      // recover every missed event from the feed alone.
      await sync.sync();
      expect(sync.applied.length).toBe(150);
      expect(sync.applied[0]).toBe(1);
      expect(sync.applied[149]).toBe(150);
      expect(sync.lastFeedRevision).toBe(150);
      expect(sync.feedReads).toBeGreaterThanOrEqual(2); // >100 events => >1 page
      expect(sync.checkpoint?.lastFeedRevision).toBe(150);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("snapshot-to-checkpoint race: event after snapshot read but before first feed read is processed before cursor persisted", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 1000 });
    const client = await connect(handler);
    try {
      emit(service, 10); // revisions 1..10
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot(); // R = 10
      // Event 11 occurs after the snapshot read but before the first feed read.
      emit(service, 1, 11);
      await sync.sync(); // immediate post-ack catch-up
      // Event 11 (> R) is applied before its cursor is persisted.
      expect(sync.applied).toEqual([11]);
      expect(sync.lastFeedRevision).toBe(11);
      expect(sync.checkpoint?.lastFeedRevision).toBe(11);
      // A later catch-up from the persisted cursor finds nothing new — event 11
      // was not skipped by persisting the cursor before processing it.
      await sync.sync();
      expect(sync.applied).toEqual([11]);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("retained-event pagination keeps snapshotRevision dedup separate from lastFeedRevision continuity", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 1000 });
    const client = await connect(handler);
    try {
      emit(service, 150); // revisions 1..150, all reflected in the snapshot
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot(); // R = 150
      await sync.sync(); // pages 1..100 then 101..150
      expect(sync.lastFeedRevision).toBe(150);
      expect(sync.applied).toEqual([]); // all <= R, skipped for application
      emit(service, 2, 151); // revisions 151,152
      await sync.sync(); // value-cursor read: first event must be 151 = lastFeedRevision+1
      expect(sync.applied).toEqual([151, 152]);
      expect(sync.lastFeedRevision).toBe(152);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("snapshot re-adoption updates R without re-applying an event already in the fresh snapshot", async () => {
    const { service, hub, handler } = makeHarness();
    const client = await connect(handler);
    try {
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot(); // R = 0
      emit(service, 1); // revision 1
      await sync.adoptSnapshot(); // adopt fresh snapshot R = 1; feed state unchanged
      expect(sync.snapshotRevision).toBe(1);
      expect(sync.lastFeedRevision).toBeNull();
      await sync.sync();
      expect(sync.applied).toEqual([]); // event 1 <= adopted R=1, not re-applied
      expect(sync.lastFeedRevision).toBe(1); // continuity advanced
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("fresh revision-zero empty bootstrap persists lastFeedRevision=0 atomically with cursor", async () => {
    const { service, hub, handler } = makeHarness();
    const client = await connect(handler);
    try {
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot(); // R = 0, no events
      await sync.sync(); // normal empty page
      expect(sync.lastFeedRevision).toBe(0);
      expect(sync.checkpoint).not.toBeNull();
      expect(sync.checkpoint!.lastFeedRevision).toBe(0);
      expect(typeof sync.checkpoint!.resumeCursor).toBe("string");
      emit(service, 1); // revision 1
      await sync.sync(); // value-cursor read expects 1 = lastFeedRevision+1
      expect(sync.applied).toEqual([1]);
      expect(sync.lastFeedRevision).toBe(1);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("replay-history gap is detected, re-baselines from snapshot, and does not silently advance the cursor", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 3 });
    const client = await connect(handler);
    try {
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot(); // R = 0
      emit(service, 5); // revisions 1..5, only 3,4,5 retained
      await sync.sync();
      // First retained event is 3, but snapshot boundary expects 1 -> gap.
      // Client re-baselines from current snapshot (R=5) and retries after=first.
      expect(sync.snapshotRevision).toBe(5);
      expect(sync.recoveryFailure).toBe(false);
      expect(sync.checkpoint).not.toBeNull();
      expect(sync.checkpoint!.lastFeedRevision).toBe(5); // no silent advance past gap
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("snapshotRequired recovery uses after=first bootstrap (API returns no cursor on that outcome)", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 2 });
    const client = await connect(handler);
    try {
      emit(service, 5);
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot();
      // Stale/expired cursor from a prior runtime -> snapshotRequired wire shape.
      sync.checkpoint = { resumeCursor: "old-runtime:1", lastFeedRevision: 1 };
      await sync.sync();
      expect(sync.recoveryFailure).toBe(false);
      expect(sync.feedReads).toBeGreaterThanOrEqual(2); // stale read + after=first read
      expect(sync.checkpoint).not.toBeNull();
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("feed continuity gap blocks checkpoint persistence and re-bootstraps", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 1000 });
    const client = await connect(handler);
    try {
      emit(service, 10);
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot(); // R = 10
      sync.lastFeedRevision = 5; // stale feed position -> first event 1 != 6
      await sync.sync();
      expect(sync.recoveryFailure).toBe(false);
      expect(sync.checkpoint).not.toBeNull();
      expect(typeof sync.checkpoint!.lastFeedRevision).toBe("number");
      expect(sync.checkpoint!.lastFeedRevision).toBe(10);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("notifications during sync are buffered and drained without out-of-order cursor advancement", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 1000 });
    const client = await connect(handler);
    try {
      emit(service, 150); // 150 events -> two catch-up pages
      const sync = new WireSyncClient(client);
      await sync.adoptSnapshot(); // R = 150
      // A notification arrives while sync is still running (after the last
      // page read). It is a change signal with no cursor and must not advance
      // the checkpoint — the client buffers it instead.
      sync.onBeforeReturn = () => { emit(service, 1, 151); };
      await sync.sync();
      expect(sync.applied).toEqual([]); // original 150 all <= R, skipped
      expect(sync.lastFeedRevision).toBe(150); // not advanced by the notification
      expect(sync.checkpoint?.lastFeedRevision).toBe(150);
      // Drain the buffered signal by re-running catch-up from the persisted pair.
      await sync.sync();
      expect(sync.applied).toEqual([151]);
      expect(sync.lastFeedRevision).toBe(151);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });
});
