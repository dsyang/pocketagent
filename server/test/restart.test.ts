import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/client.js";
import { EventLog } from "../src/events/log.js";
import { Runner } from "../src/jobs/runner.js";
import { newId } from "../src/db/ids.js";

// Simulates a process crash mid-run: a run is left `running` in the DB file,
// then a *fresh* process (fresh Runner/EventLog instances over the same
// file) boots and must honestly report it as interrupted (§7) rather than
// silently resuming or hanging forever.
describe("restart: orphaned runs are honestly recovered", () => {
  it("marks running rows found at startup as failed/interrupted, but leaves queued rows for drain()", async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pocket-agent-restart-")), "test.db");

    // --- "Process A": create a conversation with a run stuck in `running`, then vanish (no clean shutdown). ---
    const convId = newId("conv");
    const runningId = newId("run");
    const queuedId = newId("run");
    {
      const { sqlite } = openDatabase(dbPath);
      const now = Date.now();
      sqlite.prepare(`INSERT INTO conversations (id, model, last_seq, created_at, updated_at) VALUES (?, 'test/model', 0, ?, ?)`).run(convId, now, now);
      sqlite
        .prepare(`INSERT INTO runs (id, conversation_id, status, model, started_at, heartbeat_at, created_at) VALUES (?, ?, 'running', 'test/model', ?, ?, ?)`)
        .run(runningId, convId, now, now, now);
      // A queued run has produced no side effects (no OpenRouter call, no partial
      // text, no run_started event) — it's trivially resumable and should be left
      // for drain() to pick up normally, not thrown away as if it were mid-flight.
      sqlite.prepare(`INSERT INTO runs (id, conversation_id, status, model, created_at) VALUES (?, ?, 'queued', 'test/model', ?)`).run(queuedId, convId, now);
      sqlite.close(); // no graceful shutdown — this is the crash
    }

    // --- "Process B": boots fresh over the same file. ---
    const { sqlite } = openDatabase(dbPath);
    const eventLog = new EventLog(sqlite);
    const runner = new Runner({ sqlite, eventLog, loopDeps: { openRouterApiKey: "unused" } });
    const recovered = runner.recoverOrphans();
    expect(recovered).toBe(1); // only the running row

    const runningRow = sqlite.prepare(`SELECT status, error FROM runs WHERE id = ?`).get(runningId) as { status: string; error: string };
    expect(runningRow.status).toBe("failed");
    expect(runningRow.error).toBe("interrupted");

    const queuedRow = sqlite.prepare(`SELECT status, error FROM runs WHERE id = ?`).get(queuedId) as { status: string; error: string | null };
    expect(queuedRow.status).toBe("queued");
    expect(queuedRow.error).toBeNull();

    const events = sqlite.prepare(`SELECT type, run_id FROM run_events WHERE conversation_id = ? ORDER BY seq`).all(convId) as Array<{
      type: string;
      run_id: string;
    }>;
    expect(events.filter((e) => e.type === "run_error").map((e) => e.run_id)).toEqual([runningId]);

    sqlite.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("does not touch runs that already finished before restart", async () => {
    const { sqlite } = openDatabase(":memory:");
    const eventLog = new EventLog(sqlite);
    const convId = newId("conv");
    const now = Date.now();
    sqlite.prepare(`INSERT INTO conversations (id, model, last_seq, created_at, updated_at) VALUES (?, 'test/model', 0, ?, ?)`).run(convId, now, now);
    const doneId = newId("run");
    sqlite
      .prepare(`INSERT INTO runs (id, conversation_id, status, model, finished_at, created_at) VALUES (?, ?, 'completed', 'test/model', ?, ?)`)
      .run(doneId, convId, now, now);

    const runner = new Runner({ sqlite, eventLog, loopDeps: { openRouterApiKey: "unused" } });
    const recovered = runner.recoverOrphans();
    expect(recovered).toBe(0);

    const row = sqlite.prepare(`SELECT status FROM runs WHERE id = ?`).get(doneId) as { status: string };
    expect(row.status).toBe("completed");
  });
});
