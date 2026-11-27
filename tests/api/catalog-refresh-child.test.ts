/**
 * G0-A — child-process foundation tests (Windows, real Bun.spawn + IPC).
 *
 * These tests exercise the real parent/child boundary: a real `Bun.spawn` with
 * `process.execPath` + `windowsHide`, a real IPC round-trip, two independent
 * SQLite connections to the SAME file, and real exit observation. No refresh
 * pipeline, write coordinator or live provider is involved (G0-B/C/D/E).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultMigrationsFolder,
  openDatabase,
  resolveDatabasePath,
  runMigrations
} from "../../packages/database/src/index";
import {
  CatalogRefreshChildManager,
  verifyReady,
  type ManagerEvent,
  type RefreshRequest
} from "../../apps/api/src/catalog-refresh-child-manager";
import {
  MAX_IPC_MESSAGE_BYTES,
  ipcMessageByteLength,
  isIpcMessageWithinLimit,
  parseChildMessage,
  parseParentMessage,
  type ReadyMessage
} from "../../apps/api/src/catalog-refresh-ipc";
import { closeDatabaseHandle, removeTempDirAsync } from "../helpers/fs-cleanup";

const API_SRC = resolve(import.meta.dir, "../../apps/api/src");
const CHILD_ENTRY = resolve(API_SRC, "catalog-refresh-child.ts");
const MANAGER_SOURCE = resolve(API_SRC, "catalog-refresh-child-manager.ts");
const CHILD_SOURCE = CHILD_ENTRY;

function request(runId: string, provider: "UPSTOX" | "FYERS" = "UPSTOX"): RefreshRequest {
  return { runId, provider, nowIso: new Date().toISOString(), intentKey: "g0-a-test", generation: 1 };
}

/**
 * Test-only child entry: completes the real handshake, but deliberately
 * ignores `shutdown` for `stuck-run` so the parent must hit its exit timeout
 * and escalate to a kill. Uses only built-ins; no DB file is opened by it.
 */
const UNRESPONSIVE_CHILD_SOURCE = `
const dbPath = process.argv[2] ?? "";
const keepAlive = setInterval(() => {}, 1 << 30);
process.on("message", (raw) => {
  const type = raw && raw.type;
  const runId = raw && raw.runId;
  if (type === "refresh") {
    process.send({ type: "ready", runId, pid: process.pid, dbPath,
      journalMode: "wal", sqliteVersion: process.versions.sqlite });
    return;
  }
  if (type === "ping") {
    process.send({ type: "pong", runId });
    return;
  }
  if (type === "shutdown") {
    if (runId === "stuck-run") return; // unresponsive: never exits on shutdown
    clearInterval(keepAlive);
    process.exit(0);
  }
});
`;

function makeDb(dir: string, name: string, migrate: boolean) {
  const dbPath = join(dir, name);
  const handle = openDatabase({ dbPath });
  if (migrate) runMigrations(handle.db, defaultMigrationsFolder);
  return { dbPath, handle };
}

