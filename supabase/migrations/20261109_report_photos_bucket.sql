-- N30 (audit 09.11.2026): create the private photo bucket the cleaner
-- upload signs against (api/_db.ts PHOTO_BUCKET = "report-photos").
-- Until now the bucket existed only because someone created it by hand
-- in Supabase; a fresh environment (or an accidental deletion) broke
-- cleaner photo upload with no migration to restore it.
-- Production already has this bucket: the insert is a no-op there
-- (on conflict do nothing) and never changes an existing bucket's
-- settings. Apply via the Supabase SQL editor with the other migrations.
insert into storage.buckets (id, name, public)
values ('report-photos', 'report-photos', false)
on conflict (id) do nothing;
