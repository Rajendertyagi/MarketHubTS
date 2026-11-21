import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer, type McpServices } from "../../packages/mcp-core/src/index";
import { MarketDataService } from "../../packages/market-core/src/index";
import { LiveEventHub } from "../../packages/realtime/src/index";
import { healthStatusSchema } from "../../packages/contracts/src/index";

const HEALTH = healthStatusSchema.parse({
  status: "ok", service: "markethub-api", timestamp: "2026-01-01T00:00:00.000Z",
  version: "0.1.0", checks: { api: "ok", database: "ok" }
});

interface FeedEvent { event: string; id: string; data: { revision: number; type: string; [k: string]: unknown } }
interface FeedPage { events: FeedEvent[]; nextCursor: string | null; resumeCursor: string }
interface FeedRecovery { events: FeedEvent[]; nextCursor: null; snapshotRequired: { reason: string } }
type FeedBody = FeedPage | FeedRecovery;

interface Checkpoint { resumeCursor: string; lastFeedRevision: number }

/**
 * Test-side implementation of the §5.2 client synchronization procedure,
 * exercised strictly through the wire-visible resources/read interface.
 */
class FeedSyncClient {
  snapshotRevision = 0;
  lastFeedRevision: number | null = null;
  checkpoint: Checkpoint | null = null;
  applied: number[] = [];
  recoveryFailure = false;

  constructor(private readonly client: Client) {}

  private async read(uri: string): Promise<unknown> {
    const res = await this.client.readResource({ uri });
    expect(res.contents[0]!.mimeType).toBe("application/json");
    return JSON.parse(res.contents[0]!.text);
  }

  async adoptSnapshot(): Promise<void> {
    const body = await this.read("markethub://market/snapshot") as { revision: number };
    this.snapshotRevision = body.revision; // adopt: update dedup baseline, leave feed state
  }

  private async readFeed(after: string): Promise<FeedBody> {
    return await this.read(`markethub://events/live?after=${after}&limit=100`) as FeedBody;
  }

