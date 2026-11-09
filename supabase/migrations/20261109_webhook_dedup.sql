-- C14 (09.11.2026): persistent webhook dedup. The Stripe webhook used
-- to dedupe redeliveries only in a per-instance in-memory Set (cleared
-- entirely past 2000 entries), and the Resend webhook had no dedup at
-- all — a cross-instance redelivery of payment_intent.payment_failed
-- wrote a fresh payment_failed journal row every time. One row per
-- (source, event_id), written only AFTER successful processing, so a
-- failed delivery (5xx) is still retried by the provider instead of
-- being swallowed as a duplicate.
create table if not exists public.gh_webhook_events (
  source text not null,
  event_id text not null,
  event_type text,
  received_at timestamptz not null default now(),
  primary key (source, event_id)
);

-- Service-role only: RLS on, no public policies (same posture as
-- gh_visits / gh_events in schema.sql).
alter table public.gh_webhook_events enable row level security;
