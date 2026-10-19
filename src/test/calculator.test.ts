// Tests for the unified price breakdown — the single source of truth for
// every price shown on /quote and signed into the booking token.
// Mirrors api/send-contact-email.ts serverBreakdown(); the two MUST agree.
import { describe, it, expect } from "vitest";
import { priceBreakdown, tierFor, addonsTotal } from "../config/calculator";

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
  // cleaned in last 3 months = Yes, founding on, inside oven +$35.
  const scenario = {
    bedrooms: 3,
    fullBaths: 2,
    frequency: "every2weeks" as const,
    founding: true,
    recentlyCleaned: true,
    addons: { insideOven: true },
  };
  it("shows ONE first-visit total including the add-on and founding discount", () => {
    const b = priceBreakdown(scenario);
    expect(b).not.toBeNull();
    // 30% off the $219 one-time M price = $153, plus $35 oven = $188.
    expect(b!.first_total).toBe(188);
    expect(b!.first_service).toBe("standard");
    expect(b!.founding_applies).toBe(true);
  });
  it("shows the founding recurring rate including the add-on", () => {
    const b = priceBreakdown(scenario);
    // 30% off the $189 recurring M price = $132, plus $35 oven = $167.
    expect(b!.recurring_total).toBe(167);
    expect(b!.founding_recurring).toBe(132);
  });
  it("shows the post-founding price (what the client pays after 6 months)", () => {
    const b = priceBreakdown({ ...scenario, founding: false });
    expect(b!.recurring_total).toBe(189 + 35); // $224
    expect(b!.first_total).toBe(189 + 35);
  });
});

describe("priceBreakdown — deep first visit", () => {
  it("labels the first visit as a deep clean when not cleaned recently", () => {
    const b = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "every2weeks",
      founding: false,
      recentlyCleaned: false,
      addons: { insideOven: true },
    });
    expect(b!.first_service).toBe("deep");
    // Deep M = $329; oven is included in deep, not charged twice.
    expect(b!.first_total).toBe(329);
    expect(b!.recurring_total).toBe(189 + 35);
  });
  it("founding deep-first: full deep price by default (owner rule)", () => {
    const b = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "every2weeks",
      founding: true,
      recentlyCleaned: false,
      addons: { insideOven: true },
    });
    expect(b!.first_total).toBe(329); // no founding discount on the deep clean
    expect(b!.recurring_total).toBe(132 + 35); // founding rate on recurring
    expect(b!.founding_applies).toBe(true);
  });
});

describe("priceBreakdown — one-time", () => {
  it("one-time standard without founding", () => {
    const b = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "onetime",
      founding: false,
      recentlyCleaned: true,
      addons: {},
    });
    expect(b!.first_total).toBe(219);
  });
  it("one-time standard with founding: 30% off the one-time price", () => {
    const b = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "onetime",
      founding: true,
      recentlyCleaned: true,
      addons: {},
    });
    expect(b!.first_total).toBe(153); // matches advertised $104/$153/$195
  });
});
