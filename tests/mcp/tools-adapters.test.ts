import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
import { createHttpMcpServices } from "../../apps/api/src/mcp-services";
import { createLogger } from "../../apps/api/src/lib/logger";
import { composeProviderStatuses } from "../../apps/api/src/provider-routes";
import { createStdioServices } from "../../apps/mcp-server/src/services";
import { loadConfig, resetConfigCache } from "../../packages/config/src/index";
import { defaultMigrationsFolder, openDatabase, runMigrations } from "../../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const A = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";

/** Build a real app with fake injected services to verify HTTP adapter instance sharing. */
function makeApp() {
  resetConfigCache();
  const dir = mkdtempSync(join(tmpdir(), "markethub-b2-adapters-"));
  const dbPath = join(dir, "test.sqlite");
  const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_LAN: "false" } });
  const db = openDatabase({ dbPath });
  runMigrations(db.db, defaultMigrationsFolder);
  const auth = {
    UPSTOX: { id: "UPSTOX", enabled: true, authState: "AUTHENTICATED", streamingState: "NOT_STARTED", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null },
    FYERS: { id: "FYERS", enabled: true, authState: "NOT_CONFIGURED", streamingState: "NOT_STARTED", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null }
  };
  const app = createApp({
    config, db, logger: createLogger("error"), startedAt: Date.now(),
    providerRegistry: { getStatuses: () => auth } as never
  });
  return { app, db, dir, cleanup: () => { closeDatabaseHandle(db); removeTempDir(dir); } };
}

describe("M6-B2 HTTP adapter", () => {
  test("composeProviderStatuses preserves runtime streaming state for both providers", () => {
    const auth = {
      UPSTOX: { id: "UPSTOX", enabled: true, authState: "AUTHENTICATED", streamingState: "NOT_STARTED", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null },
      FYERS: { id: "FYERS", enabled: true, authState: "AUTHENTICATED", streamingState: "NOT_STARTED", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null }
    };
    const registry = { getStatuses: () => auth } as never;
    const service = { getConnectionStatus: (id: string) => ({ state: id === "UPSTOX" ? "STREAMING" : "DISCONNECTED" }) } as never;
    const composed = composeProviderStatuses({ providerRegistry: registry, service })!;
    expect(composed.UPSTOX.streamingState).toBe("STREAMING");
    expect(composed.FYERS.streamingState).toBe("DISCONNECTED");
    expect(composed.UPSTOX.authState).toBe("AUTHENTICATED");
  });

  test("REST provider status endpoint exposes the composed map", async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await app.request("/api/providers/status");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.providers).toBeDefined();
      expect(json.providers.UPSTOX).toBeDefined();
      expect(json.providers.FYERS).toBeDefined();
      expect(json.localManagement).toBe(true);
    } finally { cleanup(); }
  });
});

describe("M6-B2 STDIO adapter", () => {
  test("getProviderStatus extracts and validates the composed providers map", async () => {
    const providers = {
      UPSTOX: { id: "UPSTOX", enabled: true, authState: "AUTHENTICATED", streamingState: "STREAMING", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null },
      FYERS: { id: "FYERS", enabled: true, authState: "NOT_CONFIGURED", streamingState: "NOT_STARTED", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null }
    };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ providers, localManagement: true, note: "x" }) });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.getProviderStatus();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.UPSTOX.streamingState).toBe("STREAMING");
        expect(result.value.FYERS.streamingState).toBe("NOT_STARTED");
      }
    } finally { await server.stop(true); }
  });

  test("capture 422 parity: no-snapshot is ok:true with canonical CaptureResult", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "capture_unavailable", message: "no provider available" }, { status: 422 }) });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.captureSnapshot({ underlyingCanonicalId: A, expiryDate: "2026-03-26" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.snapshot).toBeNull();
        expect(result.value.error).toBe("no provider available");
      }
    } finally { await server.stop(true); }
  });

  test("capture 400 maps to validation and 403 maps to unavailable", async () => {
    let status = 400;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "x", message: "bad request" }, { status }) });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const bad = await services.captureSnapshot({ underlyingCanonicalId: A, expiryDate: "2026-03-26" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.category).toBe("validation");
      status = 403;
      const forbidden = await services.captureSnapshot({ underlyingCanonicalId: A, expiryDate: "2026-03-26" });
      expect(forbidden.ok).toBe(false);
      if (!forbidden.ok) expect(forbidden.error.category).toBe("unavailable");
    } finally { await server.stop(true); }
  });

  test("historical fetch with empty candles and valid reports is ok:true", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] }) });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.fetchHistorical({ canonicalId: A, interval: "1D", fromMs: 1, toMs: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.candles).toEqual([]);
    } finally { await server.stop(true); }
  });

  test("snapshot get 404 maps to unavailable", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "not_found", message: "Snapshot not found" }, { status: 404 }) });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.getSnapshot("missing");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.category).toBe("unavailable");
    } finally { await server.stop(true); }
  });

  test("errors are sanitized with no credential/token leakage", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ message: "Bearer secret-token-123 rejected" }, { status: 403 }) });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.getLiveSnapshot();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).not.toContain("secret-token-123");
        expect(result.error.message).not.toContain("Bearer");
      }
    } finally { await server.stop(true); }
  });
});

