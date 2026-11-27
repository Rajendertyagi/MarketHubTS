import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type {
  CandleRangeNote,
  CatalogWriteGuard,
  HistoricalCandle,
  HistoricalSyncConfig
} from "@markethub/contracts";
import { candleRangeNotes, historicalCandles, historicalSyncConfigs } from "../schema";
import type { MarketHubDb } from "../index";

export interface UpsertCandlesOptions {
  /** Owner-initiated same-provider refresh; the only path that may replace a stored candle. */
  refresh?: boolean;
}

export interface UpsertCandlesResult {
  inserted: number;
  unchanged: number;
  conflicts: number;
  refreshed: number;
}

function sameValues(a: HistoricalCandle, b: HistoricalCandle): boolean {
  return a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close &&
    a.volume === b.volume && a.oi === b.oi;
}

function toRow(c: HistoricalCandle) {
  return {
    canonicalId: c.canonicalId,
    interval: c.interval,
    tsMs: c.tsMs,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    oi: c.oi,
    provider: c.provider,
    provenanceJson: JSON.stringify(c.provenance),
    receivedAt: new Date(c.receivedAtMs).toISOString()
  };
}

export class CandleRepository {
  /** G0-C: optional injected write guard; absent = legacy behaviour. */
  constructor(private readonly db: MarketHubDb, private readonly sqlite: Database, private readonly guard?: CatalogWriteGuard) {}

  /** First valid write wins. Conflicts are recorded, never silently applied. */
  upsertCandles(candles: HistoricalCandle[], options: UpsertCandlesOptions = {}): UpsertCandlesResult {
    this.guard?.assertWritable("I"); // G0-C #21/#22: before BEGIN IMMEDIATE
    const result: UpsertCandlesResult = { inserted: 0, unchanged: 0, conflicts: 0, refreshed: 0 };
    if (candles.length === 0) return result;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const candle of candles) {
        const existing = this.db.select().from(historicalCandles).where(
          and(
            eq(historicalCandles.canonicalId, candle.canonicalId),
            eq(historicalCandles.interval, candle.interval),
            eq(historicalCandles.tsMs, candle.tsMs)
          )
        ).get();
        if (!existing) {
          this.db.insert(historicalCandles).values(toRow(candle)).run();
          result.inserted++;
          continue;
        }
        const existingCandle: HistoricalCandle = {
          canonicalId: existing.canonicalId,
          interval: existing.interval as HistoricalCandle["interval"],
          tsMs: existing.tsMs,
          open: existing.open, high: existing.high, low: existing.low, close: existing.close,
          volume: existing.volume, oi: existing.oi,
          provider: existing.provider as HistoricalCandle["provider"],
          provenance: JSON.parse(existing.provenanceJson) as HistoricalCandle["provenance"],
          receivedAtMs: Date.parse(existing.receivedAt)
        };
        if (sameValues(existingCandle, candle)) {
          result.unchanged++; // duplicate identical response is idempotent
          continue;
        }
        if (options.refresh && existingCandle.provider === candle.provider && candle.receivedAtMs > existingCandle.receivedAtMs) {
          this.db.update(historicalCandles).set(toRow(candle)).where(
            and(
              eq(historicalCandles.canonicalId, candle.canonicalId),
              eq(historicalCandles.interval, candle.interval),
              eq(historicalCandles.tsMs, candle.tsMs)
            )
          ).run();
          result.refreshed++;
          continue;
        }
        // Conflicting value from another provider (or a late response) — record, do not overwrite.
        this.recordConflict(candle, existingCandle);
        result.conflicts++;
      }
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.sqlite.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  private recordConflict(incoming: HistoricalCandle, stored: HistoricalCandle): void {
    const now = new Date().toISOString();
    const reasonJson = JSON.stringify({
      storedProvider: stored.provider,
      stored: { open: stored.open, high: stored.high, low: stored.low, close: stored.close, volume: stored.volume, oi: stored.oi },
      competingProvider: incoming.provider,
      competing: { open: incoming.open, high: incoming.high, low: incoming.low, close: incoming.close, volume: incoming.volume, oi: incoming.oi },
      tsMs: incoming.tsMs
    });
    const key = {
      canonicalId: incoming.canonicalId,
      interval: incoming.interval,
      provider: incoming.provider,
      rangeStartMs: incoming.tsMs,
      kind: "CONFLICT"
    };
    const existing = this.db.select().from(candleRangeNotes).where(
      and(
        eq(candleRangeNotes.canonicalId, key.canonicalId),
        eq(candleRangeNotes.interval, key.interval),
        eq(candleRangeNotes.provider, key.provider),
        eq(candleRangeNotes.rangeStartMs, key.rangeStartMs),
        eq(candleRangeNotes.kind, key.kind)
      )
    ).get();
    if (existing) {
      this.db.update(candleRangeNotes).set({ reasonJson, updatedAt: now }).where(
        and(
          eq(candleRangeNotes.canonicalId, key.canonicalId),
          eq(candleRangeNotes.interval, key.interval),
          eq(candleRangeNotes.provider, key.provider),
          eq(candleRangeNotes.rangeStartMs, key.rangeStartMs),
          eq(candleRangeNotes.kind, key.kind)
        )
      ).run();
    } else {
      this.db.insert(candleRangeNotes).values({
        ...key, rangeEndMs: incoming.tsMs, reasonCode: null, reasonJson,
        requestedAt: now, updatedAt: now
      }).run();
    }
  }

