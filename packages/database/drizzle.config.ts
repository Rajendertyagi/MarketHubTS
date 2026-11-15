import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.MARKETHUB_DB_PATH ?? "./data/markethub.sqlite"
  },
  strict: true,
  verbose: true
});
