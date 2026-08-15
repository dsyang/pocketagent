import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Bearer-token preHandler — the second layer behind the tailnet (§8). */
export function createAuthPreHandler(token: string) {
  const expected = Buffer.from(token, "utf8");
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
    const ok = provided.length === expected.length && timingSafeEqual(provided, expected);
    if (!ok) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}
