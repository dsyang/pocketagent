import { describe, it, expect, afterEach, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/client.js";
import { EventLog } from "../src/events/log.js";
import { Runner } from "../src/jobs/runner.js";
import { CURATED_MODELS } from "../src/api/models.js";
import { envSchema } from "../src/env.js";
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
// fetchImpl seam, unlike openrouter.ts/loop.ts) whenever it does reach for
// the live OpenRouter catalog. Stub it so any test that exercises that path
// is deterministic and offline-safe, and so we can assert it's *not* called
// when it shouldn't be — tracked separately from the global fetch spy, which
// also (unavoidably) counts the test's own request to the harness itself.
function stubOpenRouterFetch(impl: (input: unknown, init?: RequestInit) => Promise<Response>) {
  const realFetch = globalThis.fetch;
  const openRouterCalls: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(((input: any, init?: any) => {
    if (String(input).startsWith("https://openrouter.ai/")) {
      openRouterCalls.push(input);
      return impl(input, init);
    }
    return realFetch(input, init); // let the test's own request to the harness through
  }) as typeof fetch);
  return openRouterCalls;
}

describe("GET /models", () => {
  it("returns only the curated list with no query, and never touches the live OpenRouter API to do it", async () => {
    const openRouterCalls = stubOpenRouterFetch(() => Promise.reject(new Error("should not be called")));
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/models`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }>; default: string };
    expect(body.default).toBe("test/default-model");
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.length).toBeLessThan(20); // the curated set, not the hundreds-strong live catalog
    expect(openRouterCalls).toHaveLength(0);
  });

  // A search always checks the live catalog too, even when the curated set
  // already has a match — a curated id can otherwise permanently shadow a
  // more specific live model whose id is one of its substrings (regression
  // test for that: the live stub below deliberately returns an entry that
  // duplicates the curated hit's id, to also verify the union doesn't list
  // it twice).
  it("searching for a curated model still includes it, merged with the live catalog rather than short-circuiting", async () => {
    stubOpenRouterFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: "z-ai/glm-5.2", name: "Z.ai: GLM 5.2" }, // duplicates the curated entry — must not be listed twice
              { id: "z-ai/glm-5.2-mini", name: "Z.ai: GLM 5.2 Mini" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/models?q=glm`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }>; default: string };
    const ids = body.models.map((m) => m.id);
    expect(ids).toContain("z-ai/glm-5.2");
    expect(ids).toContain("z-ai/glm-5.2-mini"); // the live-only, non-shadowed match
    expect(ids.filter((id) => id === "z-ai/glm-5.2")).toHaveLength(1); // not duplicated
  });

  it("searching for something not in the curated list falls back to the live catalog", async () => {
    stubOpenRouterFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [{ id: "some/obscure-model", name: "Some Obscure Model" }] }), { status: 200 })),
    );
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/models?q=obscure`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }>; default: string };
    expect(body.default).toBe("test/default-model");
    expect(body.models).toEqual([{ id: "some/obscure-model", name: "Some Obscure Model" }]);
  });

  it("reports an empty result, not the curated list, when a search matches nothing anywhere", async () => {
    stubOpenRouterFetch(() => Promise.reject(new Error("offline")));
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/models?q=zzz-nonexistent-zzz`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }>; default: string };
    expect(body.default).toBe("test/default-model");
    expect(body.models).toEqual([]);
  });

  it("fetches the live catalog once and reuses it across multiple searches, within the cache TTL", async () => {
    const openRouterCalls = stubOpenRouterFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [{ id: "some/obscure-model", name: "Some Obscure Model" }] }), { status: 200 })),
    );
    const h = await buildHarness();
    harnesses.push(h);

    await fetch(`${h.base}/models?q=obscure`, authed());
    await fetch(`${h.base}/models?q=another-live-only-term`, authed());
    expect(openRouterCalls).toHaveLength(1);
  });

  it("caps live-catalog results at 50, so a broad search can't dump the whole catalog into the picker", async () => {
    const liveModels = Array.from({ length: 60 }, (_, i) => ({ id: `some-provider/broad-match-${i}`, name: `Broad Match ${i}` }));
    stubOpenRouterFetch(() => Promise.resolve(new Response(JSON.stringify({ data: liveModels }), { status: 200 })));
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/models?q=broad-match`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string }> };
    expect(body.models).toHaveLength(50);
  });

  // Regression guard for the client's dedupe between the pinned "Default"
  // row and a CURATED_MODELS entry that happens to share its id (see
  // index.html's renderModelOptions): if this ever drifts apart, the picker
  // quietly shows the default model twice with nothing else catching it.
  it("keeps DEFAULT_MODEL's fallback in the curated list", () => {
    const fallbackDefault = envSchema.shape.DEFAULT_MODEL.parse(undefined);
    expect(CURATED_MODELS.map((m) => m.id)).toContain(fallbackDefault);
  });
});