  getCandles(canonicalId: string, interval: HistoricalCandle["interval"], fromMs: number, toMs: number, limit = 5000): HistoricalCandle[] {
    const rows = this.db.select().from(historicalCandles).where(
      and(
        eq(historicalCandles.canonicalId, canonicalId),
        eq(historicalCandles.interval, interval),
        gte(historicalCandles.tsMs, fromMs),
        lte(historicalCandles.tsMs, toMs)
      )
    ).orderBy(asc(historicalCandles.tsMs)).limit(Math.max(1, Math.min(limit, 20000))).all();
    return rows.map((r) => ({
      canonicalId: r.canonicalId,
      interval: r.interval as HistoricalCandle["interval"],
      tsMs: r.tsMs,
      open: r.open, high: r.high, low: r.low, close: r.close,
      volume: r.volume, oi: r.oi,
      provider: r.provider as HistoricalCandle["provider"],
      provenance: JSON.parse(r.provenanceJson) as HistoricalCandle["provenance"],
      receivedAtMs: Date.parse(r.receivedAt)
    }));
  }

  /** Covered timestamps are derived from actual stored rows — never a fictional coverage claim. */
  getCoveredTimestamps(canonicalId: string, interval: HistoricalCandle["interval"], fromMs: number, toMs: number): number[] {
    const rows = this.db.select({ tsMs: historicalCandles.tsMs }).from(historicalCandles).where(
      and(
        eq(historicalCandles.canonicalId, canonicalId),
        eq(historicalCandles.interval, interval),
        gte(historicalCandles.tsMs, fromMs),
        lte(historicalCandles.tsMs, toMs)
      )
    ).orderBy(asc(historicalCandles.tsMs)).all();
    return rows.map((r) => r.tsMs);
  }

  addRangeNote(note: CandleRangeNote): void {
    this.guard?.assertWritable("I"); // G0-C #21/#22
    const now = new Date().toISOString();
    this.db.insert(candleRangeNotes).values({
      canonicalId: note.canonicalId,
      interval: note.interval,
      provider: note.provider,
      rangeStartMs: note.rangeStartMs,
      kind: note.kind,
      rangeEndMs: note.rangeEndMs,
      reasonCode: note.reasonCode ?? null,
      reasonJson: note.reasonJson,
      requestedAt: now,
      updatedAt: now
    }).onConflictDoUpdate({
      target: [
        candleRangeNotes.canonicalId, candleRangeNotes.interval, candleRangeNotes.provider,
        candleRangeNotes.rangeStartMs, candleRangeNotes.kind
      ],
      set: { rangeEndMs: note.rangeEndMs, reasonCode: note.reasonCode ?? null, reasonJson: note.reasonJson, updatedAt: now }
    }).run();
  }

