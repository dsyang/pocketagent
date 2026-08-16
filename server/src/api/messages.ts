import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { newId } from "../db/ids.js";
import { conversations, messages, runs } from "../db/schema.js";

const sendBodySchema = z.object({
  content: z.string().min(1),
  clientMessageId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).optional(),
});

export function registerMessageRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Params: { id: string } }>("/conversations/:id/messages", async (req, reply) => {
    const parsed = sendBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

    const conversationId = req.params.id;
    const conversation = ctx.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
    if (!conversation) return reply.code(404).send({ error: "not_found" });

    // Archived conversations are read-only: unarchive before replying. Checked
    // ahead of the idempotency lookup below so a retried send against a
    // conversation archived in between attempts still surfaces the block
    // rather than silently returning the original (pre-archive) run.
    if (conversation.archivedAt !== null) {
      return reply.code(409).send({ error: "conversation_archived" });
    }

    // Idempotent sends (§7): a retried POST with the same clientMessageId returns the existing run.
    if (parsed.data.clientMessageId) {
      const existing = ctx.db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.clientMessageId, parsed.data.clientMessageId)))
        .get();
      if (existing) {
        const existingRun = existing.runId ? ctx.db.select().from(runs).where(eq(runs.id, existing.runId)).get() : null;
        return reply.code(200).send({ messageId: existing.id, runId: existing.runId, deduped: true, run: existingRun ?? null });
      }
    }

    // Reject rather than interleave: two runs streaming into the same
    // conversation concurrently garble the transcript (their assistant_delta
    // events land in seq order but from two different answers) and each
    // builds its context from history that doesn't include the other's
    // reply. This check and the insert below never straddle an `await`, so
    // there's no window for two requests to both pass it (see loop.ts's
    // pickup CAS for the same synchronous-execution invariant).
    const activeRun = ctx.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["queued", "running"])))
      .get();
    if (activeRun) {
      return reply.code(409).send({ error: "run_in_progress", runId: activeRun.id, status: activeRun.status });
    }

    const model = parsed.data.model ?? conversation.model;
    const now = Date.now();
    const messageId = newId("msg");
    const runId = newId("run");
    const preview = parsed.data.content.slice(0, 120);

    const txn = ctx.sqlite.transaction(() => {
      ctx.db
        .insert(messages)
        .values({
          id: messageId,
          conversationId,
          role: "user",
          content: parsed.data.content,
          runId,
          clientMessageId: parsed.data.clientMessageId ?? null,
          createdAt: now,
        })
        .run();

      ctx.db
        .insert(runs)
        .values({ id: runId, conversationId, status: "queued", model, createdAt: now })
        .run();

      ctx.db
        .update(conversations)
        .set({ lastMessageAt: now, lastMessagePreview: preview, updatedAt: now })
        .where(eq(conversations.id, conversationId))
        .run();
    });
    txn();

    ctx.runner.nudge();

    return reply.code(202).send({ messageId, runId });
  });
}
