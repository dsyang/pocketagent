import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";

export interface NewEvent {
  type: string;
  payload: unknown;
}

export interface RunEventRow {
  conversationId: string;
  seq: number;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

interface RawRow {
  conversation_id: string;
  seq: number;
  run_id: string;
  type: string;
  payload: string;
  created_at: number;
}

function fromRaw(r: RawRow): RunEventRow {
  return {
    conversationId: r.conversation_id,
    seq: r.seq,
    runId: r.run_id,
    type: r.type,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
  };
}

/**
 * Append-only per-conversation event log over the run_events table.
 *
 * append() allocates the seq range and inserts rows in one transaction
 * (SQLite has a single writer, better-sqlite3 transactions are synchronous,
 * so no async interleaving is possible mid-transaction — race-free by
 * construction) then publishes to an in-process EventEmitter, one per
 * conversation, so live tails wake up immediately.
 */
export class EventLog {
  private emitters = new Map<string, EventEmitter>();

  constructor(private sqlite: Database.Database) {}

  private emitterFor(conversationId: string): EventEmitter {
    let e = this.emitters.get(conversationId);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(0);
      this.emitters.set(conversationId, e);
    }
    return e;
  }

  /** Reserve seqs for `events` and insert them, all inside the caller's transaction context if any. */
  append(conversationId: string, runId: string, events: NewEvent[]): RunEventRow[] {
    if (events.length === 0) return [];

    const now = Date.now();
    const n = events.length;

    const txn = this.sqlite.transaction(() => {
      const reserve = this.sqlite
        .prepare(`UPDATE conversations SET last_seq = last_seq + ? WHERE id = ? RETURNING last_seq`)
        .get(n, conversationId) as { last_seq: number } | undefined;
      if (!reserve) {
        throw new Error(`append: conversation ${conversationId} not found`);
      }
      const endSeq = reserve.last_seq;
      const startSeq = endSeq - n + 1;

      const insert = this.sqlite.prepare(
        `INSERT INTO run_events (conversation_id, seq, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const rows: RunEventRow[] = [];
      events.forEach((e, i) => {
        const seq = startSeq + i;
        const payload = JSON.stringify(e.payload);
        insert.run(conversationId, seq, runId, e.type, payload, now);
        rows.push({ conversationId, seq, runId, type: e.type, payload: e.payload, createdAt: now });
      });
      return rows;
    });

    const rows = txn();
    const emitter = this.emitterFor(conversationId);
    for (const row of rows) emitter.emit("event", row);
    return rows;
  }

  readSince(conversationId: string, after: number): RunEventRow[] {
    const rows = this.sqlite
      .prepare(`SELECT * FROM run_events WHERE conversation_id = ? AND seq > ? ORDER BY seq`)
      .all(conversationId, after) as RawRow[];
    return rows.map(fromRaw);
  }

  /**
   * Register-then-read-then-live, per §4: register on the emitter first (live
   * events start landing in a buffer), read the backlog, then flush the
   * buffer and switch to live — gated by `seq <= lastSent` so the
   * replay/live overlap is at-least-once-but-effectively-exactly-once.
   * Returns an unsubscribe function.
   */
  subscribe(conversationId: string, after: number, onEvent: (row: RunEventRow) => void): () => void {
    const emitter = this.emitterFor(conversationId);
    let lastSent = after;
    let buffering = true;
    const buffer: RunEventRow[] = [];

    const liveHandler = (row: RunEventRow) => {
      if (buffering) {
        buffer.push(row);
        return;
      }
      if (row.seq <= lastSent) return;
      lastSent = row.seq;
      onEvent(row);
    };
    emitter.on("event", liveHandler);

    const backlog = this.readSince(conversationId, after);
    for (const row of backlog) {
      if (row.seq <= lastSent) continue;
      lastSent = row.seq;
      onEvent(row);
    }

    buffering = false;
    for (const row of buffer) {
      if (row.seq <= lastSent) continue;
      lastSent = row.seq;
      onEvent(row);
    }

    return () => emitter.off("event", liveHandler);
  }

  /** Number of currently-registered live listeners for a conversation (subscribers connected right now). */
  listenerCount(conversationId: string): number {
    return this.emitters.get(conversationId)?.listenerCount("event") ?? 0;
  }
}
