import type { TrialResult } from "@cartguardian/shared";
import type { AiAdapter, TrialRequest } from "./types.js";
import { toMinorUnits } from "../money.js";

/**
 * Deterministic, rule-based stand-in for a real model. It exists so the
 * whole flow (including PayPal) can be built and demoed before AI
 * credentials exist. Every response it produces is labelled provider "mock".
 */
export class MockAdapter implements AiAdapter {
  readonly name = "mock" as const;
  readonly model = "mock-v1";

  async runTrial({ input, amount, metrics }: TrialRequest): Promise<TrialResult> {
    const price = `${amount.value} ${amount.currency}`;
    const priceMinor = toMinorUnits(amount.value);
    const cpuMinor = metrics.costPerUse ? toMinorUnits(metrics.costPerUse.value) : null;
    const hasUsage = input.usesPerMonth !== undefined && input.lifetimeMonths !== undefined;

    const buyArgs: TrialResult["buyCase"]["arguments"] = [];
    const skipArgs: TrialResult["skipCase"]["arguments"] = [];

    if (input.intendedUse) {
      buyArgs.push({ point: `You have a specific use in mind: "${input.intendedUse.slice(0, 120)}".`, basis: "your_input" });
    }
    if (metrics.costPerUse) {
      const p = `At your expected usage this works out to ${metrics.costPerUse.value} ${amount.currency} per use.`;
      (cpuMinor !== null && cpuMinor <= 200 ? buyArgs : skipArgs).push({ point: p, basis: "your_input" });
    }
    if (input.usesPerMonth === 0) {
      skipArgs.push({ point: "You expect to use it zero times a month, so it may sit unused.", basis: "your_input" });
    }
    if (!hasUsage) {
      skipArgs.push({ point: "You haven't estimated how often you'd use it, so its value is hard to judge.", basis: "assumption" });
    }
    if (priceMinor >= 50000) {
      skipArgs.push({ point: `At ${price}, this is a large purchase where a 24-hour pause is commonly recommended.`, basis: "general_knowledge" });
    } else {
      buyArgs.push({ point: `At ${price}, the downside of a wrong decision is relatively contained.`, basis: "assumption" });
    }
    if (buyArgs.length === 0) buyArgs.push({ point: "It may solve a need you haven't fully described yet.", basis: "assumption" });
    if (skipArgs.length === 0) skipArgs.push({ point: "Prices and alternatives change; comparing two options first rarely hurts.", basis: "general_knowledge" });

    let verdict: TrialResult["verdict"] = "wait";
    if (cpuMinor !== null && input.usesPerMonth !== 0) verdict = cpuMinor <= 200 ? "buy" : cpuMinor >= 1000 ? "skip" : "wait";
    if (input.usesPerMonth === 0) verdict = "skip";

    return {
      buyCase: { headline: "Why it could be worth it", arguments: buyArgs.slice(0, 4) },
      skipCase: { headline: "Why you might hold off", arguments: skipArgs.slice(0, 4) },
      verdict,
      confidence: hasUsage ? "medium" : "low",
      verdictRationale:
        "[Mock adapter] Rule-based verdict from cost per use and your stated usage. Connect a real AI provider for a reasoned evaluation.",
      questionsBeforeBuying: [
        "What is the return window and who pays return shipping?",
        "Is there a cheaper option that covers 80% of your use case?",
      ],
      unverifiedAssumptions: input.description ? ["Claims in the product description have not been verified."] : [],
    };
  }
}
