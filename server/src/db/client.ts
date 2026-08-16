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
  //
  // Two partial indexes, not one covering (archived_at, updated_at, id)
  // index: listConversations always orders by (updated_at DESC, id) within
  // one archived state or the other, never mixing states in one query. A
  // leading archived_at column only helps the equality case (archived_at IS
  // NULL); "IS NOT NULL" is a range predicate SQLite can't use to satisfy
  // updated_at ordering from that index, so it falls back to a full
  // temp-b-tree sort of every archived row on each page (verified via
  // EXPLAIN QUERY PLAN — "USE TEMP B-TREE FOR ORDER BY" instead of "...FOR
  // LAST TERM OF ORDER BY"). Matching each WHERE arm to its own
  // (updated_at DESC, id) index gets both cases back to the cheap tie-break
  // path conv_recency already had.
  sqlite.exec(`CREATE INDEX IF NOT EXISTS conv_inbox_recency ON conversations(updated_at DESC, id) WHERE archived_at IS NULL`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS conv_archive_recency ON conversations(updated_at DESC, id) WHERE archived_at IS NOT NULL`);
}

export type DbHandle = ReturnType<typeof openDatabase>;
export type Db = DbHandle["db"];
