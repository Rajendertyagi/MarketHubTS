import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OptionChainCaptureConfig, OptionChainSnapshot, OptionChainSnapshotEnvelope } from "../../packages/contracts/src/index";
import { AppSettings, SnapshotRepository, openDatabase } from "../../packages/database/src/index";
import {
  OptionChainSnapshotService, decodeSnapshotCursor, encodeSnapshotCursor,
  type SnapshotPageSelector
} from "../../packages/market-core/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const UNDERLYING = "v1|NSE|INDEX|INDEX|CODE:NIFTY50";

function envelope(capturedAt: string): OptionChainSnapshotEnvelope {
  return {
    underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29",
    capturedAt, observationTimestamp: null, underlyingLtp: 25000,
    strikes: [{ strike: 25000, optionType: "CE", ltp: 100, oi: 0 }],
    providerExtensions: {},
  } as OptionChainSnapshotEnvelope;
}

function snap(id: string, configId: string | null, capturedAt: string): OptionChainSnapshot {
  return {
    id, configId, capturedAt, provider: "UPSTOX",
    envelope: envelope(capturedAt),
    provenance: { source: "provider-feed", provider: "UPSTOX", receivedAt: capturedAt }
  };
}

function config(id: string): OptionChainCaptureConfig {
  return {
    id, underlyingCanonicalId: UNDERLYING, expiryDate: "2026-01-29",
    strikeRangeJson: null, captureEnabled: true, captureMode: "MANUAL", scheduleJson: null,
    streamingEnabled: false, provider: "UPSTOX",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "mh-b3-page-"));
  const handle = openDatabase({ dbPath: join(dir, "s.sqlite"), migrate: true });
  const snapshots = new SnapshotRepository(handle.db, handle.sqlite);
  const settings = new AppSettings(handle.db);
  const service = new OptionChainSnapshotService({ snapshots, settings, providers: [] });
  return { dir, handle, snapshots, service };
}

const configNone: SnapshotPageSelector = { kind: "config", configId: "none" };
const nullConfig: SnapshotPageSelector = { kind: "null-config" };

