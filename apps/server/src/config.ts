import { z } from "zod";

/**
 * All environment configuration is parsed once, here. Secrets never leave
 * the server: only `paypalClientId` (a public identifier) is ever exposed
 * to the browser, via GET /api/config.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  WEB_ORIGIN: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  AI_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().trim().optional(),
  ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-sonnet-5-5"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),

  PAYPAL_ENVIRONMENT: z.literal("sandbox").default("sandbox"),
  PAYPAL_CLIENT_ID: z.string().trim().optional(),
  PAYPAL_CLIENT_SECRET: z.string().trim().optional(),
  PAYPAL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),

  RATE_LIMIT_EVALUATIONS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  RATE_LIMIT_ORDERS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),
});

export type AppConfig = ReturnType<typeof loadConfig>;

const nonEmpty = (v: string | undefined) => (v && v.length > 0 ? v : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  const anthropicKey = nonEmpty(e.ANTHROPIC_API_KEY);
  if (e.AI_PROVIDER === "anthropic" && !anthropicKey) {
    throw new Error(
      "AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty. Set the key in apps/server/.env or use AI_PROVIDER=mock.",
    );
  }

  const clientId = nonEmpty(e.PAYPAL_CLIENT_ID);
  const clientSecret = nonEmpty(e.PAYPAL_CLIENT_SECRET);
  if (clientId && clientSecret && clientId === clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are identical. Copy both values from your Sandbox REST app.");
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    webOrigins: e.WEB_ORIGIN,
    trustProxy: e.TRUST_PROXY,
    ai: {
      provider: e.AI_PROVIDER,
      anthropicApiKey: anthropicKey,
      model: e.AI_PROVIDER === "mock" ? "mock-v1" : e.ANTHROPIC_MODEL,
      timeoutMs: e.AI_TIMEOUT_MS,
    },
    paypal: {
      environment: e.PAYPAL_ENVIRONMENT,
      // Sandbox only in this build. Going live is a deliberate code change.
      baseUrl: "https://api-m.sandbox.paypal.com",
      clientId,
      clientSecret,
      configured: Boolean(clientId && clientSecret),
      timeoutMs: e.PAYPAL_TIMEOUT_MS,
    },
    rateLimits: {
      evaluationsPerMinute: e.RATE_LIMIT_EVALUATIONS_PER_MINUTE,
      ordersPerMinute: e.RATE_LIMIT_ORDERS_PER_MINUTE,
    },
  };
}
