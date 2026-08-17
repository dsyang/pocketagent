import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

// The model picker's default view — a short, hand-picked list so opening the
// dialog doesn't dump OpenRouter's entire multi-hundred-model catalog on the
// user. GET /models returns only these unless the caller searches (?q=) for
// something, in which case the live catalog is searched too (see the /models
// handler below for why searches always check both, not curated-first).
//
// The current default model (ctx.defaultModel) doesn't strictly need an
// entry here — the client always pins it at the top of the list separately
// — but env.ts's DEFAULT_MODEL fallback is deliberately kept in sync with
// the "deepseek/deepseek-v4-flash-0731" entry below (see models.test.ts's
// "keeps DEFAULT_MODEL's fallback in the curated list" test), because the
// client dedupes a curated row against the pinned Default row when their
// ids match — if this list ever drops or renames that id without updating
// env.ts (or vice versa), that dedupe silently becomes a no-op and the
// default renders twice.
export const CURATED_MODELS = [
  { id: "google/gemini-3.7-flash:batch", name: "Gemini 3.7 Flash (batch)" },
  { id: "deepseek/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
  { id: "z-ai/glm-5.2", name: "GLM 5.2" },
  { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
  { id: "thinkingmachines/inkling-small", name: "Inkling Small" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra (free)" },
  { id: "qwen/qwen3.7-flash", name: "Qwen3.7 Flash" },
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

  // Only called when the caller searches (?q=) — the live catalog is
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
      const body = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
      // Defensive: an upstream entry missing `id` would otherwise become
      // `{ id: undefined, name: undefined }`, which throws out of matches()'s
      // .toLowerCase() the first time anyone searches — and since `cache` is
      // set below before that ever happens, the broken array would stay
      // cached (and every search would keep 500ing) for the full TTL.
      const models = (body.data ?? [])
        .filter((m): m is { id: string; name?: string } => typeof m.id === "string" && m.id.length > 0)
        .map((m) => ({ id: m.id, name: typeof m.name === "string" && m.name ? m.name : m.id }));
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

    // Search both tiers and union them (curated first), rather than
    // short-circuiting as soon as the curated set has any match — a
    // curated id can otherwise permanently shadow a more specific live
    // model whose id happens to be one of its substrings. E.g.
    // "google/gemini-3.7-flash:batch" is curated, so every prefix of the
    // *non*-batch "google/gemini-3.7-flash" — including its own full,
    // exact slug — also substring-matches the curated entry, making the
    // plain variant unreachable no matter what's typed. Capped: a broad
    // query (e.g. a single letter) shouldn't dump hundreds of live results
    // into the picker any more than the old unfiltered fetch did.
    const curatedMatches = CURATED_MODELS.filter((m) => matches(m, q));
    const live = await fetchLiveModels();
    const liveMatches = live.filter((m) => matches(m, q) && !curatedMatches.some((c) => c.id === m.id)).slice(0, 50);
    return { models: [...curatedMatches, ...liveMatches], default: ctx.defaultModel };
  });
}
