import { z } from "zod";

/**
 * Shared contract between the React app and the API.
 * The server is the only party that trusts these schemas: the browser uses
 * them for types and early feedback, the server re-validates everything.
 */

/** Currencies the MVP accepts. All use two decimal places in PayPal. */
export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Hard ceiling for a single Sandbox order in the MVP (major units). */
export const MAX_PRICE = 5000;

/** Decimal string with up to 2 fraction digits, e.g. "129.99". No exponents, no signs. */
export const PRICE_PATTERN = /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/;

export const LIMITS = {
  productName: { min: 2, max: 120 },
  description: { max: 2000 },
  intendedUse: { max: 500 },
  usesPerMonth: { min: 0, max: 1000 },
  lifetimeMonths: { min: 1, max: 240 },
} as const;

const cleanText = (max: number) =>
  z
    .string()
    .trim()
    // strip ASCII control characters except newline and tab
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""))
    .pipe(z.string().max(max));

export const EvaluationInputSchema = z.object({
  productName: cleanText(LIMITS.productName.max).pipe(
    z.string().min(LIMITS.productName.min, "Product name is required"),
  ),
  price: z
    .string()
    .trim()
    .regex(PRICE_PATTERN, "Price must be a number with at most 2 decimals, e.g. 129.99")
    .refine((v) => Number(v) > 0, "Price must be greater than zero")
    .refine((v) => Number(v) <= MAX_PRICE, `Price must be at most ${MAX_PRICE}`),
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

export type AiProviderName = "mock" | "anthropic";

export interface Evaluation {
  id: string;
  createdAt: string;
  productName: string;
  /** Server-normalised amount. The only amount an order can be created for. */
  amount: Money;
  metrics: ValueMetrics;
  trial: TrialResult;
  provider: AiProviderName;
  model: string;
  /** Server-side guardrail notes, e.g. a blocked absolute claim. */
  policyFlags: string[];
  disclaimer: string;
}

export type OrderStatus = "CREATED" | "COMPLETED" | "PENDING" | "FAILED";

export interface OrderSummary {
  orderId: string;
  evaluationId: string;
  amount: Money;
  status: OrderStatus;
  captureId: string | null;
  createdAt: string;
  completedAt: string | null;
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
}

export interface PublicConfig {
  paypalClientId: string | null;
  paypalEnvironment: "sandbox";
  aiProvider: AiProviderName;
  currencies: readonly Currency[];
  maxPrice: number;
}
