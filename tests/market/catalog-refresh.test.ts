import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { istDateString } from "../../packages/contracts/src/index";
import { openDatabase, SqliteCatalogRepository } from "../../packages/database/src/index";
import type { CatalogRepository, CatalogSyncRunRecord, MasterFetch } from "../../packages/market-core/src/index";
import { CatalogMasterRefresh, CatalogSyncService, buildUpstoxImport, buildFyersImport } from "../../packages/market-core/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { fyersFiles, upstoxRows } from "../fixtures/provider-masters";

const CLOCK = new Date("2026-11-24T10:00:00.000Z"); // IST date 2026-11-24

function makeCatalog(runs: CatalogSyncRunRecord[] = []) {
  const stored = [...runs];
  const catalog = {
    listSyncRuns: async (query: { provider?: string; status?: string; limit?: number } = {}) =>
      stored
        .filter((r) => (!query.provider || r.provider === query.provider) && (!query.status || r.status === query.status))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, query.limit ?? 100),
    recordSyncRun: async (run: CatalogSyncRunRecord) => { stored.push(run); },
    runs: stored
  };
  return catalog as unknown as CatalogRepository & { runs: CatalogSyncRunRecord[] };
}

function makeSync() {
  const applied: Array<{ provider: string; status: string }> = [];
  const batches: Array<{ provider?: string; sourceObservedAt?: string }> = [];
  const sync = {
    applyCompleteProviderSnapshot: async (batch: { provider?: string; sourceObservedAt?: string }) => {
      applied.push({ provider: batch.provider ?? "unknown", status: "COMPLETED" });
      batches.push({ provider: batch.provider, sourceObservedAt: batch.sourceObservedAt });
      return { status: "COMPLETED", counts: {} } as any;
    }
  };
  return { sync: sync as unknown as CatalogSyncService, applied, batches };
}

