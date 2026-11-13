// @vitest-environment node
// G3y round, card-status:
// - G3 10-card limit: the card list used to stop at 10, so a client
//   with more than 10 cards could lose their booking's own card from
//   the list. reconcileCard now pages through the whole list, and a
//   confirmed card not on any page is fetched directly by id.
// - G4 L10: a GET/revisit reconcile is read-only (no card_ready
//   writes); the backfill happens only behind POST confirm_card.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import handler from "../../api/card-status";

const SECRET = "sk_test_g3y_cards";
const BID = "bid-g3y-cards";
const TARGET = "pm_target_card";

function mintToken(): string {
  const key = createHash("sha256").update(`gatehouse-booking-link:${SECRET}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = {
    bid: BID, email: "client@example.com", name: "Casey Client",
    ts: Math.floor(Date.now() / 1000),
    first: "21.9", service: "Standard Cleaning", date: "2026-11-08",
  };
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `v2.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url")}`;
}

function response() {
  return {
    code: 0,
    body: {} as Record<string, unknown>,
    status(code: number) { this.code = code; return this; },
    json(body: Record<string, unknown>) { this.body = body; },
    setHeader: vi.fn(),
    end: vi.fn(),
  };
}

type Card = { id: string; card?: { brand?: string; last4?: string } };
type Ev = { event: string; detail: Record<string, unknown> | null; created_at: string };

let customerMetadata: Record<string, string>;
// Pages of the Stripe payment-method list, in order.
let pmPages: { cards: Card[]; has_more: boolean }[];
let dbRow: Record<string, unknown> | null;
let dbEvents: Ev[];
let stripePosts: string[];
let resendCalls: number;
let pmListCalls: number;

const card = (id: string): Card => ({ id, card: { brand: "visa", last4: id.slice(-4) } });

function installFetch() {
  stripePosts = [];
  resendCalls = 0;
  pmListCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = new URL(String(url));
    const ok = (data: unknown) => ({
      ok: true, status: 200,
      json: async () => data, text: async () => JSON.stringify(data),
    });
    if (u.hostname.includes("supabase")) {
      const table = u.pathname.split("/").pop() ?? "";
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        if (table === "gh_visits") return ok(dbRow ? [dbRow] : []);
        if (table === "gh_events") {
          let out = [...dbEvents];
          const ev = u.searchParams.get("event");
          if (ev?.startsWith("eq.")) out = out.filter((e) => e.event === ev.slice(3));
          const limit = u.searchParams.get("limit");
          if (limit) out = out.slice(0, parseInt(limit, 10));
          return ok(out);
        }
        return ok([]);
      }
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const inserted = { ...body, id: `ev-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString() };
        dbEvents.push(inserted);
        return ok([inserted]);
      }
      return ok([]);
    }
    if (u.hostname === "api.resend.com") { resendCalls++; return ok({ id: "em_1" }); }
    if (u.hostname === "api.stripe.com") {
      if (u.pathname.endsWith("/customers/search")) {
        return ok({ data: [{ id: "cus_1", email: "client@example.com", name: "Casey Client", metadata: { gh_booking_id: BID, ...customerMetadata } }] });
      }
      if (u.pathname.endsWith("/payment_methods")) {
        pmListCalls++;
        const after = u.searchParams.get("starting_after");
        let idx = 0;
        if (after) {
          idx = pmPages.findIndex((p) => p.cards.some((c) => c.id === after)) + 1;
          if (idx <= 0) idx = pmPages.length;
        }
        const page = pmPages[idx] ?? { cards: [], has_more: false };
        return ok({ data: page.cards, has_more: page.has_more });
      }
      const pmM = /^\/v1\/payment_methods\/(pm_[A-Za-z0-9_]+)$/.exec(u.pathname);
      if (pmM) {
        const all = pmPages.flatMap((p) => p.cards);
        const found = all.find((c) => c.id === pmM[1]);
        if (found) return ok({ id: found.id, customer: "cus_1", card: found.card ?? {} });
        // The confirmed card may exist at Stripe without being on any
        // list page (the direct-fetch backstop).
        if (pmM[1] === TARGET) return ok({ id: TARGET, customer: "cus_1", card: { brand: "mastercard", last4: "5555" } });
        return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" };
      }
      if (u.pathname === "/v1/customers/cus_1") {
        if (init?.body) {
          stripePosts.push(String(init.body));
          const params = new URLSearchParams(String(init.body));
          for (const [k, v] of params.entries()) {
            const m = /^metadata\[(.+)\]$/.exec(k);
            if (m) customerMetadata[m[1]] = v;
          }
        }
        return ok({ id: "cus_1", email: "client@example.com", name: "Casey Client", metadata: customerMetadata });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", SECRET);
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  customerMetadata = { gh_state: "awaiting_card", gh_first_price_cents: "2190" };
  pmPages = [{ cards: [card("pm_123")], has_more: false }];
  dbRow = null;
  dbEvents = [];
  installFetch();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const get = () => ({ method: "GET", headers: {}, query: { bt: mintToken() } });

describe("G3: more than 10 cards — the booking's own card is never dropped", () => {
  it("finds a cached card sitting on page 2 of the list (old limit=10 missed it)", async () => {
    customerMetadata = { gh_state: "awaiting_card", gh_payment_method: TARGET };
    pmPages = [
      { cards: Array.from({ length: 10 }, (_, i) => card(`pm_page1_${i}`)), has_more: true },
      { cards: [card(TARGET), card("pm_page2_b")], has_more: false },
    ];
    const res = response();
    await handler(get() as never, res as never);
    expect(res.code).toBe(200);
    const booking = res.body.booking as Record<string, string>;
    expect(booking.has_card).toBe("1");
    expect(booking.card_state).toBe("card_ready");
    expect(booking.card_last4).toBe("card"); // card("pm_target_card").last4
    expect(pmListCalls).toBe(2);
  });

  it("several cards with no booking signal stays ambiguous (no guessing)", async () => {
    pmPages = [
      { cards: Array.from({ length: 10 }, (_, i) => card(`pm_page1_${i}`)), has_more: true },
      { cards: [card("pm_page2_a"), card("pm_page2_b")], has_more: false },
    ];
    const res = response();
    await handler(get() as never, res as never);
    const booking = res.body.booking as Record<string, string>;
    expect(booking.card_state).toBe("card_confirmation_required");
  });
});

describe("G4 L10: GET reconcile is read-only, POST confirm_card writes", () => {
  it("GET reports the card but writes nothing to Stripe", async () => {
    const res = response();
    await handler(get() as never, res as never);
    expect(res.code).toBe(200);
    expect((res.body.booking as Record<string, string>).has_card).toBe("1");
    expect(stripePosts).toHaveLength(0);
    expect(customerMetadata["gh_payment_method"]).toBeUndefined();
    expect(customerMetadata["gh_state"]).toBe("awaiting_card");
  });

  it("POST confirm_card backfills the card and marks card_ready", async () => {
    dbRow = {
      id: "row-g3y-1", booking_id: BID, status: "requested", amount_cents: 2190,
      client_email: "client@example.com", client_name: "Casey Client",
      visit_date: "2026-11-08", report_sent_at: null,
    };
    dbEvents = [
      { event: "visit_created", detail: {}, created_at: new Date(Date.now() - 3600 * 1000).toISOString() },
      { event: "card_confirmed", detail: { payment_method_id: TARGET, brand: "mastercard", last4: "5555" }, created_at: new Date().toISOString() },
    ];
    // The confirmed card is NOT on any list page — the direct fetch
    // backstop must still find it (never silently dropped).
    pmPages = [
      { cards: Array.from({ length: 10 }, (_, i) => card(`pm_page1_${i}`)), has_more: true },
      { cards: [card("pm_page2_a")], has_more: false },
    ];
    const res = response();
    await handler({ method: "POST", headers: {}, body: { bt: mintToken(), action: "confirm_card" } } as never, res as never);
    expect(res.code).toBe(200);
    expect(res.body["card_last4"]).toBe("5555");
    expect(customerMetadata["gh_payment_method"]).toBe(TARGET);
    expect(customerMetadata["gh_state"]).toBe("card_ready");
    expect(stripePosts.some((b) => b.includes("gh_payment_method") && b.includes(TARGET))).toBe(true);
  });
});
