// @vitest-environment node
// The server-side price mirror (api/send-contact-email.ts) MUST compute the
// same totals as the client calculator (src/config/calculator.ts).
// The booking token and the charge-amount check depend on this agreement.
//
// The Founding Clients program was closed to new bookings on 2026-10-23.
// The matrix still passes founding=true to the SERVER for half the cases:
// a stale open tab may send the flag, and the server must ignore it —
// totals must equal the regular client breakdown either way.
import { createHash, createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { priceBreakdown } from "../config/calculator";
import { serverBreakdown, verifyTestPriceToken } from "../../api/send-contact-email";

const bedrooms = [1, 2, 3, 4, 5];
const fullBaths = [1, 2, 3, 4, 5];
const frequencies = ["every2weeks", "onetime"] as const;
const addonSets = [
  {},
  { insideOven: true },
  { insideOven: true, insideFridge: true, pets: true, interiorWindows: 5 },
];

describe("server/client price parity", () => {
  for (const b of bedrooms) {
    for (const f of fullBaths) {
      for (const freq of frequencies) {
        for (const staleFounding of [false, true]) {
          for (const cleaned of [false, true]) {
            for (const addons of addonSets) {
              const label = `${b}bd/${f}ba ${freq} staleFounding=${staleFounding} cleaned=${cleaned} addons=${JSON.stringify(addons)}`;
              it(label, () => {
                const client = priceBreakdown({
                  bedrooms: b,
                  fullBaths: f,
                  frequency: freq,
                  recentlyCleaned: cleaned,
                  addons,
                });
                const server = serverBreakdown({
                  bedroomsRaw: String(b),
                  bathroomsRaw: String(f),
                  serviceKey: "standard",
                  frequency: freq,
                  // @ts-expect-error stale clients may still send the removed flag
                  founding: staleFounding,
                  cleanedRecently: cleaned,
                  addons,
                });
                expect(server).not.toBeNull();
                expect(client).not.toBeNull();
                expect(server!.first_total).toBe(client!.first_total);
                expect(server!.recurring_total).toBe(client!.recurring_total);
                expect(server!.first_service).toBe(client!.first_service);
              });
            }
          }
        }
      }
    }
  }
});

describe("owner price-test mode parity (testScale = 1/100)", () => {
  it("client and server agree on scaled totals", () => {
    const client = priceBreakdown({
      bedrooms: 3,
      fullBaths: 2,
      frequency: "onetime",
      recentlyCleaned: true,
      addons: {},
      testScale: true,
    });
    const server = serverBreakdown({
      bedroomsRaw: "3",
      bathroomsRaw: "2",
      serviceKey: "standard",
      frequency: "onetime",
      cleanedRecently: true,
      addons: {},
      testScale: true,
    });
    expect(client!.first_total).toBe(21.9); // $219 / 10
    expect(server!.first_total).toBe(21.9);
    expect(server!.recurring_total).toBe(client!.recurring_total);
  });
});

describe("verifyTestPriceToken", () => {
  const admin = "test-admin-token";
  const email = "owner@example.com";
  const now = 1_800_000_000;
  const mint = (exp: number, forEmail: string) => {
    const emailB64 = Buffer.from(forEmail, "utf8").toString("base64url");
    const key = createHash("sha256").update(`gatehouse-test-price:${admin}`).digest();
    const sig = createHmac("sha256", key).update(`tp1.${exp}.${emailB64}`).digest("base64url");
    return `tp1.${exp}.${emailB64}.${sig}`;
  };
  it("accepts a valid token for the matching email", () => {
    expect(verifyTestPriceToken(mint(now + 3600, email), email, admin, now)).toBe(true);
  });
  it("rejects an expired token", () => {
    expect(verifyTestPriceToken(mint(now - 10, email), email, admin, now)).toBe(false);
  });
  it("rejects a token minted for a different email", () => {
    expect(verifyTestPriceToken(mint(now + 3600, "other@example.com"), email, admin, now)).toBe(false);
  });
  it("rejects a tampered signature and garbage input", () => {
    const good = mint(now + 3600, email);
    const tampered = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
    expect(verifyTestPriceToken(tampered, email, admin, now)).toBe(false);
    expect(verifyTestPriceToken("not-a-token", email, admin, now)).toBe(false);
    expect(verifyTestPriceToken("", email, admin, now)).toBe(false);
    expect(verifyTestPriceToken(good, email, undefined, now)).toBe(false);
  });
});
