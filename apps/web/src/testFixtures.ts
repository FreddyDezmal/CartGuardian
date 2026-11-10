import type { Evaluation } from "@cartguardian/shared";

/** A complete evaluation as the server returns it; tests override parts. */
export function makeEvaluation(over: Partial<Evaluation> = {}, trialOver: Partial<Evaluation["trial"]> = {}): Evaluation {
  return {
    id: "c561dd04-8db8-401a-99d6-05b24ad79912",
    createdAt: "2026-11-10T10:00:00.000Z",
    productName: "Espresso machine",
    amount: { currency: "USD", value: "449.00" },
    metrics: { costPerUse: { currency: "USD", value: "0.57" }, costPerMonth: { currency: "USD", value: "12.47" }, totalExpectedUses: 792 },
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    policyFlags: [],
    disclaimer: "CartGuardian offers a structured second opinion, not financial advice.",
    ...over,
    trial: {
      buyCase: {
        headline: "Replaces a daily café habit",
        arguments: [
          { point: "You'd use it on 22 workdays a month.", basis: "your_input" },
          { point: "Built-in grinders save counter space.", basis: "general_knowledge" },
          { point: "Your latte costs more than the machine per cup.", basis: "your_input" },
        ],
      },
      skipCase: {
        headline: "Upkeep and claims to check",
        arguments: [
          { point: "Grinders need regular cleaning.", basis: "general_knowledge" },
          { point: "\"Pays for itself in 3 months\" is the seller's claim.", basis: "your_input" },
        ],
      },
      verdict: "buy",
      confidence: "high",
      verdictRationale: "At your usage it costs less per cup than what you pay now.",
      questionsBeforeBuying: ["What does the warranty cover?", "How much do replacement burrs cost?"],
      unverifiedAssumptions: ["The machine lasts 3 years."],
      ...trialOver,
    },
  };
}