describe("M6-B3 snapshot page selector and cursor", () => {
  test("versioned opaque cursor round-trips and binds the full selector", () => {
    const cursor = encodeSnapshotCursor({ c: "2026-01-02T00:00:00.000Z", i: "s1", s: configNone });
    expect(cursor.startsWith("v1.")).toBe(true);
    expect(decodeSnapshotCursor(cursor, configNone)).toEqual({
      capturedAt: "2026-01-02T00:00:00.000Z", id: "s1"
    });
    // A different real config id and the null-config selector must both reject it.
    expect(decodeSnapshotCursor(cursor, { kind: "config", configId: "other" })).toBeNull();
    expect(decodeSnapshotCursor(cursor, nullConfig)).toBeNull();
    // Malformed / wrong-version / empty cursors are rejected.
    expect(decodeSnapshotCursor("garbage", configNone)).toBeNull();
    expect(decodeSnapshotCursor("v2.abc", configNone)).toBeNull();
    expect(decodeSnapshotCursor("v1.", configNone)).toBeNull();
  });

  test("a structurally valid cursor with a malformed timestamp is rejected", () => {
    const badPayload = JSON.stringify({
      c: "not-a-date", i: "s1", s: { kind: "null-config" }
    });
    const badCursor = "v1." + Buffer.from(badPayload, "utf8").toString("base64url");
    expect(decodeSnapshotCursor(badCursor, nullConfig)).toBeNull();

    const h = harness();
    try {
      const result = h.service.listSnapshotsPage({ selector: nullConfig, limit: 25, cursor: badCursor });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_cursor");
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test('a real configuration whose id is exactly "none" is addressable', () => {
    const h = harness();
    try {
      h.service.putCaptureConfig(config("none"));
      h.snapshots.putSnapshot(snap("s-none", "none", "2026-01-02T00:00:00.000Z"));
      const page = h.service.listSnapshotsPage({ selector: configNone, limit: 25 });
      expect(page.ok).toBe(true);
      if (page.ok) {
        expect(page.snapshots.map((s) => s.id)).toEqual(["s-none"]);
        expect(page.nextCursor).toBeNull();
      }
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("other arbitrary non-empty config ids work", () => {
    const h = harness();
    try {
      h.service.putCaptureConfig(config("cfg/with space"));
      h.snapshots.putSnapshot(snap("s-cfg", "cfg/with space", "2026-01-02T00:00:00.000Z"));
      const page = h.service.listSnapshotsPage({ selector: { kind: "config", configId: "cfg/with space" }, limit: 25 });
      expect(page.ok).toBe(true);
      if (page.ok) expect(page.snapshots.map((s) => s.id)).toEqual(["s-cfg"]);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("unknown config is genuine not-found; valid config with zero snapshots is an empty page", () => {
    const h = harness();
    try {
      const missing = h.service.listSnapshotsPage({ selector: { kind: "config", configId: "missing" }, limit: 25 });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.reason).toBe("unknown_config");

      h.service.putCaptureConfig(config("empty"));
      const empty = h.service.listSnapshotsPage({ selector: { kind: "config", configId: "empty" }, limit: 25 });
      expect(empty.ok).toBe(true);
      if (empty.ok) {
        expect(empty.snapshots).toEqual([]);
        expect(empty.nextCursor).toBeNull();
      }
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("null-config selector returns both on-demand and config-deleted snapshots", () => {
    const h = harness();
    try {
      h.snapshots.putSnapshot(snap("od", null, "2026-01-01T00:00:00.000Z"));
      h.service.putCaptureConfig(config("cfg"));
      h.snapshots.putSnapshot(snap("cfg1", "cfg", "2026-01-02T00:00:00.000Z"));
      h.service.deleteCaptureConfig("cfg"); // snapshots retained, config_id -> NULL
      expect(h.service.getSnapshot("cfg1")?.configId).toBeNull();

      const page = h.service.listSnapshotsPage({ selector: nullConfig, limit: 25 });
      expect(page.ok).toBe(true);
      if (page.ok) expect(page.snapshots.map((s) => s.id).sort()).toEqual(["cfg1", "od"]);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("newest-first ordering, id tie-break, lookahead and final page", () => {
    const h = harness();
    try {
      h.service.putCaptureConfig(config("cfg"));
      const t = "2026-01-02T00:00:00.000Z";
      h.snapshots.putSnapshot(snap("a", "cfg", t));
      h.snapshots.putSnapshot(snap("b", "cfg", t));
      h.snapshots.putSnapshot(snap("c", "cfg", "2026-01-01T00:00:00.000Z"));

      const p1 = h.service.listSnapshotsPage({ selector: { kind: "config", configId: "cfg" }, limit: 2 });
      expect(p1.ok).toBe(true);
      if (!p1.ok) return;
      expect(p1.snapshots.map((s) => s.id)).toEqual(["b", "a"]); // id DESC tie-break
      expect(p1.nextCursor).not.toBeNull();

      const p2 = h.service.listSnapshotsPage({
        selector: { kind: "config", configId: "cfg" }, limit: 2, cursor: p1.nextCursor!
      });
      expect(p2.ok).toBe(true);
      if (p2.ok) {
        expect(p2.snapshots.map((s) => s.id)).toEqual(["c"]);
        expect(p2.nextCursor).toBeNull(); // final page
      }
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("deleting the anchor row between requests still yields the correct next page", () => {
    const h = harness();
    try {
      h.service.putCaptureConfig(config("cfg"));
      h.snapshots.putSnapshot(snap("a", "cfg", "2026-01-03T00:00:00.000Z"));
      h.snapshots.putSnapshot(snap("b", "cfg", "2026-01-02T00:00:00.000Z"));
      h.snapshots.putSnapshot(snap("c", "cfg", "2026-01-01T00:00:00.000Z"));

      const p1 = h.service.listSnapshotsPage({ selector: { kind: "config", configId: "cfg" }, limit: 1 });
      if (!p1.ok) throw new Error("first page failed");
      expect(p1.snapshots[0]!.id).toBe("a");
      // Delete the anchor row (the last returned row) before requesting page 2.
      h.handle.sqlite.run("DELETE FROM option_chain_snapshots WHERE id = ?", ["a"]);
      const p2 = h.service.listSnapshotsPage({
        selector: { kind: "config", configId: "cfg" }, limit: 1, cursor: p1.nextCursor!
      });
      expect(p2.ok).toBe(true);
      if (p2.ok) expect(p2.snapshots.map((s) => s.id)).toEqual(["b"]);
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("config deletion between requests prevents cross-selector cursor reuse", () => {
    const h = harness();
    try {
      h.service.putCaptureConfig(config("cfg"));
      h.snapshots.putSnapshot(snap("a", "cfg", "2026-01-03T00:00:00.000Z"));
      h.snapshots.putSnapshot(snap("b", "cfg", "2026-01-02T00:00:00.000Z"));
      const p1 = h.service.listSnapshotsPage({ selector: { kind: "config", configId: "cfg" }, limit: 1 });
      if (!p1.ok) throw new Error("first page failed");
      const cursor = p1.nextCursor!;

      h.service.deleteCaptureConfig("cfg"); // snapshots move to null-config
      const reused = h.service.listSnapshotsPage({ selector: nullConfig, limit: 1, cursor });
      expect(reused.ok).toBe(false);
      if (!reused.ok) expect(reused.reason).toBe("invalid_cursor");
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });

  test("malformed cursor is rejected, never an empty success", () => {
    const h = harness();
    try {
      h.service.putCaptureConfig(config("cfg"));
      const result = h.service.listSnapshotsPage({
        selector: { kind: "config", configId: "cfg" }, limit: 25, cursor: "not-a-cursor"
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_cursor");
    } finally { closeDatabaseHandle(h.handle); removeTempDir(h.dir); }
  });
});
