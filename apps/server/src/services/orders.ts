import { randomUUID } from "node:crypto";
import type { CaptureResponse, OrderSummary } from "@cartguardian/shared";
import { HttpError } from "../errors.js";
import { moneyEquals } from "../money.js";
import type { Store } from "../store.js";
import { PayPalApiError, type PayPalApi, type PayPalOrder } from "../paypal/client.js";

/** PayPal order ids: uppercase alphanumerics, 1-36 chars (Orders v2 reference). */
export const ORDER_ID_PATTERN = /^[A-Z0-9]{1,36}$/;

export class OrderService {
  /** In-process lock so two simultaneous capture calls hit PayPal once. */
  private inflight = new Map<string, Promise<OrderSummary>>();

  constructor(
    private readonly paypal: PayPalApi,
    private readonly store: Store,
    private readonly opts: { returnUrl: string; cancelUrl: string },
  ) {}

  async create(evaluationId: string): Promise<OrderSummary> {
    if (!this.paypal.configured) {
      throw new HttpError(503, "PAYPAL_NOT_CONFIGURED", "PayPal Sandbox credentials are not configured on the server.");
    }
    const evaluation = await this.store.getEvaluation(evaluationId);
    if (!evaluation) throw new HttpError(404, "EVALUATION_NOT_FOUND", "No evaluation with that id.");

    // Amount comes ONLY from the stored evaluation, never from the request.
    const amount = { currency_code: evaluation.amount.currency, value: evaluation.amount.value };

    let order: PayPalOrder;
    try {
      order = await this.paypal.createOrder({
        requestId: randomUUID(),
        amount,
        referenceId: evaluation.id,
        description: `CartGuardian: ${evaluation.productName}`,
        returnUrl: this.opts.returnUrl,
        cancelUrl: this.opts.cancelUrl,
      });
    } catch (err) {
      throw mapPayPalError(err, "create");
    }

    const unitAmount = order.purchase_units?.[0]?.amount;
    if (unitAmount && !moneyEquals({ currency: unitAmount.currency_code, value: unitAmount.value }, evaluation.amount)) {
      throw new HttpError(502, "AMOUNT_MISMATCH", "PayPal returned an order for a different amount.");
    }

    const summary: OrderSummary = {
      orderId: order.id,
      evaluationId: evaluation.id,
      amount: evaluation.amount,
      status: "CREATED",
      captureId: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    await this.store.saveOrder(summary);
    return summary;
  }

  async capture(orderId: string): Promise<CaptureResponse> {
    if (!ORDER_ID_PATTERN.test(orderId)) throw new HttpError(400, "INVALID_ORDER_ID", "Order id format is invalid.");

    const record = await this.store.getOrder(orderId);
    // Only capture orders this server created: blocks capturing arbitrary order ids.
    if (!record) throw new HttpError(404, "ORDER_NOT_FOUND", "This order was not created by CartGuardian.");
    if (record.status === "COMPLETED") return { order: record, replayed: true };

    const existing = this.inflight.get(orderId);
    if (existing) return { order: await existing, replayed: true };

    const p = this.doCapture(record).finally(() => this.inflight.delete(orderId));
    this.inflight.set(orderId, p);
    return { order: await p, replayed: false };
  }

  async status(orderId: string): Promise<{ order: OrderSummary; paypalStatus: string | null }> {
    if (!ORDER_ID_PATTERN.test(orderId)) throw new HttpError(400, "INVALID_ORDER_ID", "Order id format is invalid.");
    const record = await this.store.getOrder(orderId);
    if (!record) throw new HttpError(404, "ORDER_NOT_FOUND", "This order was not created by CartGuardian.");
    try {
      const live = await this.paypal.getOrder(orderId);
      return { order: record, paypalStatus: live.status };
    } catch (err) {
      console.warn("Live PayPal status unavailable:", (err as Error).message);
      return { order: record, paypalStatus: null };
    }
  }

  private async doCapture(record: OrderSummary): Promise<OrderSummary> {
    // Deterministic request id: if we retry (or the browser double-submits), PayPal
    // treats it as the same capture instead of a second one.
    const requestId = `cg-capture-${record.orderId}`;
    let result: PayPalOrder;
    try {
      result = await this.paypal.captureOrder(record.orderId, requestId);
    } catch (err) {
      if (err instanceof PayPalApiError && err.issue === "ORDER_ALREADY_CAPTURED") {
        // Captured earlier (e.g. before a restart): reconcile from PayPal's record.
        result = await this.paypal.getOrder(record.orderId).catch((e) => {
          throw mapPayPalError(e, "capture");
        });
      } else {
        throw mapPayPalError(err, "capture");
      }
    }
    return this.verifyAndRecord(record, result);
  }

  private async verifyAndRecord(record: OrderSummary, order: PayPalOrder): Promise<OrderSummary> {
    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];

    if (order.id !== record.orderId) {
      throw new HttpError(502, "ORDER_MISMATCH", "PayPal returned a different order.");
    }
    if (unit?.reference_id && unit.reference_id !== record.evaluationId) {
      throw new HttpError(502, "ORDER_MISMATCH", "PayPal order does not belong to this evaluation.");
    }
    if (!capture) {
      await this.store.saveOrder({ ...record, status: "FAILED" });
      throw new HttpError(502, "CAPTURE_MISSING", `PayPal order status is ${order.status} with no capture.`);
    }
    if (!moneyEquals({ currency: capture.amount.currency_code, value: capture.amount.value }, record.amount)) {
      console.error(`AMOUNT MISMATCH on ${record.orderId}: expected ${record.amount.value} ${record.amount.currency}, got ${capture.amount.value} ${capture.amount.currency_code}`);
      await this.store.saveOrder({ ...record, status: "FAILED", captureId: capture.id });
      throw new HttpError(502, "AMOUNT_MISMATCH", "Captured amount does not match the evaluated price. Flagged for review.");
    }

    if (order.status === "COMPLETED" && capture.status === "COMPLETED") {
      const done: OrderSummary = { ...record, status: "COMPLETED", captureId: capture.id, completedAt: new Date().toISOString() };
      await this.store.saveOrder(done);
      return done;
    }
    if (capture.status === "PENDING") {
      const pending: OrderSummary = { ...record, status: "PENDING", captureId: capture.id };
      await this.store.saveOrder(pending);
      return pending;
    }
    await this.store.saveOrder({ ...record, status: "FAILED", captureId: capture.id });
    throw new HttpError(402, "PAYMENT_DECLINED", `Payment was not completed (capture status ${capture.status}).`);
  }
}

