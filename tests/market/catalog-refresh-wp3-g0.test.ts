/**
 * WP3 / §7.4.9 G0 proof — real-listener API responsiveness during a large
 * provider refresh. This is NOT a harness event-loop-delay substitute: it
 * binds an actual `Bun.serve()` listener, drives the real `createApp` fetch
 * handler and the real `CatalogMasterRefresh` streaming/import path, and
 * asserts that `/health`, `/ready` and a normal API request answer while the
 * refresh is blocked in both the download and the DB-apply stage.
 *
 * No numeric latency threshold is adopted. The per-request timeout below is a
 * test-hang guard only, not a performance gate; the assertions are status and
 * schema-valid payloads, which are timing-independent.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { healthStatusSchema, readinessStatusSchema, systemStatusSchema } from "../../packages/contracts/src/index";
import { CatalogMasterRefresh } from "../../packages/market-core/src/index";
import type { CatalogRepository, CatalogSyncRunRecord, CatalogSyncService, MasterFetch } from "../../packages/market-core/src/index";
import { createApp } from "../../apps/api/src/app";
import { createLogger } from "../../apps/api/src/lib/logger";
import { startRefreshAfterListening } from "../../apps/api/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";
import { upstoxRows } from "../fixtures/provider-masters";

const CLOCK = new Date("2026-11-24T10:00:00.000Z");

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeCatalog(): CatalogRepository {
  const stored: CatalogSyncRunRecord[] = [];
  return {
    listSyncRuns: async () => stored,
    recordSyncRun: async (r: CatalogSyncRunRecord) => { stored.push(r); }
  } as unknown as CatalogRepository;
}

/** Large, valid Upstox-shaped source: 3000 pairs -> 12,000 in-scope rows. */
function largeRows(pairs: number): unknown[] {
  const rows: unknown[] = [];
  for (let i = 0; i < pairs; i++) {
    const key = `NSE_EQ|G0N${i}`;
    rows.push({
      segment: "NSE_EQ", name: `NSE SYN ${i}`, exchange: "NSE", isin: `INEG0N${String(i).padStart(5, "0")}`,
      instrument_type: "EQ", instrument_key: key, exchange_token: String(100000 + i), tick_size: 0.05,
      trading_symbol: `GSYN${i}`, short_name: `GSYN${i}`
    });
    rows.push({
      segment: "NSE_FO", name: `NSE SYN ${i}`, exchange: "NSE", instrument_type: "OPTSTK", option_type: "CE",
      instrument_key: `NSE_FO|G0N${i}-CE`, underlying_key: key, underlying_type: "EQ",
      expiry: "2026-12-29T15:00:00+05:30", strike_price: 100 + i, lot_size: 250, tick_size: 0.05,
      freeze_quantity: 10000, trading_symbol: `GSYN${i}26DEC${100 + i}CE`
    });
    rows.push({
      segment: "BSE_EQ", name: `BSE SYN ${i}`, exchange: "BSE", isin: `INEG0B${String(i).padStart(5, "0")}`,
      instrument_type: "EQ", instrument_key: `BSE_EQ|G0B${i}`, exchange_token: String(200000 + i), tick_size: 0.05,
      trading_symbol: `GBSYN${i}`, short_name: `GBSYN${i}`
    });
    rows.push({
      segment: "BSE_FO", name: `BSE SYN ${i}`, exchange: "BSE", instrument_type: "OPTSTK", option_type: "PE",
      instrument_key: `BSE_FO|G0B${i}-PE`, underlying_key: `BSE_EQ|G0B${i}`, underlying_type: "EQ",
      expiry: "2026-12-29T15:00:00+05:30", strike_price: 200 + i, lot_size: 100, tick_size: 0.05,
      freeze_quantity: 5000, trading_symbol: `GBSYN${i}26DEC${200 + i}PE`
    });
  }
  return rows;
}

