import { afterEach, describe, expect, test } from "bun:test";
import {
  istCalendarParts, istDateString, istDayStartMs, istMonthStartMs, nextIstMonthStartMs,
  parseIstDateOnly, parseIstDateRange, type HistoricalCandle, type HistoricalSyncConfig
} from "../../packages/contracts/src/index";
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

describe("India-local date-only range", () => {
  test("date-only selection maps to inclusive IST boundaries", () => {
    const range = parseIstDateRange("2026-01-05", "2026-01-05");
    expect(range).not.toBeNull();
    // 2026-01-05 00:00 IST = 2026-01-04 18:30Z; end = 23:59:59.999 IST
    expect(range!.fromMs).toBe(Date.parse("2026-01-04T18:30:00.000Z"));
    expect(range!.toMs).toBe(Date.parse("2026-01-05T18:29:59.999Z"));
  });

  test("multi-day selection covers the full final date and rejects inverted ranges", () => {
    const range = parseIstDateRange("2026-01-05", "2026-01-06");
    expect(range!.toMs).toBe(Date.parse("2026-01-06T18:29:59.999Z"));
    expect(parseIstDateRange("2026-01-06", "2026-01-05")).toBeNull();
    expect(parseIstDateRange("not-a-date", "2026-01-05")).toBeNull();
  });

  test("valid ordinary dates and leap day are accepted", () => {
    expect(Number.isFinite(parseIstDateOnly("2026-01-05"))).toBe(true);
    expect(Number.isFinite(parseIstDateOnly("2024-02-29"))).toBe(true); // leap day
    expect(parseIstDateOnly("2024-02-29")).toBe(Date.parse("2024-02-28T18:30:00.000Z"));
    expect(Number.isFinite(parseIstDateOnly("2000-02-29"))).toBe(true); // century leap year
  });

  test("impossible calendar dates are rejected, not normalized", () => {
    for (const invalid of [
      "2025-02-29", // non-leap year
      "1900-02-29", // century non-leap year
      "2026-02-30", // February has at most 29 days
      "2026-04-31", // April has 30 days
      "2026-00-10", // month 00
      "2026-13-10", // month 13
      "2026-01-00", // day 00
      "2026-01-32"  // day 32
    ]) {
      expect(Number.isNaN(parseIstDateOnly(invalid))).toBe(true);
      expect(parseIstDateRange(invalid, "2026-01-05")).toBeNull();
      expect(parseIstDateRange("2026-01-05", invalid)).toBeNull();
    }
  });

  test("four-digit year boundaries are handled without Date.UTC 0-99 remapping", () => {
    // Date.UTC(5, ...) would mean 1905; the four-digit string "0005" must mean year 5.
    // Verify via IST calendar parts: 00:00 IST is the previous UTC day, so UTC
    // getters would report year 4 for "0005-01-01".
    const year5 = parseIstDateOnly("0005-01-01");
    expect(Number.isFinite(year5)).toBe(true);
    expect(istCalendarParts(year5)).toEqual({ year: 5, month: 0, day: 1, weekday: istCalendarParts(year5).weekday });

    const year99 = parseIstDateOnly("0099-12-31");
    expect(istCalendarParts(year99).year).toBe(99);
    expect(istCalendarParts(year99).month).toBe(11);
    expect(istCalendarParts(year99).day).toBe(31);

    expect(Number.isFinite(parseIstDateOnly("9999-12-31"))).toBe(true);
    expect(istCalendarParts(parseIstDateOnly("0000-01-01")).year).toBe(0); // year 0 is a valid four-digit year
  });

  test("all IST boundary helpers avoid Date.UTC 0-99 remapping", () => {
    // A timestamp whose IST calendar date is 0005-01-15.
    const ts = parseIstDateOnly("0005-01-15");
    expect(istCalendarParts(istDayStartMs(ts))).toMatchObject({ year: 5, month: 0, day: 15 });
    expect(istCalendarParts(istMonthStartMs(ts))).toMatchObject({ year: 5, month: 0, day: 1 });
    expect(istCalendarParts(nextIstMonthStartMs(ts))).toMatchObject({ year: 5, month: 1, day: 1 });

    // December of year 0099 rolls into year 0100 for the next-month helper.
    const dec = parseIstDateOnly("0099-12-10");
    expect(istCalendarParts(nextIstMonthStartMs(dec))).toMatchObject({ year: 100, month: 0, day: 1 });
  });

  test("istDateString zero-pads years below 1000", () => {
    expect(istDateString(parseIstDateOnly("0005-01-15"))).toBe("0005-01-15");
    expect(istDateString(parseIstDateOnly("0099-12-31"))).toBe("0099-12-31");
    expect(istDateString(parseIstDateOnly("2026-01-05"))).toBe("2026-01-05");
  });
});

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

  test("coverage preserves unconfirmed gaps, basis and unavailable notes", async () => {
    fakeFetch(() => ({
      status: 200,
      body: {
        gaps: [{ canonicalId: "A", interval: "1D", fromMs: 1, toMs: 2, basis: "WEEKDAY_ONLY", confirmed: false, reason: "no candle stored" }],
        basis: "WEEKDAY_ONLY", confirmed: false,
        unavailableNotes: [{
          canonicalId: "A", interval: "1D", provider: "FYERS", rangeStartMs: 3, rangeEndMs: 4,
          kind: "UNAVAILABLE", reasonCode: "NO_DATA", reasonJson: "{}",
          requestedAtMs: 5, updatedAtMs: 5
        }]
      }
    }));
    const result = await fetchCoverage(request);
    expect(result.gaps[0]!.basis).toBe("WEEKDAY_ONLY");
    expect(result.gaps[0]!.confirmed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.unavailableNotes[0]!.reasonCode).toBe("NO_DATA");
    expect(result.unavailableNotes[0]!.provider).toBe("FYERS");
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
