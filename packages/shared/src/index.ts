import { z } from "zod";

/**
 * Shared contract between the React app and the API.
 * The server is the only party that trusts these schemas: the browser uses
 * them for types and early feedback, the server re-validates everything.
 */

/** Currencies a purchase can be evaluated in. All use two decimal places. */
export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "ZAR"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Currencies PayPal can take payment in (a subset). ZAR is evaluation-only:
 * it is not one of PayPal's payment currencies, so checkout is offered only
 * for the currencies below.
 */
export const PAYPAL_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const satisfies readonly Currency[];
export const isPayPalCurrency = (c: string): boolean => (PAYPAL_CURRENCIES as readonly string[]).includes(c);

/** Hard ceiling for a single Sandbox order in the MVP (major units). */
export const MAX_PRICE = 5000;
/** Per-currency ceiling: ZAR amounts are larger for the same goods. */
export const MAX_PRICE_BY_CURRENCY: Record<Currency, number> = {
  USD: MAX_PRICE,
  EUR: MAX_PRICE,
  GBP: MAX_PRICE,
  CAD: MAX_PRICE,
  AUD: MAX_PRICE,
  ZAR: 100000,
};

/** Decimal string with up to 2 fraction digits, e.g. "129.99". No exponents, no signs. */
export const PRICE_PATTERN = /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/;

export const LIMITS = {
  productName: { min: 2, max: 120 },
  description: { max: 2000 },
  intendedUse: { max: 500 },
  usesPerMonth: { min: 0, max: 1000 },
  lifetimeMonths: { min: 1, max: 240 },
  brand: { max: 80 },
  category: { max: 120 },
  retailer: { max: 80 },
  url: { max: 2048 },
} as const;

const cleanText = (max: number) =>
  z
    .string()
    .trim()
    // strip ASCII control characters except newline and tab
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""))
    .pipe(z.string().max(max));

/** http(s) URL only: imported links and images are shown to users and sent to the AI as data. */
const webUrl = z
  .string()
  .trim()
  .max(LIMITS.url.max)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "Must be an http or https link");

export const EvaluationInputSchema = z.object({
  productName: cleanText(LIMITS.productName.max).pipe(
    z.string().min(LIMITS.productName.min, "Product name is required"),
  ),
  price: z
    .string()
    .trim()
    .regex(PRICE_PATTERN, "Price must be a number with at most 2 decimals, e.g. 129.99")
    .refine((v) => Number(v) > 0, "Price must be greater than zero"),
  currency: z.enum(SUPPORTED_CURRENCIES),
  description: cleanText(LIMITS.description.max).optional().default(""),
  intendedUse: cleanText(LIMITS.intendedUse.max).optional().default(""),
  usesPerMonth: z
    .number()
    .int()
    .min(LIMITS.usesPerMonth.min)
    .max(LIMITS.usesPerMonth.max)
    .optional(),
  lifetimeMonths: z
    .number()
    .int()
    .min(LIMITS.lifetimeMonths.min)
    .max(LIMITS.lifetimeMonths.max)
    .optional(),
  // Optional product context, typically from a link import and then reviewed by the user.
  // Treated as untrusted listing data, like the description.
  brand: cleanText(LIMITS.brand.max).optional(),
  category: cleanText(LIMITS.category.max).optional(),
  retailer: cleanText(LIMITS.retailer.max).optional(),
  sourceUrl: webUrl.optional(),
  imageUrl: webUrl.optional(),
}).superRefine((v, ctx) => {
  const max = MAX_PRICE_BY_CURRENCY[v.currency];
  if (Number(v.price) > max) {
    ctx.addIssue({ code: "custom", path: ["price"], message: `Price must be at most ${max} ${v.currency}` });
  }
});
export type EvaluationInput = z.input<typeof EvaluationInputSchema>;
export type NormalizedEvaluationInput = z.output<typeof EvaluationInputSchema>;

/** Where a claim in the trial comes from. Shown to the user as a badge. */
export const BASIS = ["your_input", "general_knowledge", "assumption"] as const;
export type Basis = (typeof BASIS)[number];

export const ArgumentSchema = z.object({
  point: z.string().min(1).max(280),
  basis: z.enum(BASIS),
});

export const CaseSchema = z.object({
  headline: z.string().min(1).max(160),
  arguments: z.array(ArgumentSchema).min(1).max(4),
});

