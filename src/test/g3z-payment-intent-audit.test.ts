// @vitest-environment node
// G3Z payment-audit fixes in api/_payment_intent.ts:
//   - searchIntents walks ALL pages (the old 5 hops x 20 = 100 cap
//     silently dropped every intent past the first hundred).
//   - reconcileIntent logs a mismatch and CONTINUES with the remaining
//     intents instead of aborting the whole pass on the first one.
//   - findSucceededCleaningIntent verifies the client when a
//     customerId is supplied (P14 did this for findLiveIntent only).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchIntents,
  reconcileIntent,
  findSucceededCleaningIntent,
} from "../../api/_payment_intent";

const BID = "bid-g3z-intent";
const CUSTOMER = "cus_g3z";
const PINNED = 20000;

type Raw = {
  id: string;
  status: string;
  amount: number;
  currency?: string;
  customer?: string | null;
  created: number;
  metadata?: Record<string, string>;
};

function intent(over: Partial<Raw> & { id: string }): Raw {
  return {
    status: "succeeded",
    amount: PINNED,
    currency: "usd",
    customer: CUSTOMER,
    created: 100,
    metadata: { gh_booking_id: BID },
    ...over,
  };
}

// Search pages keyed by page token; getIntent rows keyed by id.
let pages: Record<string, { data: Raw[]; next_page?: string }>;
let byId: Record<string, Raw>;
let searchCalls: string[];

beforeEach(() => {
  pages = {};
  byId = {};
  searchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(String(url));
      if (u.hostname !== "api.stripe.com") throw new Error(`unexpected fetch ${url}`);
      if (u.pathname.includes("/payment_intents/search")) {
        const token = u.searchParams.get("page") ?? "";
        searchCalls.push(token);
        const page = pages[token] ?? { data: [] };
        return { ok: true, status: 200, json: async () => page };
      }
      const m = u.pathname.match(/^\/v1\/payment_intents\/([^/]+)$/);
      if (m) {
        const found = byId[m[1]];
        if (!found) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => found };
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchIntents pagination (G3Z)", () => {
  it("walks every page past the old 100-intent cap", async () => {
    // 6 pages x 2 intents = 12. The old code stopped after 5 hops.
    const mk = (n: number) => intent({ id: `pi_p${n}`, created: n });
    pages = {
      "": { data: [mk(1), mk(2)], next_page: "t1" },
      t1: { data: [mk(3), mk(4)], next_page: "t2" },
      t2: { data: [mk(5), mk(6)], next_page: "t3" },
      t3: { data: [mk(7), mk(8)], next_page: "t4" },
      t4: { data: [mk(9), mk(10)], next_page: "t5" },
      t5: { data: [mk(11), mk(12)] },
    };
    const r = await searchIntents("sk_test_x", BID);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.intents).toHaveLength(12);
    expect(r.intents.map((i) => i.id)).toContain("pi_p12");
    expect(searchCalls).toEqual(["", "t1", "t2", "t3", "t4", "t5"]);
  });

  it("stops when there is no next_page", async () => {
    pages = { "": { data: [intent({ id: "pi_only" })] } };
    const r = await searchIntents("sk_test_x", BID);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.intents).toHaveLength(1);
    expect(searchCalls).toEqual([""]);
  });
});

describe("reconcileIntent continues past mismatches (G3Z)", () => {
  const obligation = { amountCents: PINNED, currency: "usd", customerId: CUSTOMER };

  it("a mismatched known intent does not hide a later succeeded one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    byId = {
      pi_bad: intent({ id: "pi_bad", amount: 99999, created: 50 }),
    };
    pages = { "": { data: [intent({ id: "pi_good", created: 200 })] } };
    const r = await reconcileIntent("sk_test_x", BID, ["pi_bad"], obligation);
    expect(r.state).toBe("succeeded");
    if (r.state === "succeeded") expect(r.intent.id).toBe("pi_good");
  });

  it("a mismatched search result does not hide a later live one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    pages = {
      "": {
        data: [
          intent({ id: "pi_wrong_booking", metadata: { gh_booking_id: "bid-other" }, created: 300 }),
          intent({ id: "pi_live", status: "requires_payment_method", created: 100 }),
        ],
      },
    };
    const r = await reconcileIntent("sk_test_x", BID, [], obligation);
    expect(r.state).toBe("live");
    if (r.state === "live") expect(r.intent.id).toBe("pi_live");
  });

  it("only mismatches: reports the first mismatch, nothing is adopted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    byId = { pi_bad: intent({ id: "pi_bad", amount: 99999, created: 50 }) };
    pages = { "": { data: [intent({ id: "pi_bad2", amount: 30000, created: 60 })] } };
    const r = await reconcileIntent("sk_test_x", BID, ["pi_bad"], obligation);
    expect(r.state).toBe("mismatch");
    if (r.state === "mismatch") {
      expect(r.intent.id).toBe("pi_bad");
      expect(r.reason).toBe("amount_mismatch");
    }
  });

  it("a fee intent is still skipped, not a mismatch", async () => {
    pages = {
      "": {
        data: [
          intent({
            id: "pi_fee",
            metadata: { gh_booking_id: BID, gh_kind: "cancellation_fee" },
            created: 300,
          }),
        ],
      },
    };
    const r = await reconcileIntent("sk_test_x", BID, [], obligation);
    expect(r.state).toBe("none");
  });
});

describe("findSucceededCleaningIntent verifies the client (G3Z)", () => {
  it("a succeeded intent for ANOTHER customer is not accepted", async () => {
    pages = {
      "": { data: [intent({ id: "pi_stranger", customer: "cus_other" })] },
    };
    expect(await findSucceededCleaningIntent("sk_test_x", BID, PINNED, CUSTOMER)).toBeNull();
  });

  it("a succeeded intent for THIS customer is accepted", async () => {
    pages = { "": { data: [intent({ id: "pi_mine" })] } };
    expect(await findSucceededCleaningIntent("sk_test_x", BID, PINNED, CUSTOMER)).toBe("pi_mine");
  });
});
