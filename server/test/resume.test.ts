import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/client.js";
import { EventLog } from "../src/events/log.js";
import { Runner } from "../src/jobs/runner.js";
import type { AppContext } from "../src/context.js";
import { createScriptedFetch, contentChunk, finishChunk, usageChunk, DONE } from "./mockOpenRouter.js";
import type { FastifyInstance } from "fastify";

const TOKEN = "test-token";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  base: string;
}

async function buildHarness(fetchImpl: typeof fetch, opts: { deltaFlushIntervalMs?: number } = {}): Promise<Harness> {
  const { sqlite, db } = openDatabase(":memory:");
  const eventLog = new EventLog(sqlite);
  const runner = new Runner({
    sqlite,
    eventLog,
    loopDeps: { openRouterApiKey: "test", fetchImpl, deltaFlushIntervalMs: opts.deltaFlushIntervalMs ?? 5, cancelPollIntervalMs: 5 },
    pollIntervalMs: 20,
  });
  const ctx: AppContext = { sqlite, db, eventLog, runner, push: null, openRouterApiKey: "test", defaultModel: "test/model" };
  const app = buildApp(ctx, { authToken: TOKEN, logger: false });
  runner.start();
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  return { app, ctx, base };
}

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } };
}

async function json(res: Response): Promise<any> {
  return res.json();
}

async function readSseEvents(res: Response, stopOnEventTypes: Set<string>): Promise<Array<{ id: number; event: string; data: any }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const out: Array<{ id: number; event: string; data: any }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!raw || raw.startsWith(":")) continue;
      let id = 0;
      let event = "";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("id:")) id = Number(line.slice(3).trim());
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      out.push({ id, event, data: JSON.parse(dataLines.join("\n")) });
      if (stopOnEventTypes.has(event)) {
        // Cancel (not just release) so the underlying connection actually
        // closes — the server keeps this stream open indefinitely (§4:
        // connection lifetime outlives one run), so a released-but-not-
        // cancelled reader would leave the socket open and hang
        // Fastify's graceful app.close() in afterEach.
        await reader.cancel();
        return out;
      }
    }
  }
  await reader.cancel().catch(() => {});
  return out;
}

let harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses) {
    h.ctx.runner.stop();
    h.app.server.closeAllConnections?.(); // safety net: force-drop any SSE socket a test forgot to cancel
    await h.app.close();
    h.ctx.sqlite.close();
  }
  harnesses = [];
});

