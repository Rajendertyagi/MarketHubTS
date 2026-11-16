import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  await server.stop(true);
  return port;
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

async function waitForExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 10000): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited,
      new Promise<number | null>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for process exit")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertPortReleased(port: number, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      return;
    }
    await wait(100);
  }
  throw new Error(`Port ${port} still accepting connections`);
}

describe("runtime", () => {
  test("API starts with validated config and shuts down cleanly releasing listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markethub-rt-"));
    const dbPath = join(dir, "rt.sqlite");
    const port = await getFreePort();
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
      const code = await waitForExit(proc, 10000);
      await assertPortReleased(port, 5000);
      // On Windows/Bun, SIGTERM may be reported as 143; shutdown must still complete and release the listener.
      expect(code === 0 || code === 143).toBe(true);
    } finally {
      try {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("partial startup failure on invalid config exits non-zero", async () => {
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: resolve(import.meta.dir, "../apps/api"),
      env: { ...process.env, MARKETHUB_PORT: "not-a-port", MARKETHUB_LOG_LEVEL: "error" },
      stdout: "ignore",
      stderr: "pipe"
    });
    const code = await waitForExit(proc, 10000);
    expect(code).not.toBe(0);
  });
});
