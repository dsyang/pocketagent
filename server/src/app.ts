import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppContext } from "./context.js";
import { createAuthPreHandler } from "./auth.js";
import { registerConversationRoutes } from "./api/conversations.js";
import { registerMessageRoutes } from "./api/messages.js";
import { registerEventRoutes } from "./api/events.js";
import { registerRunRoutes } from "./api/runs.js";
import { registerModelRoutes } from "./api/models.js";
import { registerDeviceRoutes } from "./api/devices.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuildAppOptions {
  authToken: string;
  logger?: boolean;
  serveStatic?: boolean;
}

export function buildApp(ctx: AppContext, opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/healthz") return;
    // The web page authenticates itself with a pasted token kept in
    // localStorage (§11 — EventSource can't send an Authorization header,
    // and this keeps the page same-origin with the API with no CORS), so
    // serving the HTML shell itself doesn't need the bearer preHandler.
    if (opts.serveStatic && (req.url === "/app" || req.url === "/app/")) return;
    return createAuthPreHandler(opts.authToken)(req, reply);
  });

  registerConversationRoutes(app, ctx);
  registerMessageRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);

  if (opts.serveStatic) {
    const indexPath = path.join(__dirname, "..", "public", "index.html");
    app.get("/app", async (_req, reply) => {
      reply.type("text/html").send(fs.readFileSync(indexPath, "utf8"));
    });
  }

  return app;
}
