/**
 * Thin PayPal REST client for Orders v2, using fetch directly so every
 * request and header is visible. Endpoints used:
 *   POST /v1/oauth2/token
 *   POST /v2/checkout/orders
 *   GET  /v2/checkout/orders/{id}
 *   POST /v2/checkout/orders/{id}/capture
 * Reference: https://developer.paypal.com/docs/api/orders/v2/
 */

export interface PayPalAmount {
  currency_code: string;
  value: string;
}

export interface PayPalCapture {
  id: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
  amount: PayPalAmount;
  custom_id?: string;
}

export interface PayPalPurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  amount: PayPalAmount;
  payments?: { captures?: PayPalCapture[] };
}

export interface PayPalOrder {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  intent?: "CAPTURE" | "AUTHORIZE";
  purchase_units: PayPalPurchaseUnit[];
}

export interface CreateOrderParams {
  requestId: string;
  amount: PayPalAmount;
  referenceId: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

/** The three operations the app needs. Tests inject a fake implementation. */
export interface PayPalApi {
  readonly configured: boolean;
  createOrder(p: CreateOrderParams): Promise<PayPalOrder>;
  getOrder(orderId: string): Promise<PayPalOrder>;
  captureOrder(orderId: string, requestId: string): Promise<PayPalOrder>;
}

export class PayPalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly issue: string,
    message: string,
    public readonly debugId: string | null,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

interface ClientOptions {
  baseUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class PayPalRestClient implements PayPalApi {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get configured() {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  createOrder(p: CreateOrderParams) {
    return this.request<PayPalOrder>("POST", "/v2/checkout/orders", {
      headers: { "PayPal-Request-Id": p.requestId },
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: p.referenceId,
            custom_id: p.referenceId,
            description: p.description.slice(0, 127),
            amount: p.amount,
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              return_url: p.returnUrl,
              cancel_url: p.cancelUrl,
            },
          },
        },
      },
    });
  }

  getOrder(orderId: string) {
    return this.request<PayPalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  captureOrder(orderId: string, requestId: string) {
    return this.request<PayPalOrder>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      headers: { "PayPal-Request-Id": requestId, Prefer: "return=representation" },
      body: {},
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    if (!this.configured) {
      throw new PayPalApiError(500, "NOT_CONFIGURED", "PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set.", null);
    }
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.fetchWithTimeout(`${this.opts.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      const debugId = res.headers.get("paypal-debug-id");
      const text = await res.text().catch(() => "");
      // 401 invalid_client is the classic "wrong secret / live keys in sandbox" error.
      throw new PayPalApiError(res.status, "AUTH_FAILED", `PayPal OAuth failed (${res.status}): ${text.slice(0, 200)}`, debugId);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    // Refresh 60s early to avoid using a token that expires mid-request.
    this.token = { value: json.access_token, expiresAt: Date.now() + Math.max(0, json.expires_in - 60) * 1000 };
    return this.token.value;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { headers?: Record<string, string>; body?: unknown } = {},
    retriedAuth = false,
  ): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchWithTimeout(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (res.status === 401 && !retriedAuth) {
      this.token = null; // token revoked/expired early: refresh once
      return this.request<T>(method, path, opts, true);
    }

    const debugId = res.headers.get("paypal-debug-id");
    const text = await res.text();
    const json = text ? safeJson(text) : {};

    if (!res.ok) {
      const j = json as { name?: string; message?: string; details?: Array<{ issue?: string; description?: string }> };
      const issue = j.details?.[0]?.issue ?? j.name ?? "UNKNOWN";
      const description = j.details?.[0]?.description ?? j.message ?? "PayPal request failed";
      throw new PayPalApiError(res.status, issue, description, debugId);
    }
    return json as T;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs) });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new PayPalApiError(504, "TIMEOUT", `PayPal did not respond within ${this.opts.timeoutMs} ms.`, null);
      }
      throw new PayPalApiError(502, "NETWORK", `Could not reach PayPal: ${(err as Error).message}`, null);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}
