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

// Declared in index.html and served below; the auth exemption keys off it too.
const TOUCH_ICON_ROUTE = "/apple-touch-icon.png";

export interface BuildAppOptions {
  authToken: string;
  logger?: boolean;
  serveStatic?: boolean;
}

export function buildApp(ctx: AppContext, opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  // Both clients (cli/chat.ts, public/index.html) always send
  // Content-Type: application/json, even on no-body POSTs like
  // /runs/:id/cancel and /conversations/:id/archive — fastify's default JSON
  // parser 400s on an empty body whenever that header is present, regardless
  // of whether the route reads req.body. Treat an empty body as `{}` instead.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      // Fastify's default JSON parser 400s on malformed bodies (FST_ERR_CTP_INVALID_JSON_BODY).
      // A bare SyntaxError has no statusCode, so without this it falls through
      // to a 500 — silently downgrading every malformed-body request from a
      // client error to a server error.
      done(Object.assign(err as Error, { statusCode: 400 }), undefined);
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/healthz") return;
    // The web page authenticates itself with a pasted token kept in
    // localStorage (§11 — EventSource can't send an Authorization header,
    // and this keeps the page same-origin with the API with no CORS), so
    // serving the HTML shell itself doesn't need the bearer preHandler.
    if (opts.serveStatic && (req.url === "/app" || req.url === "/app/")) return;
    // Safari fetches the iOS home-screen icon as a plain unauthenticated
    // request, so it has to be exempt too — behind the bearer preHandler it
    // would 401 and iOS would silently fall back to a screenshot of the page.
    if (opts.serveStatic && req.url === TOUCH_ICON_ROUTE) return;
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

    // The tab favicon is inlined in index.html, but iOS won't take an SVG (or
    // a data URI) for the home-screen icon — it needs a real PNG at a URL.
    const touchIconPath = path.join(__dirname, "..", "public", "apple-touch-icon.png");
    app.get(TOUCH_ICON_ROUTE, async (_req, reply) => {
      reply
        .type("image/png")
        .header("cache-control", "public, max-age=604800")
        .send(fs.readFileSync(touchIconPath));
    });
  }

  return app;
}
