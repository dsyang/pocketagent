// Streaming client for OpenRouter's OpenAI-compatible chat completions
// endpoint, plus the `openrouter:web_search` / `openrouter:web_fetch`
// server tools (§3).
//
// NOTE on the tool wire format: OpenRouter's public docs describe the
// *request* shape for server tools precisely (`tools: [{type:
// "openrouter:web_search"}, ...]`) and the *non-streaming* response shape
// (citations as `message.annotations[].url_citation`), but do not publish
// exact streaming-delta shapes for server-tool activity. This client
// follows standard OpenAI-compatible streaming conventions — tool
// invocations surface as `delta.tool_calls[]` (accumulated by index) and
// citations as `delta.annotations[]` / the final message's `annotations`
// — with everything else ignored defensively. Verify against a live
// OpenRouter account during the Phase 2 smoke test and adjust field names
// here if reality differs; `mockOpenRouter.ts` in tests scripts exactly
// this shape so the parsing logic itself is covered either way.

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterToolSpec {
  type: "openrouter:web_search" | "openrouter:web_fetch";
  parameters?: Record<string, unknown>;
}

export interface StreamChatOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  messages: OpenRouterMessage[];
  tools?: OpenRouterToolSpec[];
  maxPriceUsd?: number;
  signal?: AbortSignal;
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export type StreamEvent =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; tool: string; query: string }
  | { type: "tool_result"; tool: string; summary: string; citations: Array<{ url: string; title?: string }> }
  | { type: "usage"; usage: Usage }
  | { type: "error"; message: string };

interface PendingToolCall {
  id: string;
  name: string;
  argsText: string;
  emitted: boolean;
}

// Best-effort typing for the guessed wire format described in the file
// header — this is the one place that parses untrusted, unverified
// third-party JSON, so a type here (over `any`) at least makes every field
// access show up as `unknown`/optional rather than silently `any`.
interface StreamChunk {
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; total_cost?: number };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string;
      reasoning?: string;
      annotations?: unknown;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    message?: { annotations?: unknown };
  }>;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function toolLabel(functionName: string): string {
  // Server tools may come back named "web_search"/"web_fetch" or namespaced
  // "openrouter:web_search" depending on account/model — normalize both.
  return functionName.replace(/^openrouter:/, "");
}

function extractQuery(argsText: string): string {
  try {
    const parsed = JSON.parse(argsText) as Record<string, unknown>;
    const q = parsed.query ?? parsed.q ?? parsed.url ?? parsed.search ?? "";
    return typeof q === "string" ? q : JSON.stringify(parsed);
  } catch {
    return argsText.slice(0, 200);
  }
}

function extractCitations(annotations: unknown): Array<{ url: string; title?: string }> {
  if (!Array.isArray(annotations)) return [];
  const out: Array<{ url: string; title?: string }> = [];
  for (const a of annotations) {
    const uc = (a as { url_citation?: { url?: string; title?: string } })?.url_citation;
    if (uc?.url) out.push({ url: uc.url, title: uc.title });
  }
  return out;
}

export async function* streamChatCompletion(opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.maxPriceUsd !== undefined) {
    body.provider = { max_price: { completion: opts.maxPriceUsd } };
  }

  const res = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      ...(opts.referer ? { "HTTP-Referer": opts.referer } : {}),
      ...(opts.title ? { "X-Title": opts.title } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    yield { type: "error", message: `OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}` };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pendingCalls = new Map<number, PendingToolCall>();

  const flushToolCall = function* (call: PendingToolCall): Generator<StreamEvent> {
    if (call.emitted) return;
    call.emitted = true;
    yield { type: "tool_call", tool: toolLabel(call.name), query: extractQuery(call.argsText) };
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith(":")) continue; // SSE comment/heartbeat
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue;
        }

        if (chunk.usage) {
          yield {
            type: "usage",
            usage: {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              costUsd: chunk.usage.cost ?? chunk.usage.total_cost ?? 0,
            },
          };
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "content", text: delta.content };
        }
        if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
          yield { type: "reasoning", text: delta.reasoning };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let call = pendingCalls.get(idx);
            if (!call) {
              call = { id: tc.id ?? `tc_${idx}`, name: "", argsText: "", emitted: false };
              pendingCalls.set(idx, call);
            }
            if (tc.function?.name) call.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") call.argsText += tc.function.arguments;
          }
        }

        const citations = extractCitations(delta.annotations ?? choice?.message?.annotations);
        if (citations.length > 0) {
          // Attribute to the most recently seen tool call (there's rarely more than one in flight).
          const call = [...pendingCalls.values()].at(-1);
          if (call) {
            yield* flushToolCall(call);
            yield {
              type: "tool_result",
              tool: toolLabel(call.name || "web_search"),
              summary: `Found ${citations.length} source${citations.length === 1 ? "" : "s"}`,
              citations,
            };
          }
        }

        if (choice?.finish_reason && choice.finish_reason !== "tool_calls") {
          for (const call of pendingCalls.values()) yield* flushToolCall(call);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
