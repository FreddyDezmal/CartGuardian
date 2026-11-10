import { useEffect, useState } from "react";
import type { Evaluation } from "@cartguardian/shared";
import { summarize } from "../confidenceCard";
import { BASIS_LABEL } from "./ConfidenceCard";
import { Logo, LogoMark } from "./Logo";

const REPO_URL = "https://github.com/FreddyDezmal/CartGuardian";

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#about", label: "About" },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  return (
    <header className="nav">
      <div className="nav-inner">
        <a href="#top" className="nav-logo" aria-label="CartGuardian, back to top">
          <Logo />
        </a>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="nav-links"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="nav-toggle-bars" aria-hidden="true" />
          <span className="sr-only">Menu</span>
        </button>
        <nav id="nav-links" className={`nav-links${open ? " is-open" : ""}`} aria-label="Main">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} onClick={() => setOpen(false)}>
              {n.label}
            </a>
          ))}
          <a href="#evaluate" className="btn btn-primary nav-cta" onClick={() => setOpen(false)}>
            Evaluate a purchase
          </a>
        </nav>
      </div>
    </header>
  );
}

/**
 * The hero's example. An illustrative product, not a real listing: the card
 * below it is built by the same rules as a real trial (confidenceCard.ts).
 * 129.00 / (30 uses × 36 months) = 0.12 per use; 129.00 / 36 = 3.58 per month.
 */
export const EXAMPLE: Evaluation = {
  id: "00000000-0000-4000-8000-000000000000",
  createdAt: "2026-11-10T00:00:00.000Z",
  productName: "Gooseneck electric kettle",
  amount: { currency: "USD", value: "129.00" },
  metrics: { costPerUse: { currency: "USD", value: "0.12" }, costPerMonth: { currency: "USD", value: "3.58" }, totalExpectedUses: 1080 },
  provider: "gemini",
  model: "example",
  policyFlags: [],
  disclaimer: "",
  trial: {
    buyCase: { headline: "Daily use", arguments: [{ point: "You brew pour-over every morning, so precise temperature gets used daily.", basis: "your_input" }] },
    skipCase: { headline: "Unproven claim", arguments: [{ point: "“Boils in 3 minutes” is the seller's claim, with no test shown.", basis: "your_input" }] },
    verdict: "wait",
    confidence: "medium",
    verdictRationale: "Good value at your usage, but the main selling point is unverified.",
    questionsBeforeBuying: ["How long is the warranty?"],
    unverifiedAssumptions: ["Boil time"],
  },
};

function KettleArt() {
  return (
    <svg className="kettle" viewBox="0 0 160 120" aria-hidden="true">
      <path d="M44 104h76" className="k-base" />
      <path d="M58 98h48l6-52H52z" className="k-body" />
      <path d="M52 46h60" className="k-lid" />
      <path d="M74 46v-8h16v8" className="k-knob" />
      <path d="M112 56c14 0 18 10 18 22s-6 18-18 18" className="k-handle" />
      <path d="M54 62C38 62 30 50 22 34l-6-4" className="k-spout" />
    </svg>
  );
}

/** Example card in the hero: the real summary rules, applied to EXAMPLE. */
function HeroPreview() {
  const s = summarize(EXAMPLE, "en-US");
  const [perUse, perMonth] = [s.facts[1], s.facts[2]];
  return (
    <figure className="preview" aria-label="Example evaluation of an illustrative product">
      <div className={`tag tag-${s.outcome.tone}`}>
        <span className="tag-hole" aria-hidden="true" />
        <div className="preview-product">
          <KettleArt />
          <div>
            <p className="preview-name">{EXAMPLE.productName}</p>
            <p className="preview-price num">{s.facts[0]?.value}</p>
          </div>
        </div>
        <p className="preview-verdict">
          <span className="dot" aria-hidden="true" />
          {s.outcome.label}
        </p>
        <p className="preview-conf">{s.confidence} confidence</p>
        <dl className="preview-figures">
          <div>
            <dt>Per use</dt>
            <dd className="num">{perUse?.value}</dd>
          </div>
          <div>
            <dt>Per month</dt>
            <dd className="num">{perMonth?.value}</dd>
          </div>
        </dl>
        <ul className="preview-points">
          <li className="pp-for">
            {s.positives[0]?.text} <span className={`basis basis-${s.positives[0]?.basis}`}>{BASIS_LABEL[s.positives[0]!.basis]}</span>
          </li>
          <li className="pp-against">
            {s.warnings[0]?.text} <span className={`basis basis-${s.warnings[0]?.basis}`}>{BASIS_LABEL[s.warnings[0]!.basis]}</span>
          </li>
        </ul>
      </div>
      <figcaption>Example evaluation of an illustrative product.</figcaption>
    </figure>
  );
}

