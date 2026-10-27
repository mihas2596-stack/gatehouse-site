-- Gatehouse entry arrangements, per visit (spec A §6).
-- Separate from gh_visits.access_notes and from Stripe customer metadata.
-- Service-role only: RLS enabled with NO public policies, matching the
-- other gh_* tables. Apply in the Supabase dashboard SQL editor before
-- deploying the code that reads this table; until then the entry
-- endpoints fail closed (no entry shown, no secret stored).
create table if not exists public.gh_visit_access (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null unique,
  booking_id text not null,
  entry_method text check (entry_method in ('home', 'someone', 'arrange')),
  entry_note text,
  -- AES-256-GCM ciphertext (v1.<iv>.<tag+ciphertext>), never cleartext.
  entry_secret text,
  assigned_cleaner_id text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gh_visit_access enable row level security;
create index if not exists gh_visit_access_expires_idx
  on public.gh_visit_access (expires_at);
-- Retention rule (automatic): rows are deleted on cancel, on cleaner
-- finish, on expiry (visit date + 2 days, else 14 days after saving),
-- and by the auto-charge cron's retention pass. Nothing is kept
-- indefinitely for future visits by default.