/** Faithful mirror of WP4B's classifyFreshness (read-only; WP4B itself is untouched). */
function wp4bFreshness(sourceObservedAt: string | undefined, finishedAt: string, todayIst: string) {
  if (!finishedAt) return "UNKNOWN";
  if (!sourceObservedAt) return "STALE";
  const ms = Date.parse(sourceObservedAt);
  if (!Number.isFinite(ms)) return "STALE";
  return istDateString(ms) === todayIst ? "FRESH" : "STALE";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Sync fake that also records a COMPLETED run, so freshness checks are realistic. */
function makeRecordingSync(catalog: CatalogRepository, clock: { value: Date }) {
  const applied: string[] = [];
  const sync = {
    applyCompleteProviderSnapshot: async (batch: { provider?: string }) => {
      const provider = batch.provider ?? "unknown";
      applied.push(provider);
      const ts = clock.value.toISOString();
      await catalog.recordSyncRun?.({
        runId: `${provider}-${applied.length}`, source: "test", provider, scopeJson: "{}",
        completeness: "COMPLETE", status: "COMPLETED", startedAt: ts, finishedAt: ts,
        countsJson: "{}", conflictsJson: "[]"
      });
      return { status: "COMPLETED", counts: {} } as any;
    }
  };
  return { sync: sync as unknown as CatalogSyncService, applied };
}

function makeFetch(overrides: { upstox?: () => Promise<Response>; fail?: boolean } = {}) {
  const calls: string[] = [];
  const fetchFn: MasterFetch = async (url) => {
    calls.push(url);
    if (overrides.fail) throw new Error("network down");
    if (overrides.upstox && url.includes("upstox")) return overrides.upstox();
    if (url.includes("upstox")) return Response.json(upstoxRows);
    if (url.includes("NSE_FO")) return Response.json(fyersFiles.NSE_FO);
    if (url.includes("BSE_FO")) return Response.json(fyersFiles.BSE_FO);
    if (url.includes("NSE_CM")) return Response.json(fyersFiles.NSE_CM);
    if (url.includes("BSE_CM")) return Response.json(fyersFiles.BSE_CM);
    return Response.json({});
  };
  return { fetchFn, calls };
}

function runRecord(provider: string, finishedAt: string): CatalogSyncRunRecord {
  return {
    runId: `${provider}-${finishedAt}`, source: "test", provider, scopeJson: "{}", completeness: "COMPLETE",
    status: "COMPLETED", startedAt: finishedAt, finishedAt, countsJson: "{}", conflictsJson: "[]"
  };
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met");
}

describe("WP4A app-owned refresh owner", () => {
  test("skips a provider already refreshed on the current India-market date", async () => {
    const catalog = makeCatalog([runRecord("UPSTOX", "2026-11-24T05:00:00.000Z")]);
    const { sync, applied } = makeSync();
    const { fetchFn, calls } = makeFetch();
    const events: string[] = [];
    const refresh = new CatalogMasterRefresh({ catalog, sync, now: () => CLOCK, fetch: fetchFn, onEvent: (e) => events.push(`${e.provider}:${e.outcome}`) });

    await (refresh as any).refreshProvider("UPSTOX");
    expect(calls.length).toBe(0);
    expect(applied.length).toBe(0);
    expect(events).toContain("UPSTOX:SKIPPED");
  });

  test("refreshes a provider with no successful run for today", async () => {
    const catalog = makeCatalog([runRecord("UPSTOX", "2026-11-23T05:00:00.000Z")]);
    const { sync, applied } = makeSync();
    const { fetchFn, calls } = makeFetch();
    const refresh = new CatalogMasterRefresh({ catalog, sync, now: () => CLOCK, fetch: fetchFn });

    await (refresh as any).refreshProvider("UPSTOX");
    expect(calls.length).toBe(1);
    expect(applied).toEqual([{ provider: "UPSTOX", status: "COMPLETED" }]);
  });

  test("single-flight: overlapping startIfNeeded calls fetch each provider at most once", async () => {
    const catalog = makeCatalog();
    const { sync } = makeSync();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { fetchFn, calls } = makeFetch({ upstox: async () => { await gate; return Response.json(upstoxRows); } });
    const refresh = new CatalogMasterRefresh({ catalog, sync, now: () => CLOCK, fetch: fetchFn });

    refresh.startIfNeeded();
    refresh.startIfNeeded();
    await waitFor(() => calls.filter((u) => u.includes("upstox")).length === 1);
    release();
    await waitFor(() => calls.length >= 5);
    expect(calls.filter((u) => u.includes("upstox")).length).toBe(1);
    expect(calls.filter((u) => u.includes("fyers")).length).toBe(4);
    refresh.stop();
  });

  test("download failure keeps last-known-good and records a concise FAILED run", async () => {
    const catalog = makeCatalog([runRecord("UPSTOX", "2026-11-23T05:00:00.000Z")]);
    const { sync, applied } = makeSync();
    const { fetchFn } = makeFetch({ fail: true });
    const events: string[] = [];
    const refresh = new CatalogMasterRefresh({ catalog, sync, now: () => CLOCK, fetch: fetchFn, onEvent: (e) => events.push(e.outcome) });

    await (refresh as any).refreshProvider("UPSTOX");
    expect(applied.length).toBe(0);
    expect(events).toContain("FAILED");
    const failed = catalog.runs.find((r) => r.status === "FAILED");
    expect(failed).toBeDefined();
    expect(failed!.error).toContain("network down");
    expect(JSON.stringify(failed)).not.toContain("token");
  });

  test("FYERS requires all four segment files; one failure prevents any import", async () => {
    const catalog = makeCatalog();
    const { sync, applied } = makeSync();
    const calls: string[] = [];
    const fetchFn: MasterFetch = async (url) => {
      calls.push(url);
      if (url.includes("BSE_FO")) throw new Error("one segment failed");
      if (url.includes("NSE_FO")) return Response.json(fyersFiles.NSE_FO);
      if (url.includes("NSE_CM")) return Response.json(fyersFiles.NSE_CM);
      return Response.json({});
    };
    const refresh = new CatalogMasterRefresh({ catalog, sync, now: () => CLOCK, fetch: fetchFn });
    await (refresh as any).refreshProvider("FYERS");
    expect(applied.length).toBe(0);
    expect(catalog.runs.some((r) => r.status === "FAILED")).toBe(true);
  });

  test("freshness lookup failure is diagnostic only; the refresh still proceeds", async () => {
    const base = makeCatalog();
    let lookupCalls = 0;
    const catalog = Object.create(base) as CatalogRepository;
    (catalog as any).listSyncRuns = async () => {
      lookupCalls++;
      throw new Error("sync-run store unavailable");
    };
    const { sync, applied } = makeSync();
    const { fetchFn, calls } = makeFetch();
    const events: Array<{ provider: string; outcome: string; reason?: string }> = [];
    const refresh = new CatalogMasterRefresh({
      catalog, sync, now: () => CLOCK, fetch: fetchFn, onEvent: (e) => events.push(e)
    });

    await (refresh as any).refreshProvider("UPSTOX");
    expect(lookupCalls).toBe(1);
    expect(calls.length).toBe(1);
    expect(applied).toEqual([{ provider: "UPSTOX", status: "COMPLETED" }]);
    expect(events.some((e) => e.outcome === "DIAGNOSTIC" && e.reason === "FRESHNESS_LOOKUP_FAILED")).toBe(true);
    expect(events.some((e) => e.outcome === "REFRESHED")).toBe(true);
  });

  test("running owner refreshes again after India-market date rolls over, without restart", async () => {
    const clock = { value: new Date("2026-11-24T10:00:00.000Z") }; // IST date 2026-11-24
    const catalog = makeCatalog();
    const { sync, applied } = makeRecordingSync(catalog, clock);
    const { fetchFn } = makeFetch();
    const refresh = new CatalogMasterRefresh({
      catalog, sync, now: () => clock.value, fetch: fetchFn, refreshIntervalMs: 20
    });
    try {
      refresh.startIfNeeded();
      await waitFor(() => applied.filter((p) => p === "UPSTOX").length === 1);
      // Repeated ticks on the same India-market date must not refresh again.
      await new Promise((r) => setTimeout(r, 80));
      expect(applied.filter((p) => p === "UPSTOX").length).toBe(1);

      // Roll over to the next India-market date without restarting the owner.
      clock.value = new Date("2026-11-25T10:00:00.000Z"); // IST date 2026-11-25
      await waitFor(() => applied.filter((p) => p === "UPSTOX").length === 2);
      expect(applied.filter((p) => p === "UPSTOX").length).toBe(2);
    } finally {
      refresh.stop();
    }
  });

  test("FYERS failure does not prevent Upstox; FYERS last-known-good is retained", async () => {
    const priorFyers = runRecord("FYERS", "2026-11-23T05:00:00.000Z");
    const catalog = makeCatalog([priorFyers]);
    const clock = { value: CLOCK };
    const { sync, applied } = makeRecordingSync(catalog, clock);
    const fetchFn: MasterFetch = async (url) => {
      if (url.includes("upstox")) return Response.json(upstoxRows);
      if (url.includes("BSE_FO")) throw new Error("fyers segment unavailable");
      if (url.includes("NSE_FO")) return Response.json(fyersFiles.NSE_FO);
      if (url.includes("NSE_CM")) return Response.json(fyersFiles.NSE_CM);
      return Response.json({});
    };
    const events: string[] = [];
    const refresh = new CatalogMasterRefresh({
      catalog, sync, now: () => clock.value, fetch: fetchFn, onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
    });
    try {
      refresh.startIfNeeded();
      await waitFor(() => events.includes("UPSTOX:REFRESHED") && events.includes("FYERS:FAILED"));
    } finally {
      refresh.stop();
    }

    expect(applied).toEqual(["UPSTOX"]); // no FYERS import/reconciliation committed
    const fyersCompleted = catalog.runs.filter((r) => r.provider === "FYERS" && r.status === "COMPLETED");
    expect(fyersCompleted.length).toBe(1);
    expect(fyersCompleted[0]!.runId).toBe(priorFyers.runId); // last-known-good retained
    expect(catalog.runs.some((r) => r.provider === "FYERS" && r.status === "FAILED")).toBe(true);
    expect(catalog.runs.some((r) => r.provider === "UPSTOX" && r.status === "COMPLETED")).toBe(true);
  });

  test("FYERS source date is the oldest of each required file's newest in-scope lastUpdate", async () => {
    const files = clone(fyersFiles) as any;
    // NSE_FO: two in-scope dates; the newest (2026-11-23) must win.
    files.NSE_FO["NSE:RELIANCE26DEC3000CE"].lastUpdate = "2026-11-23";
    files.NSE_FO["NSE:NIFTY26DEC25000PE"].lastUpdate = "2026-11-22";
    // BSE_FO: newest 2026-11-24.
    files.BSE_FO["BSE:TCS26DEC4000CE"].lastUpdate = "2026-11-24";
    files.BSE_FO["BSE:SENSEX26DEC80000PE"].lastUpdate = "2026-11-23";
    // NSE_CM: referenced rows 2026-11-22; an unrelated row is much older and must be ignored.
    files.NSE_CM["NSE:RELIANCE-EQ"].lastUpdate = "2026-11-22";
    files.NSE_CM["NSE:NIFTY50-INDEX"].lastUpdate = "2026-11-22";
    files.NSE_CM["NSE:UNUSED-EQ"].lastUpdate = "2026-11-01";
    // BSE_CM: 2026-11-23.
    files.BSE_CM["BSE:TCS-EQ"].lastUpdate = "2026-11-23";
    files.BSE_CM["BSE:SENSEX-INDEX"].lastUpdate = "2026-11-23";

    const fetchFn: MasterFetch = async (url) => {
      if (url.includes("NSE_FO")) return Response.json(files.NSE_FO);
      if (url.includes("BSE_FO")) return Response.json(files.BSE_FO);
      if (url.includes("NSE_CM")) return Response.json(files.NSE_CM);
      if (url.includes("BSE_CM")) return Response.json(files.BSE_CM);
      throw new Error("unexpected url");
    };
    const { sync, batches } = makeSync();
    const refresh = new CatalogMasterRefresh({ catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn });
    await (refresh as any).refreshProvider("FYERS");

    expect(batches.length).toBe(1);
    // per-file newest: NSE_FO 23, BSE_FO 24, NSE_CM 22, BSE_CM 23 -> oldest 22.
    expect(batches[0]!.sourceObservedAt).toBe("2026-11-22T00:00:00.000Z");
    expect(wp4bFreshness(batches[0]!.sourceObservedAt, CLOCK.toISOString(), "2026-11-22")).toBe("FRESH");
  });

  test("FYERS required file without a valid in-scope lastUpdate leaves source date unknown (STALE)", async () => {
    const files = clone(fyersFiles) as any;
    for (const key of Object.keys(files.BSE_FO)) delete files.BSE_FO[key].lastUpdate;
    const fetchFn: MasterFetch = async (url) => {
      if (url.includes("NSE_FO")) return Response.json(files.NSE_FO);
      if (url.includes("BSE_FO")) return Response.json(files.BSE_FO);
      if (url.includes("NSE_CM")) return Response.json(files.NSE_CM);
      if (url.includes("BSE_CM")) return Response.json(files.BSE_CM);
      throw new Error("unexpected url");
    };
    const { sync, batches } = makeSync();
    const refresh = new CatalogMasterRefresh({ catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn });
    await (refresh as any).refreshProvider("FYERS");

    expect(batches.length).toBe(1);
    expect(batches[0]!.sourceObservedAt).toBeUndefined();
    expect(batches[0]!.sourceObservedAt).not.toBe(CLOCK.toISOString()); // never fetch time
    expect(wp4bFreshness(batches[0]!.sourceObservedAt, CLOCK.toISOString(), "2026-11-24")).toBe("STALE");
  });

  test("Upstox without a reliable source date leaves sourceObservedAt unknown (STALE), not fetch time", async () => {
    const { sync, batches } = makeSync();
    const { fetchFn } = makeFetch(); // Response.json has no Last-Modified header
    const refresh = new CatalogMasterRefresh({ catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn });
    await (refresh as any).refreshProvider("UPSTOX");

    expect(batches.length).toBe(1);
    expect(batches[0]!.sourceObservedAt).toBeUndefined();
    expect(batches[0]!.sourceObservedAt).not.toBe(CLOCK.toISOString());
    expect(wp4bFreshness(batches[0]!.sourceObservedAt, CLOCK.toISOString(), "2026-11-24")).toBe("STALE");
  });

  test("Upstox uses a valid Last-Modified header as the source date", async () => {
    const header = "Tue, 24 Nov 2026 05:00:00 GMT";
    const expected = new Date(header).toISOString();
    const fetchFn: MasterFetch = async () =>
      new Response(JSON.stringify(upstoxRows), { headers: { "Last-Modified": header } });
    const { sync, batches } = makeSync();
    const refresh = new CatalogMasterRefresh({ catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn });
    await (refresh as any).refreshProvider("UPSTOX");

    expect(batches.length).toBe(1);
    expect(batches[0]!.sourceObservedAt).toBe(expected);
    expect(wp4bFreshness(batches[0]!.sourceObservedAt, CLOCK.toISOString(), "2026-11-24")).toBe("FRESH");
  });

  test("Upstox ignores an unparseable Last-Modified header", async () => {
    const fetchFn: MasterFetch = async () =>
      new Response(JSON.stringify(upstoxRows), { headers: { "Last-Modified": "not-a-date" } });
    const { sync, batches } = makeSync();
    const refresh = new CatalogMasterRefresh({ catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn });
    await (refresh as any).refreshProvider("UPSTOX");

    expect(batches.length).toBe(1);
    expect(batches[0]!.sourceObservedAt).toBeUndefined();
    expect(wp4bFreshness(batches[0]!.sourceObservedAt, CLOCK.toISOString(), "2026-11-24")).toBe("STALE");
  });
});

describe("WP4A refresh validation gate: malformed masters never reconcile", () => {
  const IMPORT_OPTS = { now: CLOCK.toISOString(), sourceVersion: "fixture-v1", sourceObservedAt: CLOCK.toISOString() };

  function seedBothProviders() {
    const dir = mkdtempSync(join(tmpdir(), "wp4a-guard-"));
    const handle = openDatabase({ dbPath: join(dir, "test.sqlite"), migrate: true });
    const repo = new SqliteCatalogRepository(handle.db, handle.sqlite);
    const sync = new CatalogSyncService(repo);
    return { dir, handle, repo, sync };
  }

  /** Report a yesterday COMPLETED run so the refresh owner proceeds deterministically. */
  function proceedingCatalog(repo: SqliteCatalogRepository, provider: string): CatalogRepository {
    const catalog = Object.create(repo) as CatalogRepository;
    (catalog as any).listSyncRuns = async (q: { provider?: string; status?: string; limit?: number } = {}) => {
      if (q.provider === provider && q.status === "COMPLETED") {
        return [runRecord(provider, "2026-11-23T05:00:00.000Z")];
      }
      return repo.listSyncRuns(q);
    };
    return catalog;
  }

  async function seed(sync: CatalogSyncService) {
    const up = buildUpstoxImport(upstoxRows, IMPORT_OPTS);
    const fy = buildFyersImport(fyersFiles, IMPORT_OPTS);
    expect((await sync.applyCompleteProviderSnapshot(up.batch, up.reconciliation)).status).toBe("COMPLETED");
    expect((await sync.applyCompleteProviderSnapshot(fy.batch, fy.reconciliation)).status).toBe("COMPLETED");
  }

  test("FYERS required segment with zero usable rows: no reconciliation, no catalogue change, FAILED run", async () => {
    const { dir, handle, repo, sync } = seedBothProviders();
    try {
      await seed(sync);
      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();
      expect((await repo.getMapping("FYERS", "BSE:TCS26DEC4000CE"))?.status).toBe("ACTIVE");

      const files = clone(fyersFiles) as any;
      files.BSE_FO = {}; // valid JSON, but zero usable in-scope rows
      const fetchFn: MasterFetch = async (url) => {
        if (url.includes("NSE_FO")) return Response.json(files.NSE_FO);
        if (url.includes("BSE_FO")) return Response.json(files.BSE_FO);
        if (url.includes("NSE_CM")) return Response.json(files.NSE_CM);
        if (url.includes("BSE_CM")) return Response.json(files.BSE_CM);
        throw new Error("unexpected url");
      };
      const events: string[] = [];
      const refresh = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "FYERS"), sync, now: () => CLOCK, fetch: fetchFn,
        onEvent: (e) => events.push(`${e.provider}:${e.outcome}`)
      });
      await (refresh as any).refreshProvider("FYERS");

      expect(events).toContain("FYERS:FAILED");
      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      // Without the guard this BSE mapping would be marked REMOVED by reconciliation.
      expect((await repo.getMapping("FYERS", "BSE:TCS26DEC4000CE"))?.status).toBe("ACTIVE");
      expect((await repo.getMapping("FYERS", "NSE:RELIANCE26DEC3000CE"))?.status).toBe("ACTIVE");
      const failed = (await repo.listSyncRuns({ provider: "FYERS", status: "FAILED" }))[0];
      expect(failed).toBeDefined();
      expect(failed!.error).toContain("EMPTY_REQUIRED_SEGMENT:BSE_FO");
      expect((await repo.listSyncRuns({ provider: "FYERS", status: "COMPLETED" })).length).toBeGreaterThanOrEqual(1);
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("Upstox unresolved underlying: no reconciliation, no catalogue change, FAILED run", async () => {
    const { dir, handle, repo, sync } = seedBothProviders();
    try {
      await seed(sync);
      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();

      const rows = clone(upstoxRows) as any[];
      rows.find((r) => r.instrument_key === "NSE_FO|REL-CE-1")!.underlying_key = "NSE_EQ|MISSING";
      const refresh = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "UPSTOX"), sync, now: () => CLOCK,
        fetch: async () => Response.json(rows)
      });
      await (refresh as any).refreshProvider("UPSTOX");

      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      expect((await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))?.status).toBe("ACTIVE");
      const failed = (await repo.listSyncRuns({ provider: "UPSTOX", status: "FAILED" }))[0];
      expect(failed).toBeDefined();
      expect(failed!.error).toContain("UNRESOLVED_UNDERLYINGS:1");
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });

  test("Upstox invalid option row: no reconciliation, no catalogue change, FAILED run", async () => {
    const { dir, handle, repo, sync } = seedBothProviders();
    try {
      await seed(sync);
      const before = (await repo.listInstruments()).map((i) => i.canonicalId).sort();

      const rows = clone(upstoxRows) as any[];
      rows.find((r) => r.instrument_key === "NSE_FO|REL-CE-1")!.strike_price = -1;
      const refresh = new CatalogMasterRefresh({
        catalog: proceedingCatalog(repo, "UPSTOX"), sync, now: () => CLOCK,
        fetch: async () => Response.json(rows)
      });
      await (refresh as any).refreshProvider("UPSTOX");

      expect((await repo.listInstruments()).map((i) => i.canonicalId).sort()).toEqual(before);
      expect((await repo.getMapping("UPSTOX", "NSE_FO|REL-CE-1"))?.status).toBe("ACTIVE");
      const failed = (await repo.listSyncRuns({ provider: "UPSTOX", status: "FAILED" }))[0];
      expect(failed).toBeDefined();
      expect(failed!.error).toContain("INVALID_ROWS:1");
    } finally {
      closeDatabaseHandle(handle);
      removeTempDir(dir);
    }
  });
});
