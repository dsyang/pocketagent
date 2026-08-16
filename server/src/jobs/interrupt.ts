import type Database from "better-sqlite3";
import type { EventLog } from "../events/log.js";

/**
 * Marks a queued/running run as failed with an "interrupted" error and
 * emits run_error. Shared by the startup orphan scan and the heartbeat
 * reaper (§7) — both discover runs whose owning process is gone. Guarded by
 * the WHERE clause so a race against the run's own finalize is a no-op.
 */
export function interruptRun(sqlite: Database.Database, eventLog: EventLog, runId: string, conversationId: string, reason: string): boolean {
  const now = Date.now();
  let interrupted = false;
  const txn = sqlite.transaction(() => {
    const info = sqlite
      .prepare(`UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')`)
      .run(reason, now, runId);
    if (info.changes === 0) return;
    interrupted = true;
    eventLog.append(conversationId, runId, [{ type: "run_error", payload: { runId, message: reason, code: "interrupted" } }]);
  });
  try {
    txn();
  } finally {
    if (interrupted) eventLog.flushPending();
    else eventLog.discardPending();
  }
  return interrupted;
}
