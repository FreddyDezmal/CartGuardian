import { bootstrap } from "./bootstrap.js";

let built;
try {
  built = bootstrap();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const { app, config, ai, paypal, store } = built;

const server = app.listen(config.port, () => {
  console.log(`CartGuardian API listening on http://localhost:${config.port}`);
  console.log(`  AI provider : ${ai.name} (${ai.model})${ai.name === "mock" ? "  <- MOCK: evaluations are rule-based" : ""}`);
  console.log(`  PayPal      : sandbox, ${paypal.configured ? "credentials loaded" : "NOT CONFIGURED (checkout disabled)"}`);
  console.log(`  Database    : ${store.kind === "supabase" ? `Supabase (${config.supabase?.url})` : "in-memory (lost on restart)"}`);
  console.log(`  CORS origins: ${config.webOrigins.join(", ")}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
