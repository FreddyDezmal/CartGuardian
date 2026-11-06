import { describe, expect, it } from "vitest";
import type { Evaluation, OrderSummary } from "@cartguardian/shared";
import { SupabaseStore } from "../src/supabase-store.js";
import { loadConfig } from "../src/config.js";
import { bootstrap } from "../src/bootstrap.js";

const order: OrderSummary = {
  orderId: "5O190127TN364715T",
  evaluationId: "11111111-1111-1111-1111-111111111111",
  amount: { currency: "USD", value: "449.00" },
  status: "CREATED",
  captureId: null,
  createdAt: "2026-11-03T13:00:00.000Z",
  completedAt: null,
};

/** Real supabase-js client, fake network: checks the exact HTTP requests it makes. */
function recordingStore(respond: (url: URL, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ method: string; url: URL; headers: Headers; body: unknown }> = [];
  const store = new SupabaseStore({
    url: "https://abcd.supabase.co",
    secretKey: "sb_secret_test",
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      calls.push({ method: init.method ?? "GET", url, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = respond(url, init);
      const status = r.status ?? 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(r.body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  return { store, calls };
}

describe("SupabaseStore", () => {
  it("upserts orders as snake_case rows using the secret key", async () => {
    const { store, calls } = recordingStore(() => ({ status: 201, body: [] }));
    await store.saveOrder(order);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url.pathname).toBe("/rest/v1/orders");
    expect(c.headers.get("apikey")).toBe("sb_secret_test");
    expect(c.headers.get("prefer")).toContain("resolution=merge-duplicates");
    expect(c.body).toMatchObject({ order_id: order.orderId, amount_value: "449.00", currency: "USD", status: "CREATED" });
  });

  it("maps rows back, normalising Postgres numerics to 2-decimal strings", async () => {
    const row = { order_id: order.orderId, evaluation_id: order.evaluationId, amount_value: 449, currency: "USD", status: "COMPLETED", capture_id: "CAP1", created_at: "2026-11-03T13:00:00+00:00", completed_at: "2026-11-03T13:01:00+00:00", capture_started_at: null };
    const { store, calls } = recordingStore(() => ({ body: row }));
    const got = await store.getOrder(order.orderId);
    expect(calls[0]!.url.searchParams.get("order_id")).toBe(`eq.${order.orderId}`);
    expect(got).toEqual({ ...order, status: "COMPLETED", captureId: "CAP1", completedAt: "2026-11-03T13:01:00.000Z", captureStartedAt: null });
  });

  it("claims through the claim_order_for_capture RPC and returns null when someone else holds it", async () => {
    let rows: unknown[] = [{ ...{ order_id: order.orderId, evaluation_id: order.evaluationId, amount_value: "449.00", currency: "USD", status: "CAPTURING", capture_id: null, created_at: order.createdAt, completed_at: null, capture_started_at: "2026-11-03T13:00:05Z" } }];
    const { store, calls } = recordingStore(() => ({ body: rows }));
    const won = await store.claimForCapture(order.orderId, 120_000);
    expect(calls[0]!.url.pathname).toBe("/rest/v1/rpc/claim_order_for_capture");
    expect(calls[0]!.body).toEqual({ p_order_id: order.orderId, p_stale_after_seconds: 120 });
    expect(won).toMatchObject({ status: "CAPTURING", amount: { value: "449.00" } });
    rows = [];
    expect(await store.claimForCapture(order.orderId, 120_000)).toBeNull();
  });

  it("releases only a CAPTURING claim", async () => {
    const { store, calls } = recordingStore(() => ({ status: 204, body: null }));
    await store.releaseCapture(order.orderId);
    const c = calls[0]!;
    expect(c.method).toBe("PATCH");
    expect(c.url.searchParams.get("order_id")).toBe(`eq.${order.orderId}`);
    expect(c.url.searchParams.get("status")).toBe("eq.CAPTURING");
    expect(c.body).toEqual({ status: "CREATED", capture_started_at: null });
  });

  it("stores and returns whole evaluations", async () => {
    const evaluation = { id: order.evaluationId, createdAt: order.createdAt, productName: "X" } as Evaluation;
    const { store, calls } = recordingStore((url, init) => ({ body: init.method === "POST" ? [] : { data: evaluation } }));
    await store.saveEvaluation(evaluation);
    expect(calls[0]!.body).toEqual({ id: evaluation.id, created_at: evaluation.createdAt, data: evaluation });
    expect(await store.getEvaluation(evaluation.id)).toEqual(evaluation);
  });

  it("surfaces database errors instead of pretending the write worked", async () => {
    const { store } = recordingStore(() => ({ status: 401, body: { message: "Invalid API key" } }));
    await expect(store.saveOrder(order)).rejects.toMatchObject({ name: "StoreError" });
  });
});

describe("store selection and config", () => {
  it("uses Supabase when both variables are set, memory otherwise", () => {
    expect(bootstrap({ AI_PROVIDER: "mock" }).store.kind).toBe("memory");
    expect(bootstrap({ AI_PROVIDER: "mock", SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" }).store.kind).toBe("supabase");
  });

  it("rejects half-configured, wrong-key and wrong-URL setups", () => {
    expect(() => loadConfig({ SUPABASE_URL: "https://abcd.supabase.co" })).toThrow(/both/);
    expect(() => loadConfig({ SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_SECRET_KEY: "sb_publishable_x" })).toThrow(/publishable/);
    expect(() => loadConfig({ SUPABASE_URL: "abcd.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" })).toThrow(/https/);
  });

  it("refuses to run on Vercel with the in-memory store", () => {
    expect(() => loadConfig({ VERCEL: "1" })).toThrow(/Vercel without a database/);
    expect(() => loadConfig({ VERCEL: "1", SUPABASE_URL: "https://abcd.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" })).not.toThrow();
  });
});

describe("Vercel entry URL handling", () => {
  it("keeps original URLs and rebuilds rewritten ones", async () => {
    const { restoreOriginalUrl } = await import("../src/vercel.js");
    expect(restoreOriginalUrl("/api/health")).toBe("/api/health");
    expect(restoreOriginalUrl("/api/orders/ABC/capture?__cgpath=orders%2FABC%2Fcapture")).toBe("/api/orders/ABC/capture");
    expect(restoreOriginalUrl("/api/index.mjs?__cgpath=orders%2FABC%2Fcapture")).toBe("/api/orders/ABC/capture");
    expect(restoreOriginalUrl("/api/index.mjs?__cgpath=health&x=1")).toBe("/api/health?x=1");
  });
});
