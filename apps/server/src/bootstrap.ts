import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createAiAdapter } from "./ai/index.js";
import { PayPalRestClient } from "./paypal/client.js";
import { MemoryStore, type Store } from "./store.js";
import { SupabaseStore } from "./supabase-store.js";

/** Builds the app from environment variables. Shared by local dev (index.ts) and Vercel (vercel.ts). */
export function bootstrap(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const ai = createAiAdapter(config.ai);
  const paypal = new PayPalRestClient({
    baseUrl: config.paypal.baseUrl,
    clientId: config.paypal.clientId,
    clientSecret: config.paypal.clientSecret,
    timeoutMs: config.paypal.timeoutMs,
  });
  const store: Store = config.supabase ? new SupabaseStore(config.supabase) : new MemoryStore();
  const app = createApp({ config, ai, paypal, store });
  return { app, config, ai, paypal, store };
}