/**
 * The structured output the AI must return. Note: there is deliberately
 * no price/amount field here. Money is computed by the server only.
 */
export const TrialResultSchema = z.object({
  buyCase: CaseSchema,
  skipCase: CaseSchema,
  verdict: z.enum(["buy", "wait", "skip"]),
  confidence: z.enum(["low", "medium", "high"]),
  verdictRationale: z.string().min(1).max(500),
  questionsBeforeBuying: z.array(z.string().min(1).max(200)).max(4),
  unverifiedAssumptions: z.array(z.string().min(1).max(200)).max(5),
});
export type TrialResult = z.infer<typeof TrialResultSchema>;

export interface Money {
  currency: Currency;
  /** Decimal string, always 2 fraction digits, e.g. "129.99" */
  value: string;
}

export interface ValueMetrics {
  /** Price divided by expected total uses, if usage was provided. */
  costPerUse: Money | null;
  /** Price amortised over expected lifetime, if provided. */
  costPerMonth: Money | null;
  totalExpectedUses: number | null;
}

export type AiProviderName = "mock" | "anthropic" | "gemini";

export interface Evaluation {
  id: string;
  createdAt: string;
  productName: string;
  /** Server-normalised amount. The only amount an order can be created for. */
  amount: Money;
  /** Where the product came from, if the user imported or entered it. */
  product?: ProductContext;
  metrics: ValueMetrics;
  trial: TrialResult;
  provider: AiProviderName;
  model: string;
  /** Server-side guardrail notes, e.g. a blocked absolute claim. */
  policyFlags: string[];
  disclaimer: string;
}

/** CAPTURING = a server instance has claimed the order and is talking to PayPal. */
export type OrderStatus = "CREATED" | "CAPTURING" | "COMPLETED" | "PENDING" | "FAILED";

export interface OrderSummary {
  orderId: string;
  evaluationId: string;
  amount: Money;
  status: OrderStatus;
  captureId: string | null;
  createdAt: string;
  completedAt: string | null;
  /** When the current capture claim was taken (CAPTURING only). */
  captureStartedAt?: string | null;
}

export const CreateOrderBodySchema = z.object({
  evaluationId: z.string().uuid(),
});

export interface CaptureResponse {
  order: OrderSummary;
  /** true when this call returned a previously recorded capture */
  replayed: boolean;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface HealthResponse {
  status: "ok";
  uptimeSeconds: number;
  ai: { provider: AiProviderName; configured: boolean; model: string };
  paypal: { environment: "sandbox"; configured: boolean };
  /** "memory" loses data on restart and is unsafe on serverless hosts. */
  store: "memory" | "supabase";
}

export interface ProductContext {
  brand?: string;
  category?: string;
  retailer?: string;
  sourceUrl?: string;
  imageUrl?: string;
}

// ---------- Product link import ----------

/** Fields an import can fill. retailer and sourceUrl are always known, so they are not counted. */
export const IMPORT_FIELDS = ["title", "description", "price", "currency", "imageUrl", "brand", "category"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const ProductImportRequestSchema = z.object({
  url: z.string().trim().min(1, "Paste a product link").max(LIMITS.url.max),
});

/**
 * What a page actually said. Every field except sourceUrl may be missing:
 * nothing is guessed. price is a decimal string ("1299.00") like all money here.
 * currency is an ISO 4217 code as found, and may be one CartGuardian can't evaluate.
 */
export interface ImportedProduct {
  title?: string;
  description?: string;
  price?: string;
  currency?: string;
  imageUrl?: string;
  brand?: string;
  category?: string;
  retailer?: string;
  sourceUrl: string;
}

export interface ProductImportResponse {
  success: true;
  product: ImportedProduct;
  fieldsFound: ImportField[];
  fieldsMissing: ImportField[];
  retailer: { id: string; name: string; supported: boolean };
  /** Plain-language caveats, e.g. "Price varies by option; showing the lowest." */
  notes: string[];
}

export interface PublicConfig {
  paypalClientId: string | null;
  paypalEnvironment: "sandbox";
  aiProvider: AiProviderName;
  currencies: readonly Currency[];
  /** Currencies checkout is offered in. */
  paypalCurrencies: readonly Currency[];
  maxPrice: number;
  maxPriceByCurrency: Record<Currency, number>;
}
