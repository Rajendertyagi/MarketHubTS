import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type {
  OptionChainCaptureConfig,
  OptionChainSnapshot
} from "@markethub/contracts";
import { optionChainCaptureConfigs, optionChainSnapshots } from "../schema";
import type { MarketHubDb } from "../index";

export class SnapshotRepository {
  constructor(private readonly db: MarketHubDb, private readonly sqlite: Database) {}

  putCaptureConfig(config: OptionChainCaptureConfig): void {
    this.db.insert(optionChainCaptureConfigs).values({
      id: config.id,
      underlyingCanonicalId: config.underlyingCanonicalId,
      expiryDate: config.expiryDate,
      strikeRangeJson: config.strikeRangeJson,
      captureEnabled: config.captureEnabled,
      captureMode: config.captureMode,
      scheduleJson: config.scheduleJson,
      streamingEnabled: config.streamingEnabled,
      provider: config.provider,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt
    }).onConflictDoUpdate({
      target: optionChainCaptureConfigs.id,
      set: {
        underlyingCanonicalId: config.underlyingCanonicalId,
        expiryDate: config.expiryDate,
        strikeRangeJson: config.strikeRangeJson,
        captureEnabled: config.captureEnabled,
        captureMode: config.captureMode,
        scheduleJson: config.scheduleJson,
        streamingEnabled: config.streamingEnabled,
        provider: config.provider,
        updatedAt: config.updatedAt
      }
    }).run();
  }

  getCaptureConfig(id: string): OptionChainCaptureConfig | null {
    const r = this.db.select().from(optionChainCaptureConfigs).where(eq(optionChainCaptureConfigs.id, id)).get();
    if (!r) return null;
    return {
      id: r.id,
      underlyingCanonicalId: r.underlyingCanonicalId,
      expiryDate: r.expiryDate,
      strikeRangeJson: r.strikeRangeJson,
      captureEnabled: r.captureEnabled,
      captureMode: r.captureMode as OptionChainCaptureConfig["captureMode"],
      scheduleJson: r.scheduleJson,
      streamingEnabled: r.streamingEnabled,
      provider: r.provider as OptionChainCaptureConfig["provider"],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    };
  }

  listCaptureConfigs(): OptionChainCaptureConfig[] {
    return this.db.select().from(optionChainCaptureConfigs)
      .orderBy(asc(optionChainCaptureConfigs.underlyingCanonicalId), asc(optionChainCaptureConfigs.expiryDate))
      .all().map((r) => ({
      id: r.id,
      underlyingCanonicalId: r.underlyingCanonicalId,
      expiryDate: r.expiryDate,
      strikeRangeJson: r.strikeRangeJson,
      captureEnabled: r.captureEnabled,
      captureMode: r.captureMode as OptionChainCaptureConfig["captureMode"],
      scheduleJson: r.scheduleJson,
      streamingEnabled: r.streamingEnabled,
      provider: r.provider as OptionChainCaptureConfig["provider"],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }));
  }

  /** Deleting a config leaves its snapshots intact (config_id becomes NULL via FK). */
  deleteCaptureConfig(id: string): void {
    this.db.delete(optionChainCaptureConfigs).where(eq(optionChainCaptureConfigs.id, id)).run();
  }

  putSnapshot(snapshot: OptionChainSnapshot): void {
    this.db.insert(optionChainSnapshots).values({
      id: snapshot.id,
      configId: snapshot.configId,
      capturedAt: snapshot.capturedAt,
      provider: snapshot.provider,
      envelopeJson: JSON.stringify(snapshot.envelope),
      provenanceJson: JSON.stringify(snapshot.provenance)
    }).run();
  }

  getSnapshot(id: string): OptionChainSnapshot | null {
    const r = this.db.select().from(optionChainSnapshots).where(eq(optionChainSnapshots.id, id)).get();
    return r ? this.toSnapshot(r) : null;
  }

  listSnapshots(configId?: string, fromMs?: number, toMs?: number, limit = 200): OptionChainSnapshot[] {
    const conditions = [];
    if (configId !== undefined) conditions.push(eq(optionChainSnapshots.configId, configId));
    if (fromMs !== undefined) conditions.push(gte(optionChainSnapshots.capturedAt, new Date(fromMs).toISOString()));
    if (toMs !== undefined) conditions.push(lte(optionChainSnapshots.capturedAt, new Date(toMs).toISOString()));
    const rows = conditions.length
      ? this.db.select().from(optionChainSnapshots).where(and(...conditions)).orderBy(asc(optionChainSnapshots.capturedAt)).limit(Math.max(1, Math.min(limit, 1000))).all()
      : this.db.select().from(optionChainSnapshots).orderBy(asc(optionChainSnapshots.capturedAt)).limit(Math.max(1, Math.min(limit, 1000))).all();
    return rows.map((r) => this.toSnapshot(r));
  }

  private toSnapshot(r: typeof optionChainSnapshots.$inferSelect): OptionChainSnapshot {
    return {
      id: r.id,
      configId: r.configId,
      capturedAt: r.capturedAt,
      provider: r.provider as OptionChainSnapshot["provider"],
      envelope: JSON.parse(r.envelopeJson) as OptionChainSnapshot["envelope"],
      provenance: JSON.parse(r.provenanceJson) as OptionChainSnapshot["provenance"]
    };
  }

  /**
   * Bounded, FK-safe cleanup. Deletes in bounded batches so no single
   * transaction grows unbounded on large histories. Caller must validate
   * retention settings first.
   */
  cleanupSnapshots(cutoffMs: number, batchLimit = 500): number {
    const limit = Math.max(1, Math.min(batchLimit, 10000));
    const cutoff = new Date(cutoffMs).toISOString();
    let deleted = 0;
    while (true) {
      const result = this.sqlite.run(
        "DELETE FROM option_chain_snapshots WHERE rowid IN (SELECT rowid FROM option_chain_snapshots WHERE captured_at <= ? LIMIT ?)",
        [cutoff, limit]
      );
      deleted += result.changes;
      if (result.changes < limit) break;
    }
    return deleted;
  }
}
