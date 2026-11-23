import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OptionChainCaptureConfig, OptionChainSnapshotEnvelope, ProviderId } from "../../packages/contracts/src/index";
import { AppSettings, SnapshotRepository, openDatabase } from "../../packages/database/src/index";
import { OptionChainSnapshotService, type OptionChainProvider, type OptionChainRequest } from "../../packages/market-core/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const UNDERLYING = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";

function envelope(overrides: Partial<OptionChainSnapshotEnvelope> = {}): OptionChainSnapshotEnvelope {
  return {
    underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29",
    capturedAt: "2026-01-01T00:00:00.000Z", observationTimestamp: null, underlyingLtp: 25000,
    strikes: [
      { strike: 25000, optionType: "CE", ltp: 100, oi: 0, greeks: { delta: 0.5, gamma: null, theta: -1, vega: 2, iv: 18 } },
      { strike: 25000, optionType: "PE", ltp: 0, volume: 0 }
    ],
    providerExtensions: { fyToken: "123", oich: -5 },
    ...overrides
  };
}

class FakeOptionProvider implements OptionChainProvider {
  calls: OptionChainRequest[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly value: OptionChainSnapshotEnvelope = envelope(),
    private readonly trace?: string[]
  ) {}
  async fetchOptionChain(request: OptionChainRequest): Promise<OptionChainSnapshotEnvelope> {
    this.calls.push(request);
    this.trace?.push(this.id);
    return this.value;
  }
}

/** Deterministic failing provider — no vendor API, no credentials. */
class FailingOptionProvider implements OptionChainProvider {
  calls: OptionChainRequest[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly message = "provider down",
    private readonly trace?: string[]
  ) {}
  async fetchOptionChain(request: OptionChainRequest): Promise<OptionChainSnapshotEnvelope> {
    this.calls.push(request);
    this.trace?.push(this.id);
    throw new Error(this.message);
  }
}

function harness(providers: OptionChainProvider[]) {
  const dir = mkdtempSync(join(tmpdir(), "mh-snapshots-"));
  const handle = openDatabase({ dbPath: join(dir, "s.sqlite"), migrate: true });
  const snapshots = new SnapshotRepository(handle.db, handle.sqlite);
  const settings = new AppSettings(handle.db);
  const service = new OptionChainSnapshotService({ snapshots, settings, providers, now: () => Date.parse("2026-01-01T00:00:00.000Z") });
  return { dir, handle, snapshots, settings, service };
}

