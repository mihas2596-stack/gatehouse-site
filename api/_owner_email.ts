// Single source of truth for the owner's notification mailbox (N22).
// Every server email addressed to the owner goes through
// ownerNotificationEmail() instead of a literal repeated in six files.
// Override with OWNER_NOTIFICATION_EMAIL; without it the mailbox below
// (the owner's address since launch) is used, so nothing breaks when
// the variable is not set in Vercel.
const FALLBACK_OWNER_EMAIL = "nikolajmihasenok@gmail.com";

export function ownerNotificationEmail(): string {
  const env = (process.env.OWNER_NOTIFICATION_EMAIL ?? "").trim();
  return env || FALLBACK_OWNER_EMAIL;
}
