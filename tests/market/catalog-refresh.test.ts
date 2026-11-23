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
});
