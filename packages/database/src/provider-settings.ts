import { eq } from "drizzle-orm";
import type { ProviderSettings } from "@markethub/contracts";
import { providerSettings } from "./schema";
import type { DatabaseHandle } from "./index";

/** Durable non-secret provider settings. Secrets stay in the encrypted CredentialStore. */
export class SqliteProviderSettings implements ProviderSettings {
  constructor(private readonly handle: DatabaseHandle) {}

  async get(key: string): Promise<string | null> {
    const row = this.handle.db.select().from(providerSettings).where(eq(providerSettings.key, key)).get();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    this.handle.db
      .insert(providerSettings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: providerSettings.key, set: { value, updatedAt: now } })
      .run();
  }

  async delete(key: string): Promise<void> {
    this.handle.db.delete(providerSettings).where(eq(providerSettings.key, key)).run();
  }

  async all(): Promise<Record<string, string>> {
    const rows = this.handle.db.select().from(providerSettings).all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}

export const PROVIDER_SETTING_KEYS = {
  fyersAppId: "fyers.appId",
  fyersRedirectUri: "fyers.redirectUri",
  upstoxTokenExpiresAt: "upstox.tokenExpiresAt",
  fyersTokenExpiresAt: "fyers.tokenExpiresAt"
} as const;
