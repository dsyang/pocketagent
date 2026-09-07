import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

// OpenRouter's account-wide balance, not per-key usage — GET /credits on
// their API reports the whole account's lifetime purchased credits and
// lifetime usage, regardless of which key made the request. Remaining
// balance is derived (total - used) since OpenRouter doesn't return it
// directly.
export interface CreditsInfo {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

const CACHE_TTL_MS = 60 * 1000; // short-lived: unlike /models' catalog, a balance is meant to look fresh
const NEGATIVE_CACHE_TTL_MS = 15 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

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
      const res = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${ctx.openRouterApiKey}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } };
      const totalCredits = Number(body.data?.total_credits);
      const totalUsage = Number(body.data?.total_usage);
      if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) throw new Error("malformed response");

      const info: CreditsInfo = { totalCredits, totalUsage, remaining: totalCredits - totalUsage };
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
