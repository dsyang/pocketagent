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
  const ctx: AppContext = { sqlite, db, eventLog, runner, push: null, openRouterApiKey: "test", defaultModel: "test/model" };
  const app = buildApp(ctx, { authToken: TOKEN, logger: false });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  return { app, ctx, base };
}

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } };
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

describe("GET /conversations?before= — malformed cursors", () => {
  it.each([
    ["garbage base64url that decodes to invalid JSON", "xyz"],
    ["valid base64url of the JSON literal null", Buffer.from("null").toString("base64url")],
    ["valid base64url of a non-string id", Buffer.from(JSON.stringify([1, 2])).toString("base64url")],
  ])("returns 400 invalid_cursor instead of 500, for: %s", async (_label, cursor) => {
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/conversations?before=${encodeURIComponent(cursor)}`, authed());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_cursor" });
  });

  it("still accepts a well-formed cursor", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const good = Buffer.from(JSON.stringify([Date.now(), "conv_abc"])).toString("base64url");

    const res = await fetch(`${h.base}/conversations?before=${encodeURIComponent(good)}`, authed());
    expect(res.status).toBe(200);
  });
});
