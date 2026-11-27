import { eq } from "drizzle-orm";
import { retentionSettingsSchema, type CatalogWriteGuard, type RetentionSettings, type RetentionSettingsView } from "@markethub/contracts";
import { appMeta } from "./schema";
import type { MarketHubDb } from "./index";

/** Durable user-configurable retention lives in validated app_meta, not provider_settings. */
export const RETENTION_SETTINGS_KEY = "retention_settings";

/** Kept as a public alias so existing consumers do not break; the shape is contract-owned. */
export type RetentionReadResult = RetentionSettingsView;

export class AppSettings {
  /** G0-C: optional injected write guard; absent = legacy behaviour (all writes allowed). */
  constructor(private readonly db: MarketHubDb, private readonly guard?: CatalogWriteGuard) {}

  getRetention(): RetentionSettingsView {
    const row = this.db.select().from(appMeta).where(eq(appMeta.key, RETENTION_SETTINGS_KEY)).get();
    if (!row) return { settings: null, valid: false, error: "retention settings not configured" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return { settings: null, valid: false, error: "retention settings malformed" };
    }
    const result = retentionSettingsSchema.safeParse(parsed);
    if (!result.success) return { settings: null, valid: false, error: "retention settings invalid" };
    return { settings: result.data, valid: true, error: null };
  }

  setRetention(settings: RetentionSettings): void {
    this.guard?.assertWritable("I"); // G0-C #17: fail fast before any mutation
    const value = JSON.stringify(retentionSettingsSchema.parse(settings));
    const now = new Date();
    this.db.insert(appMeta)
      .values({ key: RETENTION_SETTINGS_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
      .run();
  }
}
