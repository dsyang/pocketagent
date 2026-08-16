import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { runs } from "../db/schema.js";

export function registerRunRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (req, reply) => {
    const run = ctx.db.select().from(runs).where(eq(runs.id, req.params.id)).get();
    if (!run) return reply.code(404).send({ error: "not_found" });

    // A queued run has nothing executing yet — cancel_requested is only
    // polled from inside executeRun (agent/loop.ts), which doesn't exist
    // until the run is picked up, so setting the flag on a still-queued run
    // would leave it stuck with no terminal state until drain() gets to it.
    // Settle it here instead, synchronously.
    if (run.status === "queued") {
      const finishedAt = Date.now();
      const claimed = ctx.sqlite
        .prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'`)
        .run(finishedAt, run.id);
      if (claimed.changes > 0) {
        ctx.eventLog.append(run.conversationId, run.id, [{ type: "run_finished", payload: { runId: run.id, status: "cancelled", usage: null } }]);
        return reply.code(200).send({ id: run.id, status: "cancelled" });
      }
      // Lost the race to the runner picking it up between the SELECT above and this CAS — fall through as "running".
    }

    const current = ctx.db.select({ status: runs.status }).from(runs).where(eq(runs.id, req.params.id)).get()!;
    if (current.status !== "running") {
      return reply.code(200).send({ id: run.id, status: current.status });
    }

    ctx.db.update(runs).set({ cancelRequested: 1 }).where(eq(runs.id, req.params.id)).run();
    return reply.code(202).send({ id: run.id, status: current.status, cancelRequested: true });
  });
}
