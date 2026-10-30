import type { AppConfig } from "../config.js";
import type { AiAdapter } from "./types.js";
import { MockAdapter } from "./mock.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";

export function createAiAdapter(config: AppConfig["ai"]): AiAdapter {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicAdapter({ apiKey: config.anthropicApiKey, model: config.model, timeoutMs: config.timeoutMs });
    case "gemini":
      return new GeminiAdapter({
        apiKey: config.geminiApiKey,
        model: config.model,
        fallbackModels: config.geminiFallbackModels,
        timeoutMs: config.timeoutMs,
        perModelTimeoutMs: config.geminiPerModelTimeoutMs,
        thinkingLevel: config.geminiThinkingLevel,
      });
    case "mock":
      return new MockAdapter();
  }
}

export * from "./types.js";
