import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { conversations, messages, runs } from "./schema.js";

export interface ConversationListItem {
  id: string;
  title: string | null;
  model: string;
  updatedAt: number;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  activeRunStatus: "queued" | "running" | null;
}

export interface ListConversationsOptions {
  limit: number;
  before?: { updatedAt: number; id: string };
}

export interface ListConversationsResult {
  items: ConversationListItem[];
  nextCursor: string | null;
}

export function encodeCursor(updatedAt: number, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt, id])).toString("base64url");
}

export function decodeCursor(cursor: string): { updatedAt: number; id: string } {
  const [updatedAt, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [number, string];
  return { updatedAt, id };
}

// Keyset pagination ordered by (updated_at DESC, id): stable while new
// activity reshuffles the top, straight index walk over conv_recency.
export function listConversations(db: Db, opts: ListConversationsOptions): ListConversationsResult {
  const { limit, before } = opts;

  const whereClause = before
    ? or(lt(conversations.updatedAt, before.updatedAt), and(eq(conversations.updatedAt, before.updatedAt), lt(conversations.id, before.id)))
    : undefined;

  const rows = db
    .select()
    .from(conversations)
    .where(whereClause)
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const activeStatuses = page.length
    ? db
        .select({ conversationId: runs.conversationId, status: runs.status })
        .from(runs)
        .where(and(inArray(runs.conversationId, page.map((r) => r.id)), inArray(runs.status, ["queued", "running"])))
        .all()
    : [];
  const activeByConv = new Map(activeStatuses.map((r) => [r.conversationId, r.status as "queued" | "running"]));

  const items: ConversationListItem[] = page.map((c) => ({
    id: c.id,
    title: c.title,
    model: c.model,
    updatedAt: c.updatedAt,
    lastMessageAt: c.lastMessageAt,
    lastMessagePreview: c.lastMessagePreview,
    activeRunStatus: activeByConv.get(c.id) ?? null,
  }));

  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;

  return { items, nextCursor };
}

export function getConversationSnapshot(db: Db, conversationId: string) {
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
  if (!conversation) return null;

  const msgs = db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt)
    .all();

  const activeRun = db
    .select()
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["queued", "running"])))
    .orderBy(desc(runs.createdAt))
    .get();

  return {
    conversation,
    messages: msgs,
    activeRun: activeRun ?? null,
    lastSeq: conversation.lastSeq,
  };
}
