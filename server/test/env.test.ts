import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/env.js";

const BASE_ENV = { OPENROUTER_API_KEY: "test-key" };

describe("parseEnv", () => {
  it("applies defaults for a minimal valid environment", () => {
    const env = parseEnv(BASE_ENV);
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.DEFAULT_MODEL).toBe("anthropic/claude-sonnet-5");
    expect(env.MAX_PRICE_USD).toBeUndefined();
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

  it("parses a valid MAX_PRICE_USD", () => {
    const env = parseEnv({ ...BASE_ENV, MAX_PRICE_USD: "0.02" });
    expect(env.MAX_PRICE_USD).toBe(0.02);
  });

  it("rejects a non-numeric or out-of-range PORT instead of binding an arbitrary ephemeral port", () => {
    expect(() => parseEnv({ ...BASE_ENV, PORT: "tcp/3000" })).toThrow(/Invalid environment configuration/);
    expect(() => parseEnv({ ...BASE_ENV, PORT: "70000" })).toThrow(/Invalid environment configuration/);
  });

  it("treats blank APNs vars as unset rather than empty-but-present, so push stays disabled", () => {
    const env = parseEnv({ ...BASE_ENV, APNS_TEAM_ID: "", APNS_KEY_ID: "", APNS_SIGNING_KEY: "", APNS_TOPIC: "" });
    expect(env.APNS_TEAM_ID).toBeUndefined();
    expect(env.APNS_KEY_ID).toBeUndefined();
    expect(env.APNS_SIGNING_KEY).toBeUndefined();
    expect(env.APNS_TOPIC).toBeUndefined();
  });
});
