// A scripted mock of OpenRouter's streaming chat-completions endpoint.
// Rather than standing up a real HTTP server, this builds a `fetch`
// implementation (the same seam `openrouter.ts`/`loop.ts` take as
// `fetchImpl`) whose Response body is a hand-built SSE byte stream — which
// lets tests script chunk splits (including byte-at-a-time delivery, to
// stress the line buffer), tool-call deltas, and mid-stream disconnects
// precisely.

export type FetchImpl = typeof fetch;

export function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function contentChunk(text: string): string {
  return sseChunk({ choices: [{ delta: { content: text } }] });
}

export function reasoningChunk(text: string): string {
  return sseChunk({ choices: [{ delta: { reasoning: text } }] });
}

export function toolCallChunk(index: number, id: string | undefined, name: string | undefined, argsFragment: string): string {
  return sseChunk({
    choices: [{ delta: { tool_calls: [{ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: argsFragment } }] } }],
  });
}

export function annotationsChunk(annotations: Array<{ type: string; url_citation: { url: string; title?: string } }>): string {
  return sseChunk({ choices: [{ delta: { annotations } }] });
}

export function finishChunk(reason = "stop"): string {
  return sseChunk({ choices: [{ delta: {}, finish_reason: reason }] });
}

export function usageChunk(usage: { prompt_tokens: number; completion_tokens: number; cost?: number }): string {
  return sseChunk({ usage });
}

export const DONE = "data: [DONE]\n\n";
export const HEARTBEAT = ": OPENROUTER PROCESSING\n\n";

export interface ScriptedFetchOptions {
  status?: number;
  disconnectError?: Error;
  splitBytes?: boolean;
  onRequest?: (url: string, init: RequestInit | undefined) => void;
  /** Never resolves/closes the stream — used to test the wall-clock timeout guardrail. */
  hang?: boolean;
  /** Delay between chunks (ms) — used to give a test time to flip cancel_requested mid-stream. */
  delayMs?: number;
}

export function createScriptedFetch(rawChunks: string[], opts: ScriptedFetchOptions = {}): FetchImpl {
  return (async (url: any, init: any) => {
    opts.onRequest?.(String(url), init);
    const status = opts.status ?? 200;

    if (opts.hang) {
      const signal: AbortSignal | undefined = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (signal) {
            signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
          }
        },
      });
      return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
    }

    const signal: AbortSignal | undefined = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of rawChunks) {
          if (signal?.aborted) {
            controller.error(new DOMException("Aborted", "AbortError"));
            return;
          }
          if (opts.splitBytes) {
            const bytes = encoder.encode(chunk);
            for (const b of bytes) controller.enqueue(new Uint8Array([b]));
          } else {
            controller.enqueue(encoder.encode(chunk));
          }
          await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
        }
        if (opts.disconnectError) {
          controller.error(opts.disconnectError);
          return;
        }
        controller.close();
      },
    });

    return new Response(stream, { status, headers: { "Content-Type": "text/event-stream" } });
  }) as FetchImpl;
}

/** A plain "hello" response: a couple of content chunks, usage, done. */
export function simpleAnswerScript(text: string): string[] {
  const words = text.split(" ");
  const chunks = words.map((w, i) => contentChunk(i === 0 ? w : ` ${w}`));
  return [...chunks, finishChunk("stop"), usageChunk({ prompt_tokens: 10, completion_tokens: words.length, cost: 0.0001 }), DONE];
}

/** A response that performs one web search (tool call) then answers with a citation. */
export function searchAnswerScript(query: string, answer: string, citation: { url: string; title: string }): string[] {
  return [
    toolCallChunk(0, "call_1", "web_search", JSON.stringify({ query })),
    annotationsChunk([{ type: "url_citation", url_citation: citation }]),
    contentChunk(answer),
    finishChunk("stop"),
    usageChunk({ prompt_tokens: 20, completion_tokens: 10, cost: 0.0002 }),
    DONE,
  ];
}
