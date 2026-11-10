import type { ReactNode } from "react";
import type { Basis, Evaluation } from "@cartguardian/shared";
import { summarize, type Point } from "../confidenceCard";

export const BASIS_LABEL: Record<Basis, string> = {
  your_input: "From you",
  general_knowledge: "General knowledge",
  assumption: "Assumption",
};

function Points({ title, points, className }: { title: string; points: Point[]; className: string }) {
  return (
    <div className={`cc-points ${className}`}>
      <h3>{title}</h3>
      {points.length ? (
        <ul>
          {points.map((p, i) => (
            <li key={i}>
              <span>{p.text}</span>
              <span className={`basis basis-${p.basis}`}>{BASIS_LABEL[p.basis]}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None given.</p>
      )}
    </div>
  );
}

/**
 * Summary of a trial: recommendation, why, the strongest points on each side,
 * what's still unknown, and what to check before paying. Everything comes from
 * the evaluation; see confidenceCard.ts for the rules.
 */
export function ConfidenceCard({ evaluation, beam }: { evaluation: Evaluation; beam?: ReactNode }) {
  const s = summarize(evaluation);
  return (
    <section className={`cc cc-${s.outcome.tone}`} aria-labelledby="cc-title">
      <div className="cc-head">
        <div>
          <p className="cc-kicker">Purchase confidence</p>
          <h2 id="cc-title">
            <span className="cc-dot" aria-hidden="true" />
            {s.outcome.label}
          </h2>
          <p className="cc-conf">
            {s.confidence ? (
              <>
                AI confidence: <strong>{s.confidence}</strong>
                <span className="muted"> (the AI's own rating, not a measured score)</span>
              </>
            ) : (
              <span className="muted">No confidence rating</span>
            )}
          </p>
        </div>
        {beam}
      </div>

      {s.why && (
        <p className="cc-why">
          <strong>Why: </strong>
          {s.why}
        </p>
      )}

      {s.uncertainty.length > 0 && (
        <ul className="cc-uncertain" aria-label="How sure this is">
          {s.uncertainty.map((u, i) => (
            <li key={i}>{u}</li>
          ))}
        </ul>
      )}

      {s.facts.length > 0 && (
        <div className="cc-facts">
          <p className="cc-label">Your numbers (not AI)</p>
          <dl>
            {s.facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
                <dd className="cc-src">{f.source}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="cc-ai">
        <p className="cc-label">AI assessment</p>
        <div className="cc-sides">
          <Points title="In its favour" points={s.positives} className="cc-for" />
          <Points title="Watch out for" points={s.warnings} className="cc-against" />
        </div>
        {s.hiddenCount > 0 && (
          <p className="cc-more muted">
            {s.hiddenCount} more {s.hiddenCount === 1 ? "point" : "points"} in the full trial below.
          </p>
        )}
      </div>

      <div className="cc-lower">
      {s.unknowns.length > 0 && (
        <div className="cc-unknown">
          <h3>Still unknown</h3>
          <ul>
            {s.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="cc-steps">
        <h3>Before you buy</h3>
        <ol>
          {s.nextSteps.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ol>
      </div>
      </div>

      <p className="cc-note">
        {s.isDemo ? "Rule-based demo, not an AI evaluation. " : ""}AI recommendations are decision support, not a guarantee. Badges show where each point comes from.
      </p>
    </section>
  );
}
