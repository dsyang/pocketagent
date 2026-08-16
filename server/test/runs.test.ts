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

// Runner never starts (runner.start() is not called) — every run created in
// these tests stays 'queued' forever unless a test moves it itself, which is
// exactly the state POST /runs/:id/cancel needs to exercise.
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

// No Content-Type/body — Fastify's default JSON body parser 400s on an
// empty body when Content-Type: application/json is set with nothing to parse.
function cancelRun(base: string, runId: string): Promise<Response> {
  return fetch(`${base}/runs/${runId}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
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

describe("POST /runs/:id/cancel", () => {
  it("settles a queued run synchronously: cancelled status, terminal event, no lingering flag-only state", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const conv = await json(await fetch(`${h.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) })));
    const send = await json(await fetch(`${h.base}/conversations/${conv.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "hi" }) })));

    const cancelRes = await cancelRun(h.base, send.runId);
    expect(cancelRes.status).toBe(200);
    const cancelBody = await json(cancelRes);
    expect(cancelBody).toEqual({ id: send.runId, status: "cancelled" });

    const run = h.ctx.sqlite.prepare(`SELECT status, cancel_requested, finished_at FROM runs WHERE id = ?`).get(send.runId) as {
      status: string;
      cancel_requested: number;
      finished_at: number | null;
    };
    expect(run.status).toBe("cancelled");
    expect(run.cancel_requested).toBe(0); // never needed the flag path — settled directly
    expect(run.finished_at).not.toBeNull();

    const events = h.ctx.sqlite.prepare(`SELECT type FROM run_events WHERE conversation_id = ? ORDER BY seq`).all(conv.id) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toEqual(["run_finished"]);
  });

  it("sets cancel_requested (flag path) for a run that is already running", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const conv = await json(await fetch(`${h.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) })));
    const send = await json(await fetch(`${h.base}/conversations/${conv.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "hi" }) })));
    h.ctx.sqlite.prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(send.runId);

    const cancelRes = await cancelRun(h.base, send.runId);
    expect(cancelRes.status).toBe(202);
    const cancelBody = await json(cancelRes);
    expect(cancelBody).toEqual({ id: send.runId, status: "running", cancelRequested: true });

    const run = h.ctx.sqlite.prepare(`SELECT status, cancel_requested FROM runs WHERE id = ?`).get(send.runId) as {
      status: string;
      cancel_requested: number;
    };
    expect(run.status).toBe("running"); // unchanged — executeRun's cancelTimer is what acts on the flag
    expect(run.cancel_requested).toBe(1);
  });

  it("is a no-op that reports the terminal status for an already-finished run", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const conv = await json(await fetch(`${h.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) })));
    const send = await json(await fetch(`${h.base}/conversations/${conv.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "hi" }) })));
    h.ctx.sqlite.prepare(`UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?`).run(Date.now(), send.runId);

    const cancelRes = await cancelRun(h.base, send.runId);
    expect(cancelRes.status).toBe(200);
    expect(await json(cancelRes)).toEqual({ id: send.runId, status: "completed" });
  });
});
