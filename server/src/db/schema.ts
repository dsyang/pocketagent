import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    model: text("model").notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
    lastMessageAt: integer("last_message_at"),
    lastMessagePreview: text("last_message_preview"),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("conv_recency").on(t.updatedAt, t.id), index("conv_archived").on(t.archivedAt, t.updatedAt, t.id)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    citations: text("citations"),
    runId: text("run_id"),
    clientMessageId: text("client_message_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("msg_client_id")
      .on(t.conversationId, t.clientMessageId)
      .where(sql`${t.clientMessageId} IS NOT NULL`),
    index("msg_conv").on(t.conversationId, t.createdAt),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled"],
    }).notNull(),
    model: text("model").notNull(),
    error: text("error"),
    usage: text("usage"),
    cancelRequested: integer("cancel_requested").notNull().default(0),
    heartbeatAt: integer("heartbeat_at"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("runs_active").on(t.status).where(sql`${t.status} IN ('queued','running')`)],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    runId: text("run_id").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.seq] })],
);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  apnsToken: text("apns_token").notNull().unique(),
  platform: text("platform").notNull().default("ios"),
  createdAt: integer("created_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
});