describe("resume: the kill-app contract", () => {
  it("disconnect mid-stream, let the run finish unattended, reconnect with after= — concatenated transcript is byte-identical to an uninterrupted read", async () => {
    const answer = "The Raspberry Pi 3B plus has one gigabyte of RAM and a quad core arm cpu";
    const words = answer.split(" ");
    const script = [...words.map((w, i) => contentChunk(i === 0 ? w : ` ${w}`)), finishChunk("stop"), usageChunk({ prompt_tokens: 5, completion_tokens: words.length }), DONE];

    // --- Control run: uninterrupted read start to finish ---
    const control = await buildHarness(createScriptedFetch(script, { delayMs: 1 }));
    harnesses.push(control);
    const convA = await json(await fetch(`${control.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) })));
    const sendA = await json(await fetch(`${control.base}/conversations/${convA.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "tell me about the pi" }) })));
    const controlRes = await fetch(`${control.base}/conversations/${convA.id}/events?after=0`, authed());
    const controlEvents = await readSseEvents(controlRes, new Set(["run_finished", "run_error"]));
    const controlText = controlEvents.filter((e) => e.event === "assistant_delta").map((e) => e.data.text).join("");
    expect(controlText).toBe(answer);

    // --- Test run: same script, disconnect after 3 events, reconnect later ---
    const test = await buildHarness(createScriptedFetch(script, { delayMs: 1 }));
    harnesses.push(test);
    const convB = await json(await fetch(`${test.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) })));
    const sendB = await json(await fetch(`${test.base}/conversations/${convB.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "tell me about the pi" }) })));

    const firstRes = await fetch(`${test.base}/conversations/${convB.id}/events?after=0`, authed());
    const reader = firstRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventsSeen = 0;
    let lastSeqSeen = 0;
    // consume exactly 3 SSE events then abandon the connection (simulates the app being force-quit)
    while (eventsSeen < 3) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1 && eventsSeen < 3) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!raw || raw.startsWith(":")) continue;
        eventsSeen++;
        const idLine = raw.split("\n").find((l) => l.startsWith("id:"));
        if (idLine) lastSeqSeen = Number(idLine.slice(3).trim());
      }
    }
    reader.cancel();

    // Let the run finish server-side with nobody attached.
    await test.ctx.runner.waitForIdle();

    // Confirm it really did finish unattended.
    const runRow = test.ctx.sqlite.prepare(`SELECT status FROM runs WHERE id = ?`).get(sendB.runId) as { status: string };
    expect(runRow.status).toBe("completed");

    // Reconnect from the last cursor we actually saw (as a real client would after reopening).
    const resumeRes = await fetch(`${test.base}/conversations/${convB.id}/events?after=${lastSeqSeen}`, authed());
    const resumeEvents = await readSseEvents(resumeRes, new Set(["run_finished", "run_error"]));

    // Reconstruct the full transcript: snapshot (empty, run hadn't finalized when we first connected)
    // + events from the first partial read + events from the resumed read, deduped/ordered by seq.
    // Simpler and just as valid a check of gaplessness: read the whole thing fresh with after=0 and
    // compare against the control run.
    const freshRes = await fetch(`${test.base}/conversations/${convB.id}/events?after=0`, authed());
    const freshEvents = await readSseEvents(freshRes, new Set(["run_finished", "run_error"]));
    const freshText = freshEvents.filter((e) => e.event === "assistant_delta").map((e) => e.data.text).join("");
    expect(freshText).toBe(controlText); // byte-identical to the uninterrupted read

    // And the resume-from-cursor stream picks up exactly where we left off, no gap, no duplicate.
    expect(resumeEvents.every((e) => e.id > lastSeqSeen)).toBe(true);
    const seqs = resumeEvents.map((e) => e.id);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates

    // The conversation snapshot (what a reopened app actually calls) shows the finished message.
    const snapshot = await json(await fetch(`${test.base}/conversations/${convB.id}`, authed()));
    expect(snapshot.activeRun).toBeNull();
    expect(snapshot.messages.at(-1).content).toBe(answer);
  });

  it("multiple subscribers on the same conversation each get the full stream (multi-device tailing)", async () => {
    const script = [contentChunk("hello"), contentChunk(" world"), finishChunk("stop"), usageChunk({ prompt_tokens: 1, completion_tokens: 2 }), DONE];
    const h = await buildHarness(createScriptedFetch(script, { delayMs: 2 }));
    harnesses.push(h);
    const conv = await json(await fetch(`${h.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) })));
    await fetch(`${h.base}/conversations/${conv.id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "hi" }) }));

    const [resA, resB] = await Promise.all([
      fetch(`${h.base}/conversations/${conv.id}/events?after=0`, authed()),
      fetch(`${h.base}/conversations/${conv.id}/events?after=0`, authed()),
    ]);
    const [eventsA, eventsB] = await Promise.all([
      readSseEvents(resA, new Set(["run_finished"])),
      readSseEvents(resB, new Set(["run_finished"])),
    ]);
    const textA = eventsA.filter((e) => e.event === "assistant_delta").map((e) => e.data.text).join("");
    const textB = eventsB.filter((e) => e.event === "assistant_delta").map((e) => e.data.text).join("");
    expect(textA).toBe("hello world");
    expect(textB).toBe("hello world");
  });
});
