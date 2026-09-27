// ===========================================================
// SINGLE SOURCE OF TRUTH for the first-clean offer.
// Change it here and it changes everywhere on the site.
// ===========================================================

export const OFFER_DISCOUNT_PERCENT = 30;
export const OFFER_DISCOUNT_RATE = OFFER_DISCOUNT_PERCENT / 100;

/** Short inline label. */
export const OFFER_SHORT = `founding price on your first clean`;

/** Founding-client paragraph used on the home page and /founding. */
export const OFFER_TEXT = `We're new in North Atlanta. The first 10 households pay a founding price on their first clean and keep their founding rate for six months.`;

/** Sentence used in meta descriptions and FAQ answers. */
export const OFFER_SENTENCE = `The first 10 households in our service area pay a founding price on their first clean and keep their founding rate for six months.`;

/** Apply the first-clean discount to a price, rounded to a whole dollar. */
export const applyOfferDiscount = (price: number): number =>
  Math.max(0, Math.round(price * (1 - OFFER_DISCOUNT_RATE)));
