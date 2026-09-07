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
// only requests aimed at OpenRouter through the stub, letting the test's
// own request to the harness through untouched.
function stubOpenRouterFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>) {
  const realFetch = globalThis.fetch;
  const openRouterCalls: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) => {
    if (String(input).startsWith("https://openrouter.ai/")) {
      openRouterCalls.push(input);
      return impl(input, init);
    }
    return realFetch(input, init);
  }) as typeof fetch);
  return openRouterCalls;
}

describe("GET /credits", () => {
  it("returns total credits, total usage, and the derived remaining balance", async () => {
    const openRouterCalls = stubOpenRouterFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 32.5 } }), { status: 200 })),
    );
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/credits`, authed());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ totalCredits: 50, totalUsage: 32.5, remaining: 17.5 });
    expect(openRouterCalls).toHaveLength(1);
  });

  it("caches the result and doesn't re-fetch within the TTL", async () => {
    const openRouterCalls = stubOpenRouterFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 1 } }), { status: 200 })),
    );
    const h = await buildHarness();
    harnesses.push(h);

    await fetch(`${h.base}/credits`, authed());
    await fetch(`${h.base}/credits`, authed());
    expect(openRouterCalls).toHaveLength(1);
  });

  it("returns 502 with a message when OpenRouter is unreachable", async () => {
    stubOpenRouterFetch(() => Promise.reject(new Error("offline")));
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/credits`, authed());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("openrouter_unavailable");
    expect(body.message).toContain("offline");
  });

  it("returns 502 when OpenRouter responds with a non-2xx status", async () => {
    stubOpenRouterFetch(() => Promise.resolve(new Response("nope", { status: 401 })));
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/credits`, authed());
    expect(res.status).toBe(502);
  });

  it("returns 502 when OpenRouter's response is malformed", async () => {
    stubOpenRouterFetch(() => Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 })));
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
