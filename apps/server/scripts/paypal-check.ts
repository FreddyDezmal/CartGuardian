/**
 * Verifies PayPal Sandbox credentials WITHOUT the UI:
 *   1. fetches an OAuth token
 *   2. creates a 1.00 USD order
 *   3. reads it back and prints the buyer approval link
 * Run: npm run paypal:check -w @cartguardian/server
 * Optional second step after approving in the browser:
 *   npm run paypal:check -w @cartguardian/server -- capture <ORDER_ID>
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { PayPalApiError, PayPalRestClient } from "../src/paypal/client.js";

const config = loadConfig();
const client = new PayPalRestClient({
  baseUrl: config.paypal.baseUrl,
  clientId: config.paypal.clientId,
  clientSecret: config.paypal.clientSecret,
  timeoutMs: config.paypal.timeoutMs,
});

async function main() {
  if (!client.configured) {
    console.error("✗ PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in apps/server/.env");
    process.exit(1);
  }
  const [cmd, orderId] = process.argv.slice(2);

  if (cmd === "capture" && orderId) {
    const res = await client.captureOrder(orderId, `cg-check-${orderId}`);
    const cap = res.purchase_units[0]?.payments?.captures?.[0];
    console.log(`✓ Capture: order ${res.status}, capture ${cap?.id} ${cap?.status} ${cap?.amount.value} ${cap?.amount.currency_code}`);
    return;
  }

  const order = await client.createOrder({
    requestId: randomUUID(),
    amount: { currency_code: "USD", value: "1.00" },
    referenceId: "paypal-check",
    description: "CartGuardian connectivity check",
    returnUrl: `${config.webOrigins[0]}/?paypal=return`,
    cancelUrl: `${config.webOrigins[0]}/?paypal=cancel`,
  });
  console.log(`✓ OAuth token obtained and order created: ${order.id} (${order.status})`);
  const read = await client.getOrder(order.id);
  console.log(`✓ Order read back: status ${read.status}`);
  const links = (read as unknown as { links?: Array<{ rel: string; href: string }> }).links ?? [];
  const approve = links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (approve) {
    console.log(`\nTo test approval + capture manually:\n  1. Open ${approve.href}\n  2. Log in with your Sandbox PERSONAL (buyer) account and approve\n  3. npm run paypal:check -w @cartguardian/server -- capture ${order.id}`);
  }
}

main().catch((err) => {
  if (err instanceof PayPalApiError) {
    console.error(`✗ PayPal error ${err.status} ${err.issue}: ${err.message}${err.debugId ? ` (debug_id ${err.debugId})` : ""}`);
  } else {
    console.error("✗", err);
  }
  process.exit(1);
});
