import type { AppConfig } from "../config.js";
import type { AiAdapter } from "./types.js";
import { MockAdapter } from "./mock.js";
import { AnthropicAdapter } from "./anthropic.js";

export function createAiAdapter(config: AppConfig["ai"]): AiAdapter {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicAdapter({ apiKey: config.anthropicApiKey, model: config.model, timeoutMs: config.timeoutMs });
    case "mock":
      return new MockAdapter();
  }
}

export * from "./types.js";
