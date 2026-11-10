import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfidenceCard } from "./ConfidenceCard";
import { TrialView } from "./TrialView";
import { makeEvaluation } from "../testFixtures";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("ConfidenceCard rendering", () => {
  it("renders the outcome, confidence, reasons, both sides, unknowns, steps and the decision-support note", () => {
    const html = renderToStaticMarkup(<ConfidenceCard evaluation={makeEvaluation()} />);
    const t = text(html);
    expect(html).toContain('class="cc cc-positive"');
    expect(t).toContain("Worth considering");
    expect(t).toContain("AI confidence: High");
    expect(t).toContain("the AI's own rating, not a measured score");
    expect(t).toContain("Why: At your usage it costs less per cup");
    expect(t).toContain("In its favour");
    expect(t).toContain("Watch out for");
    expect(html).toContain('class="basis basis-your_input"');
    expect(t).toContain("1 more point in the full trial below.");
    expect(t).toContain("Still unknown");
    expect(t).toContain("Before you buy");
    expect(t).toContain("AI recommendations are decision support, not a guarantee.");
    expect(t).toContain("Your numbers (not AI)");
  });

  it.each([
    ["wait", "cc-caution", "Proceed with caution"],
    ["skip", "cc-negative", "Not recommended"],
  ] as const)("renders a %s verdict as %s", (verdict, cls, label) => {
    const html = renderToStaticMarkup(<ConfidenceCard evaluation={makeEvaluation({}, { verdict })} />);
    expect(html).toContain(`class="cc ${cls}"`);
    expect(text(html)).toContain(label);
  });

  it("shows no score, percentage or unsupported claim about price, store or authenticity", () => {
    for (const verdict of ["buy", "wait", "skip"] as const) {
      const t = text(renderToStaticMarkup(<ConfidenceCard evaluation={makeEvaluation({ product: { retailer: "Example Shop", sourceUrl: "https://shop.example/p/1" } }, { verdict })} />));
      expect(t).not.toMatch(/%|\/ ?10\b|score:/i);
      expect(t).not.toMatch(/cheaper|best price|trusted|legit|authentic|genuine|verified seller/i);
    }
  });

  it("renders an evaluation with missing trial fields without crashing", () => {
    const broken = { ...makeEvaluation(), trial: {} } as never;
    const t = text(renderToStaticMarkup(<ConfidenceCard evaluation={broken} />));
    expect(t).toContain("No recommendation");
    expect(t).toContain("No confidence rating");
    expect(t).toContain("None given.");
  });

  it("labels the demo adapter", () => {
    expect(text(renderToStaticMarkup(<ConfidenceCard evaluation={makeEvaluation({ provider: "mock" })} />))).toContain("Rule-based demo, not an AI evaluation.");
  });
});

describe("Trial view keeps the existing evaluation details", () => {
  it("shows the card first, then every argument of both cases, safety flags and the disclaimer", () => {
    const ev = makeEvaluation({ policyFlags: ["Removed an absolute claim (\"guaranteed\")."], product: { retailer: "Example Shop", sourceUrl: "https://shop.example/p/1" } });
    const html = renderToStaticMarkup(<TrialView evaluation={ev} />);
    const t = text(html);
    expect(html.indexOf('class="cc ')).toBeLessThan(html.indexOf("The full trial"));
    expect(t).toContain("The case for");
    expect(t).toContain("The case against");
    for (const a of [...ev.trial.buyCase.arguments, ...ev.trial.skipCase.arguments]) expect(t).toContain(a.point);
    expect(t).toContain("Safety check: Removed an absolute claim");
    expect(t).toContain(ev.disclaimer);
    expect(html).toContain('href="https://shop.example/p/1"');
    expect(html).toContain('role="img"'); // the balance beam
  });

  it("still renders when the trial is missing parts", () => {
    const broken = { ...makeEvaluation(), trial: { verdict: "wait" }, policyFlags: undefined } as never;
    expect(() => renderToStaticMarkup(<TrialView evaluation={broken} />)).not.toThrow();
  });
});

describe("Mobile layout", () => {
  // Layout itself was checked in a real browser at 375 px; this guards the rules that make it work.
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const mobile = css.slice(css.indexOf("/* Purchase Confidence Card */"));
  const block = mobile.slice(mobile.indexOf("@media (max-width: 640px)"));

  it("stacks the card into one column on narrow screens", () => {
    expect(block).toMatch(/\.cc-head \{ grid-template-columns: 1fr; \}/);
    expect(block).toMatch(/\.cc-sides \{ grid-template-columns: 1fr; \}/);
  });

  it("lets long values wrap instead of widening the page", () => {
    expect(mobile).toMatch(/\.cc-facts dd \{[^}]*overflow-wrap: anywhere/);
    expect(mobile).toMatch(/\.cc-points li \{[^}]*flex-wrap: wrap/);
  });
});
