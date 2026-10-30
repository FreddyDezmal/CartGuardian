import type { Evaluation, OrderSummary } from "@cartguardian/shared";

/**
 * Persistence boundary. Milestone 1 uses an in-memory implementation:
 * data is lost on restart, which is acceptable for a local demo but means an
 * order created before a restart cannot be captured afterwards.
 * Swap for SQLite (see docs/PLAN.md, Day 6) without touching routes.
 */
export interface Store {
  saveEvaluation(e: Evaluation): Promise<void>;
  getEvaluation(id: string): Promise<Evaluation | undefined>;
  saveOrder(o: OrderSummary): Promise<void>;
  getOrder(orderId: string): Promise<OrderSummary | undefined>;
}

export class MemoryStore implements Store {
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
}

function evictOldest<V>(map: Map<string, V>, max: number) {
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}
