import { useState, type FormEvent } from "react";
import { LIMITS, MAX_PRICE, PRICE_PATTERN, type Currency, type EvaluationInput } from "@cartguardian/shared";

interface Props {
  currencies: readonly Currency[];
  busy: boolean;
  onSubmit: (input: EvaluationInput) => void;
}

const EXAMPLE = {
  productName: "Espresso machine with built-in grinder",
  price: "449.00",
  currency: "USD" as Currency,
  description: "15-bar pump, steam wand, 2L water tank. Seller says it pays for itself in 3 months.",
  intendedUse: "Replace my daily café latte on workdays",
  usesPerMonth: "22",
  lifetimeMonths: "36",
};

const EMPTY = { productName: "", price: "", currency: "USD" as Currency, description: "", intendedUse: "", usesPerMonth: "", lifetimeMonths: "" };

export function ProductForm({ currencies, busy, onSubmit }: Props) {
  const [f, setF] = useState(EMPTY);
  const [touched, setTouched] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  // Client checks are for fast feedback only. The server re-validates everything.
  const priceError =
    f.price === ""
      ? "Enter the price you'd pay."
      : !PRICE_PATTERN.test(f.price.trim())
        ? "Use a number with up to 2 decimals, like 129.99."
        : Number(f.price) <= 0 || Number(f.price) > MAX_PRICE
          ? `Enter an amount between 0.01 and ${MAX_PRICE}.`
          : null;
  const nameError = f.productName.trim().length < LIMITS.productName.min ? "Name the product." : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (priceError || nameError) return;
    const int = (s: string) => (s.trim() === "" ? undefined : Math.trunc(Number(s)));
    onSubmit({
      productName: f.productName,
      price: f.price.trim(),
      currency: f.currency,
      description: f.description,
      intendedUse: f.intendedUse,
      usesPerMonth: int(f.usesPerMonth),
      lifetimeMonths: int(f.lifetimeMonths),
    });
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="form-head">
        <h2>What are you thinking of buying?</h2>
        <button type="button" className="link" onClick={() => setF(EXAMPLE)}>
          Fill with an example
        </button>
      </div>

      <label className="field">
        <span>Product</span>
        <input value={f.productName} onChange={set("productName")} maxLength={LIMITS.productName.max} placeholder="e.g. Noise-cancelling headphones" aria-invalid={touched && !!nameError} />
        {touched && nameError && <small className="err">{nameError}</small>}
      </label>

      <div className="row">
        <label className="field grow">
          <span>Price</span>
          <input value={f.price} onChange={set("price")} inputMode="decimal" placeholder="199.99" aria-invalid={touched && !!priceError} />
        </label>
        <label className="field">
          <span>Currency</span>
          <select value={f.currency} onChange={set("currency")}>
            {currencies.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      {touched && priceError && <small className="err">{priceError}</small>}

      <label className="field">
        <span>Listing or description <em>optional</em></span>
        <textarea rows={3} value={f.description} onChange={set("description")} maxLength={LIMITS.description.max} placeholder="Paste what the seller says. CartGuardian treats it as claims, not facts." />
      </label>

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
  );
}
