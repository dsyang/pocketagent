import { openDatabase } from "../src/db/client.js";
import { EventLog } from "../src/events/log.js";
import { newId } from "../src/db/ids.js";

export function setupDb() {
  return openDatabase(":memory:");
}

export function createConversation(sqlite: import("better-sqlite3").Database, model = "test/model"): string {
  const id = newId("conv");
  const now = Date.now();
  sqlite
    .prepare(`INSERT INTO conversations (id, title, model, last_seq, created_at, updated_at) VALUES (?, NULL, ?, 0, ?, ?)`)
    .run(id, model, now, now);
  return id;
}

export function createUserMessageAndRun(sqlite: import("better-sqlite3").Database, conversationId: string, content: string, model = "test/model") {
  const messageId = newId("msg");
  const runId = newId("run");
  const now = Date.now();
  sqlite
    .prepare(`INSERT INTO messages (id, conversation_id, role, content, run_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)`)
    .run(messageId, conversationId, content, runId, now);
  sqlite.prepare(`INSERT INTO runs (id, conversation_id, status, model, created_at) VALUES (?, ?, 'queued', ?, ?)`).run(runId, conversationId, model, now);
  return { messageId, runId };
}

export function newEventLog(sqlite: import("better-sqlite3").Database) {
  return new EventLog(sqlite);
}
