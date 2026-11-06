import type { Evaluation, OrderSummary } from "@cartguardian/shared";

/**
 * Persistence boundary. Two implementations:
 * - MemoryStore: local development and tests. Lost on restart, and unsafe on
 *   serverless hosts where requests can land on different instances.
 * - SupabaseStore (supabase-store.ts): Postgres, used whenever SUPABASE_URL and
 *   SUPABASE_SECRET_KEY are set, and required on Vercel.
 */
export interface Store {
  readonly kind: "memory" | "supabase";
  saveEvaluation(e: Evaluation): Promise<void>;
  getEvaluation(id: string): Promise<Evaluation | undefined>;
  saveOrder(o: OrderSummary): Promise<void>;
  getOrder(orderId: string): Promise<OrderSummary | undefined>;
  /**
   * Atomically move an order from CREATED to CAPTURING (or take over a
   * CAPTURING claim older than staleAfterMs). Returns the claimed order, or
   * null if another caller holds it or it is in any other state. Exactly one
   * concurrent caller can win, across every server instance.
   */
  claimForCapture(orderId: string, staleAfterMs: number): Promise<OrderSummary | null>;
  /** Undo a claim (CAPTURING -> CREATED) so the buyer can retry, e.g. after a decline. */
  releaseCapture(orderId: string): Promise<void>;
}

export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private evaluations = new Map<string, Evaluation>();
  private orders = new Map<string, OrderSummary>();
  private static readonly MAX_ITEMS = 5000;

  async saveEvaluation(e: Evaluation) {
    this.evaluations.set(e.id, structuredClone(e));
    evictOldest(this.evaluations, MemoryStore.MAX_ITEMS);
  }
  async getEvaluation(id: string) {
    const e = this.evaluations.get(id);
    return e && structuredClone(e);
  }
  async saveOrder(o: OrderSummary) {
    this.orders.set(o.orderId, structuredClone(o));
    evictOldest(this.orders, MemoryStore.MAX_ITEMS);
  }
  async getOrder(orderId: string) {
    const o = this.orders.get(orderId);
    return o && structuredClone(o);
  }
  // Synchronous check-and-set: atomic within one process, which is all a MemoryStore can promise.
  async claimForCapture(orderId: string, staleAfterMs: number) {
    const o = this.orders.get(orderId);
    if (!o) return null;
    const stale = o.status === "CAPTURING" && o.captureStartedAt != null && Date.parse(o.captureStartedAt) < Date.now() - staleAfterMs;
    if (o.status !== "CREATED" && !stale) return null;
    o.status = "CAPTURING";
    o.captureStartedAt = new Date().toISOString();
    return structuredClone(o);
  }
  async releaseCapture(orderId: string) {
    const o = this.orders.get(orderId);
    if (o?.status === "CAPTURING") {
      o.status = "CREATED";
      o.captureStartedAt = null;
    }
  }
}

function evictOldest<V>(map: Map<string, V>, max: number) {
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}
