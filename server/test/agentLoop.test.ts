import { describe, it, expect } from "vitest";
import { executeRun } from "../src/agent/loop.js";
import { setupDb, createConversation, createUserMessageAndRun, newEventLog } from "./helpers.js";
import { createScriptedFetch, simpleAnswerScript, searchAnswerScript, DONE, contentChunk, finishChunk } from "./mockOpenRouter.js";

function getRunRow(sqlite: import("better-sqlite3").Database, runId: string) {
  return sqlite.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as any;
}
function getMessages(sqlite: import("better-sqlite3").Database, conversationId: string) {
  return sqlite.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at`).all(conversationId) as any[];
}
function getEvents(sqlite: import("better-sqlite3").Database, conversationId: string) {
  return sqlite.prepare(`SELECT * FROM run_events WHERE conversation_id = ? ORDER BY seq`).all(conversationId) as any[];
}

describe("agent loop", () => {
  it("streams content, finalizes the assistant message, and marks the run completed", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "hello there");

    const fetchImpl = createScriptedFetch(simpleAnswerScript("hi how can I help"));
    await executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl, deltaFlushIntervalMs: 5 }, runId);

    const run = getRunRow(sqlite, runId);
    expect(run.status).toBe("completed");
    expect(run.finished_at).not.toBeNull();

    const messages = getMessages(sqlite, conv);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("hi how can I help");

    const events = getEvents(sqlite, conv);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_started");
    expect(types).toContain("assistant_delta");
    expect(types.at(-2)).toBe("assistant_message_final");
    expect(types.at(-1)).toBe("run_finished");
  });

  it("surfaces web_search tool activity as tool_call/tool_result events with citations", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "what's new today");

    const fetchImpl = createScriptedFetch(
      searchAnswerScript("today's news", "Here's what happened.", { url: "https://example.com/a", title: "Example Article" }),
    );
    await executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl, deltaFlushIntervalMs: 5 }, runId);

    const events = getEvents(sqlite, conv);
    const toolCall = events.find((e) => e.type === "tool_call");
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolCall).toBeDefined();
    expect(JSON.parse(toolCall.payload).query).toBe("today's news");
    expect(toolResult).toBeDefined();
    const citations = JSON.parse(toolResult.payload).citations;
    expect(citations).toEqual([{ url: "https://example.com/a", title: "Example Article" }]);

    const messages = getMessages(sqlite, conv);
    const assistantCitations = JSON.parse(messages[1].citations);
    expect(assistantCitations).toEqual([{ url: "https://example.com/a", title: "Example Article" }]);
  });

  it("captures usage/cost from the final SSE usage chunk", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "hi");

    const fetchImpl = createScriptedFetch(simpleAnswerScript("hello"));
    await executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl, deltaFlushIntervalMs: 5 }, runId);

    const run = getRunRow(sqlite, runId);
    const usage = JSON.parse(run.usage);
    expect(usage.completion_tokens).toBe(1);
    expect(usage.cost_usd).toBeGreaterThan(0);
  });

  it("handles a mid-stream disconnect as a failed run with run_error, not a crash", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "hi");

    const fetchImpl = createScriptedFetch([contentChunk("partial")], { disconnectError: new Error("socket hang up") });
    await executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl, deltaFlushIntervalMs: 5 }, runId);

    const run = getRunRow(sqlite, runId);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("socket hang up");

    const events = getEvents(sqlite, conv);
    expect(events.map((e) => e.type)).toContain("run_error");
  });

  it("respects cancel_requested: stops the stream, marks the run cancelled, keeps partial text", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "hi");

    // A slow-trickling stream so there's time to flip cancel_requested mid-flight.
    const chunks = ["one ", "two ", "three ", "four ", "five "].map((w) => contentChunk(w));
    const fetchImpl = createScriptedFetch([...chunks, finishChunk("stop"), DONE], { delayMs: 15 });

    const runPromise = executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl, deltaFlushIntervalMs: 5, cancelPollIntervalMs: 5 }, runId);
    setTimeout(() => {
      sqlite.prepare(`UPDATE runs SET cancel_requested = 1 WHERE id = ?`).run(runId);
    }, 20);
    await runPromise;

    const run = getRunRow(sqlite, runId);
    expect(run.status).toBe("cancelled");

    const messages = getMessages(sqlite, conv);
    expect(messages[1].content).toContain("[stopped]");

    const events = getEvents(sqlite, conv);
    const finished = events.find((e) => e.type === "run_finished");
    expect(JSON.parse(finished.payload).status).toBe("cancelled");
  });

  it("enforces the wall-clock timeout guardrail on a hung stream", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "hi");

    const fetchImpl = createScriptedFetch([], { hang: true });
    await executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl, timeoutMs: 30 }, runId);

    const run = getRunRow(sqlite, runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/time limit/i);
  });

  it("does not resurrect a run the reaper already marked failed while it was still executing", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "hi");

    const fetchImpl = createScriptedFetch(simpleAnswerScript("hello there"), { delayMs: 15 });
    const runPromise = executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl, deltaFlushIntervalMs: 5 }, runId);

    // Simulate the reaper's stale-heartbeat sweep landing mid-flight (e.g. a long
    // synchronous SQLite write blocked the event loop past the heartbeat interval).
    setTimeout(() => {
      sqlite.prepare(`UPDATE runs SET status = 'failed', error = 'interrupted (stale heartbeat)', finished_at = ? WHERE id = ?`).run(Date.now(), runId);
    }, 20);
    await runPromise;

    const run = getRunRow(sqlite, runId);
    expect(run.status).toBe("failed"); // the reaper's verdict sticks — not overwritten to 'completed'
    expect(run.error).toBe("interrupted (stale heartbeat)");

    // No assistant message should have been inserted after the reap, and the
    // conversation's preview must still reflect the reaper's own run_error event
    // — not get clobbered by this finalize resurrecting itself.
    const messages = getMessages(sqlite, conv);
    expect(messages).toHaveLength(1); // just the user message
  });

  it("short-circuits a run already cancel_requested at pickup time to 'cancelled' without ever calling OpenRouter", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "hi");
    sqlite.prepare(`UPDATE runs SET cancel_requested = 1 WHERE id = ?`).run(runId);

    let fetchCalled = false;
    const fetchImpl = (async () => {
      fetchCalled = true;
      throw new Error("should not be called — a run cancelled before pickup must not contact OpenRouter");
    }) as typeof fetch;

    await executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl }, runId);

    expect(fetchCalled).toBe(false);
    const run = getRunRow(sqlite, runId);
    expect(run.status).toBe("cancelled");

    const events = getEvents(sqlite, conv);
    expect(events.map((e) => e.type)).toEqual(["run_finished"]);
    expect(JSON.parse(events[0].payload).status).toBe("cancelled");
  });

  it("calls onFinish with the final status once the run settles", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    const { runId } = createUserMessageAndRun(sqlite, conv, "hi");

    let finishInfo: any = null;
    const fetchImpl = createScriptedFetch(simpleAnswerScript("done"));
    await executeRun({ sqlite, eventLog, openRouterApiKey: "test", fetchImpl, onFinish: (info) => (finishInfo = info) }, runId);

    expect(finishInfo).toEqual({ conversationId: conv, runId, status: "completed", finalText: "done" });
  });
});
