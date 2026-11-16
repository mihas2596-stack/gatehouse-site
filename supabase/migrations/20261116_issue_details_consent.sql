-- 20261116_issue_details_consent: issue details request, reduced-amount
-- offers, partial refunds, damage path and card-save consent (spec
-- 16.11.2026). Apply in the Supabase dashboard only — never from the
-- sandbox. All new columns are nullable; server code reads them
-- tolerantly (absent column = "no request / no offer / no consent"),
-- following the charge_waived / reclean_* pattern.
alter table public.gh_visits
  add column if not exists consent_text_version text,
  add column if not exists consent_given_at timestamptz,
  add column if not exists issue_kind text,
  add column if not exists issue_rooms jsonb,
  add column if not exists details_requested_at timestamptz,
  add column if not exists details_deadline_at timestamptz,
  add column if not exists details_request_text text,
  add column if not exists details_email_id text,
  add column if not exists issue_ack_email_id text,
  add column if not exists offer_amount_cents int,
  add column if not exists offer_status text,
  add column if not exists partial_refund_cents int,
  add column if not exists damage_reported_at timestamptz;
