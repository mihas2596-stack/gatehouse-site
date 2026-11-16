// Client-side mirror of api/_consent.ts — the consent text version and
// the exact checkbox wording shown when the client saves a card.
// Keep the two files in sync: CONSENT_TEXT_VERSION must be identical
// in both (pinned by src/test/card-consent.test.ts).
export const CONSENT_TEXT_VERSION = "2026-11-16-v1";

export function consentText(amount: string): string {
  return `I authorize Gatehouse Home Cleaning to save my card and charge ${amount} for this visit under the payment schedule shown above.`;
}
