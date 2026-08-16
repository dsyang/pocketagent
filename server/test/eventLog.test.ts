import { describe, it, expect } from "vitest";
import { setupDb, createConversation, newEventLog } from "./helpers.js";

describe("EventLog", () => {
  it("allocates monotonic seqs per conversation, race-free across batches", () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);

    const first = eventLog.append(conv, "run_1", [{ type: "a", payload: {} }, { type: "b", payload: {} }]);
    const second = eventLog.append(conv, "run_1", [{ type: "c", payload: {} }]);

    expect(first.map((e) => e.seq)).toEqual([1, 2]);
    expect(second.map((e) => e.seq)).toEqual([3]);
  });

  it("keeps separate conversations on independent seq counters", () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const convA = createConversation(sqlite);
    const convB = createConversation(sqlite);

    eventLog.append(convA, "run_a", [{ type: "x", payload: {} }, { type: "y", payload: {} }]);
    const bEvents = eventLog.append(convB, "run_b", [{ type: "z", payload: {} }]);

    expect(bEvents.map((e) => e.seq)).toEqual([1]); // unaffected by convA's counter
  });

  it("readSince returns only events after the given seq, in order", () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    eventLog.append(conv, "run_1", [{ type: "a", payload: { n: 1 } }, { type: "b", payload: { n: 2 } }, { type: "c", payload: { n: 3 } }]);

    const rows = eventLog.readSince(conv, 1);
    expect(rows.map((r) => r.type)).toEqual(["b", "c"]);
    expect(rows.map((r) => r.seq)).toEqual([2, 3]);
  });

  it("subscribe replays backlog then delivers live events with no gap or duplicate", async () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    eventLog.append(conv, "run_1", [{ type: "a", payload: {} }, { type: "b", payload: {} }]);

    const received: number[] = [];
    const unsubscribe = eventLog.subscribe(conv, 0, (row) => received.push(row.seq));

    // backlog delivered synchronously inside subscribe()
    expect(received).toEqual([1, 2]);

    eventLog.append(conv, "run_1", [{ type: "c", payload: {} }]);
    expect(received).toEqual([1, 2, 3]);

    unsubscribe();
    eventLog.append(conv, "run_1", [{ type: "d", payload: {} }]);
    expect(received).toEqual([1, 2, 3]); // unsubscribed, no more delivery
  });

  it("dissolves the replay/live race via seq-gating: a listener registered before the backlog read never double-delivers or drops an event landing in between", () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    eventLog.append(conv, "run_1", [{ type: "a", payload: {} }]); // seq 1 exists before subscribe

    const received: number[] = [];
    // Monkey-patch readSince to simulate an event (seq 2) landing *during* the backlog read window —
    // subscribe() registers the live listener first, so this event should still be delivered exactly once.
    const originalReadSince = eventLog.readSince.bind(eventLog);
    let patched = false;
    eventLog.readSince = (conversationId: string, after: number) => {
      if (!patched) {
        patched = true;
        eventLog.append(conv, "run_1", [{ type: "b", payload: {} }]); // lands "during" the read, seq 2
      }
      return originalReadSince(conversationId, after);
    };

    eventLog.subscribe(conv, 0, (row) => received.push(row.seq));

    expect(received).toEqual([1, 2]); // no duplicate of seq 2, no gap
  });

  it("listenerCount reflects currently-registered live subscribers", () => {
    const { sqlite } = setupDb();
    const eventLog = newEventLog(sqlite);
    const conv = createConversation(sqlite);
    expect(eventLog.listenerCount(conv)).toBe(0);
    const unsub1 = eventLog.subscribe(conv, 0, () => {});
    const unsub2 = eventLog.subscribe(conv, 0, () => {});
    expect(eventLog.listenerCount(conv)).toBe(2);
    unsub1();
    expect(eventLog.listenerCount(conv)).toBe(1);
    unsub2();
    expect(eventLog.listenerCount(conv)).toBe(0);
  });
});
