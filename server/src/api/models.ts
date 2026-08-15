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
let cache: { at: number; models: Array<{ id: string; name: string }> } | null = null;

export function registerModelRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/models", async () => {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return { models: cache.models };
    }

    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${ctx.openRouterApiKey}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> };
      const models = (body.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
      if (models.length > 0) {
        cache = { at: Date.now(), models };
        return { models };
      }
    } catch {
      // fall through to curated list
    }

    return { models: CURATED_MODELS };
  });
}
