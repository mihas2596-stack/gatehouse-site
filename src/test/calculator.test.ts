// Tests for the unified price breakdown — the single source of truth for
// every price shown on /quote and signed into the booking token.
// Mirrors api/send-contact-email.ts serverBreakdown(); the two MUST agree.
//
// The Founding Clients program was closed to new bookings on 2026-10-23:
// every scenario below prices from the regular tables. The owner's signed
// price-test mode (testScale) prices at 1/10 and is covered separately.
import { describe, it, expect } from "vitest";
import { priceBreakdown, tierFor, addonsTotal, priceCutActive } from "../config/calculator";

describe("tierFor", () => {
  it("maps 3bd/2ba to M", () => {
    expect(tierFor(3, 2)).toBe("M");
  });
  it("returns null for homes larger than tier L (custom quote)", () => {
    expect(tierFor(6, 2)).toBeNull();
    expect(tierFor(3, 6)).toBeNull();
    expect(tierFor(5, 5)).toBe("L");
  });
});

describe("addonsTotal", () => {
  it("charges oven/fridge/cabinets only for standard (included in deep)", () => {
    const addons = { insideOven: true, insideFridge: true, insideCabinets: true };
    expect(addonsTotal(addons, "standard")).toBe(35 + 35 + 45);
    expect(addonsTotal(addons, "deep")).toBe(0);
    expect(addonsTotal(addons, "moveinout")).toBe(0);
  });
  it("always charges pets and windows", () => {
    expect(addonsTotal({ pets: true, interiorWindows: 3 }, "deep")).toBe(15 + 24);
  });
});

describe("priceBreakdown — confirmed scenario (P0-1)", () => {
  // 3 bedrooms, 2 full bathrooms, ZIP 30024, Standard, every other week,
  // cleaned in last 3 months = Yes, inside oven +$35.
  const scenario = {
    bedrooms: 3,
    fullBaths: 2,
    frequency: "every2weeks" as const,
    recentlyCleaned: true,
    addons: { insideOven: true },
  };
  it("shows ONE first-visit total including the add-on at regular prices", () => {
    const b = priceBreakdown(scenario);
    expect(b).not.toBeNull();
    // Recurring plan, cleaned recently: first visit at the $189 recurring
    // M rate, plus $35 oven = $224.
    expect(b!.first_total).toBe(224);
    expect(b!.first_service).toBe("standard");
  });
  it("shows the regular recurring rate including the add-on", () => {
    const b = priceBreakdown(scenario);
    expect(b!.recurring_total).toBe(189 + 35); // $224
  });
});

describe("priceBreakdown — deep first visit", () => {
  it("labels the first visit as a deep clean when not cleaned recently", () => {
    const b = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "every2weeks",
      recentlyCleaned: false,
      addons: { insideOven: true },
    });
    expect(b!.first_service).toBe("deep");
    // Deep M = $329; oven is included in deep, not charged twice.
    expect(b!.first_total).toBe(329);
    expect(b!.recurring_total).toBe(189 + 35);
  });
});

describe("priceBreakdown — one-time", () => {
  it("one-time standard is the regular one-time price", () => {
    const b = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "onetime",
      recentlyCleaned: true,
      addons: {},
    });
    expect(b!.first_total).toBe(219);
  });
});

describe("priceBreakdown — owner price-test mode (testScale)", () => {
  it("scales a one-time standard total to 1/100", () => {
    const b = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "onetime",
      recentlyCleaned: true,
      addons: {},
      testScale: true,
    });
    expect(b!.first_total).toBe(1.5); // $219 / 100 = $2.19, capped at the $1.50 test ceiling
  });
  it("scales first and recurring totals including add-ons", () => {
    const b = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "every2weeks",
      recentlyCleaned: true,
      addons: { insideOven: true },
      testScale: true,
    });
    expect(b!.first_total).toBe(1.5); // $224 / 100 = $2.24, capped at the $1.50 test ceiling
    expect(b!.recurring_total).toBe(1.5);
  });
});

describe("global price-cut window", () => {
  it("is active before the end and inactive after", () => {
    expect(priceCutActive(Date.parse("2026-10-24T00:00:00.000Z"))).toBe(true);
    expect(priceCutActive(Date.parse("2026-10-25T08:48:59.000Z"))).toBe(true);
    expect(priceCutActive(Date.parse("2026-10-25T08:49:00.000Z"))).toBe(false);
    expect(priceCutActive(Date.parse("2026-10-26T00:00:00.000Z"))).toBe(false);
  });
});
