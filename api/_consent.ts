// Card-save consent (16.11.2026, spec 2.1): ONE source of truth for the
// consent text version, shared by the UI, the card-save servers and the
// details-request gate. A visit whose row carries this version (plus a
// consent_given_at timestamp) is a "new-consent" visit; every older visit
// — consent_* columns absent or an older version — is "without new
// consent" and must never be charged under the new 48h details rule.
export const CONSENT_TEXT_VERSION = "2026-11-16-v1";

// The exact checkbox text the client ticks when saving a card.
// {{amount}} is replaced with the pinned visit amount, e.g. "$149".
export function consentText(amount: string): string {
  return `I authorize Gatehouse Home Cleaning to save my card and charge ${amount} for this visit under the payment schedule shown above.`;
}

// A row read tolerantly: the consent_* columns exist only after
// migration 20261116_issue_details_consent. Absent columns read as
// undefined, which is "no new consent" — never upgraded retroactively.
export function hasNewConsent(row: {
  consent_text_version?: string | null;
  consent_given_at?: string | null;
}): boolean {
  return row.consent_text_version === CONSENT_TEXT_VERSION && Boolean(row.consent_given_at);
}

// "Friday, November 20 at 5:00 PM ET" — the deadline wording used in
// the details-request email (letter 2) and on the client report page.
export function formatDeadlineET(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const body = d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${body} ET`;
}

// A details request is ACTIVE while it was requested and the client has
// not answered it since. The answer is judged by the journal event's
// created_at, not by when the owner read it. A provided answer clears
// the deadline but the payment pause is kept (see api/report.ts).
export function detailsRequestActive(
  row: { details_requested_at?: string | null; details_deadline_at?: string | null },
  events: Array<{ event: string; created_at: string }>,
): boolean {
  const requestedAt = row.details_requested_at ?? null;
  if (!requestedAt) {
    // Fallback for rows arranged before the migration: the journal
    // event is the authority.
    const req = events.find((e) => e.event === "issue_details_requested");
    if (!req) return false;
    return !events.some(
      (e) => e.event === "issue_details_provided" && e.created_at >= req.created_at,
    );
  }
  return !events.some(
    (e) => e.event === "issue_details_provided" && e.created_at >= requestedAt,
  );
}
