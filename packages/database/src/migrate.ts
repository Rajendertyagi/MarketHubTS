import { defaultMigrationsFolder, openDatabase, runMigrations } from "./index";

const dbPath = process.env.MARKETHUB_DB_PATH;
const handle = openDatabase(dbPath ? { dbPath } : {});
try {
  runMigrations(handle.db, defaultMigrationsFolder);
  console.log(`Migrations applied to ${handle.path}`);
} finally {
  handle.close();
}
