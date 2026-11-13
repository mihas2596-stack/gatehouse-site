// @vitest-environment node
// Payment #14: findLiveIntent must verify every candidate with
// verifyIntentForObligation before returning it — an unverified
// intent (wrong amount, another booking, cancellation fee) must
// never be adopted. Search errors still return null.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findLiveIntent } from "../../api/_payment_intent";

const BID = "bid-pay14";
const OBLIGATION = { amountCents: 20000, currency: "usd", customerId: "cus_live" };

type Raw = {
  id: string;
  status: string;
  amount: number;
  currency?: string;
  customer?: string | null;
  created: number;
  metadata?: Record<string, string>;
};

let searchData: Raw[];
let searchError: boolean;

function intent(over: Partial<Raw> & { id: string }): Raw {
  return {
    status: "requires_payment_method",
    amount: 20000,
    currency: "usd",
    customer: "cus_live",
    created: 100,
    metadata: { gh_booking_id: BID },
    ...over,
  };
}

beforeEach(() => {
  searchData = [];
  searchError = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(String(url));
      if (u.hostname === "api.stripe.com" && u.pathname.includes("/payment_intents/search")) {
        if (searchError) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: searchData }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("findLiveIntent verification (Payment #14)", () => {
  it("(1) an intent with the wrong amount is NOT returned", async () => {
    searchData = [intent({ id: "pi_wrong_amount", amount: 30000, created: 200 })];
    expect(await findLiveIntent("sk_test_x", BID, 1, OBLIGATION)).toBeNull();
  });

  it("(2) an intent bound to another booking is NOT returned", async () => {
    searchData = [
      intent({ id: "pi_other_booking", metadata: { gh_booking_id: "bid-other" }, created: 200 }),
    ];
    expect(await findLiveIntent("sk_test_x", BID, 1, OBLIGATION)).toBeNull();
  });

  it("(3) a cancellation-fee intent is NOT returned", async () => {
    searchData = [
      intent({
        id: "pi_cancel_fee",
        metadata: { gh_booking_id: BID, gh_kind: "cancellation_fee" },
        created: 200,
      }),
    ];
    expect(await findLiveIntent("sk_test_x", BID, 1, OBLIGATION)).toBeNull();
  });

  it("(4) a fully matching live intent IS returned (newest verified wins)", async () => {
    searchData = [
      intent({ id: "pi_good", created: 100 }),
      // Newer but wrong amount: skipped, must not shadow the good one.
      intent({ id: "pi_newer_wrong", amount: 99999, created: 300 }),
    ];
    const hit = await findLiveIntent("sk_test_x", BID, 1, OBLIGATION);
    expect(hit?.id).toBe("pi_good");
  });

  it("(5) search error returns null", async () => {
    searchError = true;
    expect(await findLiveIntent("sk_test_x", BID, 1, OBLIGATION)).toBeNull();
  });

  it("(6) without an obligation, booking binding + kind are still verified", async () => {
    // Bound to another booking: rejected even with no obligation.
    searchData = [
      intent({ id: "pi_other_booking", metadata: { gh_booking_id: "bid-other" }, created: 200 }),
    ];
    expect(await findLiveIntent("sk_test_x", BID, 1)).toBeNull();
    // Cancellation fee: rejected even with no obligation.
    searchData = [
      intent({
        id: "pi_cancel_fee",
        metadata: { gh_booking_id: BID, gh_kind: "cancellation_fee" },
        created: 200,
      }),
    ];
    expect(await findLiveIntent("sk_test_x", BID, 1)).toBeNull();
    // Bound to this booking, right kind: returned.
    searchData = [intent({ id: "pi_good_no_obligation", created: 100 })];
    expect((await findLiveIntent("sk_test_x", BID, 1))?.id).toBe("pi_good_no_obligation");
  });
});
