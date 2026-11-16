import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, resolveCredentialKeyPath, SqliteCredentialStore } from "../../packages/database/src/index";
import { closeDatabaseHandle, removeTempDir } from "../helpers/fs-cleanup";

const dirs: string[] = [];
const handles: Array<{ close: () => void }> = [];

function freshDb(label: string, dbPath?: string) {
  const dir = newTempDir(label);
  dirs.push(dir);
  const path = dbPath ?? join(dir, "data", "markethub.sqlite");
  mkdirSync(join(path, ".."), { recursive: true });
  const handle = openDatabase({ dbPath: path, migrate: true });
  handles.push(handle);
  return { dir, handle, path };
}

function mkdtemp(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function newTempDir(label: string): string {
  return mkdtemp(`mh-cred-${label}-`);
}

afterEach(() => {
  while (handles.length) {
    try { handles.pop()?.close(); } catch {}
  }
  while (dirs.length) {
    try { removeTempDir(dirs.pop()!); } catch {}
  }
});

describe("portable encrypted credential store", () => {
  test("real AES-256-GCM round trip with key file creation and no plaintext in SQLite", async () => {
    const { handle, path } = freshDb("roundtrip");
    const keyPath = resolveCredentialKeyPath(path);
    expect(existsSync(keyPath)).toBe(false);
    const store = new SqliteCredentialStore(handle);
    expect(store.status().state).toBe("AVAILABLE");
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath).length).toBe(32);

    await store.set("UPSTOX", "analytics_token", "upstox-secret-token-value");
    await store.set("FYERS", "app_secret", "fyers-app-secret-value");
    expect(await store.get("UPSTOX", "analytics_token")).toBe("upstox-secret-token-value");
    expect(await store.get("FYERS", "app_secret")).toBe("fyers-app-secret-value");

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("upstox-secret-token-value");
    expect(raw).not.toContain("fyers-app-secret-value");
    const rows = handle.sqlite.query("SELECT provider, name, format_version, nonce, ciphertext, tag FROM provider_credentials").all() as any[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.format_version === 1 && r.nonce && r.ciphertext && r.tag)).toBe(true);
    expect(rows.some((r) => JSON.stringify(r).includes("secret-token"))).toBe(false);
  });

  test("fresh nonce per encryption and ciphertext differs for identical plaintext", async () => {
    const { handle } = freshDb("nonce");
    const store = new SqliteCredentialStore(handle);
    await store.set("UPSTOX", "a", "same-value");
    await store.set("UPSTOX", "b", "same-value");
    const rows = handle.sqlite.query("SELECT nonce, ciphertext, tag FROM provider_credentials ORDER BY name").all() as any[];
    expect(rows[0]!.nonce).not.toBe(rows[1]!.nonce);
    expect(rows[0]!.ciphertext).not.toBe(rows[1]!.ciphertext);
    expect(rows[0]!.tag).not.toBe(rows[1]!.tag);
  });

  test("tampered ciphertext and AAD mismatch fail closed", async () => {
    const { handle } = freshDb("tamper");
    const store = new SqliteCredentialStore(handle);
    await store.set("UPSTOX", "analytics_token", "secret-value");
    const original = (handle.sqlite.query("SELECT ciphertext FROM provider_credentials").get() as any).ciphertext as string;

    handle.sqlite.query("UPDATE provider_credentials SET ciphertext = ? WHERE provider = 'UPSTOX'").run("AAAA");
    let failed = false;
    try { await store.get("UPSTOX", "analytics_token"); } catch { failed = true; }
    expect(failed).toBe(true);

    handle.sqlite.query("UPDATE provider_credentials SET ciphertext = ? WHERE provider = 'UPSTOX'").run(original);
    expect(await store.get("UPSTOX", "analytics_token")).toBe("secret-value");

    // AAD is bound to provider/name: renaming the row makes decryption fail.
    handle.sqlite.query("UPDATE provider_credentials SET name = 'other' WHERE provider = 'UPSTOX'").run();
    failed = false;
    try { await store.get("UPSTOX", "other"); } catch { failed = true; }
    expect(failed).toBe(true);
  });

  test("missing key with existing credential records preserves data and reports unavailable", async () => {
    const { handle, path } = freshDb("missingkey");
    const store = new SqliteCredentialStore(handle);
    await store.set("FYERS", "access_token", "keep-me");
    const keyPath = resolveCredentialKeyPath(path);
    rmSync(keyPath);

    const second = new SqliteCredentialStore(handle);
    expect(second.status().state).toBe("UNAVAILABLE");
    expect(second.status().reason).toContain("missing");
    expect(existsSync(keyPath)).toBe(false);
    const rows = handle.sqlite.query("SELECT count(*) as n FROM provider_credentials").get() as any;
    expect(rows.n).toBe(1);
    let failed = false;
    try { await second.get("FYERS", "access_token"); } catch { failed = true; }
    expect(failed).toBe(true);
  });

  test("explicit reset discards unrecoverable rows and creates a new key", async () => {
    const { handle, path } = freshDb("reset");
    const store = new SqliteCredentialStore(handle);
    await store.set("UPSTOX", "analytics_token", "old");
    rmSync(resolveCredentialKeyPath(path));
    const unavailable = new SqliteCredentialStore(handle);
    expect(unavailable.status().state).toBe("UNAVAILABLE");
    await unavailable.reset();
    expect(unavailable.status().state).toBe("AVAILABLE");
    expect(existsSync(resolveCredentialKeyPath(path))).toBe(true);
    const rows = handle.sqlite.query("SELECT count(*) as n FROM provider_credentials").get() as any;
    expect(rows.n).toBe(0);
    expect(await unavailable.get("UPSTOX", "analytics_token")).toBeNull();
  });

  test("closed-folder copy to a different path decrypts correctly", async () => {
    const { handle, path, dir } = freshDb("copy");
    const store = new SqliteCredentialStore(handle);
    await store.set("UPSTOX", "analytics_token", "portable-token");
    handle.close();

    const target = mkdtemp("mh-cred-copy-target-");
    dirs.push(target);
    const targetData = join(target, "data");
    mkdirSync(targetData, { recursive: true });
    copyFileSync(path, join(targetData, "markethub.sqlite"));
    copyFileSync(resolveCredentialKeyPath(path), join(targetData, "markethub.key"));
    for (const suffix of ["-wal", "-shm"]) {
      const src = path + suffix;
      if (existsSync(src)) copyFileSync(src, join(targetData, "markethub.sqlite" + suffix));
    }

    const copied = openDatabase({ dbPath: join(targetData, "markethub.sqlite"), migrate: true });
    handles.push(copied);
    const copiedStore = new SqliteCredentialStore(copied);
    expect(copiedStore.status().state).toBe("AVAILABLE");
    expect(await copiedStore.get("UPSTOX", "analytics_token")).toBe("portable-token");
  });

  test("delete removes only the targeted credential", async () => {
    const { handle } = freshDb("delete");
    const store = new SqliteCredentialStore(handle);
    await store.set("UPSTOX", "analytics_token", "u");
    await store.set("FYERS", "app_secret", "f");
    await store.delete("UPSTOX", "analytics_token");
    expect(await store.get("UPSTOX", "analytics_token")).toBeNull();
    expect(await store.get("FYERS", "app_secret")).toBe("f");
  });
});