/** Fake injected services that record calls, for direct HTTP-adapter verification. */
function fakeDeps() {
  const calls: string[] = [];
  const auth = {
    UPSTOX: { id: "UPSTOX", enabled: true, authState: "AUTHENTICATED", streamingState: "STREAMING", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null },
    FYERS: { id: "FYERS", enabled: true, authState: "NOT_CONFIGURED", streamingState: "NOT_STARTED", validatedAt: null, expiresAt: null, expiryKnown: false, capabilities: [], limits: [], restrictions: [], error: null, lastErrorAt: null }
  };
  const config = { version: "0.1.0" } as never;
  const db = { sqlite: {} } as never;
  const catalog = { searchInstruments: async () => [] } as never;
  const hub = { readAfter: () => ({ outcome: "page", events: [], nextCursor: null, resumeCursor: "r:0" }) } as never;
  const registry = { getStatuses: () => auth } as never;
  const service = {
    getSnapshot: () => { calls.push("getSnapshot"); return { revision: 1, capturedAtMs: 1, items: [], connections: [] }; },
    getConnectionStatus: (id: string) => ({ state: id === "UPSTOX" ? "STREAMING" : "NOT_STARTED" })
  } as never;
  const historicalService = {
    getCached: (req: { canonicalId: string }) => { calls.push(`getCached:${req.canonicalId}`); return []; },
    getCoverageStatus: (req: { canonicalId: string }) => { calls.push(`getCoverage:${req.canonicalId}`); return { gaps: [], unavailableNotes: [] }; },
    fetchOnDemand: async (req: { canonicalId: string }) => { calls.push(`fetchOnDemand:${req.canonicalId}`); return { candles: [], gaps: [], unavailable: [], conflicts: 0, providersTried: [] }; }
  } as never;
  const snapshotService = {
    listSnapshots: (configId?: string) => { calls.push(`listSnapshots:${configId ?? ""}`); return []; },
    listSnapshotsPage: (req: { selector: { kind: string; configId?: string }; limit: number; cursor?: string }) => {
      const id = req.selector.kind === "config" ? req.selector.configId : "-";
      calls.push(`page:${req.selector.kind}:${id}:${req.cursor ?? "first"}`);
      return { ok: true, snapshots: [], nextCursor: null };
    },
    getSnapshot: (id: string) => { calls.push(`getSnapshot:${id}`); return id === "missing" ? null : { id, configId: null, capturedAt: "2026-01-01T00:00:00.000Z", provider: "UPSTOX", envelope: { strikes: [] }, provenance: {} }; },
    captureOnDemand: async (req: { underlyingCanonicalId: string }) => { calls.push(`captureOnDemand:${req.underlyingCanonicalId}`); return { snapshot: null, error: "no provider available" }; }
  } as never;
  return { services: createHttpMcpServices(config, db, catalog, hub, registry, service, historicalService, snapshotService), calls, auth };
}

