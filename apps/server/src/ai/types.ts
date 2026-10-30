import type { AiProviderName, NormalizedEvaluationInput, TrialResult, ValueMetrics, Money } from "@cartguardian/shared";

export interface TrialRequest {
  input: NormalizedEvaluationInput;
  amount: Money;
  metrics: ValueMetrics;
}

export interface TrialOutcome {
  trial: TrialResult;
  /** The model that actually produced the trial (may be a fallback). */
  model: string;
}

/** Every AI provider implements this. Add a provider = add one file. */
export interface AiAdapter {
  readonly name: AiProviderName;
  /** Primary model, shown in /api/health. */
  readonly model: string;
  runTrial(req: TrialRequest): Promise<TrialOutcome>;
}

/** Thrown by adapters; mapped to HTTP errors by the evaluation route. */
export class AiError extends Error {
  constructor(
    public readonly kind: "timeout" | "rate_limited" | "auth" | "invalid_output" | "upstream",
    message: string,
    /** Provider's own explanation and request id. Logged server-side, never sent to the browser. */
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}
