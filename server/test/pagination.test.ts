import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { listConversations, decodeCursor } from "../src/db/queries.js";
import { newId } from "../src/db/ids.js";
import { conversations } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

function makeConversation(sqlite: import("better-sqlite3").Database, updatedAt: number, title: string) {
  const id = newId("conv");
  sqlite
    .prepare(`INSERT INTO conversations (id, title, model, last_seq, created_at, updated_at) VALUES (?, ?, 'test/model', 0, ?, ?)`)
    .run(id, title, updatedAt, updatedAt);
  return id;
}

describe("keyset pagination", () => {
  it("pages through all conversations, newest first, with no gaps or duplicates", () => {
    const { sqlite, db } = openDatabase(":memory:");
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(makeConversation(sqlite, base + i, `conv-${i}`));
    }

    const seen: string[] = [];
    let cursor: { updatedAt: number; id: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const result = listConversations(db, { limit: 10, before: cursor });
      seen.push(...result.items.map((c) => c.id));
      if (!result.nextCursor) break;
      cursor = decodeCursor(result.nextCursor);
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25); // no duplicates
    // newest first: matches reverse insertion order (higher updatedAt first)
    expect(seen).toEqual([...ids].reverse());
  });

  it("stays stable while new activity reshuffles the top (no OFFSET drift)", () => {
    const { sqlite, db } = openDatabase(":memory:");
    const base = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(makeConversation(sqlite, base + i, `conv-${i}`));

    // Fetch page 1 (newest 2).
    const page1 = listConversations(db, { limit: 2 });
    expect(page1.items.map((c) => c.id)).toEqual([ids[4], ids[3]]);
    const cursor = decodeCursor(page1.nextCursor!);

    // New activity bumps the oldest conversation to the top (simulates a new message arriving).
    const bumpedAt = base + 100;
    db.update(conversations).set({ updatedAt: bumpedAt }).where(eq(conversations.id, ids[0])).run();

    // Continuing to page 2 from the *old* cursor must not repeat or skip anything
    // that was already below the cursor at the time page 1 was read.
    const page2 = listConversations(db, { limit: 2, before: cursor });
    expect(page2.items.map((c) => c.id)).toEqual([ids[2], ids[1]]);
  });

  it("reports activeRunStatus for conversations with a queued/running run, null otherwise", () => {
    const { sqlite, db } = openDatabase(":memory:");
    const now = Date.now();
    const idle = makeConversation(sqlite, now, "idle");
    const active = makeConversation(sqlite, now + 1, "active");
    sqlite.prepare(`INSERT INTO runs (id, conversation_id, status, model, created_at) VALUES (?, ?, 'running', 'test/model', ?)`).run(newId("run"), active, now);

    const result = listConversations(db, { limit: 10 });
    const byId = new Map(result.items.map((c) => [c.id, c.activeRunStatus]));
    expect(byId.get(idle)).toBeNull();
    expect(byId.get(active)).toBe("running");
  });
});
