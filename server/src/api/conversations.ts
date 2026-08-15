import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { newId } from "../db/ids.js";
import { conversations } from "../db/schema.js";
import { decodeCursor, getConversationSnapshot, listConversations } from "../db/queries.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().optional(),
});

const createBodySchema = z.object({
  model: z.string().min(1).optional(),
  title: z.string().min(1).max(200).optional(),
});

export function registerConversationRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/conversations", async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });

    let before: { updatedAt: number; id: string } | undefined;
    if (parsed.data.before) {
      try {
        before = decodeCursor(parsed.data.before);
      } catch {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
      if (!Number.isFinite(before.updatedAt) || typeof before.id !== "string" || !before.id) {
        return reply.code(400).send({ error: "invalid_cursor" });
      }
    }

    const result = listConversations(ctx.db, { limit: parsed.data.limit, before });
    return result;
  });

  app.post("/conversations", async (req, reply) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

    const now = Date.now();
    const id = newId("conv");
    ctx.db
      .insert(conversations)
      .values({
        id,
        title: parsed.data.title ?? null,
        model: parsed.data.model ?? ctx.defaultModel,
        lastSeq: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const conversation = ctx.db.select().from(conversations).where(eq(conversations.id, id)).get();
    return reply.code(201).send(conversation);
  });

  app.get<{ Params: { id: string } }>("/conversations/:id", async (req, reply) => {
    const snapshot = getConversationSnapshot(ctx.db, req.params.id);
    if (!snapshot) return reply.code(404).send({ error: "not_found" });
    return snapshot;
  });
}
