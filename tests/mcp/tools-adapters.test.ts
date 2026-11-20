import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
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
