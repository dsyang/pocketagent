import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/db/client.js";
import { EventLog } from "../src/events/log.js";
import { Pruner } from "../src/jobs/pruner.js";
import { newId } from "../src/db/ids.js";
import { getConversationSnapshot } from "../src/db/queries.js";

function makeConversation(sqlite: import("better-sqlite3").Database, now: number) {
  const id = newId("conv");
  sqlite.prepare(`INSERT INTO conversations (id, model, last_seq, created_at, updated_at) VALUES (?, 'test/model', 0, ?, ?)`).run(id, now, now);
  return id;
}
function makeRun(sqlite: import("better-sqlite3").Database, conversationId: string, status: string, finishedAt: number | null) {
  const id = newId("run");
  sqlite
    .prepare(`INSERT INTO runs (id, conversation_id, status, model, finished_at, created_at) VALUES (?, ?, ?, 'test/model', ?, ?)`)
    .run(id, conversationId, status, finishedAt, finishedAt ?? Date.now());
  return id;
}

describe("pruner", () => {
  it("deletes run_events for runs completed longer ago than the retention window, keeps recent ones", () => {
    const { sqlite, db } = openDatabase(":memory:");
    const eventLog = new EventLog(sqlite);
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;

    const conv = makeConversation(sqlite, now);
    const oldRun = makeRun(sqlite, conv, "completed", eightDaysAgo);
    const recentRun = makeRun(sqlite, conv, "completed", oneDayAgo);

    eventLog.append(conv, oldRun, [{ type: "run_started", payload: {} }, { type: "run_finished", payload: {} }]);
    eventLog.append(conv, recentRun, [{ type: "run_started", payload: {} }, { type: "run_finished", payload: {} }]);

    const pruner = new Pruner(sqlite, { retentionMs: 7 * 24 * 60 * 60 * 1000 });
    const deleted = pruner.prune();
    expect(deleted).toBe(2); // the old run's two events

    const remaining = sqlite.prepare(`SELECT run_id FROM run_events`).all() as Array<{ run_id: string }>;
    expect(remaining.every((r) => r.run_id === recentRun)).toBe(true);
    expect(remaining).toHaveLength(2);
  });

  it("never touches the messages table (durable tier survives pruning)", () => {
    const { sqlite, db } = openDatabase(":memory:");
    const eventLog = new EventLog(sqlite);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const conv = makeConversation(sqlite, eightDaysAgo);
    const run = makeRun(sqlite, conv, "completed", eightDaysAgo);
    eventLog.append(conv, run, [{ type: "run_started", payload: {} }]);

    const msgId = newId("msg");
    sqlite
      .prepare(`INSERT INTO messages (id, conversation_id, role, content, run_id, created_at) VALUES (?, ?, 'assistant', 'hello', ?, ?)`)
      .run(msgId, conv, run, eightDaysAgo);

    new Pruner(sqlite).prune();

    const msg = sqlite.prepare(`SELECT content FROM messages WHERE id = ?`).get(msgId) as { content: string };
    expect(msg.content).toBe("hello");
  });

  it("pruning is invisible to a fresh snapshot-and-subscribe (§6 invariant): nothing user-visible changes", () => {
    const { sqlite, db } = openDatabase(":memory:");
    const eventLog = new EventLog(sqlite);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const conv = makeConversation(sqlite, eightDaysAgo);
    const run = makeRun(sqlite, conv, "completed", eightDaysAgo);
    eventLog.append(conv, run, [{ type: "run_started", payload: {} }]);
    const msgId = newId("msg");
    sqlite
      .prepare(`INSERT INTO messages (id, conversation_id, role, content, run_id, created_at) VALUES (?, ?, 'assistant', 'hello there', ?, ?)`)
      .run(msgId, conv, run, eightDaysAgo);
    sqlite.prepare(`UPDATE conversations SET last_message_at = ?, last_message_preview = 'hello there' WHERE id = ?`).run(eightDaysAgo, conv);

    const before = getConversationSnapshot(db, conv);
    new Pruner(sqlite).prune();
    const after = getConversationSnapshot(db, conv);

    expect(after!.messages.map((m) => m.content)).toEqual(before!.messages.map((m) => m.content));
    expect(after!.activeRun).toBeNull();
  });
});
