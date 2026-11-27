// @vitest-environment node
// 16.11 (item 6): a saved card the server cannot identify for THIS
// booking must never be confirmed blind. The GET returns the masked
// list for an explicit choice (only when the booking is bound to one
// Stripe Customer); the POST confirms the chosen card after
// re-verifying ownership; a card that disappeared is refused with
// card_unavailable, and a blind confirm with several cards is refused
// with card_confirmation_required.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/card-status";

const SECRET = "sk_test_choice";
const BID = "bid-choice-1";

function mintToken(): string {
  const key = createHash("sha256").update(`gatehouse-booking-link:${SECRET}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = {
    bid: BID,
    email: "client@example.com",
    name: "Casey Client",
    ts: Math.floor(Date.now() / 1000),
    first: "21.9",
    service: "Standard Cleaning",
    date: "2026-11-08",
  };
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `v2.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url")}`;
}

function response() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    headers: {} as Record<string, string>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end: vi.fn(),
  };
}

let stripePmList: Array<{ id: string; allow_redisplay?: string | null; card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number } }>;
let customerBookingId: string;

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as Response;
    if (url.includes("/customers/search")) {
      return ok({ data: [{ id: "cus_1", email: "client@example.com", name: "Casey Client", metadata: { gh_booking_id: customerBookingId, gh_state: "awaiting_card" } }] });
    }
    if (url.includes("/customers/cus_1/payment_methods")) return ok({ data: stripePmList });
    const single = /\/payment_methods\/(pm_[A-Za-z0-9]+)/.exec(url);
    if (single) {
      const found = stripePmList.find((p) => p.id === single[1]);
      if (!found) return ok({ error: { message: "not found" } }, 404);
      return ok({ id: found.id, customer: "cus_1", card: found.card, allow_redisplay: found.allow_redisplay });
    }
    if (url.includes("/customers/cus_1")) return ok({});
    if (url.includes("api.resend.com")) return ok({ id: "em_1" });
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", SECRET);
  vi.stubEnv("RESEND_API_KEY", "test-key");
  customerBookingId = BID;
  stripePmList = [
    { id: "pm_1", allow_redisplay: "always", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 } },
    { id: "pm_2", allow_redisplay: "always", card: { brand: "mastercard", last4: "5555", exp_month: 3, exp_year: 2027 } },
  ];
  installFetch();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("saved-card choice (item 6)", () => {
  it("GET with several cards returns the masked list, never a guessed card", async () => {
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect(res.code).toBe(200);
    const booking = res.body.booking as Record<string, unknown>;
    expect(booking.has_card).toBe("1");
    expect(booking.card_state).toBe("card_confirmation_required");
    // No single brand/last4 at the top level — the client must choose.
    expect(booking.card_brand).toBeUndefined();
    expect(booking.card_last4).toBeUndefined();
    const cards = booking.cards as Array<Record<string, unknown>>;
    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({ id: "pm_1", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 });
    expect(cards[1]).toEqual({ id: "pm_2", brand: "mastercard", last4: "5555", exp_month: 3, exp_year: 2027 });
    // The choice response is never cached.
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it.each([
    [{ exp_month: 12, exp_year: 2028 }, { exp_month: 12, exp_year: 2028 }],
    [{ exp_month: 12 }, { exp_year: 2028 }],
  ])("withholds the choice when the visible details match (%j, %j)", async (firstExpiry, secondExpiry) => {
    stripePmList = [
      { id: "pm_1", allow_redisplay: "always", card: { brand: "visa", last4: "4242", ...firstExpiry } },
      { id: "pm_2", allow_redisplay: "always", card: { brand: "visa", last4: "4242", ...secondExpiry } },
    ];
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect(res.code).toBe(200);
    expect(res.body.booking).toMatchObject({ has_card: "1", card_state: "card_confirmation_required" });
    expect(res.body.booking).not.toHaveProperty("cards");
  });

  it("offers both cards when the expiration dates distinguish them", async () => {
    stripePmList = [
      { id: "pm_1", allow_redisplay: "always", card: { brand: "visa", last4: "4242", exp_month: 3, exp_year: 2028 } },
      { id: "pm_2", allow_redisplay: "always", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 } },
    ];
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect(res.code).toBe(200);
    expect(res.body.booking).toMatchObject({ cards: [
      { id: "pm_1", exp_month: 3 },
      { id: "pm_2", exp_month: 12 },
    ] });
  });

  it("GET with one card identifies it directly, no list needed", async () => {
    stripePmList = [{ id: "pm_1", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 } }];
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    const booking = res.body.booking as Record<string, unknown>;
    expect(booking.card_brand).toBe("visa");
    expect(booking.card_last4).toBe("4242");
    expect(booking.cards).toBeUndefined();
  });

  it("offers only cards Stripe allows to be shown in a new checkout", async () => {
    stripePmList[1].allow_redisplay = "limited";
    stripePmList.push(
      { id: "pm_3", allow_redisplay: "unspecified", card: { brand: "visa", last4: "0003" } },
      { id: "pm_4", card: { brand: "visa", last4: "0004" } },
    );
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect(res.code).toBe(200);
    expect(res.body.booking).toMatchObject({ cards: [{ id: "pm_1" }] });
  });

  it("POST confirms the chosen card and reports its brand/last4", async () => {
    const res = response();
    await handler(
      { method: "POST", headers: {}, query: {}, body: { bt: mintToken(), action: "confirm_card", payment_method_id: "pm_2" } },
      res,
    );
    expect(res.code).toBe(200);
    expect(res.body["ok"]).toBe(true);
    expect(res.body["card_brand"]).toBe("mastercard");
    expect(res.body["card_last4"]).toBe("5555");
  });

  it("POST refuses a card that is no longer on the customer", async () => {
    const res = response();
    await handler(
      { method: "POST", headers: {}, query: {}, body: { bt: mintToken(), action: "confirm_card", payment_method_id: "pm_999" } },
      res,
    );
    expect(res.code).toBe(409);
    expect(res.body["error"]).toBe("card_unavailable");
  });

  it("POST refuses a card if permission to redisplay changed after loading the list", async () => {
    stripePmList[1].allow_redisplay = "limited";
    const res = response();
    await handler(
      { method: "POST", headers: {}, query: {}, body: { bt: mintToken(), action: "confirm_card", payment_method_id: "pm_2" } },
      res,
    );
    expect(res.code).toBe(409);
    expect(res.body.error).toBe("card_unavailable");
  });

  it("POST requires a booking-linked Customer for a saved-card list selection", async () => {
    customerBookingId = "another-booking";
    const res = response();
    await handler(
      { method: "POST", headers: {}, query: {}, body: { bt: mintToken(), action: "confirm_card", payment_method_id: "pm_2" } },
      res,
    );
    expect(res.code).toBe(409);
    expect(res.body.error).toBe("card_unavailable");
  });

  it("POST without a choice refuses a blind confirm when several cards exist", async () => {
    const res = response();
    await handler(
      { method: "POST", headers: {}, query: {}, body: { bt: mintToken(), action: "confirm_card" } },
      res,
    );
    expect(res.code).toBe(409);
    expect(res.body["error"]).toBe("card_confirmation_required");
  });
});
