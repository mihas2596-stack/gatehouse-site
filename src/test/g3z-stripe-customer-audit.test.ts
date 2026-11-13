// @vitest-environment node
// G3Z payment-audit fixes in api/_stripe_customer.ts:
//   - pickCustomerByEmail is deterministic: the customer already
//     linked to the booking wins, then the booking-bound one, then a
//     lone exact match. Several unbound exact matches are AMBIGUOUS
//     (null) — never a silent list[0] that could charge a stranger.
//   - pickCustomerByPaymentMethods resolves that ambiguity with the
//     booking's payment methods: the candidate holding one wins.
//   - carryDedupMarkers re-asserts the live dedup markers across a
//     rebind instead of letting the rebind clear them.
import { describe, it, expect } from "vitest";
import {
  pickCustomerByEmail,
  pickCustomerByPaymentMethods,
  carryDedupMarkers,
  DEDUP_METADATA_KEYS,
} from "../../api/_stripe_customer";

const BID = "bid-g3z-cust";
const EMAIL = "client@example.com";

describe("pickCustomerByEmail deterministic pick (G3Z)", () => {
  const a = { id: "cus_a", email: EMAIL, metadata: { gh_booking_id: "bid-other" } };
  const b = { id: "cus_b", email: EMAIL, metadata: { gh_booking_id: BID } };
  const c = { id: "cus_c", email: EMAIL, metadata: {} };

  it("the linked customer wins over the booking-bound one", () => {
    expect(pickCustomerByEmail([a, b, c], EMAIL, BID, { linkedCustomerId: "cus_c" })).toBe(c);
    expect(pickCustomerByEmail([b, c], EMAIL, BID, { linkedCustomerId: "cus_b" })).toBe(b);
  });

  it("a linked id that matches nothing falls through to the booking-bound one", () => {
    expect(pickCustomerByEmail([a, b], EMAIL, BID, { linkedCustomerId: "cus_nope" })).toBe(b);
  });

  it("several unbound exact matches are ambiguous, never list[0]", () => {
    expect(pickCustomerByEmail([a, c], EMAIL, BID)).toBeNull();
    expect(pickCustomerByEmail([c, a], EMAIL, BID)).toBeNull();
    expect(pickCustomerByEmail([a, c], EMAIL)).toBeNull();
  });

  it("a lone exact match still resolves", () => {
    expect(pickCustomerByEmail([a], EMAIL, BID)).toBe(a);
    expect(pickCustomerByEmail([c], EMAIL, BID)).toBe(c);
  });
});

describe("pickCustomerByPaymentMethods (G3Z)", () => {
  const a = { id: "cus_a", email: EMAIL, metadata: {} };
  const b = { id: "cus_b", email: EMAIL, metadata: {} };
  const pms: Record<string, string[]> = {
    cus_a: ["pm_aaa"],
    cus_b: ["pm_booking", "pm_bbb"],
  };
  const listPms = async (id: string) => pms[id] ?? [];

  it("the candidate holding the booking's card wins the ambiguity", async () => {
    expect(await pickCustomerByPaymentMethods([a, b], EMAIL, BID, ["pm_booking"], listPms)).toBe(b);
    expect(await pickCustomerByPaymentMethods([b, a], EMAIL, BID, ["pm_booking"], listPms)).toBe(b);
  });

  it("no owner, or two owners, stays ambiguous", async () => {
    expect(await pickCustomerByPaymentMethods([a, b], EMAIL, BID, ["pm_nobody"], listPms)).toBeNull();
    expect(
      await pickCustomerByPaymentMethods([a, b], EMAIL, BID, ["pm_aaa", "pm_booking"], listPms),
    ).toBeNull();
  });

  it("a direct (booking-bound / lone) pick short-circuits without fetching cards", async () => {
    const bound = { id: "cus_bound", email: EMAIL, metadata: { gh_booking_id: BID } };
    let fetched = 0;
    const counting = async (id: string) => {
      fetched++;
      return listPms(id);
    };
    expect(await pickCustomerByPaymentMethods([a, bound], EMAIL, BID, ["pm_booking"], counting)).toBe(bound);
    expect(fetched).toBe(0);
  });

  it("a failed card lookup for a candidate counts as no match, not a crash", async () => {
    const failing = async (id: string) => {
      if (id === "cus_b") throw new Error("stripe down");
      return listPms(id);
    };
    expect(await pickCustomerByPaymentMethods([a, b], EMAIL, BID, ["pm_booking"], failing)).toBeNull();
  });
});

describe("carryDedupMarkers (G3Z)", () => {
  it("carries the live dedup markers and nothing else", () => {
    expect(DEDUP_METADATA_KEYS).toContain("gh_last_payment");
    expect(DEDUP_METADATA_KEYS).toContain("gh_fee_last_payment");
    expect(
      carryDedupMarkers({
        gh_last_payment: "pi_1",
        gh_fee_last_payment: "pi_fee_1",
        gh_state: "paid",
        gh_payment_method: "pm_1",
      }),
    ).toEqual({
      "metadata[gh_last_payment]": "pi_1",
      "metadata[gh_fee_last_payment]": "pi_fee_1",
    });
  });

  it("empty when no marker is live", () => {
    expect(carryDedupMarkers({ gh_state: "paid" })).toEqual({});
    expect(carryDedupMarkers(undefined)).toEqual({});
  });
});
