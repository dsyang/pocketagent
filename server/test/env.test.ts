import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/env.js";

const BASE_ENV = { OPENROUTER_API_KEY: "test-key" };

describe("parseEnv", () => {
  it("applies defaults for a minimal valid environment, and parses a provided MAX_PRICE_USD", () => {
    const defaults = parseEnv(BASE_ENV);
    expect(defaults.PORT).toBe(3000);
    expect(defaults.HOST).toBe("127.0.0.1");
    expect(defaults.DEFAULT_MODEL).toBe("deepseek/deepseek-v4-flash-0731");
    expect(defaults.MAX_PRICE_USD).toBeUndefined();

    const withPrice = parseEnv({ ...BASE_ENV, MAX_PRICE_USD: "0.02" });
    expect(withPrice.MAX_PRICE_USD).toBe(0.02);
  });

  it("rejects a missing OPENROUTER_API_KEY instead of leaving it undefined at runtime", () => {
    expect(() => parseEnv({})).toThrow(/Invalid environment configuration/);
  });

  it("rejects a non-numeric MAX_PRICE_USD instead of silently becoming NaN (regression)", () => {
    // NaN previously flowed into `provider.max_price.completion`, and
    // JSON.stringify turns NaN into `null` — silently disabling the spend
    // guard rather than erroring, the opposite of what the operator configured.
    expect(() => parseEnv({ ...BASE_ENV, MAX_PRICE_USD: "$0.02" })).toThrow(/Invalid environment configuration/);
  });

  it("treats a blank MAX_PRICE_USD as unset, matching the deploy template's blank-line style", () => {
    const env = parseEnv({ ...BASE_ENV, MAX_PRICE_USD: "" });
    expect(env.MAX_PRICE_USD).toBeUndefined();
  });

  it("rejects a non-numeric or out-of-range PORT instead of binding an arbitrary ephemeral port", () => {
    expect(() => parseEnv({ ...BASE_ENV, PORT: "tcp/3000" })).toThrow(/Invalid environment configuration/);
    expect(() => parseEnv({ ...BASE_ENV, PORT: "70000" })).toThrow(/Invalid environment configuration/);
  });
});
