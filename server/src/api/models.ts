import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

// Curated fallback — a small, known-good set for the model picker. Used when
// the live OpenRouter /models fetch fails or is skipped (no network / no key).
const CURATED_MODELS = [
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
  { id: "openai/gpt-5.2", name: "GPT-5.2" },
  { id: "google/gemini-3-pro", name: "Gemini 3 Pro" },
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 30 * 1000; // don't retry the live fetch on every request while OpenRouter is unreachable
const FETCH_TIMEOUT_MS = 5_000;

export function registerModelRoutes(app: FastifyInstance, ctx: AppContext) {
  // Scoped to this registerModelRoutes call (one per app/AppContext instance) rather than
  // module-level, so separate app instances (tests, any future multi-instance use) don't share state.
  let cache: { at: number; models: Array<{ id: string; name: string }> } | null = null;
  let negativeCacheUntil = 0;

  app.get("/models", async () => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return { models: cache.models };
    }
    if (Date.now() < negativeCacheUntil) {
      return { models: CURATED_MODELS };
    }

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
        return { models };
      }
    } catch {
      negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
    }

    return { models: CURATED_MODELS };
  });
}
