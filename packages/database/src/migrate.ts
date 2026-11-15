import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDatabase } from "./index";

const handle = openDatabase();
try {
  migrate(handle.db, { migrationsFolder: "./drizzle" });
  console.log(`Migrations applied to ${handle.path}`);
} finally {
  handle.close();
}
