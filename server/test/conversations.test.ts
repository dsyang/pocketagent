import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/client.js";
import { EventLog } from "../src/events/log.js";
import { Runner } from "../src/jobs/runner.js";
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
});
