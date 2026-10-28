-- Entry preference chosen at quote time (GPT brief 2026-10-28).
-- This is NOT the secret channel: codes and key locations live only in
-- gh_visit_access (encrypted). These columns hold the non-secret choice:
-- how the client wants to arrange entry, the arrange-before detail, and
-- ordinary parking/building notes. The form warns against putting codes
-- in the notes; notes go to the visit row and the owner request email
-- only — never to Stripe metadata, client emails, URLs or logs.
alter table gh_visits add column if not exists entry_method text;
alter table gh_visits add column if not exists entry_detail text;
alter table gh_visits add column if not exists entry_notes text;
