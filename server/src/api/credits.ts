import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

// Two different OpenRouter endpoints, combined: /credits reports the whole
// account's lifetime purchased credits and lifetime usage (remaining balance
// is derived, since OpenRouter doesn't return it directly); /key reports
// current-key metrics including usage_weekly, the account's spend for the
// current UTC week (Monday-Sunday) — the closest thing OpenRouter exposes to
// "spend over the last 7 days" (it's a calendar week, not a trailing window,
// so it can under-report early in the week).
export interface CreditsInfo {
  remaining: number;
  weeklySpend: number;
}

const CACHE_TTL_MS = 60 * 1000; // short-lived: unlike /models' catalog, a balance is meant to look fresh
const NEGATIVE_CACHE_TTL_MS = 15 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

async function fetchOpenRouterData(apiKey: string, url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as { data?: Record<string, unknown> };
  if (!body.data) throw new Error(`malformed response from ${url}`);
  return body.data;
}

function requireNumber(data: Record<string, unknown>, field: string, url: string): number {
  const value = Number(data[field]);
  if (!Number.isFinite(value)) throw new Error(`malformed response from ${url}: missing ${field}`);
  return value;
}

export function registerCreditsRoutes(app: FastifyInstance, ctx: AppContext) {
  // Scoped per registerCreditsRoutes call (mirrors models.ts) rather than
  // module-level, so separate app instances (tests included) don't share state.
  let cache: { at: number; info: CreditsInfo } | null = null;
  let negativeCacheUntil = 0;
  let negativeCacheReason = "";

  async function fetchCredits(): Promise<{ info: CreditsInfo | null; error: string | null }> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return { info: cache.info, error: null };
    if (Date.now() < negativeCacheUntil) return { info: null, error: negativeCacheReason };

    try {
      const [credits, key] = await Promise.all([
        fetchOpenRouterData(ctx.openRouterApiKey, "https://openrouter.ai/api/v1/credits"),
        fetchOpenRouterData(ctx.openRouterApiKey, "https://openrouter.ai/api/v1/key"),
      ]);
      const totalCredits = requireNumber(credits, "total_credits", "/credits");
      const totalUsage = requireNumber(credits, "total_usage", "/credits");
      const weeklySpend = requireNumber(key, "usage_weekly", "/key");

      const info: CreditsInfo = { remaining: totalCredits - totalUsage, weeklySpend };
      cache = { at: Date.now(), info };
      return { info, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
      negativeCacheReason = message;
      return { info: null, error: message };
    }
  }

  app.get("/credits", async (_req, reply) => {
    const { info, error } = await fetchCredits();
    if (!info) return reply.code(502).send({ error: "openrouter_unavailable", message: error });
    return info;
  });
}
