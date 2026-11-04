/**
 * Verifies the Supabase connection and schema without the UI.
 * Run: npm run db:check -w @cartguardian/server
 */
import { loadConfig } from "../src/config.js";
import { SupabaseStore } from "../src/supabase-store.js";

async function main() {
  const config = loadConfig();
  if (!config.supabase) {
    console.error("✗ SUPABASE_URL and SUPABASE_SECRET_KEY are not set in apps/server/.env (the API is using the in-memory store).");
    process.exit(1);
  }
  const store = new SupabaseStore(config.supabase);
  console.log(`Checking ${config.supabase.url} ...`);

  const t = Date.now();
  await store.getEvaluation("00000000-0000-0000-0000-000000000000");
  console.log(`✓ Connected and read public.evaluations (${Date.now() - t} ms)`);

  await store.getOrder("DBCHECK0");
  console.log("✓ Read public.orders");

  const claimed = await store.claimForCapture("DBCHECK0", 120_000);
  if (claimed !== null) throw new Error("claim_order_for_capture returned a row for an order that does not exist");
  console.log("✓ Called claim_order_for_capture (schema.sql is installed)");
  console.log("\nDatabase ready. Restart the API: its startup banner should say 'Database : Supabase'.");
}

main().catch((err) => {
  const msg = String((err as Error).message);
  console.error(`✗ ${msg}`);
  if (/relation .* does not exist|Could not find the (table|function)|PGRST20[2-5]/i.test(msg)) {
    console.error("  The tables or function are missing: run supabase/schema.sql in the Supabase SQL Editor.");
  } else if (/Invalid API key|JWT|401|403|permission denied/i.test(msg)) {
    console.error("  The key was rejected: SUPABASE_SECRET_KEY must be the secret key (sb_secret_...) from Settings > API Keys.");
  } else if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(msg)) {
    console.error("  Could not reach Supabase: check SUPABASE_URL (https://<project-ref>.supabase.co) and your network.");
  }
  process.exit(1);
});
