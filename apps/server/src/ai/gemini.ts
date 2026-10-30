import { ApiError, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import { TrialResultSchema } from "@cartguardian/shared";
import { AiError, type AiAdapter, type TrialOutcome, type TrialRequest } from "./types.js";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

/** Minimal surface we use, so tests can inject a fake. */
export interface GeminiModelsClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<Pick<GenerateContentResponse, "text">>;
  };
}

/**
 * Gemini returns the trial as JSON constrained by `responseJsonSchema`.
 * Gemini ignores `maxLength`, so every result is re-validated with Zod and
 * gets one repair attempt, exactly like the Anthropic adapter.
 */
export const GEMINI_SYSTEM = SYSTEM_PROMPT.replace(
  /Record your result by calling the \S+ tool exactly once\./,
  "Respond with a single JSON object that matches the provided schema, and nothing else.",
);

export function trialJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(TrialResultSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Errors where trying a different model can help: overload, per-model quota, slowness. */
function isFallbackWorthy(err: AiError): boolean {
  return err.kind === "rate_limited" || err.kind === "timeout" || (err.kind === "upstream" && /\b(503|500)\b|UNAVAILABLE|INTERNAL/.test(`${err.message} ${err.detail ?? ""}`));
}

export class GeminiAdapter implements AiAdapter {
  readonly name = "gemini" as const;
  readonly model: string;
  private readonly chain: string[];
  private readonly client: GeminiModelsClient;
  private readonly schema = trialJsonSchema();
  private readonly thinkingLevel: ThinkingLevel | undefined;
  /** Whole-trial budget: fallbacks and the repair attempt all fit inside it. */
  private readonly totalBudgetMs: number;
  /** Cap per model while other models are still left to try. */
  private readonly perModelMs: number;

  constructor(
    opts: {
      apiKey?: string;
      model: string;
      fallbackModels?: string[];
      timeoutMs: number;
      perModelTimeoutMs?: number;
      thinkingLevel?: GeminiThinkingSetting;
    },
    client?: GeminiModelsClient,
  ) {
    this.model = opts.model;
    this.totalBudgetMs = opts.timeoutMs;
    this.perModelMs = Math.min(opts.perModelTimeoutMs ?? 12_000, opts.timeoutMs);
    this.chain = [opts.model, ...(opts.fallbackModels ?? []).filter((m) => m && m !== opts.model)];
    this.thinkingLevel = THINKING[opts.thinkingLevel ?? "low"];
    this.client =
      client ??
      new GoogleGenAI({
        apiKey: opts.apiKey,
        // SDK default is 5 attempts with up to 60 s backoff: too slow for a user waiting on a page.
        // With fallbacks configured, moving to the next model beats retrying an overloaded one.
        httpOptions: { timeout: opts.timeoutMs, retryOptions: { attempts: this.chain.length > 1 ? 1 : 2 } },
      });
  }

  async runTrial(req: TrialRequest): Promise<TrialOutcome> {
    const contents: Content[] = [{ role: "user", parts: [{ text: buildUserMessage(req) }] }];
    const deadline = Date.now() + this.totalBudgetMs;
    let model: string | undefined;

    for (let attempt = 1; attempt <= 2; attempt++) {
      // First attempt walks the chain; the repair attempt stays on the model that answered.
      const res = model ? await this.call(model, contents, remaining(deadline)) : await this.callWithFallback(contents, deadline);
      model = res.model;
      const text = res.text ?? "";
      let json: unknown;
      let problems: string;
      try {
        json = JSON.parse(text);
        const parsed = TrialResultSchema.safeParse(json);
        if (parsed.success) return { trial: parsed.data, model };
        problems = parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
      } catch {
        problems = "response was not valid JSON";
      }
      if (attempt === 2) throw new AiError("invalid_output", "Model output failed schema validation twice.", problems);

      contents.push({ role: "model", parts: [{ text }] });
      contents.push({
        role: "user",
        parts: [{ text: `Your JSON failed validation: ${problems}. Return the corrected JSON object only.` }],
      });
    }
    throw new AiError("invalid_output", "Unreachable");
  }

  private async callWithFallback(contents: Content[], deadline: number) {
    const failures: string[] = [];
    for (const [i, model] of this.chain.entries()) {
      const isLast = i === this.chain.length - 1;
      const left = remaining(deadline);
      try {
        // Earlier models get a capped slice so a stuck one can't use up the whole budget.
        return await this.call(model, contents, isLast ? left : Math.min(this.perModelMs, left));
      } catch (err) {
        if (!(err instanceof AiError) || !isFallbackWorthy(err) || i === this.chain.length - 1) {
          if (err instanceof AiError && failures.length) {
            throw new AiError(err.kind, err.message, `${failures.join(" | ")} | ${model}: ${err.detail ?? err.message}`);
          }
          throw err;
        }
        console.warn(`Gemini model ${model} unavailable (${err.message}); trying ${this.chain[i + 1]}`);
        failures.push(`${model}: ${err.detail ?? err.message}`);
      }
    }
    throw new AiError("upstream", "No Gemini model configured.");
  }

  private async call(model: string, contents: Content[], timeoutMs: number): Promise<{ text: string | undefined; model: string }> {
    try {
      const res = await this.client.models.generateContent({
        model,
        contents,
        config: {
          // Per-request timeout; the SDK also sends it to Google as X-Server-Timeout.
          httpOptions: { timeout: timeoutMs },
          systemInstruction: GEMINI_SYSTEM,
          responseMimeType: "application/json",
          responseJsonSchema: this.schema,
          // Thinking tokens can count toward output, so leave headroom for the JSON itself.
          maxOutputTokens: 4096,
          // A trial is a structured judgement, not a hard reasoning task. Low thinking keeps
          // latency well inside the per-request deadline.
          ...(this.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.thinkingLevel } } : {}),
        },
      });
      return { text: res.text, model };
    } catch (err) {
      throw mapGeminiError(err, model);
    }
  }
}

/** Time left before the deadline; throws a timeout once less than a second remains. */
function remaining(deadline: number): number {
  const left = deadline - Date.now();
  if (left < 1000) throw new AiError("timeout", "AI provider timed out.", "Trial time budget (AI_TIMEOUT_MS) used up.");
  return left;
}

export type GeminiThinkingSetting = "minimal" | "low" | "medium" | "high" | "default";

const THINKING: Record<GeminiThinkingSetting, ThinkingLevel | undefined> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  default: undefined,
};

export function mapGeminiError(err: unknown, model: string): AiError {
  if (err instanceof ApiError) {
    const detail = err.message.slice(0, 600);
    if (err.status === 429) return new AiError("rate_limited", "AI provider rate limit or daily free quota reached.", detail);
    if (err.status === 401 || err.status === 403 || /API key not valid|API_KEY_INVALID/i.test(err.message))
      return new AiError("auth", "AI provider rejected the API key.", detail);
    if (err.status === 404) return new AiError("upstream", `AI model "${model}" was not found.`, detail);
    if (err.status === 408 || err.status === 504 || /DEADLINE_EXCEEDED/.test(err.message))
      return new AiError("timeout", "AI provider timed out.", detail);
    if (err.status === 400 && /thinking/i.test(err.message))
      return new AiError("upstream", `Model "${model}" rejected the thinking setting. Set GEMINI_THINKING_LEVEL=default.`, detail);
    return new AiError("upstream", `AI provider error (${err.status}).`, detail);
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new AiError("timeout", "AI provider timed out.", err.message);
  }
  if (err instanceof AiError) return err;
  return new AiError("upstream", "AI provider request failed.", err instanceof Error ? err.message : String(err));
}
