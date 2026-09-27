// === Founding-client program config ===
// Owner manually updates FOUNDING_SPOTS_CLAIMED as bookings come in.
// When remaining <= 0, the founding discount turns off everywhere automatically.
export const FOUNDING_SPOTS_TOTAL = 10;
export const FOUNDING_SPOTS_CLAIMED = 0;
export const FOUNDING_SPOTS_REMAINING = Math.max(0, FOUNDING_SPOTS_TOTAL - FOUNDING_SPOTS_CLAIMED);

// Backward-compatible aliases used across the app.
export const FOUNDING_CLAIMED = FOUNDING_SPOTS_CLAIMED;
export const FOUNDING_TOTAL = FOUNDING_SPOTS_TOTAL;
export const FOUNDING_SPOTS_LEFT = FOUNDING_SPOTS_REMAINING;
export const FOUNDING_DISCOUNT = 0.30;
export const FOUNDING_ACTIVE = FOUNDING_SPOTS_REMAINING > 0;

/** Apply founding discount (30% off), rounded to whole dollar. */
export const foundingPrice = (price: number) => Math.round(price * (1 - FOUNDING_DISCOUNT));
// Note: all pricing math (base prices, bathroom surcharge, extras, overage, etc.)
// lives in src/config/pricing.ts — the single source of truth.