  getRangeNotes(canonicalId: string, interval: HistoricalCandle["interval"], fromMs: number, toMs: number): CandleRangeNote[] {
    const rows = this.db.select().from(candleRangeNotes).where(
      and(
        eq(candleRangeNotes.canonicalId, canonicalId),
        eq(candleRangeNotes.interval, interval),
        gte(candleRangeNotes.rangeEndMs, fromMs),
        lte(candleRangeNotes.rangeStartMs, toMs)
      )
    ).orderBy(asc(candleRangeNotes.rangeStartMs), asc(candleRangeNotes.provider)).all();
    return rows.map((r) => ({
      canonicalId: r.canonicalId,
      interval: r.interval as CandleRangeNote["interval"],
      provider: r.provider as CandleRangeNote["provider"],
      rangeStartMs: r.rangeStartMs,
      kind: r.kind as CandleRangeNote["kind"],
      rangeEndMs: r.rangeEndMs,
      reasonCode: (r.reasonCode as CandleRangeNote["reasonCode"]) ?? null,
      reasonJson: r.reasonJson,
      requestedAtMs: Date.parse(r.requestedAt),
      updatedAtMs: Date.parse(r.updatedAt)
    }));
  }

  /**
   * Bounded, FK-safe cleanup. Deletes in bounded batches so no single
   * transaction grows unbounded on large histories. Caller must validate
   * retention settings first.
   */
  cleanupCandles(cutoffMs: number, batchLimit = 1000): number {
    this.guard?.assertWritable("I"); // G0-C #18: before any batched DELETE
    const limit = Math.max(1, Math.min(batchLimit, 10000));
    let deleted = 0;
    while (true) {
      const result = this.sqlite.run(
        "DELETE FROM historical_candles WHERE rowid IN (SELECT rowid FROM historical_candles WHERE ts_ms <= ? LIMIT ?)",
        [cutoffMs, limit]
      );
      deleted += result.changes;
      if (result.changes < limit) break;
    }
    return deleted;
  }

  // --- Historical sync configuration (WebUI-owned) ---

  /**
   * Upsert by the (canonicalId, interval) identity — the table's unique index.
   * A different submitted id for the same instrument/interval merges into the
   * existing row instead of raising a constraint error. Returns the stored row.
   */
  putSyncConfig(config: HistoricalSyncConfig): HistoricalSyncConfig {
    this.guard?.assertWritable("I"); // G0-C #19
    const existing = this.db.select().from(historicalSyncConfigs).where(
      and(
        eq(historicalSyncConfigs.canonicalId, config.canonicalId),
        eq(historicalSyncConfigs.interval, config.interval)
      )
    ).get();
    if (existing) {
      this.db.update(historicalSyncConfigs).set({
        enabled: config.enabled,
        dateRangeJson: config.dateRangeJson,
        scheduleJson: config.scheduleJson,
        providerPolicyJson: config.providerPolicyJson,
        updatedAt: config.updatedAt
      }).where(eq(historicalSyncConfigs.id, existing.id)).run();
      return this.toSyncConfig({ ...existing, ...config, id: existing.id, createdAt: existing.createdAt });
    }
    this.db.insert(historicalSyncConfigs).values({
      id: config.id,
      canonicalId: config.canonicalId,
      interval: config.interval,
      enabled: config.enabled,
      dateRangeJson: config.dateRangeJson,
      scheduleJson: config.scheduleJson,
      providerPolicyJson: config.providerPolicyJson,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt
    }).run();
    return config;
  }

  getSyncConfig(id: string): HistoricalSyncConfig | null {
    const r = this.db.select().from(historicalSyncConfigs).where(eq(historicalSyncConfigs.id, id)).get();
    return r ? this.toSyncConfig(r) : null;
  }

  listSyncConfigs(): HistoricalSyncConfig[] {
    return this.db.select().from(historicalSyncConfigs)
      .orderBy(asc(historicalSyncConfigs.canonicalId), asc(historicalSyncConfigs.interval))
      .all().map((r) => this.toSyncConfig(r));
  }

  deleteSyncConfig(id: string): void {
    this.guard?.assertWritable("I"); // G0-C #20
    this.db.delete(historicalSyncConfigs).where(eq(historicalSyncConfigs.id, id)).run();
  }

  private toSyncConfig(r: typeof historicalSyncConfigs.$inferSelect): HistoricalSyncConfig {
    return {
      id: r.id,
      canonicalId: r.canonicalId,
      interval: r.interval as HistoricalSyncConfig["interval"],
      enabled: r.enabled,
      dateRangeJson: r.dateRangeJson,
      scheduleJson: r.scheduleJson,
      providerPolicyJson: r.providerPolicyJson,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    };
  }
}
