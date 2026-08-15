import { randomBytes } from "node:crypto";
import { openDatabase } from "./db/client.js";
import { EventLog } from "./events/log.js";
import { Runner } from "./jobs/runner.js";
import { Reaper } from "./jobs/reaper.js";
import { Pruner } from "./jobs/pruner.js";
import { PushService } from "./push/apns.js";
import { buildApp } from "./app.js";
import type { AppContext } from "./context.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const dbPath = process.env.DATABASE_PATH ?? "./data/pocket-agent.db";
  const authToken = process.env.AUTH_TOKEN ?? randomBytes(32).toString("hex");
  if (!process.env.AUTH_TOKEN) {
    console.warn(`AUTH_TOKEN not set — generated a one-off token for this run: ${authToken}`);
  }
  const openRouterApiKey = requireEnv("OPENROUTER_API_KEY");
  const defaultModel = process.env.DEFAULT_MODEL ?? "anthropic/claude-sonnet-5";
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";

  const { sqlite, db } = openDatabase(dbPath);
  const eventLog = new EventLog(sqlite);

  let push: PushService | null = null;
  if (process.env.APNS_TEAM_ID && process.env.APNS_KEY_ID && process.env.APNS_SIGNING_KEY && process.env.APNS_TOPIC) {
    push = new PushService(sqlite, {
      team: process.env.APNS_TEAM_ID,
      keyId: process.env.APNS_KEY_ID,
      signingKey: process.env.APNS_SIGNING_KEY,
      topic: process.env.APNS_TOPIC,
      host: process.env.APNS_HOST,
    });
  } else {
    console.warn("APNs not configured — push notifications disabled (set APNS_TEAM_ID/APNS_KEY_ID/APNS_SIGNING_KEY/APNS_TOPIC)");
  }

  const runner = new Runner({
    sqlite,
    eventLog,
    loopDeps: {
      openRouterApiKey,
      maxPriceUsd: process.env.MAX_PRICE_USD ? Number(process.env.MAX_PRICE_USD) : undefined,
      onFinish: ({ conversationId, runId, status, finalText }) => {
        if (!push) return;
        if (eventLog.listenerCount(conversationId) > 0) return; // client was watching live, no push needed
        if (status === "cancelled") return;
        const conversation = sqlite.prepare(`SELECT title FROM conversations WHERE id = ?`).get(conversationId) as { title: string | null } | undefined;
        const body = status === "failed" ? "The run hit an error." : finalText || "New reply.";
        push.notifyRunFinished({ conversationId, title: conversation?.title ?? null, body }).catch((err) => {
          console.error(`push failed for run ${runId}`, err);
        });
      },
    },
    onRunError: (runId, err) => console.error(`run ${runId} crashed`, err),
  });

  const reaper = new Reaper(sqlite, eventLog);
  const pruner = new Pruner(sqlite);

  const ctx: AppContext = { sqlite, db, eventLog, runner, push, openRouterApiKey, defaultModel };
  const app = buildApp(ctx, { authToken, logger: true, serveStatic: true });

  runner.start();
  reaper.start();
  pruner.start();

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    runner.stop();
    reaper.stop();
    pruner.stop();
    await app.close();
    if (push) await push.close();
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host });
  console.log(`pocket-agent listening on http://${host}:${port} (web UI at /app)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
