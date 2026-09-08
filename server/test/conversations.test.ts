import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/client.js";
import { EventLog } from "../src/events/log.js";
import { Runner } from "../src/jobs/runner.js";
import { runs } from "../src/db/schema.js";
import { newId } from "../src/db/ids.js";
import type { AppContext } from "../src/context.js";
import type { FastifyInstance } from "fastify";

const TOKEN = "test-token";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  base: string;
}

async function buildHarness(): Promise<Harness> {
  const { sqlite, db } = openDatabase(":memory:");
  const eventLog = new EventLog(sqlite);
  const runner = new Runner({ sqlite, eventLog, loopDeps: { openRouterApiKey: "unused" } });
  const ctx: AppContext = { sqlite, db, eventLog, runner, push: null, openRouterApiKey: "test", defaultModel: "test/model" };
  const app = buildApp(ctx, { authToken: TOKEN, logger: false });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const base = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  return { app, ctx, base };
}

function authed(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } };
}

let harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses) {
    h.app.server.closeAllConnections?.();
    await h.app.close();
    h.ctx.sqlite.close();
  }
  harnesses = [];
});

describe("GET /conversations?before= — malformed cursors", () => {
  it.each([
    ["garbage base64url that decodes to invalid JSON", "xyz"],
    ["valid base64url of the JSON literal null", Buffer.from("null").toString("base64url")],
    ["valid base64url of a non-string id", Buffer.from(JSON.stringify([1, 2])).toString("base64url")],
  ])("returns 400 invalid_cursor instead of 500, for: %s", async (_label, cursor) => {
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/conversations?before=${encodeURIComponent(cursor)}`, authed());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_cursor" });
  });

  it("still accepts a well-formed cursor", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const good = Buffer.from(JSON.stringify([Date.now(), "conv_abc"])).toString("base64url");

    const res = await fetch(`${h.base}/conversations?before=${encodeURIComponent(good)}`, authed());
    expect(res.status).toBe(200);
  });
});

describe("archiving conversations", () => {
  async function createConversation(h: Harness): Promise<string> {
    const res = await fetch(`${h.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) }));
    const conv = (await res.json()) as { id: string };
    return conv.id;
  }

  it("hides archived conversations from the default list and surfaces them only behind archived=true", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const id = await createConversation(h);

    const archiveRes = await fetch(`${h.base}/conversations/${id}/archive`, authed({ method: "POST" }));
    expect(archiveRes.status).toBe(200);
    const archived = (await archiveRes.json()) as { archivedAt: number | null };
    expect(archived.archivedAt).not.toBeNull();

    const defaultList = (await (await fetch(`${h.base}/conversations`, authed())).json()) as { items: { id: string }[] };
    expect(defaultList.items.map((c) => c.id)).not.toContain(id);

    const explicitFalse = (await (await fetch(`${h.base}/conversations?archived=false`, authed())).json()) as { items: { id: string }[] };
    expect(explicitFalse.items.map((c) => c.id)).not.toContain(id);

    const archivedList = (await (await fetch(`${h.base}/conversations?archived=true`, authed())).json()) as { items: { id: string }[] };
    expect(archivedList.items.map((c) => c.id)).toContain(id);
  });

  it("unarchiving restores a conversation to the default list", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const id = await createConversation(h);

    await fetch(`${h.base}/conversations/${id}/archive`, authed({ method: "POST" }));
    const unarchiveRes = await fetch(`${h.base}/conversations/${id}/unarchive`, authed({ method: "POST" }));
    expect(unarchiveRes.status).toBe(200);
    const unarchived = (await unarchiveRes.json()) as { archivedAt: number | null };
    expect(unarchived.archivedAt).toBeNull();

    const defaultList = (await (await fetch(`${h.base}/conversations`, authed())).json()) as { items: { id: string }[] };
    expect(defaultList.items.map((c) => c.id)).toContain(id);
  });

  it("404s archiving/unarchiving a conversation that doesn't exist", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const archiveRes = await fetch(`${h.base}/conversations/conv_missing/archive`, authed({ method: "POST" }));
    expect(archiveRes.status).toBe(404);
    const unarchiveRes = await fetch(`${h.base}/conversations/conv_missing/unarchive`, authed({ method: "POST" }));
    expect(unarchiveRes.status).toBe(404);
  });

  it("an archived conversation is still individually fetchable, but is read-only until unarchived", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const id = await createConversation(h);
    await fetch(`${h.base}/conversations/${id}/archive`, authed({ method: "POST" }));

    const getRes = await fetch(`${h.base}/conversations/${id}`, authed());
    expect(getRes.status).toBe(200);

    const blockedRes = await fetch(`${h.base}/conversations/${id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "hi" }) }));
    expect(blockedRes.status).toBe(409);
    expect(await blockedRes.json()).toEqual({ error: "conversation_archived" });

    await fetch(`${h.base}/conversations/${id}/unarchive`, authed({ method: "POST" }));
    const sendRes = await fetch(`${h.base}/conversations/${id}/messages`, authed({ method: "POST", body: JSON.stringify({ content: "hi" }) }));
    expect(sendRes.status).toBe(202);
  });

  it("a retried send with the same clientMessageId still returns the original run even if the conversation was archived in between", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const id = await createConversation(h);

    const firstSend = await fetch(
      `${h.base}/conversations/${id}/messages`,
      authed({ method: "POST", body: JSON.stringify({ content: "hi", clientMessageId: "retry-1" }) }),
    );
    expect(firstSend.status).toBe(202);
    const firstBody = (await firstSend.json()) as { runId: string };

    await fetch(`${h.base}/conversations/${id}/archive`, authed({ method: "POST" }));

    // Same clientMessageId, replayed after archiving — this must be the
    // idempotent-dedup 200, not a 409: the send already happened, and the
    // client retrying it can't distinguish "blocked" from "never went
    // through" if archiving intercepts the retry ahead of the dedup lookup.
    const retry = await fetch(
      `${h.base}/conversations/${id}/messages`,
      authed({ method: "POST", body: JSON.stringify({ content: "hi", clientMessageId: "retry-1" }) }),
    );
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { runId: string; deduped: boolean };
    expect(retryBody.deduped).toBe(true);
    expect(retryBody.runId).toBe(firstBody.runId);

    // A genuinely new send (different clientMessageId) against the same
    // now-archived conversation must still be blocked.
    const newSend = await fetch(
      `${h.base}/conversations/${id}/messages`,
      authed({ method: "POST", body: JSON.stringify({ content: "a new message", clientMessageId: "retry-2" }) }),
    );
    expect(newSend.status).toBe(409);
  });
});

describe("GET /conversations/:id/usage", () => {
  async function createConversation(h: Harness): Promise<string> {
    const res = await fetch(`${h.base}/conversations`, authed({ method: "POST", body: JSON.stringify({ model: "test/model" }) }));
    const conv = (await res.json()) as { id: string };
    return conv.id;
  }

  function insertRun(h: Harness, conversationId: string, usage: Record<string, number> | null, status = "completed") {
    h.ctx.db
      .insert(runs)
      .values({
        id: newId("run"),
        conversationId,
        status: status as "completed" | "failed" | "cancelled",
        model: "test/model",
        usage: usage ? JSON.stringify(usage) : null,
        createdAt: Date.now(),
      })
      .run();
  }

  it("404s for a conversation that doesn't exist", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/conversations/conv_missing/usage`, authed());
    expect(res.status).toBe(404);
  });

  it("returns all-zero totals for a conversation with no runs yet", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const id = await createConversation(h);

    const res = await fetch(`${h.base}/conversations/${id}/usage`, authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inputTokens: 0, cachedTokens: 0, reasoningTokens: 0, outputTokens: 0, costUsd: 0 });
  });

  it("sums input/cached/reasoning/output tokens and cost across every run, skipping runs with no usage recorded", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const id = await createConversation(h);

    insertRun(h, id, { prompt_tokens: 100, cached_tokens: 20, reasoning_tokens: 5, completion_tokens: 50, cost_usd: 0.001 });
    insertRun(h, id, { prompt_tokens: 200, cached_tokens: 0, reasoning_tokens: 15, completion_tokens: 80, cost_usd: 0.002 });
    insertRun(h, id, null, "cancelled"); // no usage chunk ever arrived — must not count as zero-inflating anything but must not error either

    const res = await fetch(`${h.base}/conversations/${id}/usage`, authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inputTokens: 300, cachedTokens: 20, reasoningTokens: 20, outputTokens: 130, costUsd: 0.003 });
  });

  it("does not include another conversation's usage", async () => {
    const h = await buildHarness();
    harnesses.push(h);
    const idA = await createConversation(h);
    const idB = await createConversation(h);

    insertRun(h, idA, { prompt_tokens: 100, cached_tokens: 0, reasoning_tokens: 0, completion_tokens: 10, cost_usd: 0.001 });
    insertRun(h, idB, { prompt_tokens: 999, cached_tokens: 0, reasoning_tokens: 0, completion_tokens: 999, cost_usd: 9 });

    const res = await fetch(`${h.base}/conversations/${idA}/usage`, authed());
    const body = (await res.json()) as { inputTokens: number };
    expect(body.inputTokens).toBe(100);
  });
});

describe("malformed request bodies", () => {
  it("returns 400, not 500, for a body that isn't valid JSON", async () => {
    const h = await buildHarness();
    harnesses.push(h);

    const res = await fetch(`${h.base}/conversations`, authed({ method: "POST", body: "{not json" }));
    expect(res.status).toBe(400);
  });
});
