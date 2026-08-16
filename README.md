# Pocket Agent

A mobile-chat-style agent with a durable server-side brain: send a message, kill the app, and the agent keeps running on your own server. Reopening shows the finished (or still-streaming) answer.

Full design: see [PLAN-pocket-agent.md](https://github.com/dsyang/claudecodeplayground/blob/main/PLAN-pocket-agent.md).

This repo currently implements **Phases 1, 2, and 2.5** of the plan: the durable server, the CLI debug client, and the static web client. The KMP mobile app (Phase 3+) is not yet built.

## What's here

```
server/
├── src/            # Fastify API + agent loop + event log + jobs, over SQLite (WAL)
├── cli/chat.ts      # terminal chat client — send, tail SSE, list conversations
├── public/index.html # the entire web client: no build step, served at /app
├── deploy/          # systemd unit, Pi setup doc, deploy script
└── test/            # vitest suite incl. the resume/restart/pruning/pagination contract tests
```

## Quickstart (local dev)

```bash
cd server
pnpm install
pnpm run test        # full suite, no external services required (mocked OpenRouter)
pnpm run typecheck

export OPENROUTER_API_KEY=sk-or-...
export AUTH_TOKEN=$(openssl rand -hex 32)
pnpm run dev          # http://127.0.0.1:3000, web UI at /app
```

In another shell:

```bash
export POCKET_AGENT_URL=http://127.0.0.1:3000
export POCKET_AGENT_TOKEN=$AUTH_TOKEN
pnpm --dir server chat new anthropic/claude-sonnet-5 "first chat"
pnpm --dir server chat send <conversationId> "hello!"
```

Ctrl-C mid-stream, then `pnpm --dir server chat tail <conversationId>` to watch the finished answer replay from the server — the core promise, provable without any client-side state at all.

## Deploying to a Raspberry Pi

See [`server/deploy/setup-pi.md`](server/deploy/setup-pi.md).

## Status vs. the plan

- ✅ §1–9: event log, agent loop, OpenRouter streaming + web search/fetch tools, REST/SSE API, bearer auth, crash recovery (reaper + startup scan), pruning, cancellation, idempotent sends, keyset-paginated conversation list.
- ✅ CLI (`cli/chat.ts`) and the static web page (`public/index.html`), including one-tap conversation archiving (`POST /conversations/:id/archive`) — archived conversations are hidden from the default list and only appear when `?archived=true` is passed.
- ✅ §13 test suite, including the flagship `resume.test.ts` kill-app contract test, the restart (crash recovery) test, the pruning invariant test, and pagination stability under reshuffling.
- ⏳ Not built: APNs push is wired up (`src/push/apns.ts`) but untested against real Apple credentials; the KMP mobile app (§11, Phase 3+); the device install/distribution pipeline (Phase 3.5); the client-side SQLite cache (§12, Phase 4).
- ⚠️ The OpenRouter `openrouter:web_search`/`openrouter:web_fetch` server-tool streaming wire format isn't fully documented publicly — `src/agent/openrouter.ts` implements it against standard OpenAI-compatible streaming conventions and should be re-verified against a live OpenRouter account (the plan's own Phase 2 smoke test).
