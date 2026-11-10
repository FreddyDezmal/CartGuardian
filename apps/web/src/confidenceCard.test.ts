import { describe, expect, it } from "vitest";
import type { Evaluation } from "@cartguardian/shared";
import { summarize } from "./confidenceCard";
import { makeEvaluation } from "./testFixtures";

describe("Purchase Confidence Card: outcomes", () => {
  it("positive: a buy verdict is 'Worth considering', in green, with the strongest points each side", () => {
    const s = summarize(makeEvaluation());
    expect(s.outcome).toEqual({ label: "Worth considering", tone: "positive" });
    expect(s.confidence).toBe("High");
    expect(s.why).toBe("At your usage it costs less per cup than what you pay now.");
    expect(s.positives.map((p) => p.text)).toEqual(["You'd use it on 22 workdays a month.", "Built-in grinders save counter space."]);
    expect(s.warnings).toHaveLength(2);
    expect(s.hiddenCount).toBe(1); // the third "for" point stays in the full trial
    expect(s.uncertainty).toEqual([]);
    expect(s.nextSteps).toEqual(["What does the warranty cover?", "How much do replacement burrs cost?", "If those check out, you can pay below at the price on trial."]);
  });

  it("cautious: a wait verdict is 'Proceed with caution', in amber, and says to hold off paying", () => {
    const s = summarize(makeEvaluation({}, { verdict: "wait", confidence: "medium" }));
    expect(s.outcome).toEqual({ label: "Proceed with caution", tone: "caution" });
    expect(s.confidence).toBe("Medium");
    expect(s.nextSteps.at(-1)).toBe("Hold off paying until the points above are answered.");
  });

  it("negative: a skip verdict is 'Not recommended', in red, and low confidence is made visible", () => {
    const s = summarize(makeEvaluation({}, { verdict: "skip", confidence: "low" }));
    expect(s.outcome).toEqual({ label: "Not recommended", tone: "negative" });
    expect(s.uncertainty).toContain("The AI rated its own confidence as low. Treat this as a first opinion.");
    expect(s.nextSteps.at(-1)).toMatch(/^Don't pay yet/);
  });

  it("never changes the AI's verdict, even when confidence is low", () => {
    expect(summarize(makeEvaluation({}, { verdict: "buy", confidence: "low" })).outcome.label).toBe("Worth considering");
  });
});

describe("Purchase Confidence Card: missing and invalid data", () => {
  it("survives an evaluation with no trial fields at all, showing less instead of guessing", () => {
    const broken = { ...makeEvaluation(), trial: {} } as unknown as Evaluation;
    const s = summarize(broken);
    expect(s.outcome).toEqual({ label: "No recommendation", tone: "neutral" });
    expect(s.confidence).toBeNull();
    expect(s.why).toBeNull();
    expect(s.positives).toEqual([]);
    expect(s.warnings).toEqual([]);
    expect(s.hiddenCount).toBe(0);
    expect(s.uncertainty).toEqual(["The AI didn't give a confidence rating for this trial.", "The trial didn't return a clear recommendation."]);
    expect(s.nextSteps).toEqual(["Read the full trial below and decide for yourself."]);
  });

  it("treats an invalid verdict or confidence as unavailable, never as a score", () => {
    const s = summarize(makeEvaluation({}, { verdict: "maybe" as never, confidence: 87 as never }));
    expect(s.outcome.label).toBe("No recommendation");
    expect(s.confidence).toBeNull();
  });

  it("drops malformed arguments rather than guessing where they came from", () => {
    const s = summarize(
      makeEvaluation({}, {
        buyCase: { headline: "x", arguments: [{ point: "  ", basis: "your_input" }, { point: "Real point", basis: "rumour" as never }, { point: "Kept", basis: "assumption" }] },
      }),
    );
    expect(s.positives).toEqual([{ text: "Kept", basis: "assumption" }]);
  });

  it("incomplete product information: missing usage is listed as unknown, not as a warning", () => {
    const s = summarize(makeEvaluation({ metrics: { costPerUse: null, costPerMonth: null, totalExpectedUses: null } }));
    expect(s.unknowns.slice(0, 2)).toEqual([
      "How often you'd use it, so cost per use couldn't be worked out.",
      "How long you'd keep it, so cost per month couldn't be worked out.",
    ]);
    expect(s.warnings.map((w) => w.text).join(" ")).not.toMatch(/use it|keep it/);
    expect(s.outcome.tone).toBe("positive"); // missing info doesn't lower the outcome
    expect(s.facts.map((f) => f.label)).toEqual(["Price on trial"]);
    expect(s.nextSteps).toContain("Add how often you'd use it and how long you'd keep it, then run the trial again.");
  });

  it("lists the AI's unverified assumptions under unknown", () => {
    expect(summarize(makeEvaluation()).unknowns).toEqual(["The machine lasts 3 years."]);
  });

  it("says how many points are assumptions when they make up half or more", () => {
    const s = summarize(
      makeEvaluation({}, {
        buyCase: { headline: "x", arguments: [{ point: "a", basis: "assumption" }, { point: "b", basis: "assumption" }] },
        skipCase: { headline: "y", arguments: [{ point: "c", basis: "assumption" }, { point: "d", basis: "your_input" }] },
      }),
    );
    expect(s.uncertainty).toContain("3 of 4 points are assumptions, not things you told CartGuardian.");
  });

  it("keeps at most 5 steps and always keeps the closing step", () => {
    const s = summarize(
      makeEvaluation({ metrics: { costPerUse: null, costPerMonth: null, totalExpectedUses: null } }, { questionsBeforeBuying: ["q1", "q2", "q3", "q4"] }),
    );
    expect(s.nextSteps).toEqual(["q1", "q2", "q3", "q4", "If those check out, you can pay below at the price on trial."]);
  });
});

describe("Purchase Confidence Card: facts are kept apart from the AI", () => {
  it("shows the price and the server's calculations with their source, never as AI output", () => {
    const s = summarize(makeEvaluation(), "en-US");
    expect(s.facts).toEqual([
      { label: "Price on trial", value: "$449.00", source: "As you confirmed it" },
      { label: "Cost per use", value: "$0.57", source: "Worked out from your usage" },
      { label: "Cost per month", value: "$12.47", source: "Worked out from how long you'd keep it" },
    ]);
  });

  it("names the store only as the user gave it, without vouching for it", () => {
    const imported = summarize(makeEvaluation({ product: { retailer: "Example Shop", sourceUrl: "https://shop.example/p/1" } }));
    expect(imported.facts.at(-1)).toEqual({ label: "Store", value: "Example Shop", source: "From the link you imported" });
    const typed = summarize(makeEvaluation({ product: { retailer: "Corner store" } }));
    expect(typed.facts.at(-1)?.source).toBe("As you entered it");
  });

  it("flags the rule-based demo adapter", () => {
    expect(summarize(makeEvaluation({ provider: "mock" })).isDemo).toBe(true);
  });
});
