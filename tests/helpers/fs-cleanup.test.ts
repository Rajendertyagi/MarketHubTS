import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirAsync } from "./fs-cleanup";

describe("removeTempDirAsync", () => {
  test("removes a temp directory containing files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-cleanup-"));
    writeFileSync(join(dir, "a.sqlite"), "data");
    writeFileSync(join(dir, "b.sqlite-wal"), "wal");

    await removeTempDirAsync(dir);

    expect(existsSync(dir)).toBe(false);
  });

  test("retries while a file is transiently locked, then removes the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mh-cleanup-locked-"));
    const file = join(dir, "locked.sqlite");
    writeFileSync(file, "data");

    // Hold an exclusive handle so the first removal attempt fails with EBUSY
    // on Windows, then release it while the helper is yielding between attempts.
    const handle = openSync(file, "r+");
    const removal = removeTempDirAsync(dir, 40, 10);
    await Bun.sleep(30);
    closeSync(handle);

    await removal;
    expect(existsSync(dir)).toBe(false);
  });
});
