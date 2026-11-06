import { describe, expect, it } from "vitest";
import request from "supertest";
import { buildTestApp, FakePayPal, validInput } from "./helpers.js";
import { PayPalApiError } from "../src/paypal/client.js";
import { MemoryStore } from "../src/store.js";

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

describe("captures across server instances (serverless)", () => {
  it("lets only one of two instances sharing a database capture an order", async () => {
    const store = new MemoryStore();
    const paypal = new FakePayPal();
    paypal.captureDelayMs = 50;
    // Two independent apps = two serverless instances: separate in-process locks, one shared store.
    const a = buildTestApp({ store, paypal });
    const b = buildTestApp({ store, paypal });
    const evaluationId = (await request(a.app).post("/api/evaluations").send(validInput).expect(201)).body.evaluation.id;
    const { body } = await request(a.app).post("/api/orders").send({ evaluationId }).expect(201);
    paypal.approve(body.order.orderId);

    const [ra, rb] = await Promise.all([
      request(a.app).post(`/api/orders/${body.order.orderId}/capture`),
      request(b.app).post(`/api/orders/${body.order.orderId}/capture`),
    ]);
    expect(paypal.calls.capture).toBe(1);
    const statuses = [ra.status, rb.status].sort();
    // The winner captures (200); the loser is told it's in progress (409) or sees the finished result (200).
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    const loser = ra.status === 409 ? ra : rb.status === 409 ? rb : null;
    if (loser) expect(loser.body.error.code).toBe("CAPTURE_IN_PROGRESS");

    // Afterwards, either instance replays the stored result without calling PayPal again.
    const replay = await request(b.app).post(`/api/orders/${body.order.orderId}/capture`).expect(200);
    expect(replay.body).toMatchObject({ replayed: true, order: { status: "COMPLETED" } });
    expect(paypal.calls.capture).toBe(1);
  });

  it("releases the claim after a retryable failure so the buyer can try again", async () => {
    const { app, paypal, store } = buildTestApp();
    const evaluationId = (await request(app).post("/api/evaluations").send(validInput).expect(201)).body.evaluation.id;
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    const orderId = body.order.orderId;

    await request(app).post(`/api/orders/${orderId}/capture`).expect(409); // not approved yet
    expect((await store.getOrder(orderId))!.status).toBe("CREATED");

    paypal.approve(orderId);
    const ok = await request(app).post(`/api/orders/${orderId}/capture`).expect(200);
    expect(ok.body.order).toMatchObject({ status: "COMPLETED", captureStartedAt: null });
  });

  it("takes over a capture claim abandoned by a crashed instance", async () => {
    const { app, paypal, store } = buildTestApp();
    const evaluationId = (await request(app).post("/api/evaluations").send(validInput).expect(201)).body.evaluation.id;
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    const orderId = body.order.orderId;
    paypal.approve(orderId);

    // Simulate an instance that claimed the order 5 minutes ago and died.
    const rec = (await store.getOrder(orderId))!;
    await store.saveOrder({ ...rec, status: "CAPTURING", captureStartedAt: new Date(Date.now() - 5 * 60_000).toISOString() });

    await request(app).post(`/api/orders/${orderId}/capture`).expect(200);
    expect(paypal.calls.capture).toBe(1);
  });

  it("reports a fresh claim held elsewhere as in progress, without calling PayPal", async () => {
    const { app, paypal, store } = buildTestApp();
    const evaluationId = (await request(app).post("/api/evaluations").send(validInput).expect(201)).body.evaluation.id;
    const { body } = await request(app).post("/api/orders").send({ evaluationId }).expect(201);
    const orderId = body.order.orderId;
    await store.claimForCapture(orderId, 120_000); // another instance is mid-capture

    const res = await request(app).post(`/api/orders/${orderId}/capture`).expect(409);
    expect(res.body.error.code).toBe("CAPTURE_IN_PROGRESS");
    expect(paypal.calls.capture).toBe(0);
  });
});
