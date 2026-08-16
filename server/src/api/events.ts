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
const MAX_BUFFERED_BYTES = 1024 * 1024; // backpressure cap per connection

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

    let closed = false;
    let unsubscribe: () => void = () => {};

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    // subscribe() replays backlog synchronously, so this callback can fire
    // (and call cleanup(), which calls `unsubscribe`) before the real
    // unsubscribe function below is assigned — hence the `closed` check
    // after subscribe() returns.
    unsubscribe = ctx.eventLog.subscribe(conversationId, parsed.data.after, (row) => {
      if (closed) return;
      try {
        const ok = reply.raw.write(formatSseEvent(row));
        // A slow client (cellular, stalled tunnel) can otherwise accumulate
        // the whole delta stream in the socket's internal buffer. Drop it
        // once backpressure crosses the cap — the client resumes from its
        // cursor, which is exactly what the resume protocol is for.
        if (!ok && reply.raw.writableLength > MAX_BUFFERED_BYTES) cleanup();
      } catch {
        // reply.raw destroyed mid-write (client vanished, TLS/proxy teardown) — drop the subscriber.
        cleanup();
      }
    });
    if (closed) unsubscribe();

    req.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  });
}
