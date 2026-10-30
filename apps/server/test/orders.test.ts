import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildTestApp, FakePayPal, validInput } from "./helpers.js";
import { PayPalApiError } from "../src/paypal/client.js";

async function evaluate(app: Parameters<typeof request>[0]) {
  const res = await request(app).post("/api/evaluations").send(validInput).expect(201);
  return res.body.evaluation.id as string;
}

describe("orders", () => {
  it("creates the order for the server-stored amount and ignores client-supplied amounts", async () => {
    const { app, paypal } = buildTestApp();
    const evaluationId = await evaluate(app);
    const res = await request(app)
      .post("/api/orders")
      .send({ evaluationId, amount: "0.01", currency: "EUR", value: "0.01" })
      .expect(201);
    const sent = paypal.orders.get(res.body.order.orderId)!.params;
    expect(sent.amount).toEqual({ currency_code: "USD", value: "199.90" });
    expect(sent.referenceId).toBe(evaluationId);
    expect(res.body.order.status).toBe("CREATED");
  });

  it("returns 404 for an unknown evaluation and 503 when PayPal is not configured", async () => {
    const { app } = buildTestApp();
    await request(app).post("/api/orders").send({ evaluationId: crypto.randomUUID() }).expect(404);

    const unconfigured = new FakePayPal();
    unconfigured.configured = false;
    const b = buildTestApp({ paypal: unconfigured });
    const id = await evaluate(b.app);
    const res = await request(b.app).post("/api/orders").send({ evaluationId: id }).expect(503);
    expect(res.body.error.code).toBe("PAYPAL_NOT_CONFIGURED");
  });

  it("captures an approved order and verifies it", async () => {
    const { app, paypal } = buildTestApp();
    const evaluationId = await evaluate(app);
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    paypal.approve(body.order.orderId);

    const cap = await request(app).post(`/api/orders/${body.order.orderId}/capture`).expect(200);
    expect(cap.body.replayed).toBe(false);
    expect(cap.body.order).toMatchObject({ status: "COMPLETED", amount: { value: "199.90", currency: "USD" } });
    expect(cap.body.order.captureId).toMatch(/^CAP/);
  });

  it("is idempotent: a second capture replays the stored result without calling PayPal", async () => {
    const { app, paypal } = buildTestApp();
    const evaluationId = await evaluate(app);
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    paypal.approve(body.order.orderId);
    await request(app).post(`/api/orders/${body.order.orderId}/capture`).expect(200);
    const second = await request(app).post(`/api/orders/${body.order.orderId}/capture`).expect(200);
    expect(second.body.replayed).toBe(true);
    expect(paypal.calls.capture).toBe(1);
  });

  it("collapses concurrent capture requests into one PayPal call", async () => {
    const { app, paypal } = buildTestApp();
    paypal.captureDelayMs = 50;
    const evaluationId = await evaluate(app);
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    paypal.approve(body.order.orderId);
    const results = await Promise.all(
      [1, 2, 3].map(() => request(app).post(`/api/orders/${body.order.orderId}/capture`)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(paypal.calls.capture).toBe(1);
  });

  it("returns 409 when the buyer has not approved", async () => {
    const { app } = buildTestApp();
    const evaluationId = await evaluate(app);
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    const res = await request(app).post(`/api/orders/${body.order.orderId}/capture`).expect(409);
    expect(res.body.error.code).toBe("ORDER_NOT_APPROVED");
    expect(res.body.error.details.debugId).toBe("dbg-3");
  });

  it("refuses to capture orders it did not create", async () => {
    const { app, paypal } = buildTestApp();
    await request(app).post("/api/orders/ABC123FOREIGN/capture").expect(404);
    await request(app).post("/api/orders/not-valid!/capture").expect(400);
    expect(paypal.calls.capture).toBe(0);
  });

  it("does not record success when the captured amount differs", async () => {
    const { app, paypal } = buildTestApp();
    const evaluationId = await evaluate(app);
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    const orderId = body.order.orderId;
    paypal.captureOverride = (id) => ({
      id,
      status: "COMPLETED",
      purchase_units: [{ reference_id: evaluationId, amount: { currency_code: "USD", value: "1.00" }, payments: { captures: [{ id: "CAPX", status: "COMPLETED", amount: { currency_code: "USD", value: "1.00" } }] } }],
    });
    const res = await request(app).post(`/api/orders/${orderId}/capture`).expect(502);
    expect(res.body.error.code).toBe("AMOUNT_MISMATCH");
    const status = await request(app).get(`/api/orders/${orderId}`).expect(200);
    expect(status.body.order.status).toBe("FAILED");
  });

  it("treats a declined instrument as 402 and a PENDING capture as 202", async () => {
    const { app, paypal } = buildTestApp();
    const evaluationId = await evaluate(app);
    const a = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    paypal.captureError = new PayPalApiError(422, "INSTRUMENT_DECLINED", "declined", "dbg-9");
    const declined = await request(app).post(`/api/orders/${a.body.order.orderId}/capture`).expect(402);
    expect(declined.body.error.code).toBe("PAYMENT_DECLINED");

    paypal.captureError = null;
    const b = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    paypal.captureOverride = (id) => ({
      id,
      status: "COMPLETED",
      purchase_units: [{ reference_id: evaluationId, amount: { currency_code: "USD", value: "199.90" }, payments: { captures: [{ id: "CAPP", status: "PENDING", amount: { currency_code: "USD", value: "199.90" } }] } }],
    });
    const pending = await request(app).post(`/api/orders/${b.body.order.orderId}/capture`).expect(202);
    expect(pending.body.order.status).toBe("PENDING");
  });

  it("reconciles ORDER_ALREADY_CAPTURED from PayPal's record", async () => {
    const { app, paypal } = buildTestApp();
    const evaluationId = await evaluate(app);
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    const orderId = body.order.orderId;
    paypal.approve(orderId);
    await paypal.captureOrder(orderId, "out-of-band"); // captured elsewhere, our store doesn't know
    const res = await request(app).post(`/api/orders/${orderId}/capture`).expect(200);
    expect(res.body.order.status).toBe("COMPLETED");
  });
});
