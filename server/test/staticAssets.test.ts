import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/client.js";
import { EventLog } from "../src/events/log.js";
import { Runner } from "../src/jobs/runner.js";
import type { AppContext } from "../src/context.js";
import type { FastifyInstance } from "fastify";

const TOKEN = "test-token";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  base: string;
}

async function buildHarness(): Promise<Harness> {
  const { sqlite, db } = openDatabase(":memory:");
  const eventLog = new EventLog(sqlite);
  const runner = new Runner({ sqlite, eventLog, loopDeps: { openRouterApiKey: "unused" } });
  const ctx: AppContext = { sqlite, db, eventLog, runner, push: null, openRouterApiKey: "test", defaultModel: "test/default-model" };
  const app = buildApp(ctx, { authToken: TOKEN, logger: false, serveStatic: true });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  return { app, ctx, base };
}

let harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses) {
    h.app.server.closeAllConnections?.();
    await h.app.close();
    h.ctx.sqlite.close();
  }
  harnesses = [];
});

describe("static client assets", () => {
  // Safari fetches the touch icon with no Authorization header. If it ever
  // lands behind the bearer preHandler the failure is silent — iOS just uses a
  // screenshot of the page as the home-screen icon instead.
  it("serves the apple-touch-icon as a PNG without a token", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/apple-touch-icon.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");

    // Real PNG magic bytes, not an error page served with the wrong type.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("references both icons from the served page", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const html = await (await fetch(`${h.base}/app`)).text();
    expect(html).toContain('rel="icon"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
  });

  it("still requires a token for API routes", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/conversations`);
    expect(res.status).toBe(401);
  });
});
