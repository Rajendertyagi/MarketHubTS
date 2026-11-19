import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CandleRangeRequest, HistoricalCandle, HistoricalSyncConfig, ProviderId
} from "../../packages/contracts/src/index";
import { AppSettings, CandleRepository, openDatabase } from "../../packages/database/src/index";
import { HistoricalCandleService, assessGaps, type HistoricalProvider, type HistoricalFetchOutcome } from "../../packages/market-core/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const CANON = "v1|NSE|EQ|EQ|CODE:SBIN";
const DAY = 24 * 60 * 60 * 1000;

function candle(tsMs: number, close: number, provider: ProviderId = "UPSTOX"): HistoricalCandle {
  return {
    canonicalId: CANON, interval: "1D", tsMs, open: close - 1, high: close + 1, low: close - 2, close,
    volume: 100, oi: null, provider,
    provenance: { source: "provider-feed", provider, receivedAt: new Date(tsMs).toISOString() },
    receivedAtMs: tsMs
  };
}

class FakeProvider implements HistoricalProvider {
  calls: CandleRangeRequest[] = [];
  constructor(readonly id: ProviderId, private readonly candles: HistoricalCandle[] = [], private readonly error?: string) {}
  async fetchCandles(request: CandleRangeRequest): Promise<HistoricalFetchOutcome> {
    this.calls.push(request);
    if (this.error) throw new Error(this.error);
    return { candles: this.candles.filter((c) => c.tsMs >= request.fromMs && c.tsMs <= request.toMs) };
  }
}

function harness(providers: HistoricalProvider[]) {
  const dir = mkdtempSync(join(tmpdir(), "mh-historical-"));
  const handle = openDatabase({ dbPath: join(dir, "h.sqlite"), migrate: true });
  const candles = new CandleRepository(handle.db, handle.sqlite);
  const settings = new AppSettings(handle.db);
  const service = new HistoricalCandleService({ candles, settings, providers, now: () => Date.parse("2026-06-01T00:00:00.000Z") });
  return { dir, handle, candles, settings, service };
}

function request(overrides: Partial<CandleRangeRequest> = {}): CandleRangeRequest {
  return { canonicalId: CANON, interval: "1D", fromMs: Date.parse("2026-01-01T00:00:00Z"), toMs: Date.parse("2026-01-31T00:00:00Z"), ...overrides };
}

