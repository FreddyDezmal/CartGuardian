-- CartGuardian database schema for Supabase (Postgres).
-- Run once: Supabase dashboard > SQL Editor > New query > paste this file > Run.
-- Safe to re-run: every statement is idempotent.
--
-- Security model: the browser never talks to Supabase. Only the API server does,
-- using the secret key (service_role). Row Level Security is enabled with NO
-- policies, and anon/authenticated privileges are revoked, so a leaked
-- publishable key can read or write nothing.

create table if not exists public.evaluations (
  id          uuid primary key,
  created_at  timestamptz not null default now(),
  -- Full Evaluation object as returned by the API (trial, metrics, amount, ...).
  data        jsonb not null
);

create table if not exists public.orders (
  order_id            text primary key check (order_id ~ '^[A-Z0-9]{1,36}$'),
  evaluation_id       uuid not null references public.evaluations (id),
  -- Amount frozen from the evaluation. Never taken from the browser or the model.
  amount_value        numeric(12, 2) not null check (amount_value > 0),
  currency            text not null check (currency ~ '^[A-Z]{3}$'),
  status              text not null check (status in ('CREATED', 'CAPTURING', 'PENDING', 'COMPLETED', 'FAILED')),
  capture_id          text unique,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,
  -- Set when a server instance claims the order for capture (see function below).
  capture_started_at  timestamptz
);

create index if not exists orders_evaluation_id_idx on public.orders (evaluation_id);

alter table public.evaluations enable row level security;
alter table public.orders enable row level security;
revoke all on table public.evaluations from anon, authenticated;
revoke all on table public.orders from anon, authenticated;

-- Atomically claims an order for capture. Exactly one caller gets the row back;
-- every concurrent caller gets nothing. This is what stops double captures when
-- requests land on different serverless instances.
-- A claim older than p_stale_after_seconds is treated as abandoned (the instance
-- died mid-capture) and can be re-claimed; the deterministic PayPal-Request-Id
-- makes the retried capture idempotent on PayPal's side.
create or replace function public.claim_order_for_capture(p_order_id text, p_stale_after_seconds integer default 120)
returns setof public.orders
language sql
security invoker
set search_path = ''
as $$
  update public.orders
     set status = 'CAPTURING',
         capture_started_at = now()
   where order_id = p_order_id
     and (
       status = 'CREATED'
       or (status = 'CAPTURING' and capture_started_at < now() - make_interval(secs => p_stale_after_seconds))
     )
  returning *;
$$;

revoke all on function public.claim_order_for_capture(text, integer) from public, anon, authenticated;
grant execute on function public.claim_order_for_capture(text, integer) to service_role;
