import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

/**
 * Runs supabase/schema.sql against a real (in-process) Postgres, so the
 * claim function and the privilege lockdown are tested, not just assumed.
 */
const schemaSql = readFileSync(fileURLToPath(new URL("../../../supabase/schema.sql", import.meta.url)), "utf8");
const EVAL = "11111111-1111-1111-1111-111111111111";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // Roles that exist in every Supabase project.
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(schemaSql);
  await db.exec(schemaSql); // must be safe to re-run
  await db.query("insert into public.evaluations (id, data) values ($1, '{}')", [EVAL]);
}, 60_000);

async function newOrder(id: string) {
  await db.query(
    "insert into public.orders (order_id, evaluation_id, amount_value, currency, status) values ($1, $2, 449.00, 'USD', 'CREATED')",
    [id, EVAL],
  );
}
const claim = (id: string, stale = 120) =>
  db.query<{ status: string }>("select * from public.claim_order_for_capture($1, $2)", [id, stale]);

describe("supabase/schema.sql", () => {
  it("lets exactly one caller claim an order", async () => {
    await newOrder("ORDERONE");
    const [a, b] = await Promise.all([claim("ORDERONE"), claim("ORDERONE")]);
    expect(a.rows.length + b.rows.length).toBe(1);
    expect((a.rows[0] ?? b.rows[0])!.status).toBe("CAPTURING");
  });

  it("allows re-claiming only after the claim goes stale", async () => {
    await newOrder("ORDERSTALE");
    expect((await claim("ORDERSTALE")).rows).toHaveLength(1);
    expect((await claim("ORDERSTALE")).rows).toHaveLength(0);
    await db.query("update public.orders set capture_started_at = now() - interval '5 minutes' where order_id = 'ORDERSTALE'");
    expect((await claim("ORDERSTALE", 120)).rows).toHaveLength(1);
  });

  it("never claims completed orders", async () => {
    await newOrder("ORDERDONE");
    await db.query("update public.orders set status = 'COMPLETED' where order_id = 'ORDERDONE'");
    expect((await claim("ORDERDONE")).rows).toHaveLength(0);
  });

  it("rejects malformed rows", async () => {
    await expect(
      db.query("insert into public.orders (order_id, evaluation_id, amount_value, currency, status) values ('bad id', $1, 1, 'USD', 'CREATED')", [EVAL]),
    ).rejects.toThrow();
    await expect(
      db.query("insert into public.orders (order_id, evaluation_id, amount_value, currency, status) values ('NEGATIVE', $1, -1, 'USD', 'CREATED')", [EVAL]),
    ).rejects.toThrow();
    await expect(
      db.query("insert into public.orders (order_id, evaluation_id, amount_value, currency, status) values ('BADSTATUS', $1, 1, 'USD', 'PAID')", [EVAL]),
    ).rejects.toThrow();
  });

  it("locks out the public roles and enables RLS", async () => {
    const priv = await db.query<Record<string, boolean>>(`
      select has_function_privilege('anon', 'public.claim_order_for_capture(text,integer)', 'execute') as anon_exec,
             has_function_privilege('authenticated', 'public.claim_order_for_capture(text,integer)', 'execute') as auth_exec,
             has_function_privilege('service_role', 'public.claim_order_for_capture(text,integer)', 'execute') as service_exec,
             has_table_privilege('anon', 'public.orders', 'select') as anon_select_orders,
             has_table_privilege('anon', 'public.evaluations', 'insert') as anon_insert_evals`);
    expect(priv.rows[0]).toEqual({ anon_exec: false, auth_exec: false, service_exec: true, anon_select_orders: false, anon_insert_evals: false });
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('orders', 'evaluations') order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "evaluations", relrowsecurity: true },
      { relname: "orders", relrowsecurity: true },
    ]);
  });
});