function mapPayPalError(err: unknown, op: "create" | "capture"): HttpError {
  if (!(err instanceof PayPalApiError)) {
    console.error(`Unexpected PayPal ${op} error`, err);
    return new HttpError(502, "PAYPAL_ERROR", "Unexpected error talking to PayPal.");
  }
  console.error(`PayPal ${op} failed: ${err.status} ${err.issue} ${err.message} debug_id=${err.debugId ?? "n/a"}`);
  const details = err.debugId ? { paypalIssue: err.issue, debugId: err.debugId } : { paypalIssue: err.issue };
  switch (err.issue) {
    case "ORDER_NOT_APPROVED":
      return new HttpError(409, "ORDER_NOT_APPROVED", "The buyer has not approved this order yet.", details);
    case "INSTRUMENT_DECLINED":
      return new HttpError(402, "PAYMENT_DECLINED", "The payment method was declined. Try another funding source.", details);
    case "AUTH_FAILED":
      return new HttpError(502, "PAYPAL_AUTH_FAILED", "Server PayPal credentials were rejected. Check client id/secret are Sandbox values.", details);
    case "TIMEOUT":
      return new HttpError(504, "PAYPAL_TIMEOUT", "PayPal took too long to respond. It is safe to retry.", details);
    case "RESOURCE_NOT_FOUND":
      return new HttpError(404, "PAYPAL_ORDER_NOT_FOUND", "PayPal does not recognise this order.", details);
    default:
      return new HttpError(502, "PAYPAL_ERROR", `PayPal ${op} failed: ${err.issue}`, details);
  }
}
