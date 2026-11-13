-- Task 4 (12.11.2026): durable re-clean fields. A re-clean used to
-- live ONLY in gh_events (issue_resolved detail.reclean_date, and the
-- issue_decision event) — and the new Arrange re-clean decision flow
-- never recorded a date at all. The journal is capped at the newest 60
-- events, so a busy visit could push the re-clean out of the window,
-- and the cleaner submit gate (api/cleaner.ts) checked the ORIGINAL
-- visit date, not the re-clean date. The row columns are the durable
-- truth; the journal stays as the fallback until the migration is
-- applied, and the code reads/writes the columns tolerantly.
--
-- NOT APPLIED from the sandbox (no Supabase CLI / service-role access
-- there). Apply in the Supabase dashboard SQL editor, then deploy the
-- code that reads/writes the columns. The code handles missing columns
-- gracefully (undefined reads as "no re-clean"; the arrange write is
-- best-effort), so applying the migration and deploying the code can
-- happen in either order.
alter table public.gh_visits add column if not exists reclean_date text;
alter table public.gh_visits add column if not exists reclean_cleaner_id text;
alter table public.gh_visits add column if not exists reclean_cleaner_name text;
alter table public.gh_visits add column if not exists reclean_status text;

-- Backfill reclean_date from the latest issue_resolved journal event
-- (best-effort: the journal may already have rotated the event out).
update public.gh_visits v
set reclean_date = sub.d
from (
  select distinct on (e.visit_id) e.visit_id, (e.detail ->> 'reclean_date') as d
  from public.gh_events e
  where e.event = 'issue_resolved'
    and (e.detail ->> 'reclean_date') is not null
    and (e.detail ->> 'reclean_date') <> ''
  order by e.visit_id, e.created_at desc
) sub
where v.id = sub.visit_id
  and (v.reclean_date is null or v.reclean_date = '');

-- A backfilled re-clean is "scheduled" unless the visit already shows
-- a resubmitted report (report_status submitted/sent after the return).
update public.gh_visits v
set reclean_status = 'scheduled'
where v.reclean_date is not null
  and v.reclean_date <> ''
  and (v.reclean_status is null or v.reclean_status = '')
  and v.report_status in ('sent', 'returned', 'draft', 'none');