describe("M6-B2 HTTP adapter (direct factory)", () => {
  test("B2 methods call the injected service instances", async () => {
    const { services, calls } = fakeDeps();
    await services.getLiveSnapshot();
    await services.getCachedCandles({ canonicalId: A, interval: "1D", fromMs: 1, toMs: 2 });
    await services.getCoverage({ canonicalId: A, interval: "1D", fromMs: 1, toMs: 2 });
    await services.fetchHistorical({ canonicalId: A, interval: "1D", fromMs: 1, toMs: 2 });
    await services.listSnapshots({ configId: "cfg" });
    await services.getSnapshot("snap-1");
    await services.captureSnapshot({ underlyingCanonicalId: A, expiryDate: "2026-03-26" });
    expect(calls).toContain("getSnapshot");
    expect(calls).toContain(`getCached:${A}`);
    expect(calls).toContain(`getCoverage:${A}`);
    expect(calls).toContain(`fetchOnDemand:${A}`);
    expect(calls).toContain("listSnapshots:cfg");
    expect(calls).toContain("getSnapshot:snap-1");
    expect(calls).toContain(`captureOnDemand:${A}`);
  });

  test("captureSnapshot returns ok:true with null snapshot (service boundary)", async () => {
    const { services } = fakeDeps();
    const result = await services.captureSnapshot({ underlyingCanonicalId: A, expiryDate: "2026-03-26" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.snapshot).toBeNull();
      expect(result.value.error).toBe("no provider available");
    }
  });

  test("getProviderStatus maps composed status with runtime streaming for both providers", async () => {
    const { services } = fakeDeps();
    const result = await services.getProviderStatus();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.UPSTOX.streamingState).toBe("STREAMING");
      expect(result.value.FYERS.streamingState).toBe("NOT_STARTED");
      expect(result.value.UPSTOX.authState).toBe("AUTHENTICATED");
    }
  });

  test("getSnapshot missing maps to unavailable", async () => {
    const { services } = fakeDeps();
    const result = await services.getSnapshot("missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.category).toBe("unavailable");
  });

  test("HTTP adapter shares the same instances as REST via AppDependencies overrides", async () => {
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "markethub-b2-share-"));
    const dbPath = join(dir, "test.sqlite");
    const config = loadConfig({ env: { MARKETHUB_ENV: "test", MARKETHUB_DB_PATH: dbPath, MARKETHUB_LAN: "false" } });
    const db = openDatabase({ dbPath });
    runMigrations(db.db, defaultMigrationsFolder);
    try {
      const { AppSettings, CandleRepository, SnapshotRepository } = await import("../../packages/database/src/index");
      const { HistoricalCandleService, OptionChainSnapshotService } = await import("../../packages/market-core/src/index");
      const appSettings = new AppSettings(db.db);
      const candleRepo = new CandleRepository(db.db, db.sqlite);
      const snapshotRepo = new SnapshotRepository(db.db, db.sqlite);
      const historicalService = new HistoricalCandleService({ candles: candleRepo, settings: appSettings, providers: [] });
      const snapshotService = new OptionChainSnapshotService({ snapshots: snapshotRepo, settings: appSettings, providers: [] });
      const app = createApp({
        config, db, logger: createLogger("error"), startedAt: Date.now(),
        appSettings, candleRepo, snapshotRepo, historicalService, snapshotService
      });
      // The REST historical route reads from the same injected service instance.
      const res = await app.request("/api/historical/candles?canonicalId=A&interval=1D&from=1&to=2");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Array.isArray(json.candles)).toBe(true);
      // The MCP adapter built from the same instance returns the same empty result.
      const mcp = createHttpMcpServices(config, db, {} as never, {} as never, {} as never, {} as never, historicalService, snapshotService);
      const mcpResult = await mcp.getCachedCandles({ canonicalId: A, interval: "1D", fromMs: 1, toMs: 2 });
      expect(mcpResult.ok).toBe(true);
      if (mcpResult.ok) expect(mcpResult.value.candles).toEqual(json.candles);
    } finally {
      closeDatabaseHandle(db);
      removeTempDir(dir);
    }
  });

  test("listSnapshotsPage forwards the discriminated selector and opaque cursor unchanged", async () => {
    const { services, calls } = fakeDeps();
    const opaque = "v1.eyJjIjoiMjAyNi0wMS0wMVQwMDowMDowMC4wMDBaIiwiaSI6InMxIiwicyI6eyJraW5kIjoibnVsbC1jb25maWcifX0";
    const configResult = await services.listSnapshotsPage({
      selector: { kind: "config", configId: "none" }, limit: 25, cursor: opaque
    });
    expect(configResult.ok).toBe(true);
    expect(calls).toContain(`page:config:none:${opaque}`);

    const nullResult = await services.listSnapshotsPage({
      selector: { kind: "null-config" }, limit: 10
    });
    expect(nullResult.ok).toBe(true);
    expect(calls).toContain("page:null-config:-:first");
  });
});

describe("M6-B3 STDIO adapter (snapshot page)", () => {
  test("forwards scope, configId and opaque cursor unchanged and validates the envelope", async () => {
    const opaque = "v1.abc123";
    let seen = "";
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req) => {
        seen = new URL(req.url).search;
        return Response.json({ snapshots: [], nextCursor: null });
      }
    });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.listSnapshotsPage({
        selector: { kind: "config", configId: "none" }, limit: 25, cursor: opaque
      });
      expect(result.ok).toBe(true);
      expect(seen).toContain("scope=config");
      expect(seen).toContain("configId=none");
      expect(seen).toContain(`cursor=${opaque}`);
      expect(seen).toContain("limit=25");
    } finally { await server.stop(true); }
  });

  test("null-config scope omits configId; 404 maps to unknown_config and 400 to validation", async () => {
    let status = 200;
    let seen = "";
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (req) => {
        seen = new URL(req.url).search;
        if (status === 404) return Response.json({ error: "not_found", message: "Unknown capture configuration" }, { status: 404 });
        if (status === 400) return Response.json({ error: "invalid_request", message: "bad cursor" }, { status: 400 });
        return Response.json({ snapshots: [], nextCursor: null });
      }
    });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const ok = await services.listSnapshotsPage({ selector: { kind: "null-config" }, limit: 25 });
      expect(ok.ok).toBe(true);
      expect(seen).toContain("scope=null-config");
      expect(seen).not.toContain("configId");

      status = 404;
      const missing = await services.listSnapshotsPage({ selector: { kind: "config", configId: "x" }, limit: 25 });
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.error.category).toBe("unavailable");
        expect(missing.error.reason).toBe("unknown_config");
      }

      status = 400;
      const bad = await services.listSnapshotsPage({ selector: { kind: "config", configId: "x" }, limit: 25, cursor: "bad" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.category).toBe("validation");
    } finally { await server.stop(true); }
  });

  test("malformed page envelope is rejected, never ok:true", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ snapshots: "not-an-array", nextCursor: null }) });
    try {
      const services = createStdioServices(`http://127.0.0.1:${server.port}`);
      const result = await services.listSnapshotsPage({ selector: { kind: "null-config" }, limit: 25 });
      expect(result.ok).toBe(false);
    } finally { await server.stop(true); }
  });
});
