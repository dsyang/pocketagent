import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { conversations } from "../db/schema.js";
import type { RunEventRow } from "../events/log.js";

const querySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
});

const HEARTBEAT_MS = 20_000;

function formatSseEvent(row: RunEventRow): string {
  const data = JSON.stringify({ runId: row.runId, ...(row.payload as object) });
  return `id: ${row.seq}\nevent: ${row.type}\ndata: ${data}\n\n`;
}

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { id: string } }>("/conversations/:id/events", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });

    const conversationId = req.params.id;
    const conversation = ctx.db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
    if (!conversation) return reply.code(404).send({ error: "not_found" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": hb\n\n");
    }, HEARTBEAT_MS);

    const unsubscribe = ctx.eventLog.subscribe(conversationId, parsed.data.after, (row) => {
      reply.raw.write(formatSseEvent(row));
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  });
}
