import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import {
  emptyProviderStatus, providerStatusMapSchema,
  type ProviderAdapter, type ProviderId, type ProviderStatus
} from "../../packages/contracts/src/index";
import { MarketDataService, ProviderRegistry } from "../../packages/market-core/src/index";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

class FakeAdapter implements ProviderAdapter {
  constructor(readonly id: ProviderId, private status: ProviderStatus) {}
  getStatus(): ProviderStatus { return { ...this.status }; }
  async isConfigured(): Promise<boolean> { return true; }
  async validate(): Promise<ProviderStatus> { return this.getStatus(); }
  async remove(): Promise<void> {}
}

function makeDeps() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-pstatus-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const logger = createLogger("error");

  const registry = new ProviderRegistry();
  const upstoxStatus = { ...emptyProviderStatus("UPSTOX", true), authState: "AUTHENTICATED" as const };
  registry.register(new FakeAdapter("UPSTOX", upstoxStatus));
  registry.register(new FakeAdapter("FYERS", emptyProviderStatus("FYERS", true)));

  const service = new MarketDataService({
    now: () => new Date(1_700_000_000_000),
    policy: { openMaxAgeMs: 15_000, unknownMaxAgeMs: 5_000, maxRetainedObservationAgeMs: 60_000 },
    maxInstruments: 10,
    session: () => "OPEN"
  });

  const app = createApp({ config, db, logger, startedAt: Date.now(), providerRegistry: registry, service });
  const cleanup = () => { closeDatabaseHandle(db); removeTempDir(dir); };
  return { app, service, cleanup };
}

describe("GET /api/providers/status composition", () => {
  test("preserves response structure and validates with providerStatusMapSchema", async () => {
    const h = makeDeps();
    try {
      const res = await h.app.request("/api/providers/status");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Object.keys(json).sort()).toEqual(["localManagement", "note", "providers"]);
      expect(json.localManagement).toBe(true);
      expect(providerStatusMapSchema.safeParse(json.providers).success).toBe(true);
    } finally { h.cleanup(); }
  });

  test("streaming state begins NOT_STARTED and reflects runtime changes", async () => {
    const h = makeDeps();
    try {
      let json = await (await h.app.request("/api/providers/status")).json();
      expect(json.providers.UPSTOX.streamingState).toBe("NOT_STARTED");

      h.service.setProviderConnection("UPSTOX", "STREAMING");
      json = await (await h.app.request("/api/providers/status")).json();
      expect(json.providers.UPSTOX.streamingState).toBe("STREAMING");
      expect(providerStatusMapSchema.safeParse(json.providers).success).toBe(true);
    } finally { h.cleanup(); }
  });

  test("auth state is retained while streaming state changes", async () => {
    const h = makeDeps();
    try {
      h.service.setProviderConnection("UPSTOX", "DISCONNECTED", "socket closed");
      const json = await (await h.app.request("/api/providers/status")).json();
      expect(json.providers.UPSTOX.authState).toBe("AUTHENTICATED");
      expect(json.providers.UPSTOX.streamingState).toBe("DISCONNECTED");
      expect(json.providers.FYERS.streamingState).toBe("NOT_STARTED");
    } finally { h.cleanup(); }
  });
});
