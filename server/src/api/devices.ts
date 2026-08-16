import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.js";
import { newId } from "../db/ids.js";
import { devices } from "../db/schema.js";

const registerBodySchema = z.object({
  apnsToken: z.string().min(1),
  platform: z.enum(["ios", "android"]).default("ios"),
});

export function registerDeviceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post("/devices", async (req, reply) => {
    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });

    const now = Date.now();
    const existing = ctx.db.select().from(devices).where(eq(devices.apnsToken, parsed.data.apnsToken)).get();
    if (existing) {
      ctx.db.update(devices).set({ lastSeenAt: now, platform: parsed.data.platform }).where(eq(devices.id, existing.id)).run();
      return reply.code(200).send({ id: existing.id });
    }

    const id = newId("dev");
    ctx.db
      .insert(devices)
      .values({ id, apnsToken: parsed.data.apnsToken, platform: parsed.data.platform, createdAt: now, lastSeenAt: now })
      .run();
    return reply.code(201).send({ id });
  });
}