function config(overrides: Partial<OptionChainCaptureConfig> = {}): OptionChainCaptureConfig {
  return {
    id: "cfg-1", underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29",
    strikeRangeJson: null, captureEnabled: true, captureMode: "MANUAL", scheduleJson: null,
    streamingEnabled: false, provider: "FYERS",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("OptionChainSnapshotService", () => {
  test("field semantics: null preserved, zero preserved, observation timestamp never defaulted", async () => {
    const p = new FakeOptionProvider("FYERS");
    const h = harness([p]);
    try {
      const result = await h.service.captureOnDemand({ underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29" });
      expect(result.error).toBeNull();
      const e = result.snapshot!.envelope;
      expect(e.observationTimestamp).toBeNull();
      expect(e.capturedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(e.strikes[0]!.greeks!.gamma).toBeNull();
      expect(e.strikes[0]!.oi).toBe(0);
      expect(e.strikes[1]!.ltp).toBe(0);
      expect(e.providerExtensions.fyToken).toBe("123");
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("on-demand capture never reads or mutates capture config", async () => {
    const p = new FakeOptionProvider("FYERS");
    const h = harness([p]);
    try {
      await h.service.captureOnDemand({ underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29" });
      const rows = h.handle.sqlite.query("SELECT COUNT(*) AS n FROM option_chain_capture_configs").get() as { n: number };
      expect(rows.n).toBe(0);
      expect(h.service.listSnapshots()[0]!.configId).toBeNull();
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("scheduled capture uses saved config; deleting config preserves snapshots", async () => {
    const p = new FakeOptionProvider("FYERS");
    const h = harness([p]);
    try {
      h.service.putCaptureConfig(config());
      const result = await h.service.captureScheduled(config());
      expect(result.snapshot?.configId).toBe("cfg-1");
      h.service.deleteCaptureConfig("cfg-1");
      expect(h.service.getCaptureConfig("cfg-1")).toBeNull();
      expect(h.service.getSnapshot(result.snapshot!.id)?.configId).toBeNull();
      expect(h.service.getSnapshot(result.snapshot!.id)?.envelope.strikes[0]!.greeks!.gamma).toBeNull();
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("disabled capture config does not capture", async () => {
    const p = new FakeOptionProvider("FYERS");
    const h = harness([p]);
    try {
      const result = await h.service.captureScheduled(config({ captureEnabled: false }));
      expect(result.snapshot).toBeNull();
      expect(p.calls.length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  // --- WP6B: explicit provider exclusivity and omitted-provider order ---

  test("explicit UPSTOX success calls UPSTOX and not FYERS", async () => {
    const upstox = new FakeOptionProvider("UPSTOX");
    const fyers = new FakeOptionProvider("FYERS");
    const h = harness([upstox, fyers]);
    try {
      const result = await h.service.captureOnDemand({
        underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29", provider: "UPSTOX"
      });
      expect(result.error).toBeNull();
      expect(result.snapshot?.provider).toBe("UPSTOX");
      expect(upstox.calls.length).toBe(1);
      expect(fyers.calls.length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("explicit FYERS success calls FYERS and not UPSTOX", async () => {
    const upstox = new FakeOptionProvider("UPSTOX");
    const fyers = new FakeOptionProvider("FYERS");
    const h = harness([upstox, fyers]);
    try {
      const result = await h.service.captureOnDemand({
        underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29", provider: "FYERS"
      });
      expect(result.error).toBeNull();
      expect(result.snapshot?.provider).toBe("FYERS");
      expect(fyers.calls.length).toBe(1);
      expect(upstox.calls.length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("explicit provider failure returns an error and does not call the other provider", async () => {
    const upstox = new FailingOptionProvider("UPSTOX", "upstox failed");
    const fyers = new FakeOptionProvider("FYERS");
    const h = harness([upstox, fyers]);
    try {
      const result = await h.service.captureOnDemand({
        underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29", provider: "UPSTOX"
      });
      expect(result.snapshot).toBeNull();
      expect(result.error).toContain("upstox failed");
      expect(upstox.calls.length).toBe(1);
      expect(fyers.calls.length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("omitted provider tries injected providers in their existing order", async () => {
    const trace: string[] = [];
    const upstox = new FailingOptionProvider("UPSTOX", "up down", trace);
    const fyers = new FakeOptionProvider("FYERS", envelope(), trace);
    const h = harness([upstox, fyers]);
    try {
      const result = await h.service.captureOnDemand({ underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29" });
      expect(result.error).toBeNull();
      expect(trace).toEqual(["UPSTOX", "FYERS"]);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }

    // Reversed injection order must be honoured — no fixed provider preference.
    const reverseTrace: string[] = [];
    const fyersFirst = new FailingOptionProvider("FYERS", "fy down", reverseTrace);
    const upstoxSecond = new FakeOptionProvider("UPSTOX", envelope(), reverseTrace);
    const h2 = harness([fyersFirst, upstoxSecond]);
    try {
      const result = await h2.service.captureOnDemand({ underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29" });
      expect(result.error).toBeNull();
      expect(reverseTrace).toEqual(["FYERS", "UPSTOX"]);
    } finally { closeDatabaseHandle(h2.handle); removeTempDir(h2.dir); }
  });

  test("first provider fails, next succeeds: snapshot identifies the successful provider", async () => {
    const upstox = new FailingOptionProvider("UPSTOX", "up down");
    const fyers = new FakeOptionProvider("FYERS");
    const h = harness([upstox, fyers]);
    try {
      const result = await h.service.captureOnDemand({ underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29" });
      expect(result.error).toBeNull();
      expect(result.snapshot?.provider).toBe("FYERS");
      expect(result.snapshot?.provenance.provider).toBe("FYERS");
      expect(upstox.calls.length).toBe(1);
      expect(fyers.calls.length).toBe(1);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("all omitted-provider attempts fail: unavailable error, no invented data", async () => {
    const upstox = new FailingOptionProvider("UPSTOX", "up down");
    const fyers = new FailingOptionProvider("FYERS", "fy down");
    const h = harness([upstox, fyers]);
    try {
      const result = await h.service.captureOnDemand({ underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29" });
      expect(result.snapshot).toBeNull();
      expect(result.error).toBeTruthy();
      expect(result.error).toContain("fy down"); // last sanitized error
      expect(upstox.calls.length).toBe(1);
      expect(fyers.calls.length).toBe(1);
      expect(h.service.listSnapshots().length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("explicit provider not in configured list does not invoke a different provider", async () => {
    const fyers = new FakeOptionProvider("FYERS");
    const h = harness([fyers]); // only FYERS configured
    try {
      const result = await h.service.captureOnDemand({
        underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29", provider: "UPSTOX"
      });
      expect(result.snapshot).toBeNull();
      expect(result.error).toBe("no provider available");
      expect(fyers.calls.length).toBe(0);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("scheduled capture uses the config provider and stays explicit", async () => {
    const upstox = new FakeOptionProvider("UPSTOX");
    const fyers = new FakeOptionProvider("FYERS");
    const h = harness([upstox, fyers]);
    try {
      const saved = config({ provider: "UPSTOX" });
      h.service.putCaptureConfig(saved);
      const result = await h.service.captureScheduled(saved);
      expect(result.error).toBeNull();
      expect(result.snapshot?.provider).toBe("UPSTOX");
      expect(upstox.calls.length).toBe(1);
      expect(fyers.calls.length).toBe(0);
      expect(upstox.calls[0]!.provider).toBe("UPSTOX"); // request carries the explicit provider
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("on-demand capture does not read or modify saved configs", async () => {
    const upstox = new FakeOptionProvider("UPSTOX");
    const h = harness([upstox]);
    try {
      const saved = config({ provider: "FYERS" });
      h.service.putCaptureConfig(saved);
      const result = await h.service.captureOnDemand({
        underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29", provider: "UPSTOX"
      });
      expect(result.snapshot?.configId).toBeNull();
      expect(result.snapshot?.provider).toBe("UPSTOX");
      expect(upstox.calls[0]!.provider).toBe("UPSTOX"); // request provider, not saved config's FYERS
      expect(h.service.getCaptureConfig("cfg-1")).toEqual(saved); // unchanged
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });
});
