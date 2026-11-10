import type { Basis, Evaluation, Money } from "@cartguardian/shared";

/**
 * The Purchase Confidence Card: a plain-language summary of a trial that is
 * already on screen. Kept free of React so every rule is unit-tested
 * (see confidenceCard.test.ts).
 *
 * Rules:
 * - Everything comes from the evaluation the server returned. Nothing new is
 *   claimed about the product, its price or the store.
 * - The outcome maps one-to-one from the AI's verdict. It is never upgraded
 *   or downgraded here.
 * - No numeric score: the evaluation holds a three-level confidence the model
 *   reports about itself, and a percentage would claim precision it doesn't have.
 * - Facts (the user's numbers and the server's calculations) are kept apart
 *   from the AI's assessment.
 * - Missing information is shown as unknown, never as a point against buying.
 */

export type Tone = "positive" | "caution" | "negative" | "neutral";

export interface Outcome {
  label: "Worth considering" | "Proceed with caution" | "Not recommended" | "No recommendation";
  tone: Tone;
}

const OUTCOMES: Record<string, Outcome> = {
  buy: { label: "Worth considering", tone: "positive" },
  wait: { label: "Proceed with caution", tone: "caution" },
  skip: { label: "Not recommended", tone: "negative" },
};
const UNAVAILABLE: Outcome = { label: "No recommendation", tone: "neutral" };

const CONFIDENCE_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

export interface Point {
  text: string;
  basis: Basis;
}

export interface Fact {
  label: string;
  value: string;
  /** Where the value comes from, in plain words. Never "AI". */
  source: string;
}

export interface CardSummary {
  outcome: Outcome;
  /** "Low" | "Medium" | "High", or null when the evaluation has no usable rating. */
  confidence: string | null;
  why: string | null;
  facts: Fact[];
  positives: Point[];
  warnings: Point[];
  /** Arguments not shown in the card; they stay in the full trial below it. */
  hiddenCount: number;
  /** Shown in neutral grey: what the trial could not check or wasn't told. */
  unknowns: string[];
  /** Why this result is less certain than it may look. Empty when nothing stands out. */
  uncertainty: string[];
  nextSteps: string[];
  isDemo: boolean;
}

export const POINTS_PER_SIDE = 2;
const MAX_STEPS = 5;
const BASES: readonly string[] = ["your_input", "general_knowledge", "assumption"];

const money = (m: Money | null | undefined, locale?: string): string | null => {
  if (!m || typeof m.value !== "string" || !m.currency) return null;
  const n = Number(m.value);
  if (!Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(n);
  } catch {
    return `${m.value} ${m.currency}`;
  }
};

/** Arguments from one side, dropping any that are malformed rather than guessing their basis. */
function pointsOf(side: unknown): Point[] {
  const args = (side as { arguments?: unknown } | undefined)?.arguments;
  if (!Array.isArray(args)) return [];
  return args.flatMap((a) => {
    const text = typeof a?.point === "string" ? a.point.trim() : "";
    return text && BASES.includes(a?.basis) ? [{ text, basis: a.basis as Basis }] : [];
  });
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : []);

/**
 * Builds the card from an evaluation. Tolerates missing or malformed parts
 * (older stored evaluations, a partial response) by showing less, not by
 * filling gaps.
 */
export function summarize(evaluation: Evaluation, locale?: string): CardSummary {
  const trial = (evaluation.trial ?? {}) as Partial<Evaluation["trial"]>;
  const outcome = OUTCOMES[trial.verdict as string] ?? UNAVAILABLE;
  const confidence = CONFIDENCE_LABEL[trial.confidence as string] ?? null;
  const why = typeof trial.verdictRationale === "string" && trial.verdictRationale.trim() ? trial.verdictRationale.trim() : null;

  const allFor = pointsOf(trial.buyCase);
  const allAgainst = pointsOf(trial.skipCase);
  const positives = allFor.slice(0, POINTS_PER_SIDE);
  const warnings = allAgainst.slice(0, POINTS_PER_SIDE);
  const hiddenCount = allFor.length + allAgainst.length - positives.length - warnings.length;

  // Facts: the user's own numbers and CartGuardian's arithmetic, never the model's.
  const facts: Fact[] = [];
  const price = money(evaluation.amount, locale);
  if (price) facts.push({ label: "Price on trial", value: price, source: "As you confirmed it" });
  const perUse = money(evaluation.metrics?.costPerUse, locale);
  if (perUse) facts.push({ label: "Cost per use", value: perUse, source: "Worked out from your usage" });
  const perMonth = money(evaluation.metrics?.costPerMonth, locale);
  if (perMonth) facts.push({ label: "Cost per month", value: perMonth, source: "Worked out from how long you'd keep it" });
  const store = evaluation.product?.retailer;
  if (store) facts.push({ label: "Store", value: store, source: evaluation.product?.sourceUrl ? "From the link you imported" : "As you entered it" });

  // Unknowns: what the trial wasn't told, then what it couldn't check. Neutral, not negative.
  const unknowns: string[] = [];
  if (!perUse) unknowns.push("How often you'd use it, so cost per use couldn't be worked out.");
  if (!perMonth) unknowns.push("How long you'd keep it, so cost per month couldn't be worked out.");
  unknowns.push(...strings(trial.unverifiedAssumptions));

  // Uncertainty: only what the evaluation itself shows.
  const uncertainty: string[] = [];
  const all = [...allFor, ...allAgainst];
  const assumed = all.filter((p) => p.basis === "assumption").length;
  if (all.length > 0 && assumed * 2 >= all.length) {
    uncertainty.push(`${assumed} of ${all.length} points are assumptions, not things you told CartGuardian.`);
  }
  if (confidence === "Low") uncertainty.push("The AI rated its own confidence as low. Treat this as a first opinion.");
  if (!confidence) uncertainty.push("The AI didn't give a confidence rating for this trial.");
  if (outcome === UNAVAILABLE) uncertainty.push("The trial didn't return a clear recommendation.");

  const nextSteps = [...strings(trial.questionsBeforeBuying)];
  if (!perUse || !perMonth) nextSteps.push("Add how often you'd use it and how long you'd keep it, then run the trial again.");
  nextSteps.push(
    {
      positive: "If those check out, you can pay below at the price on trial.",
      caution: "Hold off paying until the points above are answered.",
      negative: "Don't pay yet. If you still want it, check the warnings against the seller's listing first.",
      neutral: "Read the full trial below and decide for yourself.",
    }[outcome.tone],
  );

  return {
    outcome,
    confidence,
    why,
    facts,
    positives,
    warnings,
    hiddenCount,
    unknowns,
    uncertainty,
    // Keep the closing step: cut AI questions first when there are too many.
    nextSteps: nextSteps.length > MAX_STEPS ? [...nextSteps.slice(0, MAX_STEPS - 1), ...nextSteps.slice(-1)] : nextSteps,
    isDemo: evaluation.provider === "mock",
  };
}
