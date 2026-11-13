-- G4 L3: the photo's unique key for the atomic photo_register claim.
-- api/cleaner.ts upserts gh_photos on storage_path; without this index
-- the upsert cannot engage and registration falls back to the legacy
-- check-then-insert. Apply in Supabase Dashboard → SQL Editor.
-- Each photo_sign mints a unique path (timestamp + random), and the
-- pre-existing duplicate check returns already:true without inserting,
-- so no duplicate storage_path rows should exist; if the index build
-- ever reports duplicates, delete the unregistered copies first.
create unique index if not exists gh_photos_storage_path_key on gh_photos(storage_path);
