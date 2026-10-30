import type { TrialResult } from "@cartguardian/shared";

/**
 * Post-generation checks. The prompt asks the model to avoid these, but we
 * never rely on the prompt alone: anything that slips through is rewritten
 * and flagged so the UI can show it.
 */
const ABSOLUTE_CLAIMS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
  { pattern: /\bguarantee(?:d|s)?\b/gi, replacement: "likely", label: "guarantee" },
  { pattern: /\brisk[- ]free\b/gi, replacement: "lower-risk", label: "risk-free" },
  { pattern: /\b100\s?% (?:safe|secure|certain)\b/gi, replacement: "generally considered safe", label: "100% safe" },
  { pattern: /\bcan(?:not|'t|’t) go wrong\b/gi, replacement: "is a reasonable choice", label: "can't go wrong" },
  { pattern: /\bno[- ]brainer\b/gi, replacement: "strong option", label: "no-brainer" },
];

export interface GuardrailResult {
  trial: TrialResult;
  flags: string[];
}

export function applyGuardrails(trial: TrialResult): GuardrailResult {
  const flags = new Set<string>();

  const clean = (text: string): string => {
    let out = text;
    for (const { pattern, replacement, label } of ABSOLUTE_CLAIMS) {
      const next = out.replace(pattern, replacement);
      if (next !== out) flags.add(`Softened an absolute claim ("${label}").`);
      out = next;
    }
    return out;
  };

  const cleanCase = (c: TrialResult["buyCase"]) => ({
    headline: clean(c.headline),
    arguments: c.arguments.map((a) => ({ ...a, point: clean(a.point) })),
  });

  return {
    trial: {
      ...trial,
      buyCase: cleanCase(trial.buyCase),
      skipCase: cleanCase(trial.skipCase),
      verdictRationale: clean(trial.verdictRationale),
      questionsBeforeBuying: trial.questionsBeforeBuying.map(clean),
      unverifiedAssumptions: trial.unverifiedAssumptions.map(clean),
    },
    flags: [...flags],
  };
}
