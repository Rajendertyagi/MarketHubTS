import { defineConfig } from "drizzle-kit";
import { resolve } from "node:path";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: resolve(process.env.MARKETHUB_DB_PATH ?? "./data/markethub.sqlite")
  },
  strict: true,
  verbose: true
});
