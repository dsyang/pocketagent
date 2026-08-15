#!/usr/bin/env -S npx tsx
// Terminal chat client — debug tool and the only client during Phases 1-2.
// Implements the same §4 SSE contract every other client implements:
// snapshot-then-subscribe, cursor resume via ?after=, seq-gated dedup.

const BASE_URL = process.env.POCKET_AGENT_URL ?? "http://127.0.0.1:3000";
const TOKEN = process.env.POCKET_AGENT_TOKEN;

if (!TOKEN) {
  console.error("Set POCKET_AGENT_TOKEN in the environment.");
  process.exit(1);
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers: { ...authHeaders(), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} -> HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

interface ConversationListItem {
  id: string;
  title: string | null;
  model: string;
  updatedAt: number;
  lastMessagePreview: string | null;
  activeRunStatus: "queued" | "running" | null;
}

async function listConversations() {
  const result = await api<{ items: ConversationListItem[]; nextCursor: string | null }>("/conversations?limit=30");
  for (const c of result.items) {
    const status = c.activeRunStatus ? ` [${c.activeRunStatus}]` : "";
    console.log(`${c.id}  ${c.model}  ${c.title ?? "(untitled)"}${status}`);
    if (c.lastMessagePreview) console.log(`  ${c.lastMessagePreview}`);
  }
}

async function newConversation(model: string, title?: string) {
  const conv = await api<{ id: string }>("/conversations", { method: "POST", body: JSON.stringify({ model, title }) });
  console.log(conv.id);
}

// SSE parsing over a streaming fetch body: split on blank-line-delimited
// events, yield {id, event, data} — the transport any §4 client implements.
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!raw || raw.startsWith(":")) continue;
        let id: string | undefined;
        let event: string | undefined;
        const dataLines: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        yield { id, event, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function tailEvents(conversationId: string, after: number, stopOn: Set<string> | null): Promise<void> {
  const res = await fetch(`${BASE_URL}/conversations/${conversationId}/events?after=${after}`, { headers: authHeaders() });
  if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);

  for await (const evt of parseSse(res.body)) {
    if (!evt.event) continue;
    const payload = evt.data ? JSON.parse(evt.data) : {};
    switch (evt.event) {
      case "run_started":
        console.log(`\n[run ${payload.runId} started, model ${payload.model}]`);
        break;
      case "assistant_delta":
        process.stdout.write(payload.text);
        break;
      case "reasoning_delta":
        break; // silent by default in the terminal client
      case "tool_call":
        console.log(`\n[searching: ${payload.query}]`);
        break;
      case "tool_result":
        console.log(`[${payload.summary}]`);
        break;
      case "assistant_message_final":
        console.log(); // trailing newline after the streamed text
        break;
      case "run_finished":
        console.log(`[run finished: ${payload.status}]`);
        if (stopOn?.has("run_finished")) return;
        break;
      case "run_error":
        console.log(`\n[run error: ${payload.message}]`);
        if (stopOn?.has("run_error")) return;
        break;
    }
  }
}

async function sendMessage(conversationId: string, content: string) {
  const send = await api<{ runId: string; messageId: string }>(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, clientMessageId: `cli_${Date.now()}` }),
  });
  console.log(`[sent, run ${send.runId}]`);

  const snapshot = await api<{ lastSeq: number }>(`/conversations/${conversationId}`);
  await tailEvents(conversationId, snapshot.lastSeq, new Set(["run_finished", "run_error"]));
}

async function tailOnly(conversationId: string, after: number) {
  await tailEvents(conversationId, after, null);
}

async function cancelRun(runId: string) {
  const result = await api<{ status: string }>(`/runs/${runId}/cancel`, { method: "POST" });
  console.log(result);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "list":
      return listConversations();
    case "new":
      return newConversation(args[0] ?? "anthropic/claude-sonnet-5", args[1]);
    case "send":
      if (!args[0] || !args[1]) throw new Error("usage: chat.ts send <conversationId> <message>");
      return sendMessage(args[0], args.slice(1).join(" "));
    case "tail":
      if (!args[0]) throw new Error("usage: chat.ts tail <conversationId> [afterSeq]");
      return tailOnly(args[0], args[1] ? Number(args[1]) : 0);
    case "cancel":
      if (!args[0]) throw new Error("usage: chat.ts cancel <runId>");
      return cancelRun(args[0]);
    default:
      console.log("usage: chat.ts <list|new|send|tail|cancel> ...");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
