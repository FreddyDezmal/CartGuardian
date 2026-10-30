import { PRICE_PATTERN, type Currency, type Money } from "@cartguardian/shared";

/**
 * Money is handled as integer minor units (cents) to avoid floating point
 * drift. All supported currencies have 2 decimal places.
 */
export function toMinorUnits(value: string): number {
  if (!PRICE_PATTERN.test(value)) throw new Error(`Invalid money value: ${value}`);
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function fromMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error(`Invalid minor units: ${minor}`);
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, "0");
  return `${whole}.${frac}`;
}

/** Normalises "129.9" -> "129.90". */
export function normalizeMoney(value: string, currency: Currency): Money {
  return { currency, value: fromMinorUnits(toMinorUnits(value)) };
}

export function moneyEquals(a: { currency: string; value: string }, b: { currency: string; value: string }): boolean {
  if (a.currency !== b.currency) return false;
  try {
    return toMinorUnits(a.value) === toMinorUnits(b.value);
  } catch {
    return false;
  }
}

/** Divides money and rounds half-up to the nearest minor unit. */
export function divideMoney(m: Money, divisor: number): Money {
  if (!(divisor > 0)) throw new Error("divisor must be > 0");
  return { currency: m.currency, value: fromMinorUnits(Math.round(toMinorUnits(m.value) / divisor)) };
}
