import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Currency, Evaluation, OrderStatus, OrderSummary } from "@cartguardian/shared";
import type { Store } from "./store.js";
import { fromMinorUnits } from "./money.js";

/** Row shape of public.orders (see supabase/schema.sql). */
interface OrderRow {
  order_id: string;
  evaluation_id: string;
  amount_value: string | number;
  currency: string;
  status: OrderStatus;
  capture_id: string | null;
  created_at: string;
  completed_at: string | null;
  capture_started_at: string | null;
}

export class StoreError extends Error {
  constructor(op: string, detail: string) {
    super(`Database ${op} failed: ${detail}`);
    this.name = "StoreError";
  }
}

/**
 * Postgres via Supabase's HTTP API. Runs only on the server with the secret
 * key; the browser never talks to Supabase.
 */
export class SupabaseStore implements Store {
  readonly kind = "supabase" as const;
  private readonly db: SupabaseClient;

  constructor(opts: { url: string; secretKey: string; fetch?: typeof fetch }) {
    this.db = createClient(opts.url, opts.secretKey, {
      // Server-side client: no user sessions to persist or refresh.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: opts.fetch ? { fetch: opts.fetch } : {},
    });
  }

  async saveEvaluation(e: Evaluation) {
    const { error } = await this.db.from("evaluations").upsert({ id: e.id, created_at: e.createdAt, data: e });
    if (error) throw new StoreError("saveEvaluation", error.message);
  }

  async getEvaluation(id: string) {
    const { data, error } = await this.db.from("evaluations").select("data").eq("id", id).maybeSingle();
    if (error) throw new StoreError("getEvaluation", error.message);
    return (data?.data as Evaluation | undefined) ?? undefined;
  }

  async saveOrder(o: OrderSummary) {
    const { error } = await this.db.from("orders").upsert(toRow(o));
    if (error) throw new StoreError("saveOrder", error.message);
  }

  async getOrder(orderId: string) {
    const { data, error } = await this.db.from("orders").select("*").eq("order_id", orderId).maybeSingle();
    if (error) throw new StoreError("getOrder", error.message);
    return data ? fromRow(data as OrderRow) : undefined;
  }

  async claimForCapture(orderId: string, staleAfterMs: number) {
    const { data, error } = await this.db.rpc("claim_order_for_capture", {
      p_order_id: orderId,
      p_stale_after_seconds: Math.max(1, Math.round(staleAfterMs / 1000)),
    });
    if (error) throw new StoreError("claimForCapture", error.message);
    const rows = (data ?? []) as OrderRow[];
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async releaseCapture(orderId: string) {
    const { error } = await this.db
      .from("orders")
      .update({ status: "CREATED", capture_started_at: null })
      .eq("order_id", orderId)
      .eq("status", "CAPTURING");
    if (error) throw new StoreError("releaseCapture", error.message);
  }
}

function toRow(o: OrderSummary): OrderRow {
  return {
    order_id: o.orderId,
    evaluation_id: o.evaluationId,
    amount_value: o.amount.value,
    currency: o.amount.currency,
    status: o.status,
    capture_id: o.captureId,
    created_at: o.createdAt,
    completed_at: o.completedAt,
    capture_started_at: o.captureStartedAt ?? null,
  };
}

function fromRow(r: OrderRow): OrderSummary {
  return {
    orderId: r.order_id,
    evaluationId: r.evaluation_id,
    // numeric comes back as a number or string depending on settings: normalise to "449.00".
    amount: { currency: r.currency as Currency, value: normalizeAmount(r.amount_value) },
    status: r.status,
    captureId: r.capture_id,
    createdAt: new Date(r.created_at).toISOString(),
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    captureStartedAt: r.capture_started_at ? new Date(r.capture_started_at).toISOString() : null,
  };
}

function normalizeAmount(v: string | number): string {
  // Parse via string to avoid float artefacts, then to integer cents.
  const [whole = "0", frac = ""] = String(v).split(".");
  return fromMinorUnits(Number(whole) * 100 + Number((frac + "00").slice(0, 2)));
}
