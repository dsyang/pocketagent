import type Database from "better-sqlite3";

export function getSetting(sqlite: Database.Database, key: string): string | undefined {
  const row = sqlite.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(sqlite: Database.Database, key: string, value: string): void {
  sqlite.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
