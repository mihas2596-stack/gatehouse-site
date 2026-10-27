-- 2026-10-27: cancellation-fee obligation + atomic entry reminder (N08/N12).
-- Apply BEFORE deploying the code that reads these columns: the fee
-- claim CAS and the reminder CAS fail closed (no charge / no reminder)
-- when the columns are missing, so order matters.
--
-- Fee obligation (one per visit, separate from the cleaning payment):
--   fee_amount_cents: pinned fee from the visit_cancelled journal event
--   fee_status: NULL (never claimed) | fee_pending | fee_paid | fee_failed
--   fee_intent_id: the fee PaymentIntent, once created
alter table public.gh_visits
  add column if not exists fee_amount_cents integer,
  add column if not exists fee_status text,
  add column if not exists fee_intent_id text;
-- Atomic entry-reminder claim (N12): the two daily cron runs used to
-- both see "no journal event" and both email. The winner claims this
-- flag by CAS before sending; a failed/unknown send releases it.
-- DEFAULT false backfills existing rows, so the CAS
-- (entry_reminder_sent =neq.true) matches them.
alter table public.gh_visits
  add column if not exists entry_reminder_sent boolean not null default false;

-- Legacy plaintext entry channel (NOT applied by this file's DDL):
-- gh_visits.access_notes still holds pre-20261026 plaintext notes for
-- old visits. Clearing it in SQL would destroy entry info for
-- confirmed upcoming visits, and moving it into gh_visit_access needs
-- the app-side AES key, so it cannot be done in SQL at all. The safe
-- sequence, run by the owner after checking which visits are still
-- upcoming, is:
--   1. For each confirmed, not-yet-finished visit with a non-empty
--      access_notes, ask the client to re-enter details on /visit
--      (the new encrypted channel), OR copy the value into
--      gh_visit_access via the app (saveAccess) if it is unambiguously
--      that visit's entry detail and still within its expiry window.
--   2. Only then: update public.gh_visits set access_notes = null
--      where access_notes is not null;
-- Code already stopped writing AND reading this column (visit.ts no
-- longer copies it into Stripe metadata; owner.ts strips it from
-- responses), so the column is dormant even before step 2.
