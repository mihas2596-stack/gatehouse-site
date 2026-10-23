// ===========================================================
// PRICE CALCULATOR — single source of truth for every price
// shown on the site (quote calculator, homepage table).
// Fixed tier pricing: S / M / L by bedrooms and full bathrooms.
// Square footage and half bathrooms do not change the price.
// ===========================================================

export type TierKey = "S" | "M" | "L";
export type CalcServiceKey = "standard" | "deep" | "moveinout";
export type FrequencyKey = "every2weeks" | "onetime";
export type SizeBandKey = "notsure" | "under2500" | "2500" | "3000" | "3500" | "4000plus";

export const EXTRA_TIME_RATE = 45;
export const EXTRA_TIME_NOTE =
  "Extra time is $45/hour, only with your approval — we explain why and agree the maximum with you before any extra work starts.";

export const TIERS: { key: TierKey; label: string; rooms: string }[] = [
  { key: "S", label: "Small home", rooms: "1–2 bedrooms, up to 2 full bathrooms" },
  { key: "M", label: "Medium home", rooms: "3 bedrooms or 3 full bathrooms" },
  { key: "L", label: "Large home", rooms: "4–5 bedrooms or 4+ full bathrooms" },
];

export const TIER_ROOM_LABEL: Record<TierKey, string> = {
  S: "1–2 bed / 1–2 bath",
  M: "3 bed / 2–3 bath",
  L: "4–5 bed / 3+ bath",
};

/** Returns the tier for a home, or null when the home is larger than tier L. */
export function tierFor(bedrooms: number, fullBaths: number): TierKey | null {
  if (bedrooms > 5 || fullBaths > 5) return null;
  if (bedrooms >= 4 || fullBaths >= 4) return "L";
  if (bedrooms === 3 || fullBaths === 3) return "M";
  return "S";
}

export const PRICES: Record<"standardOnetime" | "deep" | "moveinout" | "recurring", Record<TierKey, number>> = {
  standardOnetime: { S: 14.9, M: 21.9, L: 27.9 },
  deep: { S: 24.9, M: 32.9, L: 39.9 },
  moveinout: { S: 27.9, M: 36.9, L: 44.9 },
  recurring: { S: 12.9, M: 18.9, L: 23.9 },
};

/** Founding client: 30% off, first clean and the recurring rate for 6 months. */
export const FOUNDING_DISCOUNT = 0.3;
const founding = (n: number) => Math.round(n * (1 - FOUNDING_DISCOUNT) * 10) / 10;
export const FOUNDING_FIRST_CLEAN: Record<TierKey, number> = {
  S: founding(PRICES.standardOnetime.S),
  M: founding(PRICES.standardOnetime.M),
  L: founding(PRICES.standardOnetime.L),
};
export const FOUNDING_RECURRING: Record<TierKey, number> = {
  S: founding(PRICES.recurring.S),
  M: founding(PRICES.recurring.M),
  L: founding(PRICES.recurring.L),
};

export const SERVICE_OPTIONS: { key: CalcServiceKey; label: string; tagline: string }[] = [
  { key: "standard", label: "Standard", tagline: "Every room, top to bottom" },
  { key: "deep", label: "Deep", tagline: "Detailed first-time reset" },
  { key: "moveinout", label: "Move-in / Move-out", tagline: "Empty home, full transition clean" },
];

export const SERVICE_LABEL_CALC: Record<CalcServiceKey, string> = {
  standard: "Standard",
  deep: "Deep",
  moveinout: "Move-in / Move-out",
};

export const FREQUENCY_OPTIONS: { key: FrequencyKey; label: string }[] = [
  { key: "every2weeks", label: "Every other week" },
  { key: "onetime", label: "One-time" },
];

export const FREQUENCY_LABEL: Record<FrequencyKey, string> = {
  every2weeks: "Every other week",
  onetime: "One-time",
};

/** Home size bands — collected for scheduling, they do not change the price. */
export const SIZE_BANDS: { key: SizeBandKey; label: string }[] = [
  { key: "notsure", label: "Not sure" },
  { key: "under2500", label: "Under 2,500 sq ft" },
  { key: "2500", label: "2,500–2,999 sq ft" },
  { key: "3000", label: "3,000–3,499 sq ft" },
  { key: "3500", label: "3,500–3,999 sq ft" },
  { key: "4000plus", label: "4,000+ sq ft" },
];

