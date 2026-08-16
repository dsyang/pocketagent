import type Database from "better-sqlite3";
import type { EventLog } from "../events/log.js";
import { interruptRun } from "./interrupt.js";

export interface ReaperOptions {
  staleMs?: number; // how old heartbeat_at must be to count as wedged
  intervalMs?: number; // sweep cadence
}

/** Marks `running` rows with a stale heartbeat as interrupted — covers wedged loops (§7), not just crashes. */
export class Reaper {
  private timer: NodeJS.Timeout | null = null;

  constructor(private sqlite: Database.Database, private eventLog: EventLog, private opts: ReaperOptions = {}) {}

  start(): void {
    const intervalMs = this.opts.intervalMs ?? 30_000;
    this.timer = setInterval(() => this.sweep(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sweep(): number {
    const staleMs = this.opts.staleMs ?? 30_000;
    const threshold = Date.now() - staleMs;
    const rows = this.sqlite
      .prepare(`SELECT id, conversation_id AS conversationId FROM runs WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`)
      .all(threshold) as Array<{ id: string; conversationId: string }>;
    let count = 0;
    for (const r of rows) {
      if (interruptRun(this.sqlite, this.eventLog, r.id, r.conversationId, "interrupted (stale heartbeat)")) count++;
    }
    return count;
  }
}
