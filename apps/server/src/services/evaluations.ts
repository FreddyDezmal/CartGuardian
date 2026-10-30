import { randomUUID } from "node:crypto";
import {
  EvaluationInputSchema,
  type Evaluation,
  type NormalizedEvaluationInput,
  type ValueMetrics,
  type Money,
} from "@cartguardian/shared";
import { AiError, type AiAdapter } from "../ai/index.js";
import { applyGuardrails } from "../ai/guardrails.js";
import { HttpError } from "../errors.js";
import { divideMoney, normalizeMoney } from "../money.js";
import type { Store } from "../store.js";

export const DISCLAIMER =
  "CartGuardian offers a structured second opinion, not financial advice. It has not verified product claims; check the seller's details, return policy and reviews before buying.";

export function computeMetrics(input: NormalizedEvaluationInput, amount: Money): ValueMetrics {
  const { usesPerMonth, lifetimeMonths } = input;
  const totalExpectedUses =
    usesPerMonth !== undefined && lifetimeMonths !== undefined ? usesPerMonth * lifetimeMonths : null;
  return {
    totalExpectedUses,
    costPerUse: totalExpectedUses && totalExpectedUses > 0 ? divideMoney(amount, totalExpectedUses) : null,
    costPerMonth: lifetimeMonths ? divideMoney(amount, lifetimeMonths) : null,
  };
}

export class EvaluationService {
  constructor(
    private readonly ai: AiAdapter,
    private readonly store: Store,
  ) {}

  async create(rawBody: unknown): Promise<Evaluation> {
    const parsed = EvaluationInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_FAILED",
        "Some fields are invalid.",
        parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      );
    }
    const input = parsed.data;
    // The server, never the browser or the model, owns the amount from here on.
    const amount = normalizeMoney(input.price, input.currency);
    const metrics = computeMetrics(input, amount);

    let outcome;
    try {
      outcome = await this.ai.runTrial({ input, amount, metrics });
    } catch (err) {
      throw mapAiError(err);
    }
    const guarded = applyGuardrails(outcome.trial);

    const evaluation: Evaluation = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      productName: input.productName,
      amount,
      metrics,
      trial: guarded.trial,
      provider: this.ai.name,
      model: outcome.model,
      policyFlags: guarded.flags,
      disclaimer: DISCLAIMER,
    };
    await this.store.saveEvaluation(evaluation);
    return evaluation;
  }

  async get(id: string): Promise<Evaluation> {
    const e = await this.store.getEvaluation(id);
    if (!e) throw new HttpError(404, "EVALUATION_NOT_FOUND", "No evaluation with that id.");
    return e;
  }
}

function mapAiError(err: unknown): HttpError {
  if (!(err instanceof AiError)) {
    console.error("Unexpected AI adapter error", err);
    return new HttpError(502, "AI_UPSTREAM", "The AI provider failed unexpectedly.");
  }
  console.error(`AI error (${err.kind}): ${err.message}${err.detail ? ` | provider said: ${err.detail}` : ""}`);
  switch (err.kind) {
    case "timeout":
      return new HttpError(504, "AI_TIMEOUT", "The AI provider took too long. Try again.");
    case "rate_limited":
      return new HttpError(503, "AI_RATE_LIMITED", "The AI provider is rate limiting requests. Wait a moment and retry.");
    case "auth":
      return new HttpError(502, "AI_AUTH", "The server's AI credentials were rejected. Check the API key in apps/server/.env.");
    case "invalid_output":
      return new HttpError(502, "AI_INVALID_OUTPUT", "The AI returned an unusable result. Try again.");
    case "upstream":
      // err.message is our own wording; provider detail stays in the server log.
      return new HttpError(502, "AI_UPSTREAM", err.message);
  }
}
