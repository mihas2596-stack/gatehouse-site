-- Fix round 2 (12.11.2026): durable waive flag. A waive (owner closes
-- the visit without payment) used to live ONLY in gh_events, and the
-- readers cap the journal at the newest 60 events — a busy visit could
-- push the waive out of the window, and the visit became chargeable
-- again. The row flag is the durable truth, OR-ed with the journal by
-- the charge gates (api/_payment_basis.ts paymentBasis, chargeWaivedRow
-- input) and the report/visit pages.
--
-- NOT APPLIED from the sandbox (no Supabase CLI / service-role access
-- there). Apply in the Supabase dashboard SQL editor, then deploy the
-- code that reads/writes the column. The code handles a missing column
-- gracefully (undefined reads as "not waived"; the waive write is
-- best-effort), so applying the migration and deploying the code can
-- happen in either order.
alter table public.gh_visits add column if not exists charge_waived boolean not null default false;

-- Backfill: visits whose journal already holds a waive decision get
-- the flag, so existing waived visits are durable from day one.
update public.gh_visits v
set charge_waived = true
where v.charge_waived = false
  and exists (
    select 1 from public.gh_events e
    where e.visit_id = v.id
      and e.event = 'issue_decision'
      and (e.detail ->> 'decision') = 'waived'
  );
