import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createAiAdapter } from "./ai/index.js";
import { PayPalRestClient } from "./paypal/client.js";
import { MemoryStore } from "./store.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const ai = createAiAdapter(config.ai);
const paypal = new PayPalRestClient({
  baseUrl: config.paypal.baseUrl,
  clientId: config.paypal.clientId,
  clientSecret: config.paypal.clientSecret,
  timeoutMs: config.paypal.timeoutMs,
});
const app = createApp({ config, ai, paypal, store: new MemoryStore() });

const server = app.listen(config.port, () => {
  console.log(`CartGuardian API listening on http://localhost:${config.port}`);
  console.log(`  AI provider : ${ai.name} (${ai.model})${ai.name === "mock" ? "  <- MOCK: evaluations are rule-based" : ""}`);
  console.log(`  PayPal      : sandbox, ${paypal.configured ? "credentials loaded" : "NOT CONFIGURED (checkout disabled)"}`);
  console.log(`  CORS origins: ${config.webOrigins.join(", ")}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
