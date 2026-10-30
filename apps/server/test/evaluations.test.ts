import { describe, expect, it } from "vitest";
import request from "supertest";
import type { TrialResult } from "@cartguardian/shared";
import { buildTestApp, validInput } from "./helpers.js";
import { AiError, type AiAdapter, type TrialOutcome } from "../src/ai/types.js";

describe("GET /api/health", () => {
  it("reports provider and PayPal configuration without leaking secrets", async () => {
    const { app } = buildTestApp({ env: { PAYPAL_CLIENT_ID: "public-id", PAYPAL_CLIENT_SECRET: "super-secret" } });
    const res = await request(app).get("/api/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok", ai: { provider: "mock" }, paypal: { environment: "sandbox" } });
    expect(JSON.stringify(res.body)).not.toContain("super-secret");
  });

  it("/api/config exposes the client id but never the secret", async () => {
    const { app } = buildTestApp({ env: { PAYPAL_CLIENT_ID: "public-id", PAYPAL_CLIENT_SECRET: "super-secret" } });
    const res = await request(app).get("/api/config").expect(200);
    expect(res.body.paypalClientId).toBe("public-id");
    expect(JSON.stringify(res.body)).not.toContain("super-secret");
  });
});

describe("POST /api/evaluations", () => {
  it("creates an evaluation with server-computed amount and metrics", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/api/evaluations").send(validInput).expect(201);
    const e = res.body.evaluation;
    expect(e.amount).toEqual({ currency: "USD", value: "199.90" });
    expect(e.metrics.totalExpectedUses).toBe(960);
    expect(e.metrics.costPerUse).toEqual({ currency: "USD", value: "0.21" });
    expect(e.metrics.costPerMonth).toEqual({ currency: "USD", value: "8.33" });
    expect(e.provider).toBe("mock");
    expect(e.trial.buyCase.arguments.length).toBeGreaterThan(0);
    expect(e.trial.skipCase.arguments.length).toBeGreaterThan(0);
    expect(e.disclaimer).toMatch(/not financial advice/);

    const again = await request(app).get(`/api/evaluations/${e.id}`).expect(200);
    expect(again.body.evaluation.id).toBe(e.id);
  });

  it.each([
    ["negative price", { price: "-5" }],
    ["zero price", { price: "0" }],
    ["too many decimals", { price: "1.999" }],
    ["over max", { price: "5000.01" }],
    ["number instead of string", { price: 10 }],
    ["unsupported currency", { currency: "BTC" }],
    ["empty name", { productName: " " }],
    ["oversized description", { description: "x".repeat(2001) }],
    ["fractional uses", { usesPerMonth: 1.5 }],
  ])("rejects %s with 400", async (_label, patch) => {
    const { app } = buildTestApp();
    const res = await request(app).post("/api/evaluations").send({ ...validInput, ...patch }).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects bodies over 16kb with 413", async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post("/api/evaluations")
      .send({ ...validInput, description: "x".repeat(20_000) })
      .expect(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("softens absolute claims the model slips through and flags them", async () => {
    const leaky: AiAdapter = {
      name: "anthropic",
      model: "fake",
      async runTrial(): Promise<TrialOutcome> {
        const trial: TrialResult = {
          buyCase: { headline: "A no-brainer", arguments: [{ point: "This is guaranteed to save you money.", basis: "assumption" }] },
          skipCase: { headline: "Maybe not", arguments: [{ point: "Cheaper options exist.", basis: "general_knowledge" }] },
          verdict: "buy",
          confidence: "high",
          verdictRationale: "Risk-free choice.",
          questionsBeforeBuying: [],
          unverifiedAssumptions: [],
        };
        return { trial, model: "fake" };
      },
    };
    const { app } = buildTestApp({ ai: leaky });
    const res = await request(app).post("/api/evaluations").send(validInput).expect(201);
    const text = JSON.stringify(res.body.evaluation.trial).toLowerCase();
    expect(text).not.toMatch(/guaranteed|risk-free|no-brainer/);
    expect(res.body.evaluation.policyFlags.length).toBe(3);
  });

  it("maps AI timeouts to 504 without leaking details", async () => {
    const slow: AiAdapter = {
      name: "anthropic",
      model: "fake",
      runTrial: async () => {
        throw new AiError("timeout", "internal detail");
      },
    };
    const { app } = buildTestApp({ ai: slow });
    const res = await request(app).post("/api/evaluations").send(validInput).expect(504);
    expect(res.body.error.code).toBe("AI_TIMEOUT");
    expect(JSON.stringify(res.body)).not.toContain("internal detail");
  });

  it("rate limits evaluations per IP", async () => {
    const { app } = buildTestApp({ env: { RATE_LIMIT_EVALUATIONS_PER_MINUTE: "2" } });
    await request(app).post("/api/evaluations").send(validInput).expect(201);
    await request(app).post("/api/evaluations").send(validInput).expect(201);
    const res = await request(app).post("/api/evaluations").send(validInput).expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("refuses disallowed CORS origins", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example").expect(403);
    expect(res.body.error.code).toBe("CORS_ORIGIN_DENIED");
    await request(app).get("/api/health").set("Origin", "http://localhost:5173").expect(200).expect("access-control-allow-origin", "http://localhost:5173");
  });
});
