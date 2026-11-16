import { defineConfig } from "drizzle-kit";
import { isAbsolute, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function resolveDbPath(dbPath = process.env.MARKETHUB_DB_PATH ?? "./data/markethub.sqlite"): string {
  if (isAbsolute(dbPath)) return resolve(dbPath);
  return resolve(repoRoot, dbPath);
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: resolveDbPath()
  },
  strict: true,
  verbose: true
});
