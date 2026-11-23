import { eq } from "drizzle-orm";
import { retentionSettingsSchema, type RetentionSettings, type RetentionSettingsView } from "@markethub/contracts";
import { appMeta } from "./schema";
import type { MarketHubDb } from "./index";

/** Durable user-configurable retention lives in validated app_meta, not provider_settings. */
export const RETENTION_SETTINGS_KEY = "retention_settings";

/** Kept as a public alias so existing consumers do not break; the shape is contract-owned. */
export type RetentionReadResult = RetentionSettingsView;

export class AppSettings {
  constructor(private readonly db: MarketHubDb) {}

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
    const value = JSON.stringify(retentionSettingsSchema.parse(settings));
    const now = new Date();
    this.db.insert(appMeta)
      .values({ key: RETENTION_SETTINGS_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
      .run();
  }
}
