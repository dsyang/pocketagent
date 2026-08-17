import { z } from "zod";

// Deploy templates (see deploy/setup-pi.md) leave optional vars present but
// blank (`APNS_TEAM_ID=`) rather than omitting the line — an empty string,
// not undefined. Treat blank the same as unset for optional fields.
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = () => z.preprocess(blankToUndefined, z.string().min(1).optional());
const optionalPositiveNumber = () => z.preprocess(blankToUndefined, z.coerce.number().positive().optional());

// Validated once at startup so a typo'd or malformed value fails fast
// instead of silently half-configuring the process — e.g. an unparseable
// MAX_PRICE_USD used to become NaN, which JSON.stringify turns into `null`,
// silently dropping the spend ceiling entirely.
export const envSchema = z.object({
  DATABASE_PATH: z.string().min(1).default("./data/pocket-agent.db"),
  AUTH_TOKEN: optionalString(),
  OPENROUTER_API_KEY: z.string().min(1),
  DEFAULT_MODEL: z.string().min(1).default("deepseek/deepseek-v4-flash-0731"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  // OpenRouter's provider.max_price routing ceiling (USD per million completion
  // tokens) — not a per-run spend cap. See agent/openrouter.ts.
  MAX_PRICE_USD: optionalPositiveNumber(),
  APNS_TEAM_ID: optionalString(),
  APNS_KEY_ID: optionalString(),
  APNS_SIGNING_KEY: optionalString(),
  APNS_TOPIC: optionalString(),
  APNS_HOST: optionalString(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  return parsed.data;
}