export function Hero() {
  return (
    <section className="hero" id="top">
      <div className="hero-copy">
        <h1>Before you buy, know what you're getting into.</h1>
        <p className="lede">
          Make smarter purchasing decisions with AI-powered product evaluations, transparent reasoning and real cost insights.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href="#evaluate">
            Evaluate a product
          </a>
          <a className="btn btn-quiet btn-lg" href="#how">
            See how it works
          </a>
        </div>
        <p className="hero-note">Free to try. Payments run in PayPal Sandbox, so no real money moves.</p>
      </div>
      <HeroPreview />
    </section>
  );
}

export function HowItWorks() {
  return (
    <section className="section how" id="how" aria-labelledby="how-title">
      <h2 id="how-title" className="section-title">How it works</h2>
      <ol className="rail">
        <li>
          <span className="rail-n num">01</span>
          <h3>Find your product</h3>
          <p>Paste a product URL or enter details manually.</p>
          <div className="frag frag-import" aria-hidden="true">
            <span className="frag-url">shop.example/kettle</span>
            <span className="frag-btn">Import</span>
            <span className="frag-chip">Imported</span>
          </div>
        </li>
        <li>
          <span className="rail-n num">02</span>
          <h3>Understand the decision</h3>
          <p>Get an AI-powered evaluation with supporting evidence, risks and uncertainty.</p>
          <div className="frag frag-verdict" aria-hidden="true">
            <span className="frag-dot" />
            <span>Proceed with caution</span>
            <span className="frag-soft">Medium confidence</span>
          </div>
        </li>
        <li>
          <span className="rail-n num">03</span>
          <h3>Buy with clarity</h3>
          <p>Review the recommendation, understand the costs and proceed to checkout if supported.</p>
          <div className="frag frag-pay" aria-hidden="true">
            <span className="num">$129.00</span>
            <span className="frag-soft">Price locked to the evaluation</span>
          </div>
        </li>
      </ol>
    </section>
  );
}

export function Transparency() {
  return (
    <section className="section split" id="features" aria-labelledby="features-title">
      <div className="split-intro">
        <h2 id="features-title" className="section-title">What's AI, and what isn't</h2>
        <p>
          Every evaluation keeps two kinds of information apart, so an opinion never passes for a fact. Recommendations are decision
          support, not guarantees.
        </p>
      </div>
      <div className="split-cols">
        <div className="split-col split-calc">
          <h3>Calculated, not guessed</h3>
          <ul>
            <li>The price, exactly as you confirm it</li>
            <li>Cost per use, from how often you'd use it</li>
            <li>Cost per month, from how long you'd keep it</li>
            <li>The checkout amount, set by our server from the evaluation</li>
          </ul>
        </div>
        <div className="split-col split-ai">
          <h3>AI opinion, clearly labelled</h3>
          <ul>
            <li>A recommendation with low, medium or high confidence</li>
            <li>
              Points for and against, each tagged <span className="basis basis-your_input">From you</span>{" "}
              <span className="basis basis-general_knowledge">General knowledge</span> or <span className="basis basis-assumption">Assumption</span>
            </li>
            <li>What's still unknown, and what to ask before buying</li>
          </ul>
        </div>
      </div>
      <ul className="promises">
        <li>
          <strong>Imported details stay editable.</strong> Every field shows whether it came from the page or from you.
        </li>
        <li>
          <strong>Manual entry is always there.</strong> Buying at a market or a shop with no website works the same way.
        </li>
        <li>
          <strong>Pages that block automated reading are left alone.</strong> You'll see why, and can type the details instead.
        </li>
      </ul>
    </section>
  );
}

export function About() {
  return (
    <section className="section about" id="about" aria-labelledby="about-title">
      <h2 id="about-title" className="section-title">About</h2>
      <div className="about-body">
        <p>
          CartGuardian was built for the PayPal AI Hackathon 2026. Most purchase regret starts with one-sided information: the
          seller's. CartGuardian argues the other side at the moment you decide, then makes buying easy when the answer is yes.
        </p>
        <p className="muted">
          Built with React, Express, Google Gemini, PayPal Orders v2 and the v6 Web SDK, Supabase and Vercel. Open source under the
          MIT licence.{" "}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Read the code on GitHub
          </a>
          .
        </p>
      </div>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <span className="footer-brand">
        <LogoMark size={20} /> CartGuardian
      </span>
      <span>Buy with clarity. Sandbox demo: no real money moves.</span>
    </footer>
  );
}
