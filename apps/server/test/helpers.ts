import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { MockAdapter } from "../src/ai/mock.js";
import type { AiAdapter } from "../src/ai/types.js";
import { MemoryStore } from "../src/store.js";
import { PayPalApiError, type CreateOrderParams, type PayPalApi, type PayPalOrder } from "../src/paypal/client.js";

/**
 * In-memory stand-in for PayPal that behaves like Orders v2 for the happy
 * path and lets each test inject failures. It records every call.
 */
export class FakePayPal implements PayPalApi {
  configured = true;
  orders = new Map<string, { params: CreateOrderParams; approved: boolean; captured: boolean }>();
  calls = { create: 0, get: 0, capture: 0 };
  captureDelayMs = 0;
  /** Override what capture returns, e.g. to simulate amount tampering. */
  captureOverride: ((orderId: string) => PayPalOrder) | null = null;
  captureError: PayPalApiError | null = null;
  private seq = 0;

  async createOrder(params: CreateOrderParams): Promise<PayPalOrder> {
    this.calls.create++;
    const id = `5O19012${String(++this.seq).padStart(4, "0")}TEST`;
    this.orders.set(id, { params, approved: false, captured: false });
    return { id, status: "CREATED", purchase_units: [{ reference_id: params.referenceId, amount: params.amount }] };
  }

  approve(orderId: string) {
    const o = this.orders.get(orderId);
    if (o) o.approved = true;
  }

  async getOrder(orderId: string): Promise<PayPalOrder> {
    this.calls.get++;
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalApiError(404, "RESOURCE_NOT_FOUND", "not found", "dbg-1");
    return this.representation(orderId);
  }

  async captureOrder(orderId: string, _requestId: string): Promise<PayPalOrder> {
    this.calls.capture++;
    if (this.captureDelayMs) await new Promise((r) => setTimeout(r, this.captureDelayMs));
    if (this.captureError) throw this.captureError;
    if (this.captureOverride) return this.captureOverride(orderId);
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalApiError(404, "RESOURCE_NOT_FOUND", "not found", "dbg-2");
    if (!o.approved) throw new PayPalApiError(422, "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.", "dbg-3");
    if (o.captured) throw new PayPalApiError(422, "ORDER_ALREADY_CAPTURED", "Order already captured.", "dbg-4");
    o.captured = true;
    return this.representation(orderId);
  }

  private representation(orderId: string): PayPalOrder {
    const o = this.orders.get(orderId)!;
    return {
      id: orderId,
      status: o.captured ? "COMPLETED" : o.approved ? "APPROVED" : "CREATED",
      purchase_units: [
        {
          reference_id: o.params.referenceId,
          amount: o.params.amount,
          payments: o.captured
            ? { captures: [{ id: `CAP${orderId}`, status: "COMPLETED", amount: o.params.amount }] }
            : undefined,
        },
      ],
    };
  }
}

export function buildTestApp(opts: { ai?: AiAdapter; paypal?: FakePayPal; env?: Record<string, string> } = {}) {
  const config = loadConfig({ NODE_ENV: "test", AI_PROVIDER: "mock", RATE_LIMIT_EVALUATIONS_PER_MINUTE: "100", RATE_LIMIT_ORDERS_PER_MINUTE: "100", ...opts.env });
  const paypal = opts.paypal ?? new FakePayPal();
  const store = new MemoryStore();
  const app = createApp({ config, ai: opts.ai ?? new MockAdapter(), paypal, store });
  return { app, paypal, store, config };
}

export const validInput = {
  productName: "Noise-cancelling headphones",
  price: "199.9",
  currency: "USD",
  description: "Over-ear, 30h battery",
  intendedUse: "Daily commute and focus work",
  usesPerMonth: 40,
  lifetimeMonths: 24,
};
