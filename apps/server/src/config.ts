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
    .optional()
    .transform((s) => (s ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean)),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  AI_PROVIDER: z.enum(["mock", "anthropic", "gemini"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().trim().optional(),
  ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-sonnet-5-5"),
  GEMINI_API_KEY: z.string().trim().optional(),
  GEMINI_MODEL: z.string().trim().min(1).default("gemini-3.5-flash-lite"),
  // Comma-separated models to try, in order, when the primary is overloaded or out of quota.
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((m) => m.trim()).filter(Boolean)),
  // "default" sends no thinking setting and lets the model decide (slower).
  GEMINI_THINKING_LEVEL: z.enum(["minimal", "low", "medium", "high", "default"]).default("low"),
  // Total time one trial may take, across fallbacks and the repair attempt.
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  // Max time per Gemini model while fallbacks remain (the last model gets whatever is left).
  GEMINI_PER_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(12000),

  PAYPAL_ENVIRONMENT: z.literal("sandbox").default("sandbox"),
  PAYPAL_CLIENT_ID: z.string().trim().optional(),
  PAYPAL_CLIENT_SECRET: z.string().trim().optional(),
  PAYPAL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),

  // Supabase (Postgres). When both are set, the API uses the database instead of memory.
  SUPABASE_URL: z.string().trim().optional(),
  SUPABASE_SECRET_KEY: z.string().trim().optional(),
  // Set automatically by Vercel at build and run time.
  VERCEL: z.string().optional(),
  // Vercel system variables: this deployment's own hostnames (no scheme).
  // They let every deployment, preview branches included, accept requests from its own pages.
  VERCEL_ENV: z.string().optional(),
  VERCEL_URL: z.string().trim().optional(),
  VERCEL_BRANCH_URL: z.string().trim().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().trim().optional(),

  RATE_LIMIT_EVALUATIONS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  RATE_LIMIT_ORDERS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),
  RATE_LIMIT_IMPORTS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  // Whole-fetch deadline for product link import (all redirects included).
  IMPORT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(20000).default(8000),
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

  const geminiKey = nonEmpty(e.GEMINI_API_KEY);
  if (e.AI_PROVIDER === "gemini" && !geminiKey) {
    throw new Error(
      "AI_PROVIDER=gemini but GEMINI_API_KEY is empty. Create a free key at aistudio.google.com and set it in apps/server/.env, or use AI_PROVIDER=mock.",
    );
  }

  const supabaseUrl = nonEmpty(e.SUPABASE_URL);
  const supabaseKey = nonEmpty(e.SUPABASE_SECRET_KEY);
  if (Boolean(supabaseUrl) !== Boolean(supabaseKey)) {
    throw new Error("Set both SUPABASE_URL and SUPABASE_SECRET_KEY, or neither (in-memory store).");
  }
  if (supabaseUrl && !/^https:\/\/[^/]+$/.test(supabaseUrl.replace(/\/$/, ""))) {
    throw new Error("SUPABASE_URL should look like https://<project-ref>.supabase.co");
  }
  if (supabaseKey && /^sb_publishable_/.test(supabaseKey)) {
    throw new Error("SUPABASE_SECRET_KEY is a publishable key. Use the secret key (sb_secret_...) from Settings > API Keys.");
  }
  if (e.VERCEL && !supabaseUrl) {
    // Requests can land on different instances on Vercel, so memory would lose orders between create and capture.
    throw new Error("Running on Vercel without a database. Set SUPABASE_URL and SUPABASE_SECRET_KEY in the Vercel project settings.");
  }

  const clientId = nonEmpty(e.PAYPAL_CLIENT_ID);
  const clientSecret = nonEmpty(e.PAYPAL_CLIENT_SECRET);
  if (clientId && clientSecret && clientId === clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are identical. Copy both values from your Sandbox REST app.");
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    webOrigins: webOrigins(e),
    trustProxy: e.TRUST_PROXY,
    ai: {
      provider: e.AI_PROVIDER,
      anthropicApiKey: anthropicKey,
      geminiApiKey: geminiKey,
      geminiThinkingLevel: e.GEMINI_THINKING_LEVEL,
      geminiFallbackModels: e.GEMINI_FALLBACK_MODELS,
      geminiPerModelTimeoutMs: e.GEMINI_PER_MODEL_TIMEOUT_MS,
      model: e.AI_PROVIDER === "mock" ? "mock-v1" : e.AI_PROVIDER === "gemini" ? e.GEMINI_MODEL : e.ANTHROPIC_MODEL,
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
    supabase: supabaseUrl && supabaseKey ? { url: supabaseUrl.replace(/\/$/, ""), secretKey: supabaseKey } : null,
    importTimeoutMs: e.IMPORT_TIMEOUT_MS,
    rateLimits: {
      evaluationsPerMinute: e.RATE_LIMIT_EVALUATIONS_PER_MINUTE,
      ordersPerMinute: e.RATE_LIMIT_ORDERS_PER_MINUTE,
      importsPerMinute: e.RATE_LIMIT_IMPORTS_PER_MINUTE,
    },
  };
}

/**
 * Origins allowed to call the API: WEB_ORIGIN's list, plus, on Vercel, the
 * deployment's own addresses (production domain, branch alias, unique URL), so
 * preview deployments of any branch work without editing WEB_ORIGIN.
 * Locally, with nothing set, the Vite dev server.
 */
function webOrigins(e: z.infer<typeof EnvSchema>): string[] {
  const host = (h: string | undefined) => (h && /^[a-z0-9.-]+$/i.test(h) ? `https://${h.toLowerCase()}` : undefined);
  const vercel = e.VERCEL
    ? [e.VERCEL_ENV === "production" ? host(e.VERCEL_PROJECT_PRODUCTION_URL) : undefined, host(e.VERCEL_BRANCH_URL), host(e.VERCEL_URL)]
    : [];
  const list = [...new Set([...e.WEB_ORIGIN, ...vercel].filter((o): o is string => Boolean(o)))];
  return list.length ? list : ["http://localhost:5173"];
}
