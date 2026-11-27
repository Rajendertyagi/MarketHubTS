import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const distIndex = resolve(root, "apps/web/dist/index.html");

if (!existsSync(distIndex)) {
  console.error("Production web build not found at apps/web/dist/index.html.");
  console.error("Run: bun run build");
  process.exit(1);
}

const env = { ...process.env, MARKETHUB_ENV: process.env.MARKETHUB_ENV ?? "production" };
const proc = Bun.spawn([process.execPath, "src/index.ts"], {
  cwd: resolve(root, "apps/api"),
  env,
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit"
});

const forward = (signal: "SIGINT" | "SIGTERM") => {
  try { proc.kill(signal); } catch {}
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

const code = await proc.exited;
process.exit(code ?? 0);
