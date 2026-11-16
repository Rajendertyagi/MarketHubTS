import { resolve } from "node:path";

type Proc = ReturnType<typeof Bun.spawn>;

const root = resolve(import.meta.dir, "..");
const procs: Proc[] = [];
let shuttingDown = false;

function prefix(name: string, stream: ReadableStream<Uint8Array> | null, write: (s: string) => void) {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          write(`[${name}] ${line}\n`);
        }
      }
      if (buffer.length) write(`[${name}] ${buffer}\n`);
    } catch {}
  })();
}

function spawn(name: string, cmd: string[], cwd: string) {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  procs.push(p);
  prefix(name, p.stdout, (s) => process.stdout.write(s));
  prefix(name, p.stderr, (s) => process.stderr.write(s));
  p.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited with code ${code}`);
      void shutdown(code ?? 1);
    }
  });
  return p;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    try { p.kill("SIGTERM"); } catch {}
  }
  await Bun.sleep(1500);
  for (const p of procs) {
    try { if (p.exitCode === null) p.kill("SIGKILL"); } catch {}
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

console.log("[dev] Starting MarketHubTS development (API + Web)...");
spawn("api", ["bun", "--watch", "src/index.ts"], resolve(root, "apps/api"));
spawn("web", ["bun", "run", "dev"], resolve(root, "apps/web"));

await new Promise(() => {});
