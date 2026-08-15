import { describe, it, expect } from "vitest";
import { buildContext, DEFAULT_SYSTEM_PROMPT } from "../src/agent/context.js";

describe("buildContext", () => {
  it("keeps all history when it fits comfortably under the budget", () => {
    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
    ];
    const result = buildContext(history, { maxChars: 1000 });
    expect(result).toEqual([{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...history]);
  });

  it("always includes at least the most recent message, even alone over budget", () => {
    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "short" },
      { role: "assistant", content: "x".repeat(500) },
    ];
    const result = buildContext(history, { systemPrompt: "sys", maxChars: 50 });
    expect(result).toEqual([{ role: "system", content: "sys" }, history[1]]);
  });

  it("does not overshoot maxChars by a whole extra message (regression: off-by-one in the budget check)", () => {
    // Remaining budget after the most recent message is small but still
    // positive. The bug checked that leftover budget *before* charging the
    // next (older) message, so any positive leftover — even 1 char — let an
    // arbitrarily large older message slip in whole, overshooting maxChars by
    // that message's entire size instead of excluding it.
    const systemPrompt = "sys"; // 3 chars
    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "z".repeat(1000) }, // oldest, huge — must be excluded
      { role: "user", content: "x".repeat(3) }, // most recent
    ];
    const result = buildContext(history, { systemPrompt, maxChars: 3 + 3 + 2 });
    expect(result).toEqual([{ role: "system", content: systemPrompt }, history[1]]);
  });
});
