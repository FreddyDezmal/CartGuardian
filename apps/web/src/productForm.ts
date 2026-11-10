import {
  LIMITS,
  MAX_PRICE_BY_CURRENCY,
  PRICE_PATTERN,
  SUPPORTED_CURRENCIES,
  type Currency,
  type EvaluationInput,
  type ImportField,
  type ProductImportResponse,
} from "@cartguardian/shared";

/**
 * Product form state and the rules for merging an import into it. Kept free
 * of React so the rules are unit-tested (see productForm.test.ts).
 *
 * Principles:
 * - An import only fills fields the page actually provided; everything else the
 *   user typed is left alone.
 * - Every field stays editable. Imported fields are tagged "imported" until the
 *   user changes them, then "edited".
 * - The evaluation is built from the form as it stands when submitted, never
 *   from the raw import response.
 */

export interface Fields {
  productName: string;
  price: string;
  currency: Currency;
  description: string;
  intendedUse: string;
  usesPerMonth: string;
  lifetimeMonths: string;
  brand: string;
  category: string;
  imageUrl: string;
}
export type FieldKey = keyof Fields;
export type Origin = "imported" | "edited";

export interface FormState {
  fields: Fields;
  origin: Partial<Record<FieldKey, Origin>>;
  /** Present after a successful import: where the details came from. */
  source?: { retailer: string; sourceUrl: string; supported: boolean };
}

export const EMPTY_FIELDS: Fields = {
  productName: "",
  price: "",
  currency: "USD",
  description: "",
  intendedUse: "",
  usesPerMonth: "",
  lifetimeMonths: "",
  brand: "",
  category: "",
  imageUrl: "",
};

export const initialState = (): FormState => ({ fields: { ...EMPTY_FIELDS }, origin: {} });

/** Which form field each import field fills. */
const IMPORT_TO_FIELD: Record<ImportField, FieldKey> = {
  title: "productName",
  description: "description",
  price: "price",
  currency: "currency",
  imageUrl: "imageUrl",
  brand: "brand",
  category: "category",
};

export const FIELD_LABELS: Record<ImportField, string> = {
  title: "name",
  description: "description",
  price: "price",
  currency: "currency",
  imageUrl: "image",
  brand: "brand",
  category: "category",
};

const isCurrency = (c: string, supported: readonly string[]): c is Currency => supported.includes(c);

export interface ImportOutcome {
  state: FormState;
  /** Fields the user still needs to fill or check, in plain words. */
  missing: string[];
  /** Things to tell the user, e.g. an unsupported currency. */
  warnings: string[];
}

/** What to tell the user about an import. Depends only on the response, so it can be shown immediately. */
export function importMessages(res: ProductImportResponse, supported: readonly Currency[] = SUPPORTED_CURRENCIES): { missing: string[]; warnings: string[] } {
  const missing = res.fieldsMissing.filter((f) => f !== "currency").map((f) => FIELD_LABELS[f]);
  const warnings = [...res.notes];
  const c = res.product.currency;
  if (c && !isCurrency(c, supported)) {
    warnings.push(`The page's price is in ${c}, which CartGuardian can't evaluate. Choose a currency and enter the price.`);
    if (!missing.includes(FIELD_LABELS.price)) missing.unshift(FIELD_LABELS.price);
  }
  return { missing, warnings };
}

export function applyImport(state: FormState, res: ProductImportResponse, supported: readonly Currency[] = SUPPORTED_CURRENCIES): ImportOutcome {
  const fields = { ...state.fields };
  const origin = { ...state.origin };
  const { missing, warnings } = importMessages(res, supported);

  for (const f of res.fieldsFound) {
    const key = IMPORT_TO_FIELD[f];
    const value = res.product[f];
    if (value === undefined) continue;
    if (key === "currency") {
      if (isCurrency(value, supported)) {
        fields.currency = value;
        origin.currency = "imported";
      } else {
        // A price in an unusable currency would be misleading next to another currency code.
        if (origin.price === "imported" || res.fieldsFound.includes("price")) {
          fields.price = state.fields.price;
          delete origin.price;
        }
      }
      continue;
    }
    if (key === "price" && res.product.currency && !isCurrency(res.product.currency, supported)) continue;
    fields[key] = key === "productName" ? value.slice(0, LIMITS.productName.max) : key === "description" ? value.slice(0, LIMITS.description.max) : value;
    origin[key] = "imported";
  }

  return {
    state: {
      fields,
      origin,
      source: { retailer: res.product.retailer ?? res.retailer.name, sourceUrl: res.product.sourceUrl, supported: res.retailer.supported },
    },
    missing,
    warnings,
  };
}

/** A user edit. An imported value that the user changes becomes "edited". */
export function editField<K extends FieldKey>(state: FormState, key: K, value: Fields[K]): FormState {
  const origin = { ...state.origin };
  if (origin[key] === "imported" && state.fields[key] !== value) origin[key] = "edited";
  return { ...state, fields: { ...state.fields, [key]: value }, origin };
}

/** "Clear imported details": empties every field an import filled (edited or not) and forgets the source. */
export function clearImported(state: FormState): FormState {
  const fields = { ...state.fields };
  for (const key of Object.keys(state.origin) as FieldKey[]) {
    (fields[key] as string) = EMPTY_FIELDS[key];
  }
  return { fields, origin: {} };
}

export interface Validation {
  name?: string;
  price?: string;
  imageUrl?: string;
}

export function validate(fields: Fields, maxByCurrency: Record<Currency, number> = MAX_PRICE_BY_CURRENCY): Validation {
  const v: Validation = {};
  if (fields.productName.trim().length < LIMITS.productName.min) v.name = "Name the product.";
  const max = maxByCurrency[fields.currency];
  const p = fields.price.trim();
  if (p === "") v.price = "Enter the price you'd pay.";
  else if (!PRICE_PATTERN.test(p)) v.price = "Use a number with up to 2 decimals, like 129.99.";
  else if (Number(p) <= 0 || Number(p) > max) v.price = `Enter an amount between 0.01 and ${max.toLocaleString()} ${fields.currency}.`;
  const img = fields.imageUrl.trim();
  if (img && !/^https?:\/\/\S+$/i.test(img)) v.imageUrl = "Use an http or https image link, or leave it empty.";
  return v;
}

/** The request sent for evaluation: built only from what the form shows now. */
export function toEvaluationInput(state: FormState): EvaluationInput {
  const f = state.fields;
  const int = (s: string) => (s.trim() === "" ? undefined : Math.trunc(Number(s)));
  const opt = (s: string) => (s.trim() === "" ? undefined : s.trim());
  return {
    productName: f.productName,
    price: f.price.trim(),
    currency: f.currency,
    description: f.description,
    intendedUse: f.intendedUse,
    usesPerMonth: int(f.usesPerMonth),
    lifetimeMonths: int(f.lifetimeMonths),
    brand: opt(f.brand),
    category: opt(f.category),
    imageUrl: opt(f.imageUrl),
    retailer: state.source?.retailer,
    sourceUrl: state.source?.sourceUrl,
  };
}
