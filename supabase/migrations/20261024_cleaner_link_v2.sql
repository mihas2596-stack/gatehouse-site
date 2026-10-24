-- Cleaner link v2 (reusable deterministic links) + per-visit cleaner profile.
--
-- Idempotent: safe to run more than once, and safe to run BEFORE the new
-- code deploys (the new columns are nullable and ignored by old code).
-- The new code also tolerates their absence: until this migration is
-- applied, cleaner links keep working exactly as before (random legacy
-- tokens, one-time display), and the owner panel shows the legacy state.
--
-- Run in the Supabase dashboard: SQL editor -> paste -> Run.
alter table gh_visits
  add column if not exists cleaner_link_version text,
  add column if not exists cleaner_link_issuance text,
  add column if not exists cleaner_profile jsonb;

-- cleaner_profile shape (per-visit assignment data, NOT a roster):
--   { "phone": "+1 404 555 0132" | null, "photo": "https://..." | null }
-- Phone/photo belong to the assignment on this visit: changing the
-- cleaner resets them instead of carrying the previous person's over.
