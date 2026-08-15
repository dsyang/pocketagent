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

// Runner never starts, so a sent message's run stays 'queued' rather than
// racing to complete — exactly the window a second concurrent send needs to
// be rejected in.
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

async function json(res: Response): Promise<any> {
  return res.json();
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

describe("POST /conversations/:id/messages — one active run per conversation", () => {
  it("rejects a second send while a run is queued/running, instead of letting two runs interleave", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const conv = await json(await fetch(`${h.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) })));

    const first = await fetch(`${h.base}/conversations/${conv.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "first" }) }));
    expect(first.status).toBe(202);
    const firstBody = await json(first);

    const second = await fetch(`${h.base}/conversations/${conv.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "second" }) }));
    expect(second.status).toBe(409);
    const secondBody = await json(second);
    expect(secondBody).toEqual({ error: "run_in_progress", runId: firstBody.runId, status: "queued" });

    // Only the first message and its run exist — the second send never got queued.
    const messages = h.ctx.sqlite.prepare(`SELECT content FROM messages WHERE conversation_id = ?`).all(conv.id) as Array<{ content: string }>;
    expect(messages.map((m) => m.content)).toEqual(["first"]);
  });

  it("accepts a new send once the previous run has settled", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const conv = await json(await fetch(`${h.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) })));

    const first = await fetch(`${h.base}/conversations/${conv.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "first" }) }));
    const firstBody = await json(first);
    h.ctx.sqlite.prepare(`UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?`).run(Date.now(), firstBody.runId);

    const second = await fetch(`${h.base}/conversations/${conv.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "second" }) }));
    expect(second.status).toBe(202);
  });
});