describe("G0-A — child-process foundation", () => {
  test("verified runtime baseline: Bun 1.4.5, SQLite 3.54.1, bun execPath", () => {
    expect(Bun.version).toBe("1.4.5");
    expect(process.versions.sqlite).toBe("3.54.1");
    expect(process.execPath.toLowerCase()).toContain("bun");
  });

  test("spawn contract uses process.execPath, windowsHide and advanced IPC", () => {
    const source = readFileSync(MANAGER_SOURCE, "utf8");
    expect(source).toContain("process.execPath");
    expect(source).toContain("windowsHide: true");
    expect(source).toContain('serialization: "advanced"');
    expect(source).toContain("ipc:");
    expect(source).toContain("onExit:");
  });

  test("real Windows spawn/IPC round-trip, same DB file, WAL, clean exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0a-roundtrip-"));
    const { dbPath, handle: parent } = makeDb(dir, "test.sqlite", true);
    const manager = new CatalogRefreshChildManager({ dbPath });
    try {
      const result = await manager.requestRefresh(request("run-1"));

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.ready).toBeDefined();
      expect(result.ready!.pid).toBeGreaterThan(0);
      expect(resolveDatabasePath(result.ready!.dbPath)).toBe(resolveDatabasePath(dbPath));
      expect(result.ready!.journalMode.toLowerCase()).toBe("wal");
      expect(result.ready!.sqliteVersion).toBe("3.54.1");
      expect(result.exit.code).toBe(0);
      expect(result.exit.signal).toBeNull();
      expect(result.protocolErrors).toEqual([]);
      expect(manager.activeSubprocess).toBeNull();
      expect(manager.activeRunId).toBeNull();
      expect(manager.maxObservedMessageBytes).toBeLessThanOrEqual(MAX_IPC_MESSAGE_BYTES);
      // WAL uses -wal/-shm; a rollback-journal -journal file must never appear.
      expect(existsSync(`${dbPath}-journal`)).toBe(false);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("IPC validation rejects malformed, unknown and oversized messages", () => {
    const validReady = {
      type: "ready", runId: "r", pid: 123, dbPath: "C:/x.sqlite",
      journalMode: "wal", sqliteVersion: "3.54.1"
    };
    expect(parseChildMessage(validReady).ok).toBe(true);
    expect(parseChildMessage({ type: "ready", runId: "r" }).ok).toBe(false);
    expect(parseChildMessage({ type: "bogus", runId: "r" }).ok).toBe(false);
    expect(parseChildMessage(null).ok).toBe(false);
    expect(parseChildMessage({ ...validReady, pid: -1 }).ok).toBe(false);
    expect(parseChildMessage({ ...validReady, journalMode: "x".repeat(100) }).ok).toBe(false);

    expect(parseParentMessage({
      type: "refresh", runId: "r", provider: "UPSTOX", dbPath: "x",
      nowIso: "2026-11-27T00:00:00.000Z", intentKey: "k", generation: 0
    }).ok).toBe(true);
    expect(parseParentMessage({
      type: "refresh", runId: "r", provider: "NSE", dbPath: "x",
      nowIso: "2026-11-27T00:00:00.000Z", intentKey: "k", generation: 0
    }).ok).toBe(false);
    expect(parseParentMessage({ type: "unknown", runId: "r" }).ok).toBe(false);

    const huge = { type: "pong", runId: "r", padding: "x".repeat(20_000) };
    expect(isIpcMessageWithinLimit(huge)).toBe(false);
    expect(ipcMessageByteLength(huge)).toBeGreaterThan(MAX_IPC_MESSAGE_BYTES);
    expect(MAX_IPC_MESSAGE_BYTES).toBeLessThanOrEqual(8192);
    expect(ipcMessageByteLength(validReady)).toBeLessThan(MAX_IPC_MESSAGE_BYTES);
  });

  test("verifyReady rejects path, journal-mode and SQLite-version mismatches", () => {
    const ready: ReadyMessage = {
      type: "ready", runId: "r", pid: 123, dbPath: "C:/child.sqlite",
      journalMode: "wal", sqliteVersion: "3.54.1"
    };
    const expected = { dbPath: "C:/parent.sqlite", journalMode: "wal", sqliteVersion: "3.54.1" };
    expect(verifyReady(ready, expected).ok).toBe(false);
    expect(verifyReady(ready, { ...expected, dbPath: ready.dbPath }).ok).toBe(true);
    expect(verifyReady(ready, { ...expected, dbPath: ready.dbPath, journalMode: "delete" }).ok).toBe(false);
    expect(verifyReady(ready, { ...expected, dbPath: ready.dbPath, sqliteVersion: "3.0.0" }).ok).toBe(false);
    expect(verifyReady({ ...ready, pid: 0 }, { ...expected, dbPath: ready.dbPath }).ok).toBe(false);
  });

  test("unexpected kill surfaces exit code/signal through onExit and exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0a-kill-"));
    const { dbPath, handle: parent } = makeDb(dir, "kill.sqlite", true);
    const events: ManagerEvent[] = [];
    let victim: ReturnType<typeof Bun.spawn> | null = null;
    let manager!: CatalogRefreshChildManager;
    manager = new CatalogRefreshChildManager({
      dbPath,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "spawn") victim = manager.activeSubprocess;
        if (event.type === "ready" && victim) victim.kill("SIGTERM");
      }
    });
    try {
      const result = await manager.requestRefresh(request("run-kill"));
      expect(result.ok).toBe(false);
      expect(result.exit.signal).toBe("SIGTERM");
      expect(result.exit.code).toBeNull();
      const exitEvents = events.filter((event) => event.type === "exit");
      expect(exitEvents.length).toBe(1);
      expect(exitEvents[0]!.type === "exit" && exitEvents[0]!.exit.signal).toBe("SIGTERM");
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("raw Bun.spawn onExit and exited both report SIGTERM on kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0a-rawkill-"));
    const { dbPath, handle: parent } = makeDb(dir, "raw.sqlite", true);
    const observed: Array<{ code: number | null; signal: unknown }> = [];
    const proc = Bun.spawn([process.execPath, CHILD_ENTRY, resolveDatabasePath(dbPath)], {
      cwd: resolve(API_SRC, "../.."),
      windowsHide: true,
      serialization: "advanced",
      stdout: "ignore",
      stderr: "ignore",
      onExit: (_child, code, signal) => { observed.push({ code, signal }); }
    });
    try {
      await Bun.sleep(150);
      proc.kill("SIGTERM");
      const code = await proc.exited;
      await Bun.sleep(50);
      expect(code).toBe(143);
      expect(proc.signalCode).toBe("SIGTERM");
      expect(observed.some((entry) => entry.signal === "SIGTERM")).toBe(true);
    } finally {
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("two refresh requests spawn sequentially, never two concurrent children", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0a-serial-"));
    const { dbPath, handle: parent } = makeDb(dir, "serial.sqlite", true);
    const events: ManagerEvent[] = [];
    const manager = new CatalogRefreshChildManager({ dbPath, onEvent: (event) => events.push(event) });
    try {
      const [first, second] = await Promise.all([
        manager.requestRefresh(request("run-A", "UPSTOX")),
        manager.requestRefresh(request("run-B", "FYERS"))
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(first.provider).toBe("UPSTOX");
      expect(second.provider).toBe("FYERS");

      const spawnIndexes = events.flatMap((event, index) => event.type === "spawn" ? [index] : []);
      const exitIndexes = events.flatMap((event, index) => event.type === "exit" ? [index] : []);
      expect(spawnIndexes.length).toBe(2);
      expect(exitIndexes.length).toBe(2);
      // The second spawn must occur only after the first child has exited.
      expect(spawnIndexes[1]!).toBeGreaterThan(exitIndexes[0]!);
      expect(manager.activeSubprocess).toBeNull();
      expect(manager.queuedCount).toBe(0);
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("child opens the same file without migrations and creates no -journal DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0a-nomigrate-"));
    const { dbPath, handle: parent } = makeDb(dir, "fresh.sqlite", false);
    const manager = new CatalogRefreshChildManager({ dbPath });
    try {
      const result = await manager.requestRefresh(request("run-fresh"));
      expect(result.ok).toBe(true);

      const tables = parent.sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(0);
      expect(existsSync(`${dbPath}-journal`)).toBe(false);

      const childSource = readFileSync(CHILD_SOURCE, "utf8");
      expect(childSource).not.toContain("runMigrations");
      expect(childSource).toContain("migrate: false");
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });

  test("exit timeout is a failure: no false success and no next spawn before kill/exit is observed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "g0a-exittimeout-"));
    const { dbPath, handle: parent } = makeDb(dir, "timeout.sqlite", true);
    const childEntryPath = join(dir, "unresponsive-child.ts");
    writeFileSync(childEntryPath, UNRESPONSIVE_CHILD_SOURCE, "utf8");
    const events: ManagerEvent[] = [];
    const manager = new CatalogRefreshChildManager({
      dbPath,
      childEntryPath,
      cwd: resolve(API_SRC, "../.."),
      messageTimeoutMs: 2_000,
      exitTimeoutMs: 150,
      onEvent: (event) => events.push(event)
    });
    try {
      const [stuck, normal] = await Promise.all([
        manager.requestRefresh(request("stuck-run")),
        manager.requestRefresh(request("normal-run", "FYERS"))
      ]);

      // The handshake succeeded, but the child ignored shutdown: this must be
      // a failure, never a false success.
      expect(stuck.ok).toBe(false);
      expect(stuck.error).toContain("timed out waiting for child exit");
      expect(stuck.error).toContain("child killed after exit timeout");
      // Kill evidence: a signal or a non-zero code was observed after escalation.
      expect(stuck.exit.signal !== null || (stuck.exit.code !== null && stuck.exit.code !== 0)).toBe(true);
      expect(normal.ok).toBe(true);

      const spawnIndexes = events.flatMap((event, index) => event.type === "spawn" ? [index] : []);
      const exitIndexes = events.flatMap((event, index) => event.type === "exit" ? [index] : []);
      const settledIndexes = events.flatMap((event, index) => event.type === "settled" ? [index] : []);
      expect(spawnIndexes.length).toBe(2);
      expect(exitIndexes.length).toBe(2);
      // The stuck child's exit (via kill) is observed before the next spawn
      // and before its own settled event — the slot is not released early.
      expect(spawnIndexes[1]!).toBeGreaterThan(exitIndexes[0]!);
      expect(settledIndexes[0]!).toBeGreaterThan(exitIndexes[0]!);
      expect(manager.activeSubprocess).toBeNull();
      expect(manager.activeRunId).toBeNull();
    } finally {
      await manager.shutdown();
      closeDatabaseHandle(parent);
      await removeTempDirAsync(dir);
    }
  });
});
