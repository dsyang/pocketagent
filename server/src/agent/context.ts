import type { OpenRouterMessage } from "./openrouter.js";

export const DEFAULT_SYSTEM_PROMPT =
  "You are Pocket Agent, a helpful assistant reachable from the user's phone. " +
  "You can search the web and fetch pages when useful. Be concise; this is a mobile chat.";

// Naive char-budget truncation (v1, per plan §2 — summarization later): keep
// the system prompt plus as much recent history as fits, dropping the
// oldest turns first, always keeping at least the most recent message.
export function buildContext(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  opts: { systemPrompt?: string; maxChars?: number } = {},
): OpenRouterMessage[] {
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxChars = opts.maxChars ?? 200_000;

  let budget = maxChars - systemPrompt.length;
  const kept: OpenRouterMessage[] = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    budget -= m.content.length; // charge before checking, so maxChars is actually respected
    if (budget < 0 && kept.length > 0) break;
    kept.unshift({ role: m.role, content: m.content });
  }

  return [{ role: "system", content: systemPrompt }, ...kept];
}
