import type Database from "better-sqlite3";
import type { EventLog } from "../events/log.js";
import { executeRun, type LoopDeps } from "../agent/loop.js";
import { interruptRun } from "./interrupt.js";

export interface RunnerOptions {
  sqlite: Database.Database;
  eventLog: EventLog;
  loopDeps: Omit<LoopDeps, "sqlite" | "eventLog">;
  pollIntervalMs?: number;
  onRunError?: (runId: string, err: unknown) => void;
}

/**
 * In-process job runner over the `runs` table (§9 — durability is the row,
 * not a broker). `nudge()` is called right after a send-message transaction
 * for near-instant pickup; a background poll is the backstop for anything
 * missed. `start()` first reclaims orphans: any queued/running row found at
 * boot necessarily predates this process, since nothing could legitimately
 * be mid-flight before the runner has started (§7 crash recovery).
 */
export class Runner {
  private inFlight = new Set<string>();
  private stopped = true;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private opts: RunnerOptions) {}

  recoverOrphans(): number {
    const { sqlite, eventLog } = this.opts;
    const rows = sqlite.prepare(`SELECT id, conversation_id AS conversationId FROM runs WHERE status IN ('queued','running')`).all() as Array<{
      id: string;
      conversationId: string;
    }>;
    let count = 0;
    for (const r of rows) {
      if (interruptRun(sqlite, eventLog, r.id, r.conversationId, "interrupted")) count++;
    }
    return count;
  }

  start(): void {
    this.stopped = false;
    this.recoverOrphans();
    const intervalMs = this.opts.pollIntervalMs ?? 500;
    this.pollTimer = setInterval(() => this.drain(), intervalMs);
    this.drain();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  nudge(): void {
    if (!this.stopped) this.drain();
  }

  private drain(): void {
    if (this.stopped) return;
    const rows = this.opts.sqlite.prepare(`SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at`).all() as Array<{ id: string }>;
    for (const r of rows) {
      if (this.inFlight.has(r.id)) continue;
      this.inFlight.add(r.id);
      executeRun({ sqlite: this.opts.sqlite, eventLog: this.opts.eventLog, ...this.opts.loopDeps }, r.id)
        .catch((err) => this.opts.onRunError?.(r.id, err))
        .finally(() => this.inFlight.delete(r.id));
    }
  }

  get activeCount(): number {
    return this.inFlight.size;
  }

  /** Test helper: resolves once no run is in flight (polls, since runs finish asynchronously). */
  async waitForIdle(pollMs = 20): Promise<void> {
    while (this.inFlight.size > 0) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
