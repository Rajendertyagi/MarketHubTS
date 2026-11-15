import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

export type MarketHubDb = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  db: MarketHubDb;
  sqlite: Database;
  path: string;
  close: () => void;
}

export function openDatabase(dbPath = process.env.MARKETHUB_DB_PATH ?? "./data/markethub.sqlite"): DatabaseHandle {
  const path = resolve(dbPath);
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  const db = drizzle({ client: sqlite, schema });

  return {
    db,
    sqlite,
    path,
    close: () => {
      try {
        sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // best effort on shutdown
      }
      sqlite.close();
    }
  };
}

export function checkDatabase(sqlite: Database): "ok" | "error" {
  try {
    const row = sqlite.query("SELECT 1 as ok").get() as { ok: number } | null;
    return row?.ok === 1 ? "ok" : "error";
  } catch {
    return "error";
  }
}

export { schema };
