import { useState, type FormEvent, type ReactNode } from "react";
import { LIMITS, MAX_PRICE_BY_CURRENCY, type Currency, type EvaluationInput } from "@cartguardian/shared";
import { api, ApiError } from "../api";
import {
  applyImport,
  clearImported,
  importMessages,
  editField,
  initialState,
  toEvaluationInput,
  validate,
  type FieldKey,
  type Fields,
  type FormState,
} from "../productForm";

interface Props {
  currencies: readonly Currency[];
  maxPriceByCurrency?: Record<Currency, number>;
  busy: boolean;
  onSubmit: (input: EvaluationInput) => void;
}

type Mode = "link" | "manual";
type ImportStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; retailer: string; missing: string[]; warnings: string[] }
  | { kind: "error"; message: string };

const EXAMPLE: Partial<Fields> = {
  productName: "Espresso machine with built-in grinder",
  price: "449.00",
  currency: "USD",
  description: "15-bar pump, steam wand, 2L water tank. Seller says it pays for itself in 3 months.",
  intendedUse: "Replace my daily café latte on workdays",
  usesPerMonth: "22",
  lifetimeMonths: "36",
};

export function ProductForm({ currencies, maxPriceByCurrency = MAX_PRICE_BY_CURRENCY, busy, onSubmit }: Props) {
  const [mode, setMode] = useState<Mode>("link");
  const [state, setState] = useState<FormState>(initialState);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<ImportStatus>({ kind: "idle" });
  const [touched, setTouched] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);

  const f = state.fields;
  const errors = validate(f, maxPriceByCurrency);
  const set =
    <K extends FieldKey>(k: K) =>
    (e: { target: { value: string } }) => {
      if (k === "imageUrl") setImageBroken(false);
      setState((s) => editField(s, k, e.target.value as Fields[K]));
    };

  async function runImport(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) {
      setStatus({ kind: "error", message: "Paste a product link first." });
      return;
    }
    setStatus({ kind: "loading" });
    try {
      const res = await api.importProduct(url.trim());
      // Functional update: anything typed while the import ran is kept.
      setState((s) => applyImport(s, res, currencies).state);
      setImageBroken(false);
      const { missing, warnings } = importMessages(res, currencies);
      setStatus({ kind: "done", retailer: res.product.retailer ?? res.retailer.name, missing, warnings });
    } catch (err) {
      // The form is untouched on failure, so the user can carry on manually.
      setStatus({ kind: "error", message: err instanceof ApiError ? err.message : "The import didn't work. You can enter the details yourself below." });
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (errors.name || errors.price || errors.imageUrl) return;
    onSubmit(toEvaluationInput(state));
  }

  function discardImport() {
    setState(clearImported);
    setStatus({ kind: "idle" });
    setImageBroken(false);
  }

  const tag = (k: FieldKey): ReactNode => {
    const o = state.origin[k];
    return o ? <span className={`origin origin-${o}`}>{o === "imported" ? "Imported" : "Edited"}</span> : null;
  };
  const hasImport = Object.keys(state.origin).length > 0 || state.source;

  return (
    <section className="form" aria-label="Product details">
      <div className="form-head">
        <h2>What are you thinking of buying?</h2>
        <div className="modes" role="group" aria-label="How to add the product">
          <button type="button" className="mode" aria-pressed={mode === "link"} onClick={() => setMode("link")}>
            Import from a link
          </button>
          <button type="button" className="mode" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>
            Enter product manually
          </button>
        </div>
      </div>

      {mode === "link" && (
        <form className="import" onSubmit={runImport} noValidate>
          <label className="field">
            <span>Product link</span>
            <div className="import-row">
              <input
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste a product link (e.g. Takealot)"
                maxLength={LIMITS.url.max}
                aria-describedby="import-status"
              />
              <button className="secondary" type="submit" disabled={status.kind === "loading"}>
                {status.kind === "loading" ? "Importing…" : "Import product"}
              </button>
            </div>
          </label>
          <div id="import-status" aria-live="polite">
            {status.kind === "loading" && <p className="muted import-msg">Reading the product page…</p>}
            {status.kind === "done" && (
              <div className={`import-msg ${status.missing.length ? "partial" : "ok"}`}>
                <p>
                  {status.missing.length
                    ? `Imported from ${status.retailer}, but the page didn't include: ${status.missing.join(", ")}. Fill those in below.`
                    : `Imported from ${status.retailer}. Check each field before running the trial.`}
                </p>
                {status.warnings.length > 0 && (
                  <ul>
                    {status.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {status.kind === "error" && (
              <div className="import-msg failed" role="alert">
                <p>{status.message}</p>
                <button type="button" className="link" onClick={() => setMode("manual")}>
                  Enter product manually
                </button>
              </div>
            )}
          </div>
        </form>
      )}

      <form className="details" onSubmit={submit} noValidate>
        {mode === "manual" && !hasImport && (
          <button type="button" className="link" onClick={() => setState((s) => ({ ...s, fields: { ...s.fields, ...EXAMPLE } }))}>
            Fill with an example
          </button>
        )}

        {state.source && (
          <div className="source">
            {f.imageUrl && !imageBroken && (
              <img src={f.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setImageBroken(true)} />
            )}
            <p>
              From{" "}
              <a href={state.source.sourceUrl} target="_blank" rel="noopener noreferrer">
                {state.source.retailer}
              </a>
              {!state.source.supported && <span className="muted"> (not a store CartGuardian knows well)</span>}
            </p>
            <button type="button" className="link" onClick={discardImport}>
              Clear imported details
            </button>
          </div>
        )}

        <label className="field">
          <span>
            Product {tag("productName")}
          </span>
          <input value={f.productName} onChange={set("productName")} maxLength={LIMITS.productName.max} placeholder="e.g. Noise-cancelling headphones" aria-invalid={touched && !!errors.name} />
          {touched && errors.name && <small className="err">{errors.name}</small>}
        </label>

        <div className="row">
          <label className="field grow">
            <span>
              Price {tag("price")}
            </span>
            <input value={f.price} onChange={set("price")} inputMode="decimal" placeholder="199.99" aria-invalid={touched && !!errors.price} />
          </label>
          <label className="field">
            <span>
              Currency {tag("currency")}
            </span>
            <select value={f.currency} onChange={set("currency")}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        {touched && errors.price && <small className="err">{errors.price}</small>}

        <label className="field">
          <span>
            Listing or description <em>optional</em> {tag("description")}
          </span>
          <textarea rows={3} value={f.description} onChange={set("description")} maxLength={LIMITS.description.max} placeholder="Paste what the seller says. CartGuardian treats it as claims, not facts." />
        </label>

        <div className="row">
          <label className="field grow">
            <span>
              Brand <em>optional</em> {tag("brand")}
            </span>
            <input value={f.brand} onChange={set("brand")} maxLength={LIMITS.brand.max} />
          </label>
          <label className="field grow">
            <span>
              Category <em>optional</em> {tag("category")}
            </span>
            <input value={f.category} onChange={set("category")} maxLength={LIMITS.category.max} />
          </label>
        </div>

        {(mode === "link" || f.imageUrl) && (
          <label className="field">
            <span>
              Image link <em>optional</em> {tag("imageUrl")}
            </span>
            <input type="url" value={f.imageUrl} onChange={set("imageUrl")} maxLength={LIMITS.url.max} placeholder="https://…" aria-invalid={touched && !!errors.imageUrl} />
            {touched && errors.imageUrl && <small className="err">{errors.imageUrl}</small>}
          </label>
        )}

        <label className="field">
          <span>What you'd use it for <em>optional</em></span>
          <input value={f.intendedUse} onChange={set("intendedUse")} maxLength={LIMITS.intendedUse.max} placeholder="e.g. Commute and focus work" />
        </label>

        <div className="row">
          <label className="field grow">
            <span>Uses per month</span>
            <input type="number" min={0} max={LIMITS.usesPerMonth.max} value={f.usesPerMonth} onChange={set("usesPerMonth")} placeholder="20" />
          </label>
          <label className="field grow">
            <span>Months you'd keep it</span>
            <input type="number" min={1} max={LIMITS.lifetimeMonths.max} value={f.lifetimeMonths} onChange={set("lifetimeMonths")} placeholder="24" />
          </label>
        </div>
        <p className="hint">Usage lets CartGuardian work out cost per use.</p>
        <p className="hint">What you enter is sent to an AI provider to run the trial. Leave out personal details.</p>

        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Running the trial…" : "Put it on trial"}
        </button>
      </form>
    </section>
  );
}
