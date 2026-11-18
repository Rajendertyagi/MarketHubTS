import { afterEach, describe, expect, test } from "bun:test";
import type { HistoricalCandle, HistoricalSyncConfig } from "../../packages/contracts/src/index";
import {
  deleteSyncConfig, fetchCachedCandles, fetchCoverage, fetchRetention, fetchSyncConfigs,
  HistoricalHttpError, runRetentionCleanup, saveRetention, saveSyncConfig
} from "../../apps/web/src/lib/historical";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const candle: HistoricalCandle = {
  canonicalId: "A", interval: "1D", tsMs: 1700000000000, open: 10, high: 12, low: 9, close: 11,
  volume: 100, oi: null, provider: "UPSTOX",
  provenance: { source: "provider-feed", provider: "UPSTOX", receivedAt: "2026-01-01T00:00:00.000Z" },
  receivedAtMs: 1700000000000
};

const config: HistoricalSyncConfig = {
  id: "sync-1", canonicalId: "A", interval: "1D", enabled: true,
  dateRangeJson: null, scheduleJson: null, providerPolicyJson: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

const request = { canonicalId: "A", interval: "1D" as const, fromMs: 1, toMs: 2 };

describe("historical web client", () => {
  test("cached candles are validated with the contracts schema", async () => {
    fakeFetch(() => ({ status: 200, body: { candles: [candle] } }));
    const result = await fetchCachedCandles(request);
    expect(result.candles.length).toBe(1);
    expect(result.candles[0]!.close).toBe(11);
  });

  test("invalid candle payload is rejected", async () => {
    fakeFetch(() => ({ status: 200, body: { candles: [{ close: "bad" }] } }));
    await expect(fetchCachedCandles(request)).rejects.toBeDefined();
  });

  test("coverage preserves unconfirmed gaps and basis", async () => {
    fakeFetch(() => ({
      status: 200,
      body: {
        gaps: [{ canonicalId: "A", interval: "1D", fromMs: 1, toMs: 2, basis: "WEEKDAY_ONLY", confirmed: false, reason: "no candle stored" }],
        basis: "WEEKDAY_ONLY", confirmed: false
      }
    }));
    const result = await fetchCoverage(request);
    expect(result.gaps[0]!.basis).toBe("WEEKDAY_ONLY");
    expect(result.gaps[0]!.confirmed).toBe(false);
    expect(result.confirmed).toBe(false);
  });

  test("sync config CRUD round-trips and 403 is forbidden", async () => {
    fakeFetch(() => ({ status: 200, body: { configs: [config] } }));
    expect((await fetchSyncConfigs()).length).toBe(1);

    fakeFetch(() => ({ status: 200, body: { config } }));
    expect((await saveSyncConfig(config)).id).toBe("sync-1");

    fakeFetch(() => ({ status: 200, body: { ok: true } }));
    await expect(deleteSyncConfig("sync-1")).resolves.toBeUndefined();

    fakeFetch(() => ({ status: 403, body: { error: "forbidden", message: "local only" } }));
    try {
      await saveSyncConfig(config);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(HistoricalHttpError);
      expect((error as HistoricalHttpError).kind).toBe("forbidden");
    }
  });

  test("retention view, save and cleanup fail-safe are surfaced", async () => {
    fakeFetch(() => ({ status: 200, body: { settings: null, valid: false, error: "not configured" } }));
    const invalid = await fetchRetention();
    expect(invalid.valid).toBe(false);
    expect(invalid.settings).toBeNull();

    fakeFetch(() => ({ status: 200, body: { settings: { version: 1, classes: { CANDLE: { maxAgeDays: 30 } } }, valid: true, error: null } }));
    const saved = await saveRetention({ version: 1, classes: { CANDLE: { maxAgeDays: 30 } } });
    expect(saved.valid).toBe(true);
    expect(saved.settings?.classes.CANDLE?.maxAgeDays).toBe(30);

    fakeFetch(() => ({ status: 200, body: { ran: false, reason: "invalid", candlesDeleted: 0, snapshotsDeleted: 0 } }));
    const cleanup = await runRetentionCleanup();
    expect(cleanup.ran).toBe(false);
    expect(cleanup.candlesDeleted).toBe(0);
  });
});
