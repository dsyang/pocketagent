import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

// The model picker's default view — a short, hand-picked list so opening the
// dialog doesn't dump OpenRouter's entire multi-hundred-model catalog on the
// user. GET /models returns only these unless the caller searches (?q=) for
// something not in this list, in which case (and only then) the live
// catalog is fetched and searched too. The current default model
// (ctx.defaultModel) doesn't need an entry here — the client always pins it
// at the top of the list separately.
const CURATED_MODELS = [
  { id: "google/gemini-3.7-flash:batch", name: "Gemini 3.7 Flash (batch)" },
  { id: "deepseek/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
  { id: "z-ai/glm-5.2", name: "GLM 5.2" },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "thinkingmachines/inkling-small", name: "Inkling Small" },
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 30 * 1000; // don't retry the live fetch on every request while OpenRouter is unreachable
const FETCH_TIMEOUT_MS = 5_000;

const querySchema = z.object({ q: z.string().trim().optional() });

function matches(m: { id: string; name: string }, q: string): boolean {
  return m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
}

export function registerModelRoutes(app: FastifyInstance, ctx: AppContext) {
  // Scoped to this registerModelRoutes call (one per app/AppContext instance) rather than
  // module-level, so separate app instances (tests, any future multi-instance use) don't share state.
  let cache: { at: number; models: Array<{ id: string; name: string }> } | null = null;
  let negativeCacheUntil = 0;

  // Only called when a search misses the curated list — the live catalog is
  // hundreds of entries, so it's fetched (and cached) on demand, not on
  // every /models request.
  async function fetchLiveModels(): Promise<Array<{ id: string; name: string }>> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
    if (Date.now() < negativeCacheUntil) return [];

    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${ctx.openRouterApiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
      const models = (body.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
      if (models.length > 0) {
        cache = { at: Date.now(), models };
        return models;
      }
    } catch {
      negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
    }
    return [];
  }

  app.get("/models", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", details: parsed.error.flatten() });

    const q = parsed.data.q?.toLowerCase();
    if (!q) {
      return { models: CURATED_MODELS, default: ctx.defaultModel };
    }

    const curatedMatches = CURATED_MODELS.filter((m) => matches(m, q));
    if (curatedMatches.length > 0) {
      return { models: curatedMatches, default: ctx.defaultModel };
    }

    // Nothing in the curated set matched — search the full live catalog.
    // Capped: a broad query (e.g. a single letter) shouldn't dump hundreds
    // of results into the picker any more than the old unfiltered fetch did.
    const live = await fetchLiveModels();
    const liveMatches = live.filter((m) => matches(m, q)).slice(0, 50);
    return { models: liveMatches, default: ctx.defaultModel };
  });
}
