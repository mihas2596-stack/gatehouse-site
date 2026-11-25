/** Shared photo policy — the one place photo lifetimes and kinds live.
 * (LB-43 / DA-50: the policy used to be scattered — retention 90d in
 * api/auto-charge.ts, signed-URL expiry per call site, kind:"client"
 * handling in three files. The values below are the policy; the call
 * sites import them instead of hard-coding their own copies.)
 *
 * Shared with the client through its pure re-export. Keep API imports
 * in api/ — this file must stay dependency-free. */
export const photoBlocked = (zones: string | null | undefined, room: string): boolean =>
  (zones ?? "").split(",").some((zone) => zone.trim().toLowerCase() === room.trim().toLowerCase());

/** Photo kinds. "before"/"after" are the cleaner's work photos;
 * "client" is a photo the client attached to an issue (complaint).
 * Client photos are evidence: the cleaner must never see or delete
 * them (api/cleaner.ts), and retention skips disputed visits. */
export const isClientPhotoKind = (kind: string): boolean => kind === "client";
export const isCleanerPhotoKind = (kind: string): boolean => kind === "before" || kind === "after";

/** Retention (Privacy policy): report photos of paid, undisputed
 * visits are deleted 90 days after the report was sent. 90 days is
 * past the Stripe chargeback window's practical need for the photos
 * of a completed, undisputed visit, while disputed/refunded/unpaid
 * visits keep their evidence indefinitely (the retention pass in
 * api/auto-charge.ts skips them). */
export const PHOTO_RETENTION_DAYS = 90;
export const PHOTO_RETENTION_MS = PHOTO_RETENTION_DAYS * 24 * 3600 * 1000;

/** Signed download URLs handed to the cleaner view last 24 hours: a
 * cleaning day runs long and the page stays open with the screen on,
 * and the only re-sign is on return to the tab (visibilitychange) —
 * a 1-hour TTL let the photos expire mid-visit. 24 hours covers the
 * full visit day plus the report review, and matches the client TTL.
 * A forwarded link still stops working the same day, and the cleaner
 * link itself is bearer with a 14-day life, revocable by the owner
 * (revoke_cleaner_link) — revoking it kills the entry point, not just
 * the photo URLs. Used by api/cleaner.ts. */
export const CLEANER_PHOTO_URL_TTL_SECONDS = 24 * 3600;

/** Signed download URLs handed to the client report last 24 hours —
 * the same length as the review window, so the report a client opens
 * stays readable while they decide. Used by api/report.ts (defined
 * here so the two TTLs are chosen in one place, not per call site). */
export const CLIENT_PHOTO_URL_TTL_SECONDS = 24 * 3600;

/** An unregistered upload may sit for a day while the cleaner retries
 * registration; older than this, it is abandoned, not in-flight, and
 * the orphan cleanup in api/_storage-cleanup.ts may delete it. */
export const ORPHAN_MIN_AGE_MS = 24 * 3600 * 1000;
