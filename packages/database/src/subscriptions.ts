import { eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { CatalogWriteGuard, SubscriptionRepository, SubscriptionSelection, SubscriptionState } from "@markethub/contracts";
import { appMeta, streamingSubscriptions } from "./schema";
import type { MarketHubDb } from "./index";

/** Durable desired-state generation key in the existing app_meta table. */
export const STREAMING_GENERATION_KEY = "streaming_subscriptions_generation";

/**
 * Persists desired live-streaming selections. A full replacement and the
 * generation increment commit in one serialized transaction; no provider SDK
 * or network work happens here.
 */
export class SqliteSubscriptionRepository implements SubscriptionRepository {
  private txQueue: Promise<void> = Promise.resolve();

  /** G0-C: optional injected write guard; absent = legacy behaviour. */
  constructor(private readonly db: MarketHubDb, private readonly sqlite: Database, private readonly guard?: CatalogWriteGuard) {}

  async load(): Promise<SubscriptionState> {
    // Synchronous body: rows and generation are read from one consistent point.
    const rows = this.db.select().from(streamingSubscriptions).all();
    const selections: SubscriptionSelection[] = rows.map((r) => ({
      canonicalId: r.canonicalId,
      enabled: r.enabled
    }));
    return { selections, generation: this.readGeneration() };
  }

  async replace(selections: SubscriptionSelection[]): Promise<number> {
    this.guard?.assertWritable("I"); // G0-C #30: before any delete/insert/generation change
    const run = async (): Promise<number> => {
      const seen = new Set<string>();
      for (const selection of selections) {
        if (seen.has(selection.canonicalId)) {
          throw new Error(`Duplicate canonical id: ${selection.canonicalId}`);
        }
        seen.add(selection.canonicalId);
      }

      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        this.db.delete(streamingSubscriptions).run();
        const nowIso = new Date().toISOString();
        if (selections.length > 0) {
          this.db.insert(streamingSubscriptions).values(
            selections.map((s) => ({
              canonicalId: s.canonicalId,
              enabled: s.enabled,
              createdAt: nowIso,
              updatedAt: nowIso
            }))
          ).run();
        }
        const next = this.readGeneration() + 1;
        const now = new Date();
        this.db.insert(appMeta)
          .values({ key: STREAMING_GENERATION_KEY, value: String(next), updatedAt: now })
          .onConflictDoUpdate({
            target: appMeta.key,
            set: { value: String(next), updatedAt: now }
          })
          .run();
        this.sqlite.exec("COMMIT");
        return next;
      } catch (error) {
        try { this.sqlite.exec("ROLLBACK"); } catch {}
        throw error;
      }
    };

    const queued = this.txQueue.then(run, run);
    this.txQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private readGeneration(): number {
    const row = this.db.select().from(appMeta).where(eq(appMeta.key, STREAMING_GENERATION_KEY)).get();
    if (!row) return 0;
    const value = Number(row.value);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
}
