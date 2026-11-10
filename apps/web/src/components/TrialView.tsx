import { useState } from "react";
import type { Evaluation } from "@cartguardian/shared";
import { BASIS_LABEL, ConfidenceCard } from "./ConfidenceCard";
import { LogoMark } from "./Logo";

const money = (m: Evaluation["amount"] | undefined) => {
  if (!m) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency }).format(Number(m.value));
  } catch {
    return `${m.value} ${m.currency}`;
  }
};

/** What is on trial: image, name, brand and store, and the price the trial used. */
function ProductLine({ evaluation }: { evaluation: Evaluation }) {
  const p = evaluation.product;
  const [imageOk, setImageOk] = useState(true);
  const price = money(evaluation.amount);
  return (
    <div className="on-trial">
      {p?.imageUrl && imageOk ? (
        <img src={p.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setImageOk(false)} />
      ) : (
        <span className="on-trial-ph" aria-hidden="true">
          <LogoMark size={34} />
        </span>
      )}
      <div>
        <p className="on-trial-name">{evaluation.productName}</p>
        {(p?.brand || p?.retailer) && (
          <p className="on-trial-meta">
            {p.brand && <span>{p.brand}</span>}
            {p.retailer && (
              <span>
                {p.sourceUrl ? (
                  <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer">
                    View at {p.retailer}
                  </a>
                ) : (
                  <>From {p.retailer}</>
                )}
              </span>
            )}
          </p>
        )}
      </div>
      {price && (
        <p className="on-trial-price">
          <span className="num">{price}</span>
          <small>{evaluation.amount.currency}, as you confirmed it</small>
        </p>
      )}
    </div>
  );
}

export function TrialView({ evaluation }: { evaluation: Evaluation }) {
  const { trial } = evaluation;
  const count = (trial?.buyCase?.arguments?.length ?? 0) + (trial?.skipCase?.arguments?.length ?? 0);

  return (
    <section className="trial" aria-live="polite">
      {evaluation.provider === "mock" && (
        <p className="mock-banner">
          Demo evaluation from the rule-based mock adapter. Connect an AI provider for a reasoned trial.
        </p>
      )}

      <ProductLine evaluation={evaluation} />

      <ConfidenceCard evaluation={evaluation} />

      <details className="full">
        <summary>
          <span>
            The full trial <span className="muted">({count} {count === 1 ? "point" : "points"})</span>
          </span>
        </summary>
        <div className="full-body">
          <div className="cases">
            {([["for", trial?.buyCase, "The case for"], ["against", trial?.skipCase, "The case against"]] as const).map(
              ([side, c, label]) =>
                c && (
                  <article key={side} className={`case case-${side}`}>
                    <h3>{label}</h3>
                    <p className="case-headline">{c.headline}</p>
                    <ul>
                      {(c.arguments ?? []).map((a, i) => (
                        <li key={i}>
                          <span>{a.point}</span>
                          <span className={`basis basis-${a.basis}`}>{BASIS_LABEL[a.basis]}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ),
            )}
          </div>
          {(evaluation.policyFlags ?? []).length > 0 && <p className="flags">Safety check: {evaluation.policyFlags.join(" ")}</p>}
        </div>
      </details>

      {evaluation.disclaimer && <p className="disclaimer">{evaluation.disclaimer}</p>}
    </section>
  );
}
