import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CandleRangeRequest, HistoricalCandle, HistoricalSyncConfig, ProviderId
} from "../../packages/contracts/src/index";
import { AppSettings, CandleRepository, openDatabase } from "../../packages/database/src/index";
import { HistoricalCandleService, type HistoricalProvider, type HistoricalFetchOutcome } from "../../packages/market-core/src/index";
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
