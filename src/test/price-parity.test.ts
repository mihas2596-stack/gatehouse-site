// @vitest-environment node
// The server-side price mirror (api/send-contact-email.ts) MUST compute the
// same totals as the client calculator (src/config/calculator.ts).
// The booking token and the charge-amount check depend on this agreement.
import { describe, it, expect } from "vitest";
import { priceBreakdown } from "../config/calculator";
import { serverBreakdown } from "../../api/send-contact-email";

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
        for (const founding of [false, true]) {
          for (const cleaned of [false, true]) {
            for (const addons of addonSets) {
              const label = `${b}bd/${f}ba ${freq} founding=${founding} cleaned=${cleaned} addons=${JSON.stringify(addons)}`;
              it(label, () => {
                const client = priceBreakdown({
                  bedrooms: b,
                  fullBaths: f,
                  frequency: freq,
                  founding,
                  recentlyCleaned: cleaned,
                  addons,
                });
                const server = serverBreakdown({
                  bedroomsRaw: String(b),
                  bathroomsRaw: String(f),
                  serviceKey: "standard",
                  frequency: freq,
                  founding,
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
