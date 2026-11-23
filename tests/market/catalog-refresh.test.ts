import { describe, expect, test } from "bun:test";
import type { CatalogRepository, CatalogSyncRunRecord, CatalogSyncService, MasterFetch } from "../../packages/market-core/src/index";
import { CatalogMasterRefresh } from "../../packages/market-core/src/index";
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
  const sync = {
    applyCompleteProviderSnapshot: async (batch: { provider?: string }) => {
      applied.push({ provider: batch.provider ?? "unknown", status: "COMPLETED" });
      return { status: "COMPLETED", counts: {} } as any;
    }
  };
  return { sync: sync as unknown as CatalogSyncService, applied };
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
    if (url.includes("NSE_CM")) return Response.json(fyersFiles.NSE_CM);
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
});
