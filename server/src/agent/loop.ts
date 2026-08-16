import type Database from "better-sqlite3";
import { EventLog, type NewEvent } from "../events/log.js";
import { newId } from "../db/ids.js";
import { buildContext } from "./context.js";
import { streamChatCompletion, type OpenRouterToolSpec, type Usage } from "./openrouter.js";

export interface RunRow {
  id: string;
  conversationId: string;
  model: string;
  status: string;
  cancelRequested: number;
}

export interface LoopDeps {
  sqlite: Database.Database;
  eventLog: EventLog;
  openRouterApiKey: string;
  openRouterBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxPriceUsd?: number;
  heartbeatIntervalMs?: number;
  deltaFlushIntervalMs?: number;
  cancelPollIntervalMs?: number;
  disableTools?: boolean;
  onFinish?: (info: { conversationId: string; runId: string; status: string; finalText: string }) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_FLUSH_MS = 100;
const DEFAULT_CANCEL_POLL_MS = 250;

const WEB_TOOLS: OpenRouterToolSpec[] = [{ type: "openrouter:web_search" }, { type: "openrouter:web_fetch" }];

function getRun(sqlite: Database.Database, runId: string): RunRow | null {
  const row = sqlite
    .prepare(`SELECT id, conversation_id AS conversationId, model, status, cancel_requested AS cancelRequested FROM runs WHERE id = ?`)
    .get(runId) as RunRow | undefined;
  return row ?? null;
}

/** Executes one run to completion (or interruption). Everything durable is written incrementally, so a crash mid-run is honestly recoverable (see jobs/reaper.ts and the startup scan in jobs/runner.ts). */
export async function executeRun(deps: LoopDeps, runId: string): Promise<void> {
  const { sqlite, eventLog } = deps;
  const run = getRun(sqlite, runId);
  if (!run || run.status !== "queued") return;

  const now = Date.now();
  // CAS, not read-then-write: today nothing can race this in practice (drain()
  // dedupes via inFlight and everything up to the first await here is
  // synchronous), but that's an invariant of the caller, not this function —
  // make the guard explicit and self-defending rather than load-bearing on it.
  const claimed = sqlite
    .prepare(`UPDATE runs SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ? AND status = 'queued'`)
    .run(now, now, runId);
  if (claimed.changes === 0) return;

  if (run.cancelRequested) {
    // A cancel landed while this run was still queued — settle it without ever contacting OpenRouter.
    const finishedAt = Date.now();
    let cancelled = false;
    const txn = sqlite.transaction(() => {
      const claim = sqlite.prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'running'`).run(finishedAt, runId);
      if (claim.changes === 0) return;
      cancelled = true;
      eventLog.append(run.conversationId, runId, [{ type: "run_finished", payload: { runId, status: "cancelled", usage: null } }]);
    });
    try {
      txn();
    } finally {
      if (cancelled) eventLog.flushPending();
      else eventLog.discardPending();
    }
    if (cancelled) deps.onFinish?.({ conversationId: run.conversationId, runId, status: "cancelled", finalText: "" });
    return;
  }

  const heartbeatMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeatTimer = setInterval(() => {
    sqlite.prepare(`UPDATE runs SET heartbeat_at = ? WHERE id = ?`).run(Date.now(), runId);
  }, heartbeatMs);

  const controller = new AbortController();
  let abortReason: "cancel" | "timeout" | null = null;

  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutTimer = setTimeout(() => {
    abortReason = "timeout";
    controller.abort();
  }, timeoutMs);

  const cancelPollMs = deps.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_MS;
  const cancelTimer = setInterval(() => {
    const r = sqlite.prepare(`SELECT cancel_requested FROM runs WHERE id = ?`).get(runId) as { cancel_requested: number } | undefined;
    if (r?.cancel_requested) {
      abortReason = "cancel";
      controller.abort();
    }
  }, cancelPollMs);

  eventLog.append(run.conversationId, runId, [{ type: "run_started", payload: { runId, model: run.model } }]);

  const history = sqlite
    .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at`)
    .all(run.conversationId) as Array<{ role: "user" | "assistant"; content: string }>;
  const contextMessages = buildContext(history);

  let contentBuffer = "";
  let reasoningBuffer = "";
  let flushTimer: NodeJS.Timeout | null = null;

  const flush = () => {
    const events: NewEvent[] = [];
    if (contentBuffer) {
      events.push({ type: "assistant_delta", payload: { runId, text: contentBuffer } });
      contentBuffer = "";
    }
    if (reasoningBuffer) {
      events.push({ type: "reasoning_delta", payload: { runId, text: reasoningBuffer } });
      reasoningBuffer = "";
    }
    if (events.length) eventLog.append(run.conversationId, runId, events);
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, deps.deltaFlushIntervalMs ?? DEFAULT_FLUSH_MS);
  };

  let finalText = "";
  let usage: Usage | null = null;
  let citations: Array<{ url: string; title?: string }> = [];
  let streamError: string | null = null;

  try {
    for await (const ev of streamChatCompletion({
      apiKey: deps.openRouterApiKey,
      baseUrl: deps.openRouterBaseUrl,
      model: run.model,
      messages: contextMessages,
      tools: deps.disableTools ? undefined : WEB_TOOLS,
      maxPriceUsd: deps.maxPriceUsd,
      signal: controller.signal,
      fetchImpl: deps.fetchImpl,
    })) {
      switch (ev.type) {
        case "content":
          contentBuffer += ev.text;
          finalText += ev.text;
          scheduleFlush();
          break;
        case "reasoning":
          reasoningBuffer += ev.text;
          scheduleFlush();
          break;
        case "tool_call":
          flush();
          eventLog.append(run.conversationId, runId, [{ type: "tool_call", payload: { runId, tool: ev.tool, query: ev.query } }]);
          break;
        case "tool_result":
          flush();
          citations = citations.concat(ev.citations);
          eventLog.append(run.conversationId, runId, [
            { type: "tool_result", payload: { runId, tool: ev.tool, summary: ev.summary, citations: ev.citations } },
          ]);
          break;
        case "usage":
          usage = ev.usage;
          break;
        case "error":
          streamError = ev.message;
          break;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      streamError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(timeoutTimer);
    clearInterval(cancelTimer);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
  }

  const finishedAt = Date.now();
  let status: "completed" | "failed" | "cancelled";
  let errorMessage: string | null = null;

  if (abortReason === "cancel") {
    status = "cancelled";
    finalText += finalText ? "\n\n_[stopped]_" : "_[stopped]_";
  } else if (abortReason === "timeout") {
    status = "failed";
    errorMessage = "Run exceeded the time limit and was stopped.";
  } else if (streamError) {
    status = "failed";
    errorMessage = streamError;
  } else {
    status = "completed";
  }

  const usageJson = usage ? JSON.stringify({ prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, cost_usd: usage.costUsd }) : null;
  const citationsJson = citations.length ? JSON.stringify(citations) : null;

  const finalizeEvents: NewEvent[] = [];
  let messageId: string | null = null;

  if (status !== "failed" || finalText) {
    messageId = newId("msg");
    finalizeEvents.push({
      type: "assistant_message_final",
      payload: { runId, messageId, content: finalText, citations: citations.length ? citations : undefined },
    });
  }
  if (status === "failed") {
    finalizeEvents.push({ type: "run_error", payload: { runId, message: errorMessage ?? "Unknown error" } });
  } else {
    finalizeEvents.push({
      type: "run_finished",
      payload: { runId, status, usage: usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd: usage.costUsd } : null },
    });
  }

  const preview = finalText.slice(0, 120);

  const txn = sqlite.transaction((): boolean => {
    // CAS guard: a run can only finalize from 'running'. Without this, a
    // finalize racing the reaper's "stale heartbeat" sweep (e.g. a long
    // synchronous SQLite write blocking the event loop past the heartbeat
    // interval) would silently resurrect a run the reaper already declared
    // dead — last writer wins instead of the reaper's failure sticking.
    const claim = sqlite.prepare(`UPDATE runs SET status = ?, error = ?, usage = ?, finished_at = ? WHERE id = ? AND status = 'running'`).run(
      status,
      errorMessage,
      usageJson,
      finishedAt,
      runId,
    );
    if (claim.changes === 0) return false;

    if (messageId) {
      sqlite
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, citations, run_id, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
        )
        .run(messageId, run.conversationId, finalText, citationsJson, runId, finishedAt);
    }

    eventLog.append(run.conversationId, runId, finalizeEvents);

    // Only touch last_message_at/preview when a message was actually produced —
    // a failed run with no text (e.g. an error before any content streamed)
    // has nothing to preview, and clobbering it with '' blanks out the
    // conversation's real last message in every list view.
    if (messageId) {
      sqlite
        .prepare(`UPDATE conversations SET last_message_at = ?, last_message_preview = ?, updated_at = ? WHERE id = ?`)
        .run(finishedAt, preview, finishedAt, run.conversationId);
    } else {
      sqlite.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(finishedAt, run.conversationId);
    }
    return true;
  });

  let finalized = false;
  try {
    finalized = txn();
  } finally {
    if (finalized) eventLog.flushPending();
    else eventLog.discardPending();
  }

  if (finalized) {
    deps.onFinish?.({ conversationId: run.conversationId, runId, status, finalText });
  }
}
