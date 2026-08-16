import { describe, it, expect } from "vitest";
import { buildContext, DEFAULT_SYSTEM_PROMPT } from "../src/agent/context.js";

describe("buildContext", () => {
  it("keeps all history under budget, and always includes at least the most recent message when it doesn't fit", () => {
    const fitsHistory: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
    ];
    const fitsResult = buildContext(fitsHistory, { maxChars: 1000 });
    expect(fitsResult).toEqual([{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...fitsHistory]);

    const overBudgetHistory: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "short" },
      { role: "assistant", content: "x".repeat(500) },
    ];
    const overBudgetResult = buildContext(overBudgetHistory, { systemPrompt: "sys", maxChars: 50 });
    expect(overBudgetResult).toEqual([{ role: "system", content: "sys" }, overBudgetHistory[1]]);
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
