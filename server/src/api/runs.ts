import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { runs } from "../db/schema.js";

export function registerRunRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (req, reply) => {
    const run = ctx.db.select().from(runs).where(eq(runs.id, req.params.id)).get();
    if (!run) return reply.code(404).send({ error: "not_found" });

    if (run.status !== "queued" && run.status !== "running") {
      return reply.code(200).send({ id: run.id, status: run.status });
    }

    ctx.db.update(runs).set({ cancelRequested: 1 }).where(eq(runs.id, req.params.id)).run();
    return reply.code(202).send({ id: run.id, status: run.status, cancelRequested: true });
  });
}
