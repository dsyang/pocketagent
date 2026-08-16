import type Database from "better-sqlite3";

export interface PrunerOptions {
  retentionMs?: number; // how long after run completion its replay events survive
  intervalMs?: number; // sweep cadence
}

/**
 * Deletes run_events for runs completed longer than the retention window ago
 * (§6 pruning invariant). Safe because clients always subscribe with a
 * cursor derived from a fresh snapshot, never a stored cursor from a
 * previous session — `messages` (the durable tier) is untouched.
 */
export class Pruner {
  private timer: NodeJS.Timeout | null = null;

  constructor(private sqlite: Database.Database, private opts: PrunerOptions = {}) {}

  start(): void {
    const intervalMs = this.opts.intervalMs ?? 24 * 60 * 60 * 1000;
    this.timer = setInterval(() => this.prune(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  prune(): number {
    const retentionMs = this.opts.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
    const threshold = Date.now() - retentionMs;
    const info = this.sqlite
      .prepare(
        `DELETE FROM run_events WHERE run_id IN (
           SELECT id FROM runs WHERE status IN ('completed','failed','cancelled') AND finished_at IS NOT NULL AND finished_at < ?
         )`,
      )
      .run(threshold);
    return info.changes;
  }
}
