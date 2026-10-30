import { useEffect, useState } from "react";
import { SUPPORTED_CURRENCIES, type Evaluation, type EvaluationInput, type HealthResponse, type PublicConfig } from "@cartguardian/shared";
import { api, ApiError } from "./api";
import { ProductForm } from "./components/ProductForm";
import { TrialView } from "./components/TrialView";
import { Checkout } from "./components/Checkout";

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
    <div className="shell">
      <header className="top">
        <h1 className="wordmark">CartGuardian</h1>
        <p className="tagline">Put a purchase on trial before you pay.</p>
        {health && (
          <ul className="status" aria-label="Service status">
            <li className={health.ai.provider === "mock" ? "warn" : "ok"}>AI: {health.ai.provider === "mock" ? "mock adapter" : health.ai.model}</li>
            <li className={health.paypal.configured ? "ok" : "warn"}>PayPal Sandbox: {health.paypal.configured ? "ready" : "not configured"}</li>
          </ul>
        )}
      </header>

      {bootError && <p className="err boot" role="alert">{bootError}</p>}

      <main className="layout">
        <ProductForm currencies={config?.currencies ?? SUPPORTED_CURRENCIES} busy={busy} onSubmit={run} />
        <div className="results">
          {error && <p className="err" role="alert">{error}</p>}
          {evaluation ? (
            <>
              <TrialView key={evaluation.id} evaluation={evaluation} />
              <Checkout key={`co-${evaluation.id}`} evaluation={evaluation} clientId={config?.paypalClientId ?? null} />
            </>
          ) : (
            <div className="empty">
              <p>Describe a purchase and CartGuardian argues both sides: why it could be worth it, and why you might hold off. Then you decide, and can pay with PayPal Sandbox.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
