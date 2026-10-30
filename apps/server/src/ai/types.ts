import type { AiProviderName, NormalizedEvaluationInput, TrialResult, ValueMetrics, Money } from "@cartguardian/shared";

export interface TrialRequest {
  input: NormalizedEvaluationInput;
  amount: Money;
  metrics: ValueMetrics;
}

/** Every AI provider implements this. Add a provider = add one file. */
export interface AiAdapter {
  readonly name: AiProviderName;
  readonly model: string;
  runTrial(req: TrialRequest): Promise<TrialResult>;
}

/** Thrown by adapters; mapped to HTTP errors by the evaluation route. */
export class AiError extends Error {
  constructor(
    public readonly kind: "timeout" | "rate_limited" | "auth" | "invalid_output" | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}
