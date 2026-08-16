import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/client.js";
import { conversations } from "../src/db/schema.js";

// The archived_at column was added after conversations already shipped to a
// live Pi deployment. openDatabase's CREATE-TABLE-IF-NOT-EXISTS DDL never
// touches a pre-existing table, so this proves the ALTER-TABLE migration
// path actually backfills the column instead of silently no-oping.
describe("migrating a pre-existing database", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const f of files.splice(0)) fs.rmSync(f, { force: true });
  });

  it("adds archived_at to a conversations table created before the column existed", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pa-migrate-")), "db.sqlite");
    files.push(file);

    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER,
        last_message_preview TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(`INSERT INTO conversations (id, model, created_at, updated_at) VALUES ('conv_legacy', 'test/model', 1, 1)`).run();
    legacy.close();

    const { sqlite, db } = openDatabase(file);
    const columns = sqlite.prepare(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === "archived_at")).toBe(true);

    const row = sqlite.prepare(`SELECT archived_at FROM conversations WHERE id = 'conv_legacy'`).get() as { archived_at: number | null };
    expect(row.archived_at).toBeNull();

    // and the drizzle layer reads the backfilled row without error
    const conv = db.select().from(conversations).where(eq(conversations.id, "conv_legacy")).get();
    expect(conv?.archivedAt).toBeNull();
    sqlite.close();
  });

  it("is idempotent across repeated opens (no duplicate-column error)", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pa-migrate-")), "db.sqlite");
    files.push(file);

    const first = openDatabase(file);
    first.sqlite.close();

    expect(() => {
      const second = openDatabase(file);
      second.sqlite.close();
    }).not.toThrow();
  });
});
