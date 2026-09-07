import { describe, it, expect, afterEach, vi } from "vitest";
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
  vi.restoreAllMocks();
});

// registerCreditsRoutes calls the *global* fetch directly (no injectable
// fetchImpl seam), so stub it the same way models.test.ts does — routing
// requests aimed at OpenRouter's /credits and /key endpoints separately,
// letting the test's own request to the harness through untouched.
function stubOpenRouter(opts: {
  credits?: () => Promise<Response>;
  key?: () => Promise<Response>;
}) {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) => {
    const url = String(input);
    if (url === "https://openrouter.ai/api/v1/credits" && opts.credits) {
      calls.push("credits");
      return opts.credits();
    }
    if (url === "https://openrouter.ai/api/v1/key" && opts.key) {
      calls.push("key");
      return opts.key();
    }
    return realFetch(input, init);
  }) as typeof fetch);
  return calls;
}

function jsonResponse(data: unknown, status = 200) {
  return () => Promise.resolve(new Response(JSON.stringify({ data }), { status }));
}

describe("GET /credits", () => {
  it("returns the derived remaining balance and the current week's spend", async () => {
    const calls = stubOpenRouter({
      credits: jsonResponse({ total_credits: 50, total_usage: 32.5 }),
      key: jsonResponse({ usage_weekly: 4.25 }),
    });
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/credits`, authed());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ remaining: 17.5, weeklySpend: 4.25 });
    expect(calls.sort()).toEqual(["credits", "key"]);
  });

  it("caches the result and doesn't re-fetch within the TTL", async () => {
    const calls = stubOpenRouter({
      credits: jsonResponse({ total_credits: 10, total_usage: 1 }),
      key: jsonResponse({ usage_weekly: 0.5 }),
    });
    const h = await buildHarness();
    harnesses.push(h);

    await fetch(`${h.base}/credits`, authed());
    await fetch(`${h.base}/credits`, authed());
    expect(calls).toHaveLength(2); // one credits + one key call, not four
  });

  it("returns 502 with a message when OpenRouter is unreachable", async () => {
    stubOpenRouter({
      credits: () => Promise.reject(new Error("offline")),
      key: jsonResponse({ usage_weekly: 0 }),
    });
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/credits`, authed());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("openrouter_unavailable");
    expect(body.message).toContain("offline");
  });

  it("returns 502 when either endpoint responds with a non-2xx status", async () => {
    stubOpenRouter({
      credits: jsonResponse({ total_credits: 10, total_usage: 1 }),
      key: () => Promise.resolve(new Response("nope", { status: 401 })),
    });
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/credits`, authed());
    expect(res.status).toBe(502);
  });

  it("returns 502 when a response is missing the field it needs", async () => {
    stubOpenRouter({
      credits: jsonResponse({}),
      key: jsonResponse({ usage_weekly: 0 }),
    });
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/credits`, authed());
    expect(res.status).toBe(502);
  });

  it("requires auth like every other route", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const res = await fetch(`${h.base}/credits`);
    expect(res.status).toBe(401);
  });
});
