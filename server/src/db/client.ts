import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { DDL } from "./ddl.js";

export function openDatabase(filePath: string) {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const sqlite = new Database(filePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  sqlite.exec(DDL);
  migrate(sqlite);

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

// The DDL above is CREATE-IF-NOT-EXISTS only, so it never touches a table
// that already exists on disk (e.g. the Pi's live database). New columns
// added after the initial release need an explicit, idempotent ALTER here.
function migrate(sqlite: Database.Database): void {
  const columns = sqlite.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "archived_at")) {
    sqlite.exec(`ALTER TABLE conversations ADD COLUMN archived_at INTEGER`);
  }
  // Only safe to create once the column above is guaranteed to exist — the
  // DDL's CREATE TABLE IF NOT EXISTS runs before this, so a legacy database
  // reaches this line without the column until the ALTER above ran.
  sqlite.exec(`CREATE INDEX IF NOT EXISTS conv_archived ON conversations(archived_at, updated_at DESC, id)`);
}

export type DbHandle = ReturnType<typeof openDatabase>;
export type Db = DbHandle["db"];