  /** Full §5.2 sync: bootstrap/continue, validate continuity, apply, persist atomically. */
  async sync(): Promise<void> {
    const after = this.checkpoint?.resumeCursor ?? "first";
    let body = await this.readFeed(after);
    if ("snapshotRequired" in body) {
      await this.adoptSnapshot();
      this.lastFeedRevision = null;
      this.checkpoint = null;
      body = await this.readFeed("first");
      if ("snapshotRequired" in body) { this.recoveryFailure = true; return; }
    }

    // Serialized pagination loop.
    let page: FeedPage = body as FeedPage;
    // No-cursor bootstrap: snapshot boundary check. The first event newer than
    // the adopted snapshot must be R+1; if the oldest retained event is already
    // beyond that, a gap exists and must not be silently advanced past.
    if (after === "first" && page.events.length > 0) {
      const firstNewer = page.events.find((e) => e.data.revision > this.snapshotRevision);
      if (firstNewer && firstNewer.data.revision !== this.snapshotRevision + 1) {
        await this.adoptSnapshot();
        this.lastFeedRevision = null;
        this.checkpoint = null;
        const retry = await this.readFeed("first");
        if ("snapshotRequired" in retry || (retry.events.find((e) => e.data.revision > this.snapshotRevision)?.data.revision !== this.snapshotRevision + 1)) {
          this.recoveryFailure = true;
          return;
        }
        page = retry;
      }
    }
    for (;;) {
      for (const ev of page.events) {
        const rev = ev.data.revision;
        if (this.lastFeedRevision !== null && rev !== this.lastFeedRevision + 1) {
          // Gap: do not persist, re-baseline and retry once.
          await this.adoptSnapshot();
          this.lastFeedRevision = null;
          this.checkpoint = null;
          const retry = await this.readFeed("first");
          if ("snapshotRequired" in retry || retry.events.some((e, i) => i > 0 && e.data.revision !== retry.events[i - 1]!.data.revision + 1)) {
            this.recoveryFailure = true;
            return;
          }
          page = retry;
          break;
        }
        this.lastFeedRevision = rev;
        if (rev > this.snapshotRevision) this.applied.push(rev);
      }
      // Persist checkpoint atomically after the whole page is consumed.
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
  }
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
  const services: McpServices = {
    getHealth: async () => ({ ok: true, value: HEALTH }),
    searchCatalog: async () => ({ ok: true, value: { instruments: [], nextCursor: null } }),
    readEventFeed: async (req) => {
      const r = hub.readAfter(req.after, req.limit);
      if (r.outcome === "snapshot-required") return { ok: true, value: { events: [], nextCursor: null, snapshotRequired: { reason: r.reason } } };
      return { ok: true, value: { events: r.events, nextCursor: r.nextCursor, resumeCursor: r.resumeCursor } };
    },
    getProviderStatus: async () => ({ ok: true, value: {} as never }),
    getLiveSnapshot: async () => ({ ok: true, value: service.getSnapshot() as never }),
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
  const handler = createMcpHandler((ctx) => createMcpServer(ctx, services));
  return { service, hub, handler };
}

async function connect(handler: ReturnType<typeof createMcpHandler>) {
  const client = new Client({ name: "feed-sync", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  }));
  return client;
}

function emit(service: MarketDataService, count: number, start = 1) {
  for (let i = start; i < start + count; i++) service.track(`INST-${i}`);
}

describe("M6-D feed synchronization over the wire interface", () => {
  test("empty revision-zero bootstrap sets lastFeedRevision=0 and next event is revision 1", async () => {
    const { service, hub, handler } = makeHarness();
    const client = await connect(handler);
    try {
      const sync = new FeedSyncClient(client);
      await sync.adoptSnapshot();
      expect(sync.snapshotRevision).toBe(0);
      await sync.sync();
      expect(sync.lastFeedRevision).toBe(0);
      expect(sync.checkpoint?.lastFeedRevision).toBe(0);
      emit(service, 1);
      await sync.sync();
      expect(sync.applied).toEqual([1]);
      expect(sync.lastFeedRevision).toBe(1);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("pagination beyond 100 events via nextCursor", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 1000 });
    const client = await connect(handler);
    try {
      emit(service, 150);
      const sync = new FeedSyncClient(client);
      await sync.adoptSnapshot(); // R = 150, all events already reflected
      await sync.sync();
      expect(sync.lastFeedRevision).toBe(150);
      expect(sync.applied).toEqual([]); // all <= R, skipped
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("retained-event pagination keeps snapshot dedup separate from feed continuity", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 1000 });
    const client = await connect(handler);
    try {
      emit(service, 150); // revisions 1..150
      const sync = new FeedSyncClient(client);
      await sync.adoptSnapshot(); // R = 150
      await sync.sync();
      // Feed continuity advanced through 1..150 without applying them.
      expect(sync.lastFeedRevision).toBe(150);
      expect(sync.applied).toEqual([]);
      emit(service, 2, 151); // revisions 151,152
      await sync.sync();
      expect(sync.applied).toEqual([151, 152]);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("snapshot re-adoption does not re-apply an event already in the fresh snapshot", async () => {
    const { service, hub, handler } = makeHarness();
    const client = await connect(handler);
    try {
      const sync = new FeedSyncClient(client);
      await sync.adoptSnapshot(); // R = 0
      emit(service, 1); // revision 1
      await sync.adoptSnapshot(); // adopt snapshot R = 1 (feed state unchanged)
      expect(sync.snapshotRevision).toBe(1);
      expect(sync.lastFeedRevision).toBeNull();
      await sync.sync();
      expect(sync.applied).toEqual([]); // event 1 <= adopted R=1, not re-applied
      expect(sync.lastFeedRevision).toBe(1); // continuity advanced
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("replay-history gap is detected and does not silently advance the cursor", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 3 });
    const client = await connect(handler);
    try {
      const sync = new FeedSyncClient(client);
      await sync.adoptSnapshot(); // R = 0
      emit(service, 5); // revisions 1..5, only last 3 retained (3,4,5)
      await sync.sync();
      // First retained event is 3, but snapshot boundary expects 1 -> gap.
      expect(sync.recoveryFailure).toBe(true);
      expect(sync.checkpoint).toBeNull();
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });

  test("expired cursor returns snapshotRequired wire shape and recovers via after=first", async () => {
    const { service, hub, handler } = makeHarness({ replayMaxEvents: 2 });
    const client = await connect(handler);
    try {
      emit(service, 5);
      const sync = new FeedSyncClient(client);
      await sync.adoptSnapshot();
      // Force an expired cursor by using a stale checkpoint from a prior runtime.
      sync.checkpoint = { resumeCursor: "old-runtime:1", lastFeedRevision: 1 };
      await sync.sync();
      // Recovery re-bootstraps; no explicit failure if continuity can be established.
      expect(sync.recoveryFailure).toBe(false);
    } finally {
      await client.close(); await handler.close(); hub.stop();
    }
  });
});
