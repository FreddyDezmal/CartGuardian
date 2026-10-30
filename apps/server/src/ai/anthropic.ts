import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { TrialResultSchema, type TrialResult } from "@cartguardian/shared";
import { AiError, type AiAdapter, type TrialRequest } from "./types.js";
import { SYSTEM_PROMPT, TRIAL_TOOL_NAME, buildUserMessage } from "./prompt.js";

/** Minimal surface we use, so tests can inject a fake. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

function trialInputSchema(): Anthropic.Tool["input_schema"] {
  const schema = z.toJSONSchema(TrialResultSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema as Anthropic.Tool["input_schema"];
}

export class AnthropicAdapter implements AiAdapter {
  readonly name = "anthropic" as const;
  private readonly client: MessagesClient;
  private readonly tool: Anthropic.Tool;

  constructor(
    opts: { apiKey?: string; model: string; timeoutMs: number },
    client?: MessagesClient,
  ) {
    this.model = opts.model;
    // maxRetries: 1 -> the SDK retries one transient failure (429/5xx/timeout) itself.
    this.client = client ?? new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 1 });
    this.tool = {
      name: TRIAL_TOOL_NAME,
      description: "Record the completed two-sided Purchase Trial and verdict.",
      input_schema: trialInputSchema(),
    };
  }
  readonly model: string;

  async runTrial(req: TrialRequest): Promise<TrialResult> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: buildUserMessage(req) }];

    // One repair attempt if the model returns output that fails validation.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const msg = await this.call(messages);
      const block = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TRIAL_TOOL_NAME);
      if (!block) {
        if (attempt === 2) throw new AiError("invalid_output", "Model did not return a structured trial.");
        messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
        messages.push({ role: "user", content: `Call the ${TRIAL_TOOL_NAME} tool with your result.` });
        continue;
      }
      const parsed = TrialResultSchema.safeParse(block.input);
      if (parsed.success) return parsed.data;
      if (attempt === 2) throw new AiError("invalid_output", "Model output failed schema validation twice.");

      const problems = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: `Validation failed: ${problems}. Call ${TRIAL_TOOL_NAME} again with corrected input.`,
          },
        ],
      });
    }
    throw new AiError("invalid_output", "Unreachable");
  }

  private async call(messages: Anthropic.MessageParam[]): Promise<Anthropic.Message> {
    try {
      return await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools: [this.tool],
        tool_choice: { type: "tool", name: TRIAL_TOOL_NAME },
        messages,
      });
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionTimeoutError) throw new AiError("timeout", "AI provider timed out.");
      if (err instanceof Anthropic.RateLimitError) throw new AiError("rate_limited", "AI provider rate limit reached.");
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
        throw new AiError("auth", "AI provider rejected the API key.");
      if (err instanceof Anthropic.NotFoundError) throw new AiError("upstream", `AI model "${this.model}" was not found.`);
      if (err instanceof Anthropic.APIError) throw new AiError("upstream", `AI provider error (${err.status ?? "network"}).`);
      throw err;
    }
  }
}