export const SIZE_BAND_LABEL: Record<SizeBandKey, string> = Object.fromEntries(
  SIZE_BANDS.map((b) => [b.key, b.label])
) as Record<SizeBandKey, string>;

/** Extra areas a client can flag for planning — they never change the shown price. */
export const EXTRA_ZONES = [
  { key: "office", label: "Home office" },
  { key: "basement", label: "Finished basement" },
  { key: "living", label: "Extra living room" },
  { key: "other", label: "Other space" },
] as const;
export type ExtraZoneKey = (typeof EXTRA_ZONES)[number]["key"];
export const EXTRA_ZONE_LABEL: Record<ExtraZoneKey, string> = Object.fromEntries(
  EXTRA_ZONES.map((z) => [z.key, z.label])
) as Record<ExtraZoneKey, string>;

/** Fixed-price add-ons, charged on every visit. */
export const ADDONS = {
  insideOven: { label: "Inside oven", price: 3.5 },
  insideFridge: { label: "Inside fridge", price: 3.5 },
  insideCabinets: { label: "Inside cabinets", price: 4.5 },
  interiorWindow: { label: "Interior windows (per window)", price: 0.8 },
  pets: { label: "Pets", price: 1.5 },
} as const;

export const ADDONS_CHARGED = "every visit" as const;
export const MAX_INTERIOR_WINDOWS = 40;

/** Add-ons already covered by a deep or move-in/out clean. */
export const ADDONS_INCLUDED_IN: Record<CalcServiceKey, Array<keyof typeof ADDONS>> = {
  standard: [],
  deep: ["insideOven", "insideFridge", "insideCabinets"],
  moveinout: ["insideOven", "insideFridge", "insideCabinets"],
};

export type AddonSelection = {
  insideOven?: boolean;
  insideFridge?: boolean;
  insideCabinets?: boolean;
  interiorWindows?: number;
  pets?: boolean;
};

export function addonsTotal(a: AddonSelection = {}, service: CalcServiceKey = "standard"): number {
  const included = ADDONS_INCLUDED_IN[service];
  const charge = (key: keyof typeof ADDONS, on?: boolean) =>
    on && !included.includes(key) ? ADDONS[key].price : 0;
  const windows = Math.min(MAX_INTERIOR_WINDOWS, Math.max(0, a.interiorWindows ?? 0));
  return (
    charge("insideOven", a.insideOven) +
    charge("insideFridge", a.insideFridge) +
    charge("insideCabinets", a.insideCabinets) +
    charge("pets", a.pets) +
    windows * ADDONS.interiorWindow.price
  );
}

export const BEDROOM_CHOICES = [1, 2, 3, 4, 5, 6] as const;
export const FULL_BATH_CHOICES = [1, 2, 3, 4, 5] as const;
export const HALF_BATH_CHOICES = [0, 1, 2] as const;

export type CalcInput = {
  bedrooms: number;
  fullBaths: number;
  service?: CalcServiceKey;
  frequency?: FrequencyKey;
  addons?: AddonSelection;
};

/** Base price of a single visit, before add-ons. Null = larger than tier L. */
export function basePrice({
  bedrooms,
  fullBaths,
  service = "standard",
  frequency = "every2weeks",
}: CalcInput): number | null {
  const tier = tierFor(bedrooms, fullBaths);
  if (!tier) return null;
  if (service === "deep") return PRICES.deep[tier];
  if (service === "moveinout") return PRICES.moveinout[tier];
  return frequency === "every2weeks" ? PRICES.recurring[tier] : PRICES.standardOnetime[tier];
}

/** Full price of one visit including add-ons. Null = larger than tier L. */
export function calcPrice(input: CalcInput): number | null {
  const base = basePrice(input);
  if (base === null) return null;
  return base + addonsTotal(input.addons ?? {}, input.service ?? "standard");
}

/**
 * First visit for an every-other-week plan.
 * If the home was NOT professionally cleaned in the last 3 months,
 * the first visit is a deep clean; otherwise it is the recurring rate.
 */
export function firstVisitPrice(
  bedrooms: number,
  fullBaths: number,
  recentlyCleaned: boolean,
  addons: AddonSelection = {}
): number | null {
  const tier = tierFor(bedrooms, fullBaths);
  if (!tier) return null;
  const base = recentlyCleaned ? PRICES.recurring[tier] : PRICES.deep[tier];
  return base + addonsTotal(addons, recentlyCleaned ? "standard" : "deep");
}