/** Safety guard against a hung test; not a latency assertion. */
async function fetchWithTimeout(url: string, ms = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

describe("WP3 G0 — real-listener responsiveness during large refresh", () => {
  test("/health, /ready and /api/status stay responsive through download and DB apply", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "wp3-g0-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_PORT: "3999" } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    const logger = createLogger("error");

    const rows = largeRows(3000);
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    const chunkSize = 64 * 1024;
    const downloadGate = deferred();
    const applyGate = deferred();
    let downloadBlocked = false;
    let applyStarted = false;
    const fetchedUrls: string[] = [];
    const bodies: ReadableStream<Uint8Array>[] = [];

    /**
     * Fresh, independent body per request. `startIfNeeded()` kicks off BOTH
     * providers, so a single shared stream would be consumed/locked by the
     * first reader and handed to the second already spent. UPSTOX gets the
     * large, blocked stream the G0 proof depends on; FYERS gets a benign empty
     * stream so it fast-fails ("download was empty") without touching UPSTOX's
     * body or reaching DB apply.
     */
    function makeBody(url: string): ReadableStream<Uint8Array> {
      fetchedUrls.push(url);
      if (url.includes("upstox")) {
        let chunkIndex = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (chunkIndex === 1) {
              downloadBlocked = true;
              await downloadGate.promise; // refresh is stalled mid-download
            }
            const start = chunkIndex * chunkSize;
            if (start >= bytes.length) { controller.close(); return; }
            controller.enqueue(bytes.slice(start, start + chunkSize));
            chunkIndex++;
          }
        });
        bodies.push(body);
        return body;
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.close(); }
      });
      bodies.push(body);
      return body;
    }
    const fetchFn: MasterFetch = async (url) => new Response(makeBody(url));
    const sync = {
      applyCompleteProviderSnapshot: async () => {
        applyStarted = true;
        await applyGate.promise; // refresh is inside the DB-apply stage
        return { status: "COMPLETED", counts: {} } as any;
      }
    } as unknown as CatalogSyncService;

    const refresh = new CatalogMasterRefresh({
      catalog: makeCatalog(), sync, now: () => CLOCK, fetch: fetchFn
    });

    // Spy on the scheduling seam: createApp must NOT start the refresh.
    let startCalls = 0;
    const originalStart = refresh.startIfNeeded.bind(refresh);
    (refresh as any).startIfNeeded = () => { startCalls++; originalStart(); };

    const app = createApp({ config, db, logger, startedAt: Date.now(), catalogRefresh: refresh });
    expect(startCalls).toBe(0); // listener-first: no refresh during app creation

    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const base = `http://127.0.0.1:${server.port}`;
    const startErrors: unknown[] = [];
    try {
      // Production ordering: listener established, then schedule refresh.
      startRefreshAfterListening(refresh, (error) => startErrors.push(error));
      expect(startCalls).toBe(1);
      expect(startErrors.length).toBe(0);

      // Phase 1: refresh is blocked mid-download. The real listener must answer.
      for (let i = 0; i < 200 && !downloadBlocked; i++) await Bun.sleep(5);
      expect(downloadBlocked).toBe(true);
      // Both providers were exercised, each with its own independent body —
      // no shared/consumed stream handed to the second provider.
      expect(fetchedUrls.some((u) => u.includes("upstox"))).toBe(true);
      expect(fetchedUrls.some((u) => u.includes("fyers.in"))).toBe(true);
      expect(bodies.length).toBe(fetchedUrls.length); // one fresh body per request
      const duringDownload = await fetchWithTimeout(`${base}/health`);
      expect(duringDownload.status).toBe(200);
      expect(healthStatusSchema.safeParse(await duringDownload.json()).success).toBe(true);

      downloadGate.resolve();

      // Phase 2: refresh is inside DB apply. All three endpoints must answer.
      for (let i = 0; i < 200 && !applyStarted; i++) await Bun.sleep(5);
      expect(applyStarted).toBe(true);
      const [health, ready, status] = await Promise.all([
        fetchWithTimeout(`${base}/health`),
        fetchWithTimeout(`${base}/ready`),
        fetchWithTimeout(`${base}/api/status`)
      ]);
      expect(health.status).toBe(200);
      expect(ready.status).toBe(200);
      expect(status.status).toBe(200);
      expect(healthStatusSchema.safeParse(await health.json()).success).toBe(true);
      expect(readinessStatusSchema.safeParse(await ready.json()).success).toBe(true);
      expect(systemStatusSchema.safeParse(await status.json()).success).toBe(true);
      // The refresh is still blocked in apply: responsiveness was concurrent.
      expect(applyStarted).toBe(true);

      applyGate.resolve();
      await refresh.stopAndWait();
      expect(refresh.state).toBe("STOPPED");
    } finally {
      downloadGate.resolve();
      applyGate.resolve();
      await refresh.stopAndWait();
      server.stop(true);
      closeDatabaseHandle(db);
      removeTempDir(dir);
    }
  });
});
