import type {
  ApiErrorBody,
  CaptureResponse,
  Evaluation,
  EvaluationInput,
  HealthResponse,
  OrderSummary,
  PublicConfig,
} from "@cartguardian/shared";

const BASE = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError(0, "NETWORK", `Can't reach the API at ${BASE}. Is the server running?`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, e?.code ?? "HTTP_ERROR", e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return body as T;
}

export const api = {
  health: () => call<HealthResponse>("/api/health"),
  config: () => call<PublicConfig>("/api/config"),
  evaluate: (input: EvaluationInput) =>
    call<{ evaluation: Evaluation }>("/api/evaluations", { method: "POST", body: JSON.stringify(input) }),
  createOrder: (evaluationId: string) =>
    call<{ order: OrderSummary }>("/api/orders", { method: "POST", body: JSON.stringify({ evaluationId }) }),
  capture: (orderId: string) =>
    call<CaptureResponse>(`/api/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST" }),
};
