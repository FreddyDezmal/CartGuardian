import { useEffect, useState } from "react";
import type { Evaluation } from "@cartguardian/shared";
import { BASIS_LABEL, ConfidenceCard } from "./ConfidenceCard";

/** Beam tilt per verdict: toward the stronger case. Unknown verdicts stay level. */
const TILT: Record<string, number> = { buy: -9, wait: 0, skip: 9 };

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
  const { trial } = evaluation;

  return (
    <section className="trial" aria-live="polite">
      {evaluation.provider === "mock" && (
        <p className="mock-banner">
          Demo evaluation from the rule-based mock adapter. Connect an AI provider for a reasoned trial.
        </p>
      )}

      <ProductLine evaluation={evaluation} />

      <ConfidenceCard evaluation={evaluation} beam={<Beam tilt={TILT[trial?.verdict] ?? 0} />} />

      <h3 className="full-trial">The full trial</h3>
      <div className="cases">
        {([["for", trial?.buyCase, "The case for"], ["against", trial?.skipCase, "The case against"]] as const).map(([side, c, label]) => c && (
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
        ))}
      </div>

      {(evaluation.policyFlags ?? []).length > 0 && (
        <p className="flags">Safety check: {evaluation.policyFlags.join(" ")}</p>
      )}
      <p className="disclaimer">{evaluation.disclaimer}</p>
    </section>
  );
}
