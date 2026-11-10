import { useEffect, useState } from "react";
import { PAYPAL_CURRENCIES, SUPPORTED_CURRENCIES, type Evaluation, type EvaluationInput, type HealthResponse, type PublicConfig } from "@cartguardian/shared";
import { api, ApiError } from "./api";
import { ProductForm } from "./components/ProductForm";
import { TrialView } from "./components/TrialView";
import { Checkout } from "./components/Checkout";
import { About, Hero, HowItWorks, SiteFooter, SiteNav, Transparency } from "./components/Landing";

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.health(), api.config()])
      .then(([h, c]) => {
        setHealth(h);
        setConfig(c);
      })
      .catch((e: Error) => setBootError(e.message));
  }, []);

  async function run(input: EvaluationInput) {
    setBusy(true);
    setError(null);
    try {
      const { evaluation } = await api.evaluate(input);
      setEvaluation(evaluation);
    } catch (e) {
      if (e instanceof ApiError && e.code === "VALIDATION_FAILED" && Array.isArray(e.details)) {
        setError((e.details as Array<{ field: string; message: string }>).map((d) => `${d.field}: ${d.message}`).join(". "));
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <a className="skip" href="#evaluate">
        Skip to the evaluator
      </a>
      <SiteNav />
      <div className="page">
        <Hero />
        <HowItWorks />
        <Transparency />

        <section className="section app" id="evaluate" aria-labelledby="evaluate-title">
          <div className="app-head">
            <div>
              <h2 id="evaluate-title" className="section-title">Evaluate a purchase</h2>
              <p className="muted">Import a product or describe it, then put it on trial.</p>
            </div>
            {health && (
              <ul className="status" aria-label="Service status">
                <li className={health.ai.provider === "mock" ? "warn" : "ok"}>AI: {health.ai.provider === "mock" ? "demo rules" : health.ai.model}</li>
                <li className={health.paypal.configured ? "ok" : "warn"}>PayPal Sandbox: {health.paypal.configured ? "ready" : "off"}</li>
              </ul>
            )}
          </div>

          {bootError && <p className="err boot" role="alert">{bootError}</p>}

          <div className="layout">
            <ProductForm
              currencies={config?.currencies ?? SUPPORTED_CURRENCIES}
              maxPriceByCurrency={config?.maxPriceByCurrency}
              busy={busy}
              onSubmit={run}
            />
            <div className="results">
              {error && <p className="err" role="alert">{error}</p>}
              {busy && !evaluation && <div className="thinking" role="status">Putting it on trial: weighing both sides…</div>}
              {evaluation ? (
                <>
                  <TrialView key={evaluation.id} evaluation={evaluation} />
                  <Checkout
                    key={`co-${evaluation.id}`}
                    evaluation={evaluation}
                    clientId={config?.paypalClientId ?? null}
                    paypalCurrencies={config?.paypalCurrencies ?? PAYPAL_CURRENCIES}
                  />
                </>
              ) : (
                !busy && (
                  <div className="empty">
                    <p className="empty-title">Your evaluation appears here.</p>
                    <p>
                      CartGuardian argues both sides, works out the real cost, and lists what to check before you pay. If you decide
                      to buy, you can pay with PayPal Sandbox at the price you evaluated.
                    </p>
                  </div>
                )
              )}
            </div>
          </div>
        </section>

        <About />
      </div>
      <SiteFooter />
    </>
  );
}
