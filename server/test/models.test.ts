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

// registerModelRoutes calls the *global* fetch directly (no injectable
// fetchImpl seam, unlike openrouter.ts/loop.ts), and OpenRouter's
// /api/v1/models is a public endpoint that doesn't require a valid key — so
// an unstubbed test silently takes the live-fetch branch against a real
// third party instead of the CURATED_MODELS fallback, and does so with up to
// FETCH_TIMEOUT_MS of latency on a runner with no network access at all.
// Stub global fetch so each branch is exercised deterministically.
function stubOpenRouterFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) => {
    if (String(input).startsWith("https://openrouter.ai/")) return impl(input, init);
    return realFetch(input, init); // let the test's own request to the harness through
  }) as typeof fetch);
}

describe("GET /models", () => {
  it("falls back to the curated list when the live OpenRouter fetch fails, and still reports the server's default model", async () => {
    stubOpenRouterFetch(() => Promise.reject(new Error("offline")));
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/models`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }>; default: string };
    expect(body.default).toBe("test/default-model");
    expect(body.models.map((m) => m.id)).toContain("anthropic/claude-sonnet-5"); // a CURATED_MODELS entry
  });

  it("reports the server's default model on the live-fetch branch too", async () => {
    stubOpenRouterFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [{ id: "some/live-model", name: "Some Live Model" }] }), { status: 200 })),
    );
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/models`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }>; default: string };
    expect(body.default).toBe("test/default-model");
    expect(body.models).toEqual([{ id: "some/live-model", name: "Some Live Model" }]);
  });
});
