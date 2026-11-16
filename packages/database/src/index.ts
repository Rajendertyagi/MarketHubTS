import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

export type MarketHubDb = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  db: MarketHubDb;
  sqlite: Database;
  path: string;
  close: () => void;
}

export interface OpenDatabaseOptions {
  dbPath?: string;
  migrate?: boolean;
  migrationsFolder?: string;
}

const packageDir = dirname(fileURLToPath(import.meta.url));
export const defaultMigrationsFolder = resolve(packageDir, "../drizzle");

export function resolveDatabasePath(dbPath = process.env.MARKETHUB_DB_PATH ?? "./data/markethub.sqlite"): string {
  return resolve(dbPath);
}

export function openDatabase(options: OpenDatabaseOptions | string = {}): DatabaseHandle {
  const opts: OpenDatabaseOptions = typeof options === "string" ? { dbPath: options } : options;
  const path = resolveDatabasePath(opts.dbPath);
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    sqlite.exec("PRAGMA synchronous = NORMAL;");
    sqlite.exec("PRAGMA busy_timeout = 5000;");
  } catch (error) {
    try {
      sqlite.close();
    } catch {}
    throw error;
  }

  const db = drizzle({ client: sqlite, schema });
  if (opts.migrate) {
    runMigrations(db, opts.migrationsFolder ?? defaultMigrationsFolder);
  }

  return {
    db,
    sqlite,
    path,
    close: () => {
      try {
        sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {}
      sqlite.close();
    }
  };
}

export function runMigrations(db: MarketHubDb, migrationsFolder = defaultMigrationsFolder): void {
  if (!existsSync(migrationsFolder)) {
    throw new Error(`Migrations folder not found: ${migrationsFolder}`);
  }
  migrate(db, { migrationsFolder });
}

export function checkDatabase(sqlite: Database): "ok" | "error" {
  try {
    const row = sqlite.query("SELECT 1 as ok").get() as { ok: number } | null;
    return row?.ok === 1 ? "ok" : "error";
  } catch {
    return "error";
  }
}

export function getDatabaseInfo(sqlite: Database): { ok: boolean; journalMode?: string; foreignKeys?: number } {
  try {
    const okRow = sqlite.query("SELECT 1 as ok").get() as { ok: number } | null;
    const journal = sqlite.query("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
    const fk = sqlite.query("PRAGMA foreign_keys").get() as { foreign_keys?: number } | null;
    const info: { ok: boolean; journalMode?: string; foreignKeys?: number } = { ok: okRow?.ok === 1 };
    if (journal?.journal_mode !== undefined) info.journalMode = journal.journal_mode;
    if (fk?.foreign_keys !== undefined) info.foreignKeys = fk.foreign_keys;
    return info;
  } catch {
    return { ok: false };
  }
}

export { schema };
