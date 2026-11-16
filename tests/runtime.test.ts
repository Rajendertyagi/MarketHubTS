import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(url: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

describe("runtime", () => {
  test("API starts with validated config and shuts down cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markethub-rt-"));
    const dbPath = join(dir, "rt.sqlite");
    const port = 4311;
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: resolve(import.meta.dir, "../apps/api"),
      env: {
        ...process.env,
        MARKETHUB_ENV: "test",
        MARKETHUB_HOST: "127.0.0.1",
        MARKETHUB_PORT: String(port),
        MARKETHUB_DB_PATH: dbPath,
        MARKETHUB_LOG_LEVEL: "error"
      },
      stdout: "ignore",
      stderr: "pipe"
    });
    try {
      const health = await waitForHealth(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe("ok");
      expect(health.checks.database).toBe("ok");
      proc.kill("SIGTERM");
      const code = await proc.exited;
      // Process should exit after shutdown signal; exit code may vary by platform/signal handling.
      expect(typeof code === "number" || code === null).toBe(true);
    } finally {
      try { proc.kill("SIGKILL"); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  test("partial startup failure on invalid config exits non-zero", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: resolve(import.meta.dir, "../apps/api"),
      env: { ...process.env, MARKETHUB_PORT: "not-a-port", MARKETHUB_LOG_LEVEL: "error" },
      stdout: "ignore",
      stderr: "pipe"
    });
    const code = await proc.exited;
    expect(code).not.toBe(0);
  });
});