describe("HistoricalCandleService", () => {
  test("disjoint coverage: two fetched windows leave an approximate gap, no fabricated candle", async () => {
    const jan1 = Date.parse("2026-01-01T00:00:00Z");
    const jan20 = Date.parse("2026-01-20T00:00:00Z");
    const p = new FakeProvider("UPSTOX", [candle(jan1, 100), candle(jan20, 110)]);
    const h = harness([p]);
    try {
      await h.service.fetchOnDemand(request());
      const gaps = h.service.getCoverage(request());
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps.every((g) => g.basis === "WEEKDAY_ONLY" && g.confirmed === false)).toBe(true);
      expect(h.candles.getCandles(CANON, "1D", 0, 9999999999999).length).toBe(2); // no fabricated candles
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("alternate provider fills a gap; original UNAVAILABLE note retained; no overwrite", async () => {
    const ts = Date.parse("2026-01-05T00:00:00Z");
    const a = new FakeProvider("UPSTOX", [], "ENTITLEMENT denied");
    const b = new FakeProvider("FYERS", [candle(ts, 105, "FYERS")]);
    const h = harness([a, b]);
    try {
      const result = await h.service.fetchOnDemand(request());
      expect(result.providersTried).toEqual(["UPSTOX", "FYERS"]);
      expect(result.candles.length).toBe(1);
      expect(result.candles[0]!.provider).toBe("FYERS");
      expect(h.candles.getRangeNotes(CANON, "1D", 0, 9999999999999).some((n) => n.kind === "UNAVAILABLE" && n.reasonCode === "ENTITLEMENT")).toBe(true);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("transient throttle is not stored as a permanent UNAVAILABLE note", async () => {
    const p = new FakeProvider("UPSTOX", [], "HTTP 429 rate limited");
    const h = harness([p]);
    try {
      await h.service.fetchOnDemand(request());
      expect(h.candles.getRangeNotes(CANON, "1D", 0, 9999999999999).length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("gap basis by interval: daily/weekly/monthly/intraday", () => {
    const h = harness([]);
    try {
      const daily = h.service.getCoverage(request({ interval: "1D" }));
      expect(daily.every((g) => g.basis === "WEEKDAY_ONLY" && g.confirmed === false)).toBe(true);
      const weekly = h.service.getCoverage(request({ interval: "1W" }));
      expect(weekly.every((g) => g.basis === "WEEKLY_BUCKET" && g.confirmed === false)).toBe(true);
      const monthly = h.service.getCoverage(request({ interval: "1M" }));
      expect(monthly.every((g) => g.basis === "MONTHLY_BUCKET" && g.confirmed === false)).toBe(true);
      const intraday = h.service.getCoverage(request({ interval: "60m" }));
      expect(intraday.every((g) => g.basis === "SESSION_UNKNOWN" && g.confirmed === false)).toBe(true);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("weekends are excluded from daily candidate gaps", () => {
    const h = harness([]);
    try {
      const gaps = h.service.getCoverage(request({ fromMs: Date.parse("2026-01-03T00:00:00Z"), toMs: Date.parse("2026-01-04T00:00:00Z") })); // Sat/Sun
      expect(gaps.length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("India-local calendar: Monday just after midnight IST is a weekday candidate", () => {
    // 2026-01-05T00:00:30+05:30 = 2026-01-04T18:30:30Z (Sunday in UTC, Monday in IST)
    const mondayIst = Date.parse("2026-01-04T18:30:30.000Z");
    const gaps = assessGaps(request({ fromMs: mondayIst, toMs: mondayIst + 1000 }), []);
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.basis).toBe("WEEKDAY_ONLY");
    expect(gaps[0]!.confirmed).toBe(false);
  });

  test("India-local calendar: Saturday and Sunday IST are excluded from daily candidates", () => {
    // Sat 2026-01-03 00:30 IST = Fri 2026-01-02 19:00Z; Sun 2026-01-04 12:00 IST = 06:30Z
    const satIst = Date.parse("2026-01-02T19:00:00.000Z");
    const sunIst = Date.parse("2026-01-04T06:30:00.000Z");
    expect(assessGaps(request({ fromMs: satIst, toMs: satIst + 1000 }), []).length).toBe(0);
    expect(assessGaps(request({ fromMs: sunIst, toMs: sunIst + 1000 }), []).length).toBe(0);
  });

  test("India-local weekly and monthly buckets use IST calendar boundaries", () => {
    // 2026-02-01T00:30 IST = 2026-01-31T19:00Z (January in UTC, February in IST).
    // Start before the IST month boundary so the February bucket is not clipped.
    const monthly = assessGaps(request({
      interval: "1M",
      fromMs: Date.parse("2026-01-31T18:00:00.000Z"), // 2026-01-31 23:30 IST
      toMs: Date.parse("2026-01-31T19:00:00.000Z")  // 2026-02-01 00:30 IST
    }), []);
    expect(monthly.length).toBe(2); // January + February buckets
    expect(monthly.every((g) => g.basis === "MONTHLY_BUCKET" && g.confirmed === false)).toBe(true);
    expect(monthly[1]!.fromMs).toBe(Date.parse("2026-01-31T18:30:00.000Z")); // 2026-02-01 00:00 IST

    // 2026-01-05 (Monday) 01:00 IST = 2026-01-04 19:30Z (Sunday in UTC).
    // Start before the IST week boundary so the Monday bucket is not clipped.
    const weekly = assessGaps(request({
      interval: "1W",
      fromMs: Date.parse("2026-01-04T18:00:00.000Z"), // 2026-01-04 23:30 IST (Sunday)
      toMs: Date.parse("2026-01-04T19:30:00.000Z")  // 2026-01-05 01:00 IST (Monday)
    }), []);
    expect(weekly.length).toBe(2); // Sunday's week + Monday's week
    expect(weekly.every((g) => g.basis === "WEEKLY_BUCKET" && g.confirmed === false)).toBe(true);
    expect(weekly[1]!.fromMs).toBe(Date.parse("2026-01-04T18:30:00.000Z")); // Monday 00:00 IST
  });

  test("on-demand fetch never reads or mutates sync config", async () => {
    const p = new FakeProvider("UPSTOX", [candle(Date.parse("2026-01-05T00:00:00Z"), 100)]);
    const h = harness([p]);
    try {
      const config: HistoricalSyncConfig = {
        id: "cfg-1", canonicalId: CANON, interval: "1D", enabled: true,
        dateRangeJson: null, scheduleJson: null, providerPolicyJson: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
      };
      // No config is written to the repository; on-demand must still work.
      await h.service.fetchOnDemand(request());
      const rows = h.handle.sqlite.query("SELECT COUNT(*) AS n FROM historical_sync_configs").get() as { n: number };
      expect(rows.n).toBe(0);
      expect(config.id).toBe("cfg-1");
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("first-write-wins and explicit refresh through the service", async () => {
    const ts = Date.parse("2026-01-05T00:00:00Z");
    const p = new FakeProvider("UPSTOX", [candle(ts, 100)]);
    const h = harness([p]);
    try {
      await h.service.fetchOnDemand(request());
      expect(h.candles.getCandles(CANON, "1D", ts, ts)[0]!.close).toBe(100);
      const refreshed = candle(ts, 110);
      refreshed.receivedAtMs += 1000;
      expect(h.candles.upsertCandles([refreshed], { refresh: true }).refreshed).toBe(1);
      expect(h.candles.getCandles(CANON, "1D", ts, ts)[0]!.close).toBe(110);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("a partial-range UNAVAILABLE note does not suppress the fetchable remainder", async () => {
    const p = new FakeProvider("UPSTOX", [candle(Date.parse("2026-01-20T00:00:00Z"), 110)]);
    const h = harness([p]);
    try {
      // Note covers only Jan 1-5; the request spans Jan 1-31, so the provider
      // must still be attempted for the fetchable remainder.
      h.candles.addRangeNote({
        canonicalId: CANON, interval: "1D", provider: "UPSTOX",
        rangeStartMs: Date.parse("2026-01-01T00:00:00Z"), kind: "UNAVAILABLE",
        rangeEndMs: Date.parse("2026-01-05T00:00:00Z"), reasonCode: "NO_DATA",
        reasonJson: "{}", requestedAtMs: 1, updatedAtMs: 1
      });
      const result = await h.service.fetchOnDemand(request());
      expect(result.providersTried).toEqual(["UPSTOX"]);
      expect(p.calls.length).toBe(1);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("a provider with an existing permanent UNAVAILABLE note is not retried", async () => {
    const a = new FakeProvider("UPSTOX", [], "ENTITLEMENT denied");
    const b = new FakeProvider("FYERS", [candle(Date.parse("2026-01-05T00:00:00Z"), 105, "FYERS")]);
    const h = harness([a, b]);
    try {
      const first = await h.service.fetchOnDemand(request());
      expect(first.providersTried).toEqual(["UPSTOX", "FYERS"]);
      expect(a.calls.length).toBe(1);

      // Second call for the same range: UPSTOX has a permanent note, so it is
      // skipped; FYERS is still attempted (alternate fill remains available).
      const second = await h.service.fetchOnDemand(request());
      expect(second.providersTried).toEqual(["FYERS"]);
      expect(a.calls.length).toBe(1); // not retried
      expect(b.calls.length).toBe(2);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("explicit provider no_data is recorded as an authoritative NO_DATA note", async () => {
    const noDataProvider: HistoricalProvider = {
      id: "FYERS",
      fetchCandles: async () => ({ candles: [], noData: true })
    };
    const h = harness([noDataProvider]);
    try {
      const result = await h.service.fetchOnDemand(request());
      expect(result.candles.length).toBe(0);
      expect(result.unavailable.some((u) => u.reasonCode === "NO_DATA" && u.provider === "FYERS")).toBe(true);
      const notes = h.candles.getRangeNotes(CANON, "1D", 0, 9999999999999);
      expect(notes.some((n) => n.kind === "UNAVAILABLE" && n.reasonCode === "NO_DATA")).toBe(true);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("runSync applies the saved provider preference without a fixed priority", async () => {
    const upstox = new FakeProvider("UPSTOX", [candle(Date.parse("2026-01-05T00:00:00Z"), 100)]);
    const fyers = new FakeProvider("FYERS", [candle(Date.parse("2026-01-06T00:00:00Z"), 101, "FYERS")]);
    const h = harness([upstox, fyers]); // caller order: UPSTOX first
    try {
      const config: HistoricalSyncConfig = {
        id: "cfg-1", canonicalId: CANON, interval: "1D", enabled: true,
        dateRangeJson: null,
        providerPolicyJson: JSON.stringify({ preferredProvider: "FYERS" }),
        scheduleJson: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
      };
      const result = await h.service.runSync(config);
      expect(result.providersTried[0]).toBe("FYERS"); // saved preference wins
      expect(result.providersTried).toContain("UPSTOX"); // fallback retained
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("runSync rejects invalid parsed date bounds instead of propagating NaN", async () => {
    const p = new FakeProvider("UPSTOX", [candle(Date.parse("2026-01-05T00:00:00Z"), 100)]);
    const h = harness([p]);
    try {
      const config: HistoricalSyncConfig = {
        id: "cfg-1", canonicalId: CANON, interval: "1D", enabled: true,
        dateRangeJson: JSON.stringify({ from: "not-a-date", to: "also-invalid" }),
        scheduleJson: null, providerPolicyJson: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
      };
      await h.service.runSync(config);
      expect(p.calls.length).toBe(1);
      const sent = p.calls[0]!;
      expect(Number.isFinite(sent.fromMs)).toBe(true);
      expect(Number.isFinite(sent.toMs)).toBe(true);
      expect(sent.fromMs).toBeLessThanOrEqual(sent.toMs);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("generic 422 invalid input is reported but not persisted as a DATE_LIMIT note", async () => {
    const badInput: HistoricalProvider = {
      id: "FYERS",
      fetchCandles: async () => { throw new Error("REQUEST_SPECIFIC_422"); }
    };
    const h = harness([badInput]);
    try {
      const result = await h.service.fetchOnDemand(request());
      expect(result.unavailable.some((u) => u.reasonCode === "REQUEST_ERROR")).toBe(true);
      expect(h.candles.getRangeNotes(CANON, "1D", 0, 9999999999999).length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });
});