/**
 * UNIFIED PRICE BREAKDOWN — single source of truth for what the client
 * sees AND what goes into the booking. Replaces the scattered
 * firstVisit/recurringPrice/foundingFirst/foundingRecurring display that
 * showed contradictory numbers (e.g. $329 deep alongside $153 founding).
 *
 * Founding deep-clean rule (set by the owner):
 * - "full": founding client pays the full deep-clean price for a deep first
 *   visit; the founding discount applies only to standard/recurring.
 *   (Default: matches the price actually charged today — no price change.)
 * - "flat": flat founding first-clean price replaces the deep price.
 * - "discounted": deep-clean price with the 30% founding discount.
 */
export type FoundingDeepRule = "full" | "flat" | "discounted";
export const FOUNDING_DEEP_RULE: FoundingDeepRule = "full";

export type PriceBreakdown = {
  tier: TierKey;
  /** What the first visit is: a deep clean or a standard clean. */
  first_service: "deep" | "standard";
  /** The ONE first-visit price shown and charged. No contradictions. */
  first_total: number;
  /** Per-visit price for recurring visits after the first. */
  recurring_total: number;
  founding_applies: boolean;
  /** Founding recurring rate (only when founding_applies). */
  founding_recurring?: number;
  /** Human-readable note, e.g. "30% founding discount applied". */
  note?: string;
};

export function priceBreakdown(opts: {
  bedrooms: number;
  fullBaths: number;
  frequency: FrequencyKey;
  founding: boolean;
  recentlyCleaned: boolean;
  addons?: AddonSelection;
}): PriceBreakdown | null {
  const tier = tierFor(opts.bedrooms, opts.fullBaths);
  if (!tier) return null;
  const deepFirst = !opts.recentlyCleaned;
  const first_service: "deep" | "standard" = deepFirst ? "deep" : "standard";
  const recurring_total = PRICES.recurring[tier];

  if (!opts.founding) {
    // One-time visits price from the one-time table; recurring plans price
    // the first visit at the recurring rate (or deep when needed).
    const standardBase =
      opts.frequency === "onetime" ? PRICES.standardOnetime[tier] : PRICES.recurring[tier];
    const base = deepFirst ? PRICES.deep[tier] : standardBase;
    return {
      tier,
      first_service,
      first_total: base + addonsTotal(opts.addons ?? {}, first_service),
      recurring_total: recurring_total + addonsTotal(opts.addons ?? {}, "standard"),
      founding_applies: false,
    };
  }

  // Founding client.
  const founding_recurring = FOUNDING_RECURRING[tier];
  if (!deepFirst) {
    // Standard first visit: founding first-clean price applies directly.
    return {
      tier,
      first_service,
      first_total: FOUNDING_FIRST_CLEAN[tier] + addonsTotal(opts.addons ?? {}, "standard"),
      recurring_total: founding_recurring + addonsTotal(opts.addons ?? {}, "standard"),
      founding_applies: true,
      founding_recurring,
      note: "30% founding discount applied",
    };
  }
  // Founding client, deep first visit: owner decides via FOUNDING_DEEP_RULE.
  if (FOUNDING_DEEP_RULE === "flat") {
    return {
      tier,
      first_service,
      first_total: FOUNDING_FIRST_CLEAN[tier] + addonsTotal(opts.addons ?? {}, "deep"),
      recurring_total: founding_recurring + addonsTotal(opts.addons ?? {}, "standard"),
      founding_applies: true,
      founding_recurring,
      note: "Founding flat price for the first clean",
    };
  }
  if (FOUNDING_DEEP_RULE === "discounted") {
    const discountedDeep = Math.round(PRICES.deep[tier] * (1 - FOUNDING_DISCOUNT) * 10) / 10;
    return {
      tier,
      first_service,
      first_total: discountedDeep + addonsTotal(opts.addons ?? {}, "deep"),
      recurring_total: founding_recurring + addonsTotal(opts.addons ?? {}, "standard"),
      founding_applies: true,
      founding_recurring,
      note: "30% founding discount applied to the deep clean",
    };
  }
  // "full" (default): full deep-clean price; founding discount does not
  // apply to the deep first visit. No contradictory $153 is shown.
  return {
    tier,
    first_service,
    first_total: PRICES.deep[tier] + addonsTotal(opts.addons ?? {}, "deep"),
    recurring_total: founding_recurring + addonsTotal(opts.addons ?? {}, "standard"),
    founding_applies: true,
    founding_recurring,
    note: "First deep clean at the standard deep price; founding rate applies to recurring visits",
  };
}
