import { randomBytes } from "node:crypto";
import { openDatabase } from "./db/client.js";
import { EventLog } from "./events/log.js";
import { Runner } from "./jobs/runner.js";
import { Reaper } from "./jobs/reaper.js";
import { Pruner } from "./jobs/pruner.js";
import { PushService } from "./push/apns.js";
import { buildApp } from "./app.js";
import type { AppContext } from "./context.js";
import { parseEnv } from "./env.js";

async function main() {
  const env = parseEnv(process.env);

  const authToken = env.AUTH_TOKEN ?? randomBytes(32).toString("hex");
  if (!env.AUTH_TOKEN) {
    console.warn(`AUTH_TOKEN not set — generated a one-off token for this run: ${authToken}`);
  }
  const openRouterApiKey = env.OPENROUTER_API_KEY;
  const defaultModel = env.DEFAULT_MODEL;

  const { sqlite, db } = openDatabase(env.DATABASE_PATH);
  const eventLog = new EventLog(sqlite);

  let push: PushService | null = null;
  if (env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_SIGNING_KEY && env.APNS_TOPIC) {
    push = new PushService(sqlite, {
      team: env.APNS_TEAM_ID,
      keyId: env.APNS_KEY_ID,
      signingKey: env.APNS_SIGNING_KEY,
      topic: env.APNS_TOPIC,
      host: env.APNS_HOST,
    });
  } else {
    console.warn("APNs not configured — push notifications disabled (set APNS_TEAM_ID/APNS_KEY_ID/APNS_SIGNING_KEY/APNS_TOPIC)");
  }

  const runner = new Runner({
    sqlite,
    eventLog,
    loopDeps: {
      openRouterApiKey,
      maxPriceUsd: env.MAX_PRICE_USD,
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

  const SHUTDOWN_GRACE_MS = 10_000; // safely under the systemd unit's TimeoutStopSec=15
  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down`);
    runner.stop();
    reaper.stop();
    pruner.stop();

    // Give in-flight runs a chance to finish (and disarm their heartbeat
    // timers) before closing the database out from under them. Bounded: a
    // genuinely stuck run shouldn't block shutdown forever — it'll be
    // recovered as interrupted by the orphan scan on next boot either way.
    await Promise.race([runner.waitForIdle(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
    if (runner.activeCount > 0) {
      console.warn(`${runner.activeCount} run(s) still in flight after ${SHUTDOWN_GRACE_MS}ms; closing anyway`);
    }

    // Fastify's default close() only closes idle connections; an open SSE
    // stream is never idle and would otherwise hang this indefinitely.
    app.server.closeAllConnections?.();
    await app.close();
    if (push) await push.close();
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: env.PORT, host: env.HOST });
  console.log(`pocket-agent listening on http://${env.HOST}:${env.PORT} (web UI at /app)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
