-- Gatehouse visit pipeline schema (Supabase / Postgres)
-- One row per VISIT (a recurring booking produces one row per visit).
-- Server code uses the service-role key only; RLS stays enabled with no
-- public policies, so the anon key cannot read or write anything.

create table if not exists gh_visits (
  id uuid primary key default gen_random_uuid(),
  booking_id text not null,
  visit_no int not null default 1,
  stripe_customer_id text,
  client_name text,
  client_email text,
  service text,
  visit_date date,
  "window" text,
  address text,
  access_notes text,
  no_photo_zones text,
  amount_cents int,
  currency text default 'usd',
  status text not null default 'scheduled',
  cleaner_name text,
  cleaner_token_hash text,
  cleaner_token_expires timestamptz,
  cleaner_link_version text,
  cleaner_link_issuance text,
  cleaner_profile jsonb,
  checklist jsonb not null default '[]'::jsonb,
  report_status text not null default 'none',
  report_sent_at timestamptz,
  report_email_id text,
  report_bounced boolean not null default false,
  issue_open boolean not null default false,
  issue_ever boolean not null default false,
  paid_at timestamptz,
  payment_intent_id text,
  receipt_email_id text,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, visit_no)
);

create table if not exists gh_photos (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references gh_visits(id) on delete cascade,
  room text not null,
  storage_path text not null,
  kind text not null default 'after',
  note text,
  created_at timestamptz not null default now()
);

create table if not exists gh_events (
  id bigint generated always as identity primary key,
  visit_id uuid references gh_visits(id) on delete cascade,
  booking_id text,
  actor text not null,
  event text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists gh_visits_booking_idx on gh_visits(booking_id);
create index if not exists gh_photos_visit_idx on gh_photos(visit_id);
create index if not exists gh_events_visit_idx on gh_events(visit_id);

alter table gh_visits enable row level security;
alter table gh_photos enable row level security;
alter table gh_events enable row level security;

-- Minimal-flow roster (2026-10-24): the cleaner directory. Only
-- owner-selected people go here — never the raw Indeed applicant pool.
-- Assignment runs on the roster's stable ID; the per-visit snapshot
-- (name/phone/photo) stays on gh_visits.cleaner_profile.
create table if not exists gh_cleaners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  photo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table gh_visits add column if not exists cleaner_id uuid references gh_cleaners(id) on delete set null;
create index if not exists gh_visits_cleaner_id_idx on gh_visits(cleaner_id);
alter table gh_cleaners enable row level security;
