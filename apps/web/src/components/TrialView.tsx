import { useEffect, useState } from "react";
import type { Basis, Evaluation, Money } from "@cartguardian/shared";

const BASIS_LABEL: Record<Basis, string> = {
  your_input: "From you",
  general_knowledge: "General knowledge",
  assumption: "Assumption",
};

const VERDICT: Record<Evaluation["trial"]["verdict"], { title: string; tilt: number }> = {
  buy: { title: "Leans buy", tilt: -9 },
  wait: { title: "Wait and check", tilt: 0 },
  skip: { title: "Leans skip", tilt: 9 },
};

const fmt = (m: Money | null) =>
  m ? new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency }).format(Number(m.value)) : "—";

/** The balance beam. Tilts once, toward the stronger case, after the trial lands. */
function Beam({ tilt }: { tilt: number }) {
  const [angle, setAngle] = useState(0);
  useEffect(() => {
    const t = requestAnimationFrame(() => setAngle(tilt));
    return () => cancelAnimationFrame(t);
  }, [tilt]);
  return (
    <svg className="beam" viewBox="0 0 400 120" role="img" aria-label={`Balance tilted ${tilt < 0 ? "toward buying" : tilt > 0 ? "toward skipping" : "level"}`}>
      <path d="M200 50 L186 112 H214 Z" className="beam-post" />
      <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: "200px 44px" }} className="beam-arm">
        <rect x="40" y="40" width="320" height="8" rx="4" className="beam-bar" />
        <line x1="60" y1="48" x2="60" y2="70" className="beam-string" />
        <line x1="340" y1="48" x2="340" y2="70" className="beam-string" />
        <path d="M28 70 H92 Q60 92 28 70 Z" className="pan pan-for" />
        <path d="M308 70 H372 Q340 92 308 70 Z" className="pan pan-against" />
      </g>
      <circle cx="200" cy="44" r="7" className="beam-pivot" />
    </svg>
  );
}

/** What is on trial, with where it came from when the user imported it. */
function ProductLine({ evaluation }: { evaluation: Evaluation }) {
  const p = evaluation.product;
  const [imageOk, setImageOk] = useState(true);
  return (
    <div className="on-trial">
      {p?.imageUrl && imageOk && <img src={p.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setImageOk(false)} />}
      <div>
        <p className="on-trial-name">{evaluation.productName}</p>
        {(p?.brand || p?.retailer) && (
          <p className="muted">
            {p.brand}
            {p.brand && p.retailer && " · "}
            {p.retailer &&
              (p.sourceUrl ? (
                <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {p.retailer}
                </a>
              ) : (
                p.retailer
              ))}
          </p>
        )}
      </div>
    </div>
  );
}

export function TrialView({ evaluation }: { evaluation: Evaluation }) {
  const { trial, metrics, amount } = evaluation;
  const v = VERDICT[trial.verdict];

  return (
    <section className="trial" aria-live="polite">
      {evaluation.provider === "mock" && (
        <p className="mock-banner">
          Demo evaluation from the rule-based mock adapter. Connect an AI provider for a reasoned trial.
        </p>
      )}

      <ProductLine evaluation={evaluation} />

      <div className="verdict">
        <Beam tilt={v.tilt} />
        <div className="verdict-text">
          <h2>{v.title}</h2>
          <p className="confidence">{trial.confidence} confidence</p>
          <p>{trial.verdictRationale}</p>
        </div>
      </div>

      <dl className="metrics">
        <div><dt>Price</dt><dd>{fmt(amount)}</dd></div>
        <div><dt>Cost per use</dt><dd>{fmt(metrics.costPerUse)}</dd></div>
        <div><dt>Cost per month</dt><dd>{fmt(metrics.costPerMonth)}</dd></div>
      </dl>

      <div className="cases">
        {([["for", trial.buyCase, "The case for"], ["against", trial.skipCase, "The case against"]] as const).map(([side, c, label]) => (
          <article key={side} className={`case case-${side}`}>
            <h3>{label}</h3>
            <p className="case-headline">{c.headline}</p>
            <ul>
              {c.arguments.map((a, i) => (
                <li key={i}>
                  <span>{a.point}</span>
                  <span className={`basis basis-${a.basis}`}>{BASIS_LABEL[a.basis]}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      {(trial.questionsBeforeBuying.length > 0 || trial.unverifiedAssumptions.length > 0) && (
        <div className="followups">
          {trial.questionsBeforeBuying.length > 0 && (
            <div>
              <h3>Ask before you buy</h3>
              <ul>{trial.questionsBeforeBuying.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          )}
          {trial.unverifiedAssumptions.length > 0 && (
            <div>
              <h3>Not verified</h3>
              <ul>{trial.unverifiedAssumptions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {evaluation.policyFlags.length > 0 && (
        <p className="flags">Safety check: {evaluation.policyFlags.join(" ")}</p>
      )}
      <p className="disclaimer">{evaluation.disclaimer}</p>
    </section>
  );
}
