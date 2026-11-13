// @vitest-environment node
// Payment #12: after a card is unbound (delete_card), the card-status
// GET must not keep reporting the card as ready from cached Stripe
// customer metadata (gh_state=card_ready / gh_payment_method). The live
// Stripe payment-method list is authoritative: an empty list means
// no_card, whatever the metadata says.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/card-status";

const SECRET = "sk_test_stale_card";
const BID = "bid-stale-card-1";

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
  const res = {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

let customerMetadata: Record<string, string>;
let stripePmList: Array<{ id: string; card?: { brand?: string; last4?: string } }>;

function installFetch() {
  const impl = async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
    if (url.includes("/customers/search")) {
      return ok({ data: [{ id: "cus_1", email: "client@example.com", name: "Casey Client", metadata: { gh_booking_id: BID, ...customerMetadata } }] });
    }
    if (url.includes("/customers/cus_1/payment_methods")) return ok({ data: stripePmList });
    if (url.includes("api.resend.com")) return ok({ id: "em_1" });
    if (url.includes("/customers/cus_1")) return ok({});
    throw new Error(`unexpected fetch ${url}`);
  };
  vi.stubGlobal("fetch", vi.fn(impl));
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", SECRET);
  customerMetadata = {};
  stripePmList = [];
  installFetch();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("card-status stale card after delete_card (Payment #12)", () => {
  it("card list empty + metadata says card_ready -> no_card, not card_ready", async () => {
    customerMetadata = { gh_state: "card_ready", gh_payment_method: "pm_123" };
    stripePmList = [];
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect(res.code).toBe(200);
    const booking = res.body.booking as Record<string, string>;
    expect(booking.has_card).toBeUndefined();
    expect(booking.card_state).toBe("no_card");
    expect(booking.card_brand).toBeUndefined();
    expect(booking.card_last4).toBeUndefined();
  });

  it("card list non-empty + metadata card_ready -> card_ready", async () => {
    customerMetadata = { gh_state: "card_ready", gh_payment_method: "pm_123" };
    stripePmList = [{ id: "pm_123", card: { brand: "visa", last4: "4242" } }];
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect(res.code).toBe(200);
    const booking = res.body.booking as Record<string, string>;
    expect(booking.has_card).toBe("1");
    expect(booking.card_state).toBe("card_ready");
    expect(booking.card_brand).toBe("visa");
    expect(booking.card_last4).toBe("4242");
  });

  it("card list empty + no metadata -> no_card", async () => {
    customerMetadata = {};
    stripePmList = [];
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect(res.code).toBe(200);
    const booking = res.body.booking as Record<string, string>;
    expect(booking.has_card).toBeUndefined();
    expect(booking.card_state).toBe("no_card");
  });
});
