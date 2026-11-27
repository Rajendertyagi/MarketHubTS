import { eq } from "drizzle-orm";
import type { CatalogWriteGuard, ProviderSettings } from "@markethub/contracts";
import { providerSettings } from "./schema";
import type { DatabaseHandle } from "./index";

/** Durable non-secret provider settings. Secrets stay in the encrypted CredentialStore. */
export class SqliteProviderSettings implements ProviderSettings {
  /** G0-C: optional injected write guard; absent = legacy behaviour. */
  constructor(private readonly handle: DatabaseHandle, private readonly guard?: CatalogWriteGuard) {}

  async get(key: string): Promise<string | null> {
    const row = this.handle.db.select().from(providerSettings).where(eq(providerSettings.key, key)).get();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.guard?.assertWritable("I"); // G0-C #11/#13
    const now = new Date().toISOString();
    this.handle.db
      .insert(providerSettings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: providerSettings.key, set: { value, updatedAt: now } })
      .run();
  }

  async delete(key: string): Promise<void> {
    this.guard?.assertWritable("I"); // G0-C #13/#15
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
