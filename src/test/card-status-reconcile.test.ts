// @vitest-environment node
// Card-status must tell the truth even when the Stripe webhook never
// recorded the saved card (e.g. STRIPE_WEBHOOK_SECRET missing): it
// reconciles with Stripe's own payment-method list, backfills the
// customer metadata, and sends the one-time "card saved" email.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/card-status";

const SECRET = "sk_test_reconcile";
const BID = "bid-reconcile-1";

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

type FetchCall = [string, { method?: string; body?: string } | undefined];
let calls: FetchCall[];
let customerMetadata: Record<string, string>;
let stripePmList: Array<{ id: string; card?: { brand?: string; last4?: string } }>;

function installFetch() {
  calls = [];
  const impl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push([url, init]);
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

const stripePosts = () => calls.filter(([u, i]) => u.includes("/customers/cus_1") && (i?.method ?? "GET") === "POST");
const resendCalls = () => calls.filter(([u]) => u.includes("api.resend.com"));

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", SECRET);
  vi.stubEnv("RESEND_API_KEY", "test-key");
  customerMetadata = { gh_state: "awaiting_card", gh_first_price_cents: "2190" };
  stripePmList = [{ id: "pm_123", card: { brand: "visa", last4: "4242" } }];
  installFetch();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("card-status reconciliation", () => {
  it("finds the card Stripe holds, backfills metadata, never emails on revisit", async () => {
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect(res.code).toBe(200);
    const booking = res.body.booking as Record<string, string>;
    expect(booking.has_card).toBe("1");
    const bodies = stripePosts().map(([, i]) => String(i?.body ?? ""));
    expect(bodies.some((b) => b.includes("gh_payment_method") && b.includes("pm_123"))).toBe(true);
    // §3: a revisit NEVER sends "Card saved" on its own — a card on file
    // without an explicit per-booking confirmation is a choice, not a
    // confirmation. The revisit returns the card's brand/last4 so the
    // client can make that choice.
    expect(resendCalls()).toHaveLength(0);
    expect(booking.card_brand).toBe("visa");
    expect(booking.card_last4).toBe("4242");
    expect(booking.card_confirmed).toBeUndefined();
  });

  it("does not re-email when the guard flag is already set", async () => {
    customerMetadata = { gh_state: "card_ready", gh_payment_method: "pm_123", gh_card_email_sent: "1" };
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    expect((res.body.booking as Record<string, string>).has_card).toBe("1");
    expect(resendCalls()).toHaveLength(0);
  });

  it("reports no card when Stripe holds none", async () => {
    stripePmList = [];
    const res = response();
    await handler({ method: "GET", headers: {}, query: { bt: mintToken() } }, res);
    const booking = res.body.booking as Record<string, string>;
    expect(booking.has_card).toBeUndefined();
    expect(resendCalls()).toHaveLength(0);
  });
});